// Player authentication at the relay. A player proves who they are with the NEAR function-call
// key the relay installed on their account at enrolment (the phone keeps it in the Keychain).
// Two shapes, both ed25519 over a SHA-256 digest with its own domain string:
//
//   request:  SHA256("tail/relay-req/v1" ‖ borsh(method) ‖ borsh(path) ‖ u64le(time_ms) ‖ SHA256(body))
//             headers x-tail-account, x-tail-time, x-tail-sig (base64, 64 bytes)
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
} from "@tail/protocol";

export { AuthDomain, challengeDigest, hudDigest, REQUEST_SKEW_MS, replayDigest, requestDigest };

export function verifyEd25519(publicKey: Uint8Array, digest: Uint8Array, sig: Uint8Array): boolean {
  if (publicKey.length !== 32 || sig.length !== 64) return false;
  try {
    return ed25519.verify(sig, digest, publicKey);
  } catch {
    return false;
  }
}

/** Client side (ghosts, tests, and what the phone must do): headers for a signed request. */
export function signRequestHeaders(
  accountId: string,
  secretKey: Uint8Array,
  method: string,
  path: string,
  body: Uint8Array,
  timeMs = Date.now(),
): Record<string, string> {
  const sig = ed25519.sign(requestDigest(method, path, timeMs, body), secretKey);
  return {
    "x-tail-account": accountId,
    "x-tail-time": String(timeMs),
    "x-tail-sig": Buffer.from(sig).toString("base64"),
  };
}
