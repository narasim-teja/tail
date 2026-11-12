// The referee's box key comes through the relay, which is untrusted, so the phone checks it
// before sealing anything to it: box_pk_sig = ed25519(referee_sk, SHA256("tail/referee-box/v1" ‖
// box_pk)) (crates/referee-wasi/README.md), under the referee key the match pinned on chain.
import { ed25519 } from "@noble/curves/ed25519.js";
import { concat, equal, sha256, utf8 } from "@tail/protocol";
import type { RefereeKeys } from "./client";

export const REFEREE_BOX_DOMAIN = "tail/referee-box/v1";

/** Returns the box key if the match's pinned referee key signed it; throws otherwise. */
export function checkedRefereeBox(keys: RefereeKeys, pinnedRefereePk: Uint8Array): Uint8Array {
  if (!equal(keys.refereePk, pinnedRefereePk)) throw new Error("The relay sent another referee's key.");
  const digest = sha256(concat(utf8(REFEREE_BOX_DOMAIN), keys.refereeBoxPk));
  let ok = false;
  try {
    ok = ed25519.verify(keys.boxPkSig, digest, pinnedRefereePk);
  } catch {
    ok = false;
  }
  if (!ok) throw new Error("The referee's box key is not signed by the match's referee.");
  return keys.refereeBoxPk;
}
