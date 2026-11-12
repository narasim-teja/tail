// How the phone proves itself to the relay: ed25519 signatures from the NEAR function-call key
// the relay installed on the player's account. These digests mirror apps/relay/src/auth.ts byte
// for byte; test/relay-auth.test.ts checks them against that file.
//
//   request:  SHA256("tail/relay-req/v1" ‖ borsh(method) ‖ borsh(path) ‖ u64le(time_ms) ‖ SHA256(body))
//   HUD:      SHA256("tail/hud-auth/v1" ‖ nonce[32] ‖ match_id[16] ‖ borsh(account_id))

import { sha256, utf8, Writer } from "@tail/protocol";

export const REQUEST_DOMAIN = "tail/relay-req/v1";
export const HUD_DOMAIN = "tail/hud-auth/v1";

export function requestDigest(method: string, path: string, timeMs: number, body: Uint8Array): Uint8Array {
  return sha256(
    new Writer()
      .raw(utf8(REQUEST_DOMAIN))
      .string(method.toUpperCase())
      .string(path)
      .u64(BigInt(timeMs))
      .raw(sha256(body))
      .bytes(),
  );
}

export function hudDigest(nonce: Uint8Array, matchId: Uint8Array, accountId: string): Uint8Array {
  return sha256(
    new Writer().raw(utf8(HUD_DOMAIN)).fixed(nonce, 32).fixed(matchId, 16).string(accountId).bytes(),
  );
}

/** The player's NEAR key, as far as the relay client needs it. The secret never leaves it. */
export interface Signer {
  readonly accountId: string;
  sign(digest: Uint8Array): Uint8Array;
}
