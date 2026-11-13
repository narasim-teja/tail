// One call that runs every check on a bundle against a chain state. The page runs the same
// steps one verdict per frame (see useVerification) so marks appear as checks pass.

import {
  type Anchor,
  anchorVerdicts,
  type Binding,
  bindingOf,
  type ChainState,
  type Expect,
  type MatchLevel,
  matchLevel,
} from "./anchor.ts";
import type { DecodedBundle } from "./bundle.ts";
import {
  type BatchCheck,
  checkBatches,
  checkHandler,
  checkVerdict,
  type Enrolment,
  enrolments,
  type HandlerCheck,
  type LocalContext,
  type LocalVerdictCheck,
  localContext,
} from "./checks.ts";
import {
  anchoredRoots,
  type ConsistencyCheck,
  checkConsistency,
  checkVerdictChain,
  type VerdictChainCheck,
} from "./history.ts";
import { statusOf, type VerdictStatus } from "./report.ts";

export interface Verification {
  ctx: LocalContext;
  binding: Binding;
  local: LocalVerdictCheck[];
  anchors: Anchor[];
  statuses: VerdictStatus[];
  batches: BatchCheck;
  handler: Map<number, HandlerCheck>;
  level: MatchLevel | null;
  verdictChain: VerdictChainCheck;
  consistency: ConsistencyCheck;
  enrolled: Enrolment[];
}

/** The history checks against NEAR's view, which counts only for the pinned contract and match. */
export function historyFor(d: DecodedBundle, chain: ChainState, binding: Binding) {
  const usable = binding.ok ? chain : null;
  return {
    verdictChain: checkVerdictChain(d, usable),
    consistency: checkConsistency(d.leaves, anchoredRoots(d, usable)),
  };
}

export function anchorsFor(
  d: DecodedBundle,
  ctx: LocalContext,
  local: LocalVerdictCheck[],
  chain: ChainState,
  binding: Binding,
) {
  return anchorVerdicts(
    d,
    ctx,
    local.map((l, i) => ({ v: d.verdicts[i]?.v ?? null, logIndex: l.logIndex })),
    chain,
    binding,
  );
}

/** The chain's view of the match, when NEAR answered and the bundle is for the pinned anchor. */
export function levelFor(d: DecodedBundle, chain: ChainState, binding: Binding): MatchLevel | null {
  return chain.kind === "found" && binding.ok
    ? matchLevel(
        d,
        chain.match,
        chain.roots,
        d.verdicts.map((x) => x.v),
      )
    : null;
}

export function verifyAll(d: DecodedBundle, chain: ChainState, expect: Expect): Verification {
  const binding = bindingOf(d, expect);
  const ctx = localContext(d);
  const local = d.verdicts.map((_, i) => checkVerdict(d, ctx, i));
  const anchors = anchorsFor(d, ctx, local, chain, binding);
  return {
    ctx,
    binding,
    local,
    anchors,
    statuses: local.map((l, i) => statusOf(l, anchors[i])),
    batches: checkBatches(d),
    handler: checkHandler(d),
    level: levelFor(d, chain, binding),
    ...historyFor(d, chain, binding),
    enrolled: enrolments(d),
  };
}
