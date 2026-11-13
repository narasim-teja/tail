// The referee's box key comes through the relay, which is untrusted, so the phone checks it
// before sealing anything to it: box_pk_sig = ed25519(referee_sk, SHA256("tail/referee-box/v1" ‖
// box_pk)) (crates/referee-wasi/README.md), under the referee key the match pinned on chain.
import { concat, equal, sha256, utf8, verifyEd25519 } from "@tail/protocol";
import type { RefereeKeys } from "./relay";

export const REFEREE_BOX_DOMAIN = "tail/referee-box/v1";

/** Returns the box key if the match's pinned referee key signed it; throws otherwise. */
export function checkedRefereeBox(keys: RefereeKeys, pinnedRefereePk: Uint8Array): Uint8Array {
  if (!equal(keys.refereePk, pinnedRefereePk)) throw new Error("The relay sent another referee's key.");
  const digest = sha256(concat(utf8(REFEREE_BOX_DOMAIN), keys.refereeBoxPk));
  // Strict, as every referee signature the phone checks: the permissive default would take a
  // small-order key's trivial signature for any box key.
  if (!verifyEd25519(pinnedRefereePk, digest, keys.boxPkSig))
    throw new Error("The referee's box key is not signed by the match's referee.");
  return keys.refereeBoxPk;
}
