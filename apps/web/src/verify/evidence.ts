// Re-checks a Tag against the referee's strike rule (TECHNICAL 4.6) from what the log released:
//
//   lock(h→t, e) = |{ e' ∈ (e − WINDOW_EPOCHS, e] : Contact(h, t, e') logged before the Tag }|
//   accepted iff lock ≥ LOCK_EPOCHS, a contact in e or e − 1, and t was h's target
//
// with e the epoch of the hunter's Strike, read from the batch that carried it. This counts the
// referee's Contact entries: it shows the referee followed its own rule over the contacts it
// logged, not that the phones' sightings were genuine (those sit sealed in the batches).

import { EPOCH_MS, LOCK_EPOCHS, WINDOW_EPOCHS } from "@tail/protocol";
import { type Match, type MatchEvent, snapshotBefore } from "../model/match.ts";
import type { DecodedBundle } from "./bundle.ts";
import { batchKey } from "./checks.ts";

export type TagEvidence =
  /** No released batch of the hunter's, logged before the Tag, carries a Strike. */
  | { kind: "no-strike" }
  | {
      kind: "checked";
      /** The strike's epoch. */
      epoch: number;
      /** Contact windows for the pair in (epoch − WINDOW_EPOCHS, epoch]. */
      windows: number;
      /** A contact in the strike's epoch or the one before. */
      touching: boolean;
      /** The target was the hunter's target just before the tag. */
      targetOk: boolean;
      ok: boolean;
    };

/**
 * `inLog` is the set of released batches whose hash the log holds. When the hunter struck more
 * than once in the run up to the tag, the referee took them in time order and the first that
 * met the rule made the Tag, so the same order is used here.
 */
export function tagEvidence(d: DecodedBundle, m: Match, inLog: Set<string>, ev: MatchEvent): TagEvidence {
  const h = ev.a;
  const t = ev.b;
  const tagAt = ev.logIndex;
  const start = d.verdicts.find((x) => x.v?.body.kind === "Start")?.v?.body;
  if (ev.kind !== "tag" || h === undefined || t === undefined || tagAt === null || start?.kind !== "Start")
    return { kind: "no-strike" };
  const startMs = start.startMs;

  // A strike before the hunter's previous tag was spent on that tag.
  const after = m.events
    .filter((e) => e.kind === "tag" && e.a === h && e.logIndex !== null && e.logIndex < tagAt)
    .reduce((x, e) => Math.max(x, e.logIndex as number), -1);
  const batchAt = new Map<string, number>();
  d.log.forEach((e, i) => {
    if (e.entry?.kind === "Batch") batchAt.set(batchKey(e.entry.player, e.entry.seq), i);
  });
  const strikes = d.batches
    .flatMap((x) => (x.batch ? [x.batch] : []))
    .filter((b) => {
      const at = batchAt.get(batchKey(b.player, b.seq));
      return (
        b.player === h &&
        inLog.has(batchKey(b.player, b.seq)) &&
        at !== undefined &&
        at > after &&
        at < tagAt &&
        b.tMs >= startMs &&
        b.actions.some((a) => a.kind === "Strike")
      );
    })
    .sort((x, y) => (x.tMs < y.tMs ? -1 : x.tMs > y.tMs ? 1 : x.seq - y.seq));
  if (strikes.length === 0) return { kind: "no-strike" };

  const [a, b] = h < t ? [h, t] : [t, h];
  const epochs = new Set(
    m.contacts.filter((c) => c.a === a && c.b === b && c.logIndex < tagAt).map((c) => c.epoch),
  );
  const targetOk = snapshotBefore(m, ev).target[h] === t;
  let last: Extract<TagEvidence, { kind: "checked" }> | null = null;
  for (const s of strikes) {
    const epoch = Number((s.tMs - startMs) / BigInt(EPOCH_MS));
    let windows = 0;
    for (const e of epochs) if (e > epoch - WINDOW_EPOCHS && e <= epoch) windows++;
    const touching = epochs.has(epoch) || (epoch > 0 && epochs.has(epoch - 1));
    last = {
      kind: "checked",
      epoch,
      windows,
      touching,
      targetOk,
      ok: windows >= LOCK_EPOCHS && touching && targetOk,
    };
    if (last.ok) return last;
  }
  return last as Extract<TagEvidence, { kind: "checked" }>;
}
