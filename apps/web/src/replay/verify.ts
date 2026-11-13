// Runs the checks in the browser while the film plays: one verdict at a time, the chain read in
// parallel, then NEAR's answer applied verdict by verdict. The checks are spaced out so the marks
// sweep across the timeline during the opening shot; each one is computed at the moment its mark
// appears, and nothing is shown as verified before its own checks have run.

/** Spacing between verdicts, ms: local checks, then NEAR's answer. */
const LOCAL_STEP_MS = 110;
const ANCHOR_STEP_MS = 45;

import { toHex } from "@tail/protocol";
import { bindingOf, type ChainState, type Expect } from "../verify/anchor.ts";
import { type Attestation, fetchAttestation } from "../verify/attestation.ts";
import type { DecodedBundle } from "../verify/bundle.ts";
import type { ChainReader } from "../verify/chain.ts";
import { checkVerdict, type LocalVerdictCheck, localContext } from "../verify/checks.ts";
import { anchoredRoots } from "../verify/history.ts";
import { anchorsFor, historyFor, levelFor } from "../verify/index.ts";
import { PINS, type Pins } from "../verify/pins.ts";
import { statusOf } from "../verify/report.ts";
import { signerOf } from "../verify/signer.ts";
import type { Source } from "./load.ts";
import type { VerifyStore } from "./state.ts";

/** What a replay opened from `source` must be about: the pinned anchor and the linked match. */
export const expectFor = (source: Source, pins: Pins = PINS): Expect => ({
  contract: pins.contract,
  network: pins.network,
  matchId: source.kind === "relay" ? source.matchId : null,
});

export function runVerification(
  d: DecodedBundle,
  store: VerifyStore,
  reader: ChainReader,
  source: Source,
  pins: Pins = PINS,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const n = d.verdicts.length;
  const expect = expectFor(source, pins);
  const binding = bindingOf(d, expect);
  const ctx = localContext(d);
  const local: LocalVerdictCheck[] = [];
  let chain: ChainState | null = null;
  let anchored = 0;
  let anchors: ReturnType<typeof anchorsFor> | null = null;
  store.set({ binding });

  // The contract and the match id come from the pins and the link, never from the bundle.
  void reader.read(expect.contract, expect.matchId ?? d.raw.match.id).then((c) => {
    if (stopped) return;
    chain = c;
    const signer = signerOf(source.kind === "fixture", c, pins);
    store.set({
      chain: c,
      chainSummary: c.kind,
      level: levelFor(d, c, binding),
      signer,
      history: historyFor(d, c, binding),
      anchored: anchoredRoots(d, binding.ok ? c : null),
    });
    if (signer === "enclave" && binding.ok) fetchRecords();
  });
  void reader.token(d.raw.match.token).then((meta) => {
    if (!stopped && meta) store.set({ token: meta });
  });

  // One record per OutLayer call; several verdicts of one tick share it.
  const fetchRecords = () => {
    const byCall = new Map<string, number[]>();
    d.verdicts.forEach((x, i) => {
      if (!x.v) return;
      const k = toHex(x.v.callId);
      byCall.set(k, [...(byCall.get(k) ?? []), i]);
    });
    for (const idx of byCall.values()) {
      const v = d.verdicts[idx[0] as number]?.v;
      if (!v) continue;
      void fetchAttestation(pins.outlayerApi, v.callId, pins.refereeWasmSha256).then((a: Attestation) => {
        if (stopped) return;
        const list = [...store.get().attestations];
        for (const i of idx) list[i] = a;
        store.set({ attestations: list });
      });
    }
  };

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
      anchors ??= anchorsFor(d, ctx, local, chain, binding);
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
