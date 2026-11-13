// Enrolment (TECHNICAL.md 4.4, 4.9). The phone asks for a challenge, attests its App Attest key
// over enrollClientDataHash(challenge, account_id, player_box_pk, near_pk), and sends the
// attestation. The relay checks it against Apple's root, creates `<handle>.<relay account>` with
// only a function-call key (the phone's near_pk), registers it, and answers the phone. The referee
// stores the device key in the background: a referee call can take seconds on a good day and
// minutes on a bad one, and a phone should not sit on "Join" for that. Starting a match waits
// until every player's device is with the referee (`ensureWithReferee`), because from then on
// the enclave checks every batch against that key.
//
// Ghosts (simulated phones, README "testing door") skip Apple's attestation, which no simulator
// can produce. That path exists only when the relay was configured with NEAR_NETWORK=testnet and
// ALLOW_GHOSTS=1, and ghost accounts always carry the `ghost-` prefix, on chain and in the
// referee's device record, so no ghost can pass for a phone.

import type { Environment } from "@tail/appattest";
import type { Logger } from "@tail/log";
import { enrollClientDataHash } from "@tail/protocol";
import type { DeviceRow, Store } from "./db.ts";
import { HttpError } from "./errors.ts";
import { AccountTakenError, type Chain } from "./near.ts";
import { type Referee, RefereeError } from "./referee.ts";

export const CHALLENGE_TTL_MS = 5 * 60_000;
/**
 * Waits between background attempts to register a device with the referee. After the last one
 * the device waits for the next start (or relay restart) to try again.
 */
export const REFEREE_RETRY_MS = [0, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000] as const;
export const GHOST_PREFIX = "ghost-";
const HANDLE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

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
  now?: () => number;
  /** Background retry schedule; tests pass [] to register only on demand. */
  refereeRetryMs?: readonly number[];
}

/** What the phone gets back. The referee's receipt is not part of it: it arrives later. */
export interface Enrolled {
  account_id: string;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

export class Enrolment {
  private readonly now: () => number;
  /** One referee registration in flight per account, shared by the retry loop and start. */
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly d: EnrolDeps) {
    this.now = d.now ?? Date.now;
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

  async challenge(handle: string): Promise<{ challenge: string; account_id: string; expires_ms: number }> {
    const accountId = this.accountFor(handle, false);
    this.ensureFree(accountId);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const expires = this.now() + CHALLENGE_TTL_MS;
    this.d.store.putChallenge(challenge, accountId, expires);
    return { challenge: b64(challenge), account_id: accountId, expires_ms: expires };
  }

  async enroll(i: {
    challenge: Uint8Array;
    keyId: Uint8Array;
    attestation: Uint8Array;
    playerBoxPk: Uint8Array;
    nearPk: Uint8Array;
  }): Promise<Enrolled> {
    if (i.challenge.length !== 32 || i.playerBoxPk.length !== 32 || i.nearPk.length !== 32) {
      throw new HttpError(400, "challenge, player_box_pk and near_pk are 32 bytes each");
    }
    const ch = this.d.store.takeChallenge(i.challenge);
    if (!ch || ch.expires_ms < this.now()) throw new HttpError(401, "challenge unknown or expired");
    let appAttestPk: Uint8Array;
    try {
      appAttestPk = await this.d.verifyAttestation({
        attestation: i.attestation,
        keyId: i.keyId,
        clientDataHash: enrollClientDataHash(i.challenge, ch.account_id, i.playerBoxPk, i.nearPk),
        appId: this.d.appId,
        environment: this.d.environment,
      });
    } catch (e) {
      this.d.log.warn({ accountId: ch.account_id, err: (e as Error).message }, "attestation refused");
      throw new HttpError(401, "device attestation failed");
    }
    return this.register(ch.account_id, "phone", appAttestPk, i.playerBoxPk, i.nearPk);
  }

  /** The testing door. The route that calls this exists only when the config allows ghosts. */
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
    return this.register(accountId, "ghost", i.appAttestPk, i.playerBoxPk, i.nearPk);
  }

  private async register(
    accountId: string,
    kind: DeviceRow["kind"],
    appAttestPk: Uint8Array,
    playerBoxPk: Uint8Array,
    nearPk: Uint8Array,
  ): Promise<Enrolled> {
    this.ensureFree(accountId);
    try {
      await this.d.chain.createPlayerAccount(accountId, nearPk);
    } catch (e) {
      if (e instanceof AccountTakenError) throw new HttpError(409, "that handle is taken");
      throw e;
    }
    this.d.store.putDevice({
      account_id: accountId,
      kind,
      app_attest_pk: appAttestPk,
      player_box_pk: playerBoxPk,
      near_pk: nearPk,
      receipt: null,
      receipt_sig: null,
      enroll_call_id: null,
      created_ms: this.now(),
    });
    this.d.log.info({ accountId, kind }, "enrolled; registering with the referee");
    this.retryInBackground(accountId);
    return { account_id: accountId };
  }

  /**
   * Registers each listed device with the referee if it is not yet, and waits for all of them.
   * Throws the referee's error if one cannot be registered now (the caller says so to the user).
   */
  async ensureWithReferee(accountIds: string[]): Promise<void> {
    await Promise.all(
      accountIds
        .filter((a) => this.d.store.device(a)?.receipt === null)
        .map((a) => this.registerWithReferee(a)),
    );
  }

  /** On startup: devices enrolled while the referee was away get their background retries again. */
  resumePending(): void {
    for (const a of this.d.store.devicesAwaitingReferee()) this.retryInBackground(a);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private registerWithReferee(accountId: string): Promise<void> {
    const running = this.inFlight.get(accountId);
    if (running) return running;
    const p = (async () => {
      const dev = this.d.store.device(accountId);
      if (!dev || dev.receipt !== null) return;
      // Re-registering overwrites the referee's record (crates/referee-wasi enroll), so a call
      // that succeeded in the enclave but timed out here is safe to repeat.
      const r = await this.d.referee.enroll({
        accountId,
        appAttestPk: dev.app_attest_pk,
        playerBoxPk: dev.player_box_pk,
        nearPk: dev.near_pk,
      });
      this.d.store.setDeviceReceipt(accountId, {
        app_attest_pk: r.appAttestPk,
        receipt: r.receipt,
        receipt_sig: r.sig,
        enroll_call_id: r.callId,
      });
      this.d.log.info({ accountId }, "registered with the referee");
    })().finally(() => this.inFlight.delete(accountId));
    this.inFlight.set(accountId, p);
    return p;
  }

  private retryInBackground(accountId: string, attempt = 0): void {
    const schedule = this.d.refereeRetryMs ?? REFEREE_RETRY_MS;
    const wait = schedule[attempt];
    if (wait === undefined) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.registerWithReferee(accountId).catch((e: unknown) => {
        const refused = e instanceof RefereeError && e.refused;
        this.d.log.warn({ accountId, attempt, err: (e as Error).message }, "referee registration failed");
        // A refusal is the referee's final answer for this input; repeating it cannot help.
        if (!refused) this.retryInBackground(accountId, attempt + 1);
      });
    }, wait);
    t.unref?.();
    this.timers.add(t);
  }
}
