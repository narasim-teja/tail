// One call that runs every check on a bundle against a chain state. The page runs the same
// steps one verdict per frame (see useVerification) so marks appear as checks pass.

import { type Anchor, anchorVerdicts, type ChainState, type MatchLevel, matchLevel } from "./anchor.ts";
import type { DecodedBundle } from "./bundle.ts";
import {
  type BatchCheck,
  checkBatches,
  checkHandler,
  checkVerdict,
  type LocalContext,
  type LocalVerdictCheck,
  localContext,
} from "./checks.ts";
import { statusOf, type VerdictStatus } from "./report.ts";

export interface Verification {
  ctx: LocalContext;
  local: LocalVerdictCheck[];
  anchors: Anchor[];
  statuses: VerdictStatus[];
  batches: BatchCheck;
  handler: Map<number, boolean>;
  level: MatchLevel | null;
}

export function anchorsFor(
  d: DecodedBundle,
  ctx: LocalContext,
  local: LocalVerdictCheck[],
  chain: ChainState,
) {
  return anchorVerdicts(
    d,
    ctx,
    local.map((l, i) => ({ v: d.verdicts[i]?.v ?? null, logIndex: l.logIndex })),
    chain,
  );
}

export function verifyAll(d: DecodedBundle, chain: ChainState): Verification {
  const ctx = localContext(d);
  const local = d.verdicts.map((_, i) => checkVerdict(d, ctx, i));
  const anchors = anchorsFor(d, ctx, local, chain);
  return {
    ctx,
    local,
    anchors,
    statuses: local.map((l, i) => statusOf(l, anchors[i])),
    batches: checkBatches(d),
    handler: checkHandler(d),
    level:
      chain.kind === "found"
        ? matchLevel(
            d,
            chain.match,
            d.verdicts.map((x) => x.v),
          )
        : null,
  };
}
