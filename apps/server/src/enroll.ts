// Enrolment (TECHNICAL.md 4.4, 4.9). The phone asks for a challenge, attests its App Attest key
// over enrollClientDataHash(challenge, account_id, player_box_pk, near_pk), and sends the
// attestation. The relay checks it against Apple's root (a cheap first filter; the referee checks
// it again inside the enclave, and only the referee's check counts), then:
//
//   1. writes the device row, which holds the handle and the keys while the calls below run;
//   2. registers the device with the referee and keeps its signed receipt;
//   3. creates `<handle>.<relay account>` holding only the phone's near_pk, and registers it.
//
// Only then does the phone hear "enrolled". If the referee or the chain says no, the row goes and
// the handle is free again. The referee comes before the chain so a refusal costs the relay no
// NEAR, and an account is never made for a device the referee will not take.
//
// Each receipt is kept with the referee key that signed it. When the contract pins another
// referee (local test referee ↔ OutLayer), every device is unknown to the new one, and Apple's
// attestation cannot be replayed to it (its credential certificate lasts a few days). The phone
// then refreshes: a fresh attestation over a fresh challenge, both requests signed by the
// account's NEAR key, and a `rebind_sig` by that key so the referee may replace any record it
// holds for the account. A match starts only when every player's receipt is from the referee
// the relay runs with now (`ensureWithReferee`).
//
// Ghosts (simulated phones, README "testing door") skip Apple's attestation, which no simulator
// can produce. That path exists only when the relay was configured with NEAR_NETWORK=testnet and
// ALLOW_GHOSTS=1, and ghost accounts always carry the `ghost-` prefix, on chain and in the
// referee's device record, so no ghost can pass for a phone.

import type { Environment } from "@tail/appattest";
import type { Logger } from "@tail/log";
import { concat, enrollClientDataHash, equal, sha256, utf8 } from "@tail/protocol";
import { verifyEd25519 } from "./auth.ts";
import type { DeviceRow, RefereeReceipt, Store } from "./db.ts";
import { HttpError } from "./errors.ts";
import { Buckets, DAY_MS, DEFAULT_ENROL_CAPS, type EnrolCaps } from "./limits.ts";
import { AccountTakenError, type Chain } from "./near.ts";
import { type EnrollInput, type Referee, RefereeError, type RefereeKeys } from "./referee.ts";

export const CHALLENGE_TTL_MS = 5 * 60_000;
/**
 * Unanswered enrolment and refresh challenges the relay keeps, in all and per handle and client
 * (past that, the client's oldest for the handle goes: db.ts putEnrolChallenge). Asking costs
 * nothing, so the table is capped; per-client buckets (limits.ts) stop one client from taking
 * the whole cap.
 */
export const MAX_OPEN_CHALLENGES = 1_000;
export const MAX_OPEN_CHALLENGES_PER_HANDLE = 3;
export const GHOST_PREFIX = "ghost-";
const HANDLE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
/**
 * The referee signs a receipt over SHA256(this ‖ receipt), receipt = borsh(Device)
 * (crates/referee-wasi records.rs `enroll_receipt_digest`). The relay checks it to know which
 * referee a receipt is from.
 */
const ENROLL_RECEIPT_DOMAIN = "tail/enroll-receipt/v1";

export type VerifyAttestation = (i: {
  attestation: Uint8Array;
  keyId: Uint8Array;
  clientDataHash: Uint8Array;
  appId: string;
  environment: Environment;
}) => Promise<Uint8Array>;

export interface EnrolDeps {
  store: Store;
  chain: Chain;
  referee: Referee;
  log: Logger;
  parentAccount: string;
  appId: string;
  environment: Environment;
  verifyAttestation: VerifyAttestation;
  caps?: EnrolCaps;
  now?: () => number;
}

/** What the phone gets back, once the referee holds its device and its account exists. */
export interface Enrolled {
  account_id: string;
}

/** What a phone sends to enrol or refresh, beyond what the route checks. */
export interface Attested {
  challenge: Uint8Array;
  keyId: Uint8Array;
  attestation: Uint8Array;
  playerBoxPk: Uint8Array;
  /** Optional on enrolment, required on refresh: see EnrollInput.rebindSig. */
  rebindSig?: Uint8Array | undefined;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

export class Enrolment {
  private readonly now: () => number;
  private readonly caps: EnrolCaps;
  /** New phone enrolments per client address over a rolling day. */
  private readonly perIp: Buckets;
  /** One referee registration in flight per account, shared by Start and refresh. */
  private readonly inFlight = new Map<string, Promise<void>>();
  private keys: Promise<RefereeKeys> | undefined;

  constructor(private readonly d: EnrolDeps) {
    this.now = d.now ?? Date.now;
    this.caps = d.caps ?? DEFAULT_ENROL_CAPS;
    this.perIp = new Buckets(
      { burst: this.caps.perIpPerDay, everyMs: DAY_MS / this.caps.perIpPerDay },
      this.now,
    );
  }

  /** The referee's public keys, asked once per process (a failed ask is asked again). */
  refereeKeys(): Promise<RefereeKeys> {
    this.keys ??= this.d.referee.pubkeys().catch((e: unknown) => {
      this.keys = undefined;
      throw e;
    });
    return this.keys;
  }

  accountFor(handle: string, ghost: boolean): string {
    if (!HANDLE.test(handle) || handle.length < 2 || handle.length > 40) {
      throw new HttpError(400, "handle: 2 to 40 of a-z, 0-9, single - or _ between");
    }
    if (handle.startsWith(GHOST_PREFIX) !== ghost) {
      throw new HttpError(
        400,
        ghost ? "ghost handles start with ghost-" : "handles cannot start with ghost-",
      );
    }
    const id = `${handle}.${this.d.parentAccount}`;
    if (id.length > 64) throw new HttpError(400, "handle too long for a NEAR account id");
    return id;
  }

  private ensureFree(accountId: string) {
    if (this.d.store.device(accountId)) throw new HttpError(409, "that handle is taken");
  }

  private issueChallenge(accountId: string, client: string) {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const now = this.now();
    const expires = now + CHALLENGE_TTL_MS;
    const stored = this.d.store.putEnrolChallenge(challenge, accountId, client, expires, now, {
      total: MAX_OPEN_CHALLENGES,
      perAccount: MAX_OPEN_CHALLENGES_PER_HANDLE,
    });
    if (!stored) throw new HttpError(429, "too many enrolments waiting; try again in a few minutes");
    return { challenge: b64(challenge), account_id: accountId, expires_ms: expires };
  }

  async challenge(
    handle: string,
    client: string,
  ): Promise<{ challenge: string; account_id: string; expires_ms: number }> {
    const accountId = this.accountFor(handle, false);
    this.ensureFree(accountId);
    return this.issueChallenge(accountId, client);
  }

  /** A challenge for refreshing `accountId`, which the caller proved it holds (a signed request). */
  async refreshChallenge(
    accountId: string,
    client: string,
  ): Promise<{ challenge: string; account_id: string; expires_ms: number }> {
    if (this.d.store.device(accountId)?.kind !== "phone") throw new HttpError(400, "only a phone refreshes");
    await this.refuseInMatch(accountId);
    return this.issueChallenge(accountId, client);
  }

  /**
   * A match keeps the copy of each device the referee took at its start, so a refresh mid-match
   * would leave the phone signing with keys its match does not know: refused until it ends.
   */
  private async refuseInMatch(accountId: string) {
    if (this.d.store.runningMatchesOf(accountId).length === 0) {
      // A match being started has no stored players yet; its lobby on chain names them.
      const starting = this.d.store.matchesIn(["starting"]);
      const lobbies = await Promise.all(starting.map((id) => this.d.chain.getMatch(id)));
      if (!lobbies.some((m) => m?.players.some((p) => p.account_id === accountId))) return;
    }
    throw new HttpError(409, "you are in a match; refresh once it ends", { code: "in_match" });
  }

  /** Takes the challenge (single use) and checks the attestation over it; returns its App Attest key. */
  private async attested(i: Attested, accountId: string | null, nearPk: Uint8Array) {
    const ch = this.d.store.takeEnrolChallenge(i.challenge);
    if (!ch || ch.expires_ms < this.now() || (accountId !== null && ch.account_id !== accountId)) {
      throw new HttpError(401, "challenge unknown or expired");
    }
    try {
      const pk = await this.d.verifyAttestation({
        attestation: i.attestation,
        keyId: i.keyId,
        clientDataHash: enrollClientDataHash(i.challenge, ch.account_id, i.playerBoxPk, nearPk),
        appId: this.d.appId,
        environment: this.d.environment,
      });
      return { accountId: ch.account_id, appAttestPk: pk };
    } catch (e) {
      this.d.log.warn({ accountId: ch.account_id, err: (e as Error).message }, "attestation refused");
      throw new HttpError(401, "device attestation failed");
    }
  }

  async enroll(i: Attested & { nearPk: Uint8Array; client: string }): Promise<Enrolled> {
    if (i.challenge.length !== 32 || i.playerBoxPk.length !== 32 || i.nearPk.length !== 32) {
      throw new HttpError(400, "challenge, player_box_pk and near_pk are 32 bytes each");
    }
    const { accountId, appAttestPk } = await this.attested(i, null, i.nearPk);
    return this.register(
      accountId,
      "phone",
      appAttestPk,
      i.playerBoxPk,
      i.nearPk,
      {
        attestation: i.attestation,
        challenge: i.challenge,
        ...(i.rebindSig ? { rebindSig: i.rebindSig } : {}),
      },
      i.client,
    );
  }

  /**
   * The testing door, in-process only: ghosts/fill.ts and scripts/ghost-match.ts call it with
   * keys they made themselves. No HTTP route reaches it, so no client can enrol a device without
   * an attestation, and fill.ts runs only when the config allows ghosts.
   */
  async enrollGhost(i: {
    handle: string;
    appAttestPk: Uint8Array;
    playerBoxPk: Uint8Array;
    nearPk: Uint8Array;
  }): Promise<Enrolled> {
    const accountId = this.accountFor(i.handle, true);
    if (i.appAttestPk.length !== 65 || i.playerBoxPk.length !== 32 || i.nearPk.length !== 32) {
      throw new HttpError(400, "app_attest_pk is 65 bytes, player_box_pk and near_pk 32");
    }
    return this.register(accountId, "ghost", i.appAttestPk, i.playerBoxPk, i.nearPk, null, null);
  }

  private async register(
    accountId: string,
    kind: DeviceRow["kind"],
    appAttestPk: Uint8Array,
    playerBoxPk: Uint8Array,
    nearPk: Uint8Array,
    proof: Pick<EnrollInput, "attestation" | "challenge" | "rebindSig"> | null,
    client: string | null,
  ): Promise<Enrolled> {
    this.ensureFree(accountId);
    if (this.d.store.deviceWithKey(appAttestPk, nearPk)) {
      throw new HttpError(409, "this device is already enrolled");
    }
    const now = this.now();
    // The per-address share counts enrolments that happened: any refusal below gives it back.
    let took = false;
    const refund = () => {
      if (took && client !== null) this.perIp.refund(client);
      took = false;
    };
    const row: DeviceRow = {
      account_id: accountId,
      kind,
      app_attest_pk: appAttestPk,
      player_box_pk: playerBoxPk,
      near_pk: nearPk,
      receipt: null,
      receipt_sig: null,
      enroll_call_id: null,
      created_ms: now,
      attestation: null,
      challenge: null,
      attested: null,
      referee_pk: null,
    };
    try {
      if (kind === "phone") {
        if (client !== null) {
          if (!this.perIp.take(client)) {
            throw new HttpError(
              429,
              "this network has enrolled its share of new players today; try tomorrow",
            );
          }
          took = true;
        }
        if (!this.d.store.putPhoneWithin(row, now - DAY_MS, this.caps.perDay)) {
          throw new HttpError(429, "the relay has enrolled its share of new players today; try tomorrow");
        }
      } else this.d.store.putDevice(row);
    } catch (e) {
      refund();
      // Two enrolments of one device at once both passed the check above; the index stops one.
      if (/UNIQUE constraint/.test((e as Error).message)) {
        throw new HttpError(409, "this device is already enrolled");
      }
      throw e;
    }
    try {
      const r = await this.callReferee({
        accountId,
        appAttestPk,
        playerBoxPk,
        nearPk,
        ...(proof ?? {}),
      });
      this.d.store.setDeviceReceipt(accountId, r);
      try {
        await this.d.chain.createPlayerAccount(accountId, nearPk);
      } catch (e) {
        if (e instanceof AccountTakenError) throw new HttpError(409, "that handle is taken");
        throw e;
      }
    } catch (e) {
      // Nothing half-done stays here: the handle is free on the relay again. The referee keeps
      // any record it stored, binding the account to this near_pk: a retry with the same keys
      // gets that record back, and one with a new App Attest or box key is admitted only with a
      // rebind_sig by this near_pk. A retry under another NEAR key is refused by this referee,
      // so the phone must keep its NEAR key until it is enrolled.
      refund();
      this.d.store.deleteDevice(accountId);
      this.d.log.warn({ accountId, kind, err: (e as Error).message }, "enrolment undone");
      throw e;
    }
    this.d.log.info({ accountId, kind }, "enrolled with the referee and on chain");
    return { account_id: accountId };
  }

  /**
   * A fresh attestation for an enrolled phone, for the referee the relay runs with now. The caller
   * proved it holds the account's NEAR key (a signed request); the NEAR key stays the same, the
   * App Attest key and box key may be new. Until the referee accepts, the row keeps its old
   * keys and receipt.
   */
  async refresh(accountId: string, i: Attested): Promise<Enrolled> {
    const dev = this.d.store.device(accountId);
    if (dev?.kind !== "phone") throw new HttpError(400, "only a phone refreshes");
    if (i.challenge.length !== 32 || i.playerBoxPk.length !== 32 || i.rebindSig?.length !== 64) {
      throw new HttpError(400, "challenge and player_box_pk are 32 bytes, rebind_sig 64");
    }
    await this.refuseInMatch(accountId);
    const { appAttestPk } = await this.attested(i, accountId, dev.near_pk);
    const owner = this.d.store.appAttestKeyOwner(appAttestPk);
    if (owner !== undefined && owner !== accountId)
      throw new HttpError(409, "this device is already enrolled");
    await this.once(accountId, async () => {
      // Again, now that no Start can read this device between the check and the referee call:
      // ensureWithReferee waits for this registration before it lets a match start.
      await this.refuseInMatch(accountId);
      const r = await this.callReferee({
        accountId,
        appAttestPk,
        playerBoxPk: i.playerBoxPk,
        nearPk: dev.near_pk,
        attestation: i.attestation,
        challenge: i.challenge,
        ...(i.rebindSig ? { rebindSig: i.rebindSig } : {}),
      });
      try {
        this.d.store.refreshDevice(accountId, i.playerBoxPk, r);
      } catch (e) {
        if (/UNIQUE constraint/.test((e as Error).message)) {
          throw new HttpError(409, "this device is already enrolled");
        }
        throw e;
      }
    });
    this.d.log.info({ accountId }, "refreshed with the referee");
    return { account_id: accountId };
  }

  /** Whether the referee the relay runs with now holds this device. */
  async status(accountId: string): Promise<{ account_id: string; with_referee: boolean }> {
    const dev = this.d.store.device(accountId);
    if (!dev) throw new HttpError(404, "not enrolled here");
    return { account_id: accountId, with_referee: await this.withReferee(dev) };
  }

  /**
   * Makes sure the referee the relay runs with holds every listed device, or throws. A ghost is
   * registered again (unattested, as at first); a phone whose attestation the relay still holds
   * (a row an older relay left waiting) is registered with it. Any other phone must refresh:
   * the 409 names them, with `code: "refresh"`.
   */
  async ensureWithReferee(accountIds: string[]): Promise<void> {
    const stale: string[] = [];
    // A refresh in flight lands (or fails) first, so Start sees the device the referee holds.
    // None starts after this: a lobby being started refuses its players' refreshes.
    await Promise.all(accountIds.map((a) => this.idle(a)));
    await this.dropReceiptsNotHeld(accountIds);
    await Promise.all(
      accountIds.map(async (a) => {
        const dev = this.d.store.device(a);
        if (!dev || (await this.withReferee(dev))) return;
        if (dev.kind === "ghost" || (dev.attestation && dev.challenge)) {
          try {
            await this.once(a, async () => {
              // A refresh may have landed while this waited for it.
              const now = this.d.store.device(a);
              if (now && (await this.withReferee(now))) return;
              const r = await this.callReferee({
                accountId: a,
                appAttestPk: dev.app_attest_pk,
                playerBoxPk: dev.player_box_pk,
                nearPk: dev.near_pk,
                ...(dev.attestation && dev.challenge
                  ? { attestation: dev.attestation, challenge: dev.challenge }
                  : {}),
              });
              this.d.store.setDeviceReceipt(a, r);
            });
            return;
          } catch (e) {
            if (!(e instanceof RefereeError && e.refused)) throw e;
            this.d.log.warn({ accountId: a, err: e.message }, "the referee refused a stored device");
          }
        }
        stale.push(a);
      }),
    );
    if (stale.length) {
      throw new HttpError(
        409,
        `the referee does not know these players yet; each must open the app to refresh: ${stale.join(", ")}`,
        { code: "refresh", accounts: stale },
      );
    }
  }

  /**
   * A receipt says the referee held the device when it signed it, not that it holds it now (its
   * record can be one it no longer reads, or gone). Before a lobby is locked, the referee is
   * asked: a receipt that is not the body of the record `start` would read is cleared, so the
   * account is registered again or told to refresh, and `/enroll/status` says so too.
   */
  private async dropReceiptsNotHeld(accountIds: string[]) {
    const held = await this.d.referee.devices(accountIds);
    for (const h of held) {
      const dev = this.d.store.device(h.accountId);
      if (!dev?.receipt || (h.receipt && equal(h.receipt, dev.receipt))) continue;
      this.d.log.warn(
        { accountId: h.accountId, unreadable: h.unreadable, held: h.receipt !== null },
        "the referee does not hold this device as recorded; its receipt is dropped",
      );
      this.d.store.clearDeviceReceipt(h.accountId);
    }
  }

  /**
   * True when the device's receipt is from the referee the relay runs with now. A receipt from
   * before the relay kept referee_pk is checked by its signature, once.
   */
  private async withReferee(dev: DeviceRow): Promise<boolean> {
    if (!dev.receipt || !dev.receipt_sig) return false;
    const { refereePk } = await this.refereeKeys();
    if (dev.referee_pk) return equal(dev.referee_pk, refereePk);
    if (!receiptSignedBy(refereePk, dev.receipt, dev.receipt_sig)) return false;
    this.d.store.setDeviceRefereePk(dev.account_id, refereePk);
    return true;
  }

  /** Waits until no registration for the account is in flight. */
  private async idle(accountId: string): Promise<void> {
    for (let running = this.inFlight.get(accountId); running; running = this.inFlight.get(accountId)) {
      await running.catch(() => {});
    }
  }

  /** One registration per account at a time: a second caller waits for the first and then goes. */
  private async once(accountId: string, f: () => Promise<void>): Promise<void> {
    // Not `await this.idle()`: the extra await would let two callers both find no one running.
    for (let running = this.inFlight.get(accountId); running; running = this.inFlight.get(accountId)) {
      await running.catch(() => {});
    }
    const p = f().finally(() => this.inFlight.delete(accountId));
    this.inFlight.set(accountId, p);
    return p;
  }

  /**
   * Calls the referee's `enroll` and checks the receipt is signed by the referee the relay runs
   * with now. Re-registering overwrites the referee's record (crates/referee-wasi enroll), so a
   * call that succeeded in the enclave but timed out here is safe to repeat.
   */
  private async callReferee(i: EnrollInput): Promise<RefereeReceipt> {
    const [r, keys] = await Promise.all([this.d.referee.enroll(i), this.refereeKeys()]);
    const signer = r.refereePk ?? keys.refereePk;
    if (!equal(signer, keys.refereePk) || !receiptSignedBy(signer, r.receipt, r.sig)) {
      throw new RefereeError("enroll", "the receipt is not signed by this referee", false);
    }
    return {
      app_attest_pk: r.appAttestPk,
      receipt: r.receipt,
      receipt_sig: r.sig,
      enroll_call_id: r.callId,
      attested: r.attested,
      referee_pk: signer,
    };
  }
}

/** Whether `sig` is the referee `pk`'s signature on this enrolment receipt. */
export function receiptSignedBy(pk: Uint8Array, receipt: Uint8Array, sig: Uint8Array): boolean {
  return verifyEd25519(pk, sha256(concat(utf8(ENROLL_RECEIPT_DOMAIN), receipt)), sig);
}
