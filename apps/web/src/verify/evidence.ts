// Re-checks a Tag against the referee's strike rule (TECHNICAL 4.6). For a bundle recorded before
// protocol v2 (tagEvidence), from what the log released:
//
//   lock(h→t, e) = |{ e' ∈ (e − WINDOW_EPOCHS, e] : Contact(h, t, e') logged before the Tag }|
//   accepted iff lock ≥ LOCK_EPOCHS, a contact in e or e − 1, and t was h's target
//
// with e the epoch of the hunter's Strike, read from the batch that carried it. This counts the
// referee's Contact entries: it shows the referee followed its own rule over the contacts it
// logged, not that the phones' sightings were genuine (those sit sealed in the batches).

import { EPOCH_MS, LOCK_EPOCHS, merkleProof, merkleVerify, WINDOW_EPOCHS } from "@tail/protocol";
import { type Match, type MatchEvent, snapshotBefore } from "../model/match.ts";
import type { DecodedBundle } from "./bundle.ts";
import { batchKey } from "./checks.ts";
import type { AnchoredRoot } from "./history.ts";

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

// ── Protocol v2: the Evidence entry the referee logged for the Tag ───────────────────
//
// Just before a Tag's Verdict entry the referee writes Evidence { hunter, target, strike_seq,
// strike_epoch, epochs }: the strike it judged and the contact epochs it counted. That entry is
// under the same anchored roots as the Tag, so the rule can be re-checked from the log alone,
// trails or not:
//
//   every cited epoch in (e − WINDOW_EPOCHS, e], at least LOCK_EPOCHS of them, one in e or e − 1,
//   none before the hunter was assigned this target (lock_from: 0 at the start, else the epoch
//   after the tick in which the hunter last took a head), and each a Contact entry for the pair
//   logged before the Tag.
//
// The tick's epoch comes from the Tick entry that opens it. Each cited Contact entry also has an
// inclusion path to a root NEAR anchored (inclusionOf), which the contract can check itself.

export type EvidenceCheck =
  /** Recorded before protocol v2: no Evidence entries. */
  | { kind: "v1" }
  /** A v2 Tag without its Evidence entry just before it. */
  | { kind: "missing" }
  | {
      kind: "checked";
      entryIndex: number;
      strikeSeq: number;
      strikeEpoch: number;
      epochs: number[];
      /** Its hunter and target are the Tag's. */
      sameTag: boolean;
      /** Every cited epoch is in (e − WINDOW_EPOCHS, e], none repeated. */
      inWindow: boolean;
      /** Distinct cited epochs in the window. */
      count: number;
      /** A cited epoch is e or e − 1. */
      touching: boolean;
      /** First epoch that counts toward this target; null if the log can't place it. */
      lockFrom: number | null;
      /** No cited epoch is before lockFrom; null when lockFrom is unknown. */
      afterAssigned: boolean | null;
      /** Each cited epoch's Contact entry for the pair, logged before the Tag, or null. */
      contacts: { epoch: number; logIndex: number | null }[];
      /** The released strike batch agrees (seq has a Strike in that epoch), or wasn't released. */
      strike: "match" | "differs" | "not-released";
      /** The target was the hunter's target just before the tag. */
      targetOk: boolean;
      ok: boolean;
    };

export function evidenceCheck(d: DecodedBundle, m: Match, inLog: Set<string>, ev: MatchEvent): EvidenceCheck {
  if (d.version === 1) return { kind: "v1" };
  const h = ev.a;
  const t = ev.b;
  const at = ev.logIndex;
  const start = d.verdicts.find((x) => x.v?.body.kind === "Start")?.v?.body;
  if (ev.kind !== "tag" || h === undefined || t === undefined || at === null || start?.kind !== "Start")
    return { kind: "missing" };
  const e = d.log[at - 1]?.entry;
  if (e?.kind !== "Evidence") return { kind: "missing" };
  const startMs = start.startMs;
  const strikeEpoch = e.strikeEpoch;
  const distinct = new Set(e.epochs);
  const inWindow =
    distinct.size === e.epochs.length &&
    e.epochs.every((x) => x > strikeEpoch - WINDOW_EPOCHS && x <= strikeEpoch);
  const touching = distinct.has(strikeEpoch) || (strikeEpoch > 0 && distinct.has(strikeEpoch - 1));
  const lockFrom = lockFromAt(d, m, h, ev, startMs);
  const afterAssigned = lockFrom === null ? null : e.epochs.every((x) => x >= lockFrom);

  const [a, b] = h < t ? [h, t] : [t, h];
  const contactAt = new Map<number, number>();
  for (let i = 0; i < at; i++) {
    const c = d.log[i]?.entry;
    if (c?.kind === "Contact" && c.a === a && c.b === b && !contactAt.has(c.epoch)) contactAt.set(c.epoch, i);
  }
  const contacts = e.epochs.map((epoch) => ({ epoch, logIndex: contactAt.get(epoch) ?? null }));

  const batch = d.batches.find((x) => x.batch?.player === h && x.batch.seq === e.strikeSeq)?.batch;
  const strike: "match" | "differs" | "not-released" =
    !batch || !inLog.has(batchKey(batch.player, batch.seq))
      ? "not-released"
      : batch.actions.some((x) => x.kind === "Strike") &&
          Number((batch.tMs - startMs) / BigInt(EPOCH_MS)) === strikeEpoch
        ? "match"
        : "differs";
  const targetOk = snapshotBefore(m, ev).target[h] === t;
  const sameTag = e.hunter === h && e.target === t;
  return {
    kind: "checked",
    entryIndex: at - 1,
    strikeSeq: e.strikeSeq,
    strikeEpoch,
    epochs: e.epochs,
    sameTag,
    inWindow,
    count: distinct.size,
    touching,
    lockFrom,
    afterAssigned,
    contacts,
    strike,
    targetOk,
    ok:
      sameTag &&
      inWindow &&
      distinct.size >= LOCK_EPOCHS &&
      touching &&
      afterAssigned === true &&
      contacts.every((c) => c.logIndex !== null) &&
      strike !== "differs" &&
      targetOk,
  };
}

/**
 * lock_from for hunter h at the tag `ev`: 0 if h never took a head before it, else the epoch after
 * the tick in which h last did (the referee resets it on every head h takes). That tick's time is
 * the Tick entry that opens it; null when the log has none before that verdict.
 */
function lockFromAt(d: DecodedBundle, m: Match, h: number, ev: MatchEvent, startMs: bigint): number | null {
  const won = m.events.filter(
    (x) =>
      x.index < ev.index &&
      ((x.kind === "tag" && x.a === h) || (x.kind === "forfeit" && x.b === h)) &&
      x.logIndex !== null,
  );
  const last = won.at(-1);
  if (!last) return 0;
  for (let i = (last.logIndex as number) - 1; i >= 0; i--) {
    const x = d.log[i]?.entry;
    if (x?.kind === "Tick") return Number((x.nowMs - startMs) / BigInt(EPOCH_MS)) + 1;
  }
  return null;
}

/** An entry's Merkle inclusion path to the first anchored root that covers it. */
export interface Inclusion {
  index: number;
  size: number;
  root: Uint8Array;
  path: Uint8Array[];
  /** merkleVerify(leaf, index, size, path, root) in this browser. */
  ok: boolean;
}

export function inclusionOf(
  d: DecodedBundle,
  index: number,
  roots: readonly AnchoredRoot[],
): Inclusion | null {
  const anchor = roots.find((r) => r.size > index && r.size <= d.leaves.length);
  const leaf = d.leaves[index];
  if (!anchor || !leaf) return null;
  const path = merkleProof(d.leaves.slice(0, anchor.size), index);
  return {
    index,
    size: anchor.size,
    root: anchor.root,
    path,
    ok: merkleVerify(leaf, index, anchor.size, path, anchor.root),
  };
}
