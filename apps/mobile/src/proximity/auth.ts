// How the phone proves itself to the relay: ed25519 signatures from the NEAR function-call key
// the relay installed on the player's account. The digests come from @tail/protocol, shared with
// the relay.
//
//   request:  SHA256("tail/relay-req/v2" ‖ borsh(contract_id) ‖ borsh(account_id) ‖ borsh(METHOD)
//                    ‖ borsh(path) ‖ u64le(time_ms) ‖ SHA256(body))
//   HUD:      SHA256("tail/hud-auth/v1" ‖ nonce[32] ‖ match_id[16] ‖ borsh(account_id))
//   replay:   SHA256("tail/replay-auth/v1" ‖ nonce[32] ‖ match_id[16] ‖ borsh(account_id))
//
// The request names the contract and the account, so a request carried over the mesh through
// strangers' phones cannot be replayed against another deployment or as another account.

export { AuthDomain, hudDigest, replayDigest, requestDigest } from "@tail/protocol";

/** The player's NEAR key, as far as the relay client needs it. The secret never leaves it. */
export interface Signer {
  readonly accountId: string;
  sign(digest: Uint8Array): Uint8Array;
}
