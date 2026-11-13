// Which referee signed this match, decided from the verdict key NEAR pinned for it (never from the
// bundle's say-so) against the keys pinned in pins.ts.
//
//   enclave: the OutLayer referee project's key. The key alone does not prove the code (it
//            survives new versions), so a verdict is called the enclave's only once its
//            attestation record checks out (attestation.ts).
//   local:   the local test referee: the same code, run on the relay's machine.
//   fixture: the page's own generated fixture, signed with a public test key.
//   unknown: NEAR named a key this page does not know.
//   unread:  NEAR has no such match, or couldn't be reached, so no key was read at all.

import type { ChainState } from "./anchor.ts";
import type { Pins } from "./pins.ts";

export type Signer = "enclave" | "local" | "fixture" | "unknown" | "unread";

export function signerOf(fixture: boolean, chain: ChainState | null, pins: Pins): Signer {
  if (fixture) return "fixture";
  if (chain?.kind !== "found") return "unread";
  const pk = chain.match.referee_pk.toLowerCase();
  if (pins.enclaveRefereePks.includes(pk)) return "enclave";
  if (pins.localRefereePks.includes(pk)) return "local";
  return "unknown";
}
