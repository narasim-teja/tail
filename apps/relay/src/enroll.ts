// Enrolment (TECHNICAL.md 4.4, 4.9). The phone asks for a challenge, attests its App Attest key
// over enrollClientDataHash(challenge, account_id, player_box_pk, near_pk), and sends the
// attestation. The relay checks it against Apple's root, creates `<handle>.<relay account>` with
// only a function-call key (the phone's near_pk), registers it, and has the referee store the
// device key. From then on the enclave checks every batch against that key.
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
import type { Referee } from "./referee.ts";

export const CHALLENGE_TTL_MS = 5 * 60_000;
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
}

export interface Enrolled {
  account_id: string;
  app_attest_pk: string;
  enroll_call_id: string;
  receipt: string;
  receipt_sig: string;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

export class Enrolment {
  private readonly now: () => number;

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
    const r = await this.d.referee.enroll({ accountId, appAttestPk, playerBoxPk, nearPk });
    this.d.store.putDevice({
      account_id: accountId,
      kind,
      app_attest_pk: r.appAttestPk,
      player_box_pk: playerBoxPk,
      near_pk: nearPk,
      receipt: r.receipt,
      receipt_sig: r.sig,
      enroll_call_id: r.callId,
      created_ms: this.now(),
    });
    this.d.log.info({ accountId, kind }, "enrolled");
    return {
      account_id: accountId,
      app_attest_pk: b64(r.appAttestPk),
      enroll_call_id: r.callId,
      receipt: b64(r.receipt),
      receipt_sig: b64(r.sig),
    };
  }
}
