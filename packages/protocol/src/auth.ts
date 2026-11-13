// How a player proves who they are to the relay: ed25519 signatures from the NEAR function-call
// key the relay installed on their account at enrolment. One implementation, used by the relay
// (verifying) and the phone (signing).
//
//   request:  SHA256("tail/relay-req/v2" ‖ borsh(contract_id) ‖ borsh(account_id) ‖ borsh(METHOD)
//                    ‖ borsh(path) ‖ u64le(time_ms) ‖ SHA256(body))
//             sent as headers x-tail-account, x-tail-time, x-tail-sig (base64, 64 bytes)
//   HUD:      SHA256("tail/hud-auth/v1" ‖ nonce[32] ‖ match_id[16] ‖ borsh(account_id))
//   replay:   SHA256("tail/replay-auth/v1" ‖ nonce[32] ‖ match_id[16] ‖ borsh(account_id))
//
// v2 binds the request to the account and the deployment: a key enrolled for two accounts, or
// on two contracts, cannot have one signature replayed as the other. This matters for mesh
// carry, where a request travels through strangers' phones before it reaches the relay.

import { Writer } from "./borsh.ts";
import { utf8 } from "./bytes.ts";
import { sha256 } from "./crypto.ts";

export const AuthDomain = {
  request: "tail/relay-req/v2",
  hud: "tail/hud-auth/v1",
  replay: "tail/replay-auth/v1",
} as const;

/** A signed request whose time is further than this from the relay's clock is refused. */
export const REQUEST_SKEW_MS = 60_000;

export interface RequestToSign {
  /** The tail contract this relay serves. */
  contractId: string;
  accountId: string;
  /** Case-insensitive; signed upper-case. */
  method: string;
  /** Path and query, as the relay sees them. */
  path: string;
  timeMs: number;
  body: Uint8Array;
}

export function requestDigest(r: RequestToSign): Uint8Array {
  return sha256(
    new Writer()
      .raw(utf8(AuthDomain.request))
      .string(r.contractId)
      .string(r.accountId)
      .string(r.method.toUpperCase())
      .string(r.path)
      .u64(BigInt(r.timeMs))
      .raw(sha256(r.body))
      .bytes(),
  );
}

/** A server challenge answered for one match by one account; the domain names what it opens. */
export function challengeDigest(domain: string, nonce: Uint8Array, matchId: Uint8Array, accountId: string) {
  return sha256(new Writer().raw(utf8(domain)).fixed(nonce, 32).fixed(matchId, 16).string(accountId).bytes());
}

export const hudDigest = (nonce: Uint8Array, matchId: Uint8Array, accountId: string) =>
  challengeDigest(AuthDomain.hud, nonce, matchId, accountId);

export const replayDigest = (nonce: Uint8Array, matchId: Uint8Array, accountId: string) =>
  challengeDigest(AuthDomain.replay, nonce, matchId, accountId);
