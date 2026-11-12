// Runs the checks in the browser while the film plays: one verdict at a time, the chain read in
// parallel, then NEAR's answer applied verdict by verdict. The checks are spaced out so the marks
// sweep across the timeline during the opening shot; each one is computed at the moment its mark
// appears, and nothing is shown as verified before its own checks have run.

/** Spacing between verdicts, ms: local checks, then NEAR's answer. */
const LOCAL_STEP_MS = 110;
const ANCHOR_STEP_MS = 45;

import type { ChainState } from "../verify/anchor.ts";
import { matchLevel } from "../verify/anchor.ts";
import type { DecodedBundle } from "../verify/bundle.ts";
import type { ChainReader } from "../verify/chain.ts";
import { checkVerdict, type LocalVerdictCheck, localContext } from "../verify/checks.ts";
import { anchorsFor } from "../verify/index.ts";
import { statusOf } from "../verify/report.ts";
import type { VerifyStore } from "./state.ts";

export function runVerification(d: DecodedBundle, store: VerifyStore, reader: ChainReader): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const n = d.verdicts.length;
  const ctx = localContext(d);
  const local: LocalVerdictCheck[] = [];
  let chain: ChainState | null = null;
  let anchored = 0;
  let anchors: ReturnType<typeof anchorsFor> | null = null;

  void reader.read(d.raw.match.contract, d.raw.match.id).then((c) => {
    if (stopped) return;
    chain = c;
    store.set({
      chain: c,
      chainSummary: c.kind,
      level:
        c.kind === "found"
          ? matchLevel(
              d,
              c.match,
              d.verdicts.map((x) => x.v),
            )
          : null,
    });
  });
  void reader.token(d.raw.match.token).then((meta) => {
    if (!stopped && meta) store.set({ token: meta });
  });

  const step = () => {
    if (stopped) return;
    const s = store.get();
    if (local.length < n) {
      const i = local.length;
      const l = checkVerdict(d, ctx, i);
      local.push(l);
      const loc = [...s.local];
      loc[i] = l;
      const statuses = [...s.statuses];
      statuses[i] = statusOf(l, undefined) === "mismatch" ? "mismatch" : "pending";
      store.set({ local: loc, statuses, progress: 0.4 + (0.3 * local.length) / n });
    } else if (chain) {
      anchors ??= anchorsFor(d, ctx, local, chain);
      const i = anchored++;
      const a = [...s.anchors];
      a[i] = anchors[i];
      const statuses = [...s.statuses];
      statuses[i] = statusOf(local[i], anchors[i]);
      store.set({ anchors: a, statuses, progress: anchored >= n ? 1 : 0.7 + (0.3 * anchored) / n });
      if (anchored >= n) return;
    }
    timer = setTimeout(step, local.length < n ? LOCAL_STEP_MS : ANCHOR_STEP_MS);
  };
  timer = setTimeout(step, LOCAL_STEP_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
