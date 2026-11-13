// Player authentication at the relay. A player proves who they are with the NEAR function-call
// key the relay installed on their account at enrolment (the phone keeps it in the Keychain).
// Two shapes, both ed25519 over a SHA-256 digest with its own domain string:
//
//   request:  SHA256("tail/relay-req/v2" ‖ borsh(contract_id) ‖ borsh(account_id) ‖ borsh(METHOD)
//                    ‖ borsh(path) ‖ u64le(time_ms) ‖ SHA256(body))
//             headers x-tail-account, x-tail-time, x-tail-sig (base64, 64 bytes); contract_id is
//             the contract this relay serves (GET /health `contract`)
//   HUD:      SHA256("tail/hud-auth/v1" ‖ nonce[32] ‖ match_id[16] ‖ borsh(account_id))
//   replay:   SHA256("tail/replay-auth/v1" ‖ nonce[32] ‖ match_id[16] ‖ borsh(account_id))
//
// Signed requests stop anyone else from filling a player's batch queue, opening matches on the
// relay's NEAR, or starting a lobby they do not host. The HUD challenge stops anyone else from
// subscribing to a player's sealed HUD stream (sealed, but its timing alone would leak activity).

import { ed25519 } from "@noble/curves/ed25519.js";

import {
  AuthDomain,
  challengeDigest,
  hudDigest,
  REQUEST_SKEW_MS,
  replayDigest,
  requestDigest,
  verifyEd25519,
} from "@tail/protocol";

// The protocol's strict check (RFC 8032, as the referee's verify_strict), not noble's default
// ZIP 215 rules, which accept a small-order key with a signature that holds for any message.
export {
  AuthDomain,
  challengeDigest,
  hudDigest,
  REQUEST_SKEW_MS,
  replayDigest,
  requestDigest,
  verifyEd25519,
};

/** A signed request as the phone sends it, directly or inside a mesh carry envelope. */
export interface SignedRequest {
  contractId: string;
  accountId: string;
  method: string;
  path: string;
  body: Uint8Array;
  timeMs?: number;
}

export function signRequest(r: SignedRequest, secretKey: Uint8Array): { timeMs: number; sig: Uint8Array } {
  const timeMs = r.timeMs ?? Date.now();
  return { timeMs, sig: ed25519.sign(requestDigest({ ...r, timeMs }), secretKey) };
}

/** Client side (ghosts, tests, and what the phone must do): headers for a signed request. */
export function signRequestHeaders(r: SignedRequest, secretKey: Uint8Array): Record<string, string> {
  const { timeMs, sig } = signRequest(r, secretKey);
  return {
    "x-tail-account": r.accountId,
    "x-tail-time": String(timeMs),
    "x-tail-sig": Buffer.from(sig).toString("base64"),
  };
}
