// Turns a decoded bundle into what the film plays: players, events in time, heads and targets
// after each event, contacts, and per-player tracks from batches whose hash the log holds.
//
// The log has no clock of its own, so event times are reconstructed from its order: batch
// entries carry their batch's time (when trails were released), contacts their epoch, the k-th
// checkpoint its minute, and everything between is placed by position in the log.
//
// Heads move as the contract moves them (verify/settle.ts): in protocol v2 a hint's price leaves
// the asker for the hint pool, a Tag or Forfeit first credits the loser with the hints paid onto
// them, and End credits each survivor what the pool still owes them, or refunds every stake if
// the contract's replay finds a broken rule. Whom a v2 hint was about is known only from End.

import { CHECKPOINT_MS, EPOCH_MS, ringOrder, WINDOW_EPOCHS } from "@tail/protocol";
import { displayNames, initialsFor } from "../lib/names.ts";
import type { AnyVerdict, DecodedBundle } from "../verify/bundle.ts";
import { batchKey, enrolments, type HandlerCheck } from "../verify/checks.ts";
import { applyPlay, type Settlement, settlementOf, startLedger } from "../verify/settle.ts";

export { displayName, displayNames, initialsFor } from "../lib/names.ts";

export interface PlayerInfo {
  index: number;
  account: string;
  name: string;
  initials: string;
  /**
   * From the log's Enrolled entry: whether the referee checked this phone's Apple attestation.
   * false: a test player taken without one; null: not recorded (before protocol v2).
   */
  attested: boolean | null;
}

export type EventKind = "start" | "hint" | "tag" | "forfeit" | "checkpoint" | "end";

export interface MatchEvent {
  /** Position in the bundle's verdict list (also the id for verification status). */
  index: number;
  seq: number;
  kind: EventKind;
  /** ms after the start. */
  t: number;
  logIndex: number | null;
  /**
   * tag: hunter → target; forfeit: player → to (the hunter); hint: from → whom it was about (v2:
   * from End's hint targets, absent without them; v1: the target the verdict named and paid).
   */
  a?: number;
  b?: number;
  amount?: bigint;
  /** tag, forfeit (v2): hints paid onto the loser, credited to their head before it moved. */
  credit?: bigint;
  hintId?: number;
  hintKind?: number;
  question?: string;
  /**
   * text: the quoted words, null when sealed to the asker (protocol v2); verified: the quote is
   * the line the log committed to (null without a quote); signature: see HandlerCheck.
   */
  handler?: {
    text: string | null;
    model: string | null;
    verified: boolean | null;
    signature: HandlerCheck | null;
  };
  /** forfeit: whether the last fix was outside the zone. */
  leftZone?: boolean;
  callId: Uint8Array;
}

export interface Snapshot {
  t: number;
  heads: bigint[];
  alive: boolean[];
  /** Current target of each player, -1 if none or unknown. */
  target: number[];
  /** Hint money paid in and not yet credited to anyone (v2; 0 for v1). */
  pool: bigint;
}

export interface Contact {
  a: number;
  b: number;
  epoch: number;
  /** The epoch's midpoint, ms after start. */
  t: number;
  logIndex: number;
}

export interface Track {
  t: Float64Array;
  lon: Float64Array;
  lat: Float64Array;
}

export interface Match {
  id: string;
  startMs: number;
  /** How long it ran: to the referee's last tick at End (playedMs), what the film plays. */
  durationMs: number;
  /** How long it was set to run (the match's end_ms); longer than durationMs if it ended early. */
  plannedMs: number;
  stake: bigint;
  token: string;
  network: string;
  contract: string;
  players: PlayerInfo[];
  events: MatchEvent[];
  /** snapshots[0] is the start; one more after each tag, forfeit, hint and the end. */
  snapshots: Snapshot[];
  contacts: Contact[];
  tracks: (Track | null)[];
  hasTrails: boolean;
  zone: { lon: number; lat: number; radiusM: number };
  safehouses: { lon: number; lat: number; radiusM: number }[];
  /** Hunting order from the revealed VRF, empty if the End verdict is missing. */
  ring: number[];
  /** The contract's End replay of the match: payout, refund, or why it wasn't run. */
  settlement: Settlement;
}

// ── Build ────────────────────────────────────────────────────────────────────────

const KINDS: Record<AnyVerdict["kind"], EventKind> = {
  Start: "start",
  Hint: "hint",
  Tag: "tag",
  Forfeit: "forfeit",
  Checkpoint: "checkpoint",
  End: "end",
};

export function buildMatch(
  d: DecodedBundle,
  /** Batches whose hash the log holds (BatchCheck.inLog). */
  loggedBatches: Set<string>,
  handlerChecks: Map<number, HandlerCheck>,
): Match {
  const m = d.raw.match;
  const startMs = m.startMs;
  const plannedMs = m.endMs - m.startMs;
  const verdictLog = new Map<number, number>();
  d.log.forEach((e, i) => {
    if (e.entry?.kind === "Verdict" && !verdictLog.has(e.entry.seq)) verdictLog.set(e.entry.seq, i);
  });
  const durationMs = playedMs(d, verdictLog, startMs, plannedMs);
  const names = displayNames(d.players);
  const initials = initialsFor(names);
  const enrolled = enrolments(d);
  const players = d.players.map((account, index) => ({
    index,
    account,
    name: names[index] as string,
    initials: initials[index] as string,
    attested: enrolled[index]?.attested ?? null,
  }));

  // Tracks only from batches whose hash the log holds.
  const fixes: { t: number; lon: number; lat: number }[][] = d.players.map(() => []);
  const batchTime = new Map<string, number>();
  const hintAction = new Map<string, string>(); // "player:nth hint" → question text
  const hintCount = d.players.map(() => 0);
  const sortedBatches = d.batches
    .filter((x) => x.batch && loggedBatches.has(batchKey(x.batch.player, x.batch.seq)))
    .map((x) => x.batch as NonNullable<typeof x.batch>)
    .sort((a, b) => a.player - b.player || a.seq - b.seq);
  for (const b of sortedBatches) {
    batchTime.set(batchKey(b.player, b.seq), Number(b.tMs) - startMs);
    for (const f of b.fixes)
      fixes[b.player]?.push({ t: Number(f.tMs) - startMs, lon: f.lonE7 / 1e7, lat: f.latE7 / 1e7 });
  }
  const tracks = fixes.map((fs): Track | null => {
    if (fs.length < 2) return null;
    fs.sort((a, b) => a.t - b.t);
    return {
      t: Float64Array.from(fs, (f) => f.t),
      lon: Float64Array.from(fs, (f) => f.lon),
      lat: Float64Array.from(fs, (f) => f.lat),
    };
  });

  // Log-order times.
  const anchorT: (number | null)[] = d.log.map(() => null);
  const contacts: Contact[] = [];
  d.log.forEach((e, i) => {
    const en = e.entry;
    if (en?.kind === "Batch") {
      const t = batchTime.get(batchKey(en.player, en.seq));
      if (t !== undefined) anchorT[i] = t;
    } else if (en?.kind === "Contact") {
      anchorT[i] = (en.epoch + 1) * EPOCH_MS;
      contacts.push({
        a: en.a,
        b: en.b,
        epoch: en.epoch,
        t: en.epoch * EPOCH_MS + EPOCH_MS / 2,
        logIndex: i,
      });
    }
  });
  let checkpointNo = 0;
  for (const x of d.verdicts) {
    const v = x.v;
    if (!v) continue;
    const li = verdictLog.get(v.seq);
    if (li === undefined) continue;
    if (v.body.kind === "Start") anchorT[li] = 0;
    else if (v.body.kind === "Checkpoint") anchorT[li] = ++checkpointNo * CHECKPOINT_MS;
    else if (v.body.kind === "End") anchorT[li] = durationMs;
  }
  const timeAt = logClock(anchorT, durationMs);

  // Hint questions, in order per player, from the logged batches' actions.
  for (const b of sortedBatches)
    for (const a of b.actions)
      if (a.kind === "Hint") {
        const n = hintCount[b.player] ?? 0;
        hintCount[b.player] = n + 1;
        if (a.text) hintAction.set(`${b.player}:${n}`, a.text);
      }
  const hintsAsked = d.players.map(() => 0);

  // Events and snapshots.
  const endBody = d.verdicts.find((x) => x.v?.body.kind === "End")?.v?.body;
  const ring = endBody?.kind === "End" ? ringOrder(d.players, endBody.vrfSignature) : [];
  // v2: whom the k-th hint was about, revealed by End; v1 hints name it themselves.
  const hintTargets = endBody?.kind === "End" && "hintTargets" in endBody ? endBody.hintTargets : [];
  let hintNo = 0;
  const settlement = settlementOf(d);
  const target = d.players.map(() => -1);
  ring.forEach((p, k) => {
    target[p] = ring[(k + 1) % ring.length] as number;
  });
  const ledger = startLedger(d.players.length, d.stake);
  const snap0: Snapshot = {
    t: 0,
    heads: [...ledger.heads],
    alive: d.players.map(() => true),
    target,
    pool: 0n,
  };
  const snapshots: Snapshot[] = [snap0];
  const events: MatchEvent[] = [];
  let prevT = 0;
  d.verdicts.forEach((x) => {
    const v = x.v;
    if (!v) return;
    const li = verdictLog.get(v.seq) ?? null;
    // A verdict missing from the log keeps its place after the one before it.
    const t = Math.max(prevT, li === null ? prevT : timeAt(li));
    prevT = t;
    const ev: MatchEvent = {
      index: x.index,
      seq: v.seq,
      kind: KINDS[v.body.kind],
      t,
      logIndex: li,
      callId: v.callId,
    };
    const last = snapshots[snapshots.length - 1] as Snapshot;
    const b = v.body;
    applyPlay(ledger, b);
    const next = (): Snapshot => ({
      t,
      heads: [...ledger.heads],
      alive: ledger.out.map((o) => !o),
      target: [...last.target],
      pool: ledger.pool,
    });
    if (b.kind === "Hint") {
      const about = "to" in b ? b.to : hintTargets[hintNo];
      hintNo++;
      Object.assign(ev, { a: b.from, amount: b.amount, hintId: b.hintId });
      if (about !== undefined) ev.b = about;
      const n = hintsAsked[b.from] ?? 0;
      hintsAsked[b.from] = n + 1;
      const q = hintAction.get(`${b.from}:${n}`);
      if (q) ev.question = q;
      const line = d.handler.find((h) => h.hintId === b.hintId);
      if (line) {
        const check = handlerChecks.get(b.hintId) ?? null;
        ev.handler = {
          text: line.text,
          model: line.model ?? check?.model ?? null,
          verified: line.text === null ? null : check?.text === true,
          signature: check,
        };
      }
      snapshots.push(next());
    } else if (b.kind === "Tag" || b.kind === "Forfeit") {
      const [loser, winner] = b.kind === "Tag" ? [b.target, b.hunter] : [b.player, b.to];
      ev.a = winner;
      ev.b = loser;
      if ("credit" in b) ev.credit = b.credit;
      if (b.kind === "Forfeit") {
        ev.a = loser;
        ev.b = winner;
        const tr = tracks[loser];
        if (tr && tr.t.length > 0) {
          const k = tr.t.length - 1;
          ev.leftZone =
            metres(tr.lon[k] as number, tr.lat[k] as number, m.zone.lonE7 / 1e7, m.zone.latE7 / 1e7) >
            m.zone.radiusM;
        }
      }
      const s = next();
      const inherited = s.target[loser] ?? -1;
      s.target[winner] = inherited === winner ? -1 : inherited;
      s.target[loser] = -1;
      snapshots.push(s);
    } else if (b.kind === "End") {
      // Settlement: the pool's debts go onto the survivors' heads, or every stake is refunded.
      const s = next();
      if (settlement.kind === "payout")
        s.heads = s.heads.map((h, i) => (s.alive[i] ? h + (settlement.owed[i] ?? 0n) : h));
      if (settlement.kind === "refunded") s.heads = s.heads.map(() => d.stake);
      if (settlement.kind === "payout" || settlement.kind === "refunded") s.pool = 0n;
      snapshots.push(s);
    }
    events.push(ev);
  });

  return {
    id: m.id,
    startMs,
    durationMs,
    plannedMs,
    stake: d.stake,
    token: m.token,
    network: m.network,
    contract: m.contract,
    players,
    events,
    snapshots,
    contacts,
    tracks,
    hasTrails: tracks.some(Boolean),
    zone: { lon: m.zone.lonE7 / 1e7, lat: m.zone.latE7 / 1e7, radiusM: m.zone.radiusM },
    safehouses: m.safehouses.map((s) => ({ lon: s.lonE7 / 1e7, lat: s.latE7 / 1e7, radiusM: s.radiusM })),
    ring,
    settlement,
  };
}

/**
 * How long the match ran, ms: to the referee's last tick at or before End, whose Tick entry
 * carries the referee's own clock, so a match that ended early (one player left) ends there and
 * not at the planned end. Clamped to the planned end, as the referee clamps its clock (its last
 * tick may run a little past it). A log without ticks (protocol v1) has only the plan.
 */
function playedMs(
  d: DecodedBundle,
  verdictLog: Map<number, number>,
  startMs: number,
  plannedMs: number,
): number {
  const end = d.verdicts.find((x) => x.v?.body.kind === "End")?.v;
  const upTo = (end && verdictLog.get(end.seq)) ?? d.log.length;
  for (let i = upTo - 1; i >= 0; i--) {
    const e = d.log[i]?.entry;
    if (e?.kind === "Tick") return Math.min(plannedMs, Math.max(0, Number(e.nowMs) - startMs));
  }
  return plannedMs;
}

/** Time of each log index: anchors made monotone, linear by index between them. */
export function logClock(anchors: (number | null)[], durationMs: number): (i: number) => number {
  const idx: number[] = [];
  const ts: number[] = [];
  let run = 0;
  anchors.forEach((t, i) => {
    if (t === null) return;
    run = Math.max(run, Math.min(t, durationMs));
    idx.push(i);
    ts.push(run);
  });
  return (i: number) => {
    if (idx.length === 0) return 0;
    let lo = 0;
    let hi = idx.length - 1;
    if (i <= (idx[0] as number)) return ts[0] as number;
    if (i >= (idx[hi] as number)) return ts[hi] as number;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((idx[mid] as number) <= i) lo = mid;
      else hi = mid;
    }
    const i0 = idx[lo] as number;
    const i1 = idx[hi] as number;
    const t0 = ts[lo] as number;
    const t1 = ts[hi] as number;
    return t0 + ((t1 - t0) * (i - i0)) / (i1 - i0);
  };
}

// ── Queries the film makes every frame ─────────────────────────────────────────────

export function snapshotAt(m: Match, t: number): Snapshot {
  let s = m.snapshots[0] as Snapshot;
  for (const x of m.snapshots) {
    if (x.t <= t) s = x;
    else break;
  }
  return s;
}

/** Heads, targets and who is alive just before an event (snapshots advance per hint, tag, forfeit, end). */
export function snapshotBefore(m: Match, ev: MatchEvent): Snapshot {
  const k = m.events.filter(
    (e) =>
      e.index < ev.index &&
      (e.kind === "hint" || e.kind === "tag" || e.kind === "forfeit" || e.kind === "end"),
  ).length;
  return m.snapshots[k] ?? (m.snapshots[0] as Snapshot);
}

/** Contact epochs between hunter and target in the lock window ending at time t. */
export function lockAt(m: Match, h: number, tg: number, t: number): number {
  const e = Math.floor(t / EPOCH_MS);
  const [a, b] = h < tg ? [h, tg] : [tg, h];
  let n = 0;
  for (const c of m.contacts)
    if (c.a === a && c.b === b && c.epoch <= e && c.epoch > e - WINDOW_EPOCHS && c.t <= t) n++;
  return n;
}

/** Longest gap between fixes still drawn as walking; beyond it the player is dark. */
export const GAP_MS = 20_000;

/** Interpolated [lon, lat] at time t, or null outside the track or inside a gap. */
export function positionAt(tr: Track | null, t: number): [number, number] | null {
  if (!tr) return null;
  const n = tr.t.length;
  if (n === 0 || t < (tr.t[0] as number) - 2_000 || t > (tr.t[n - 1] as number) + 6_000) return null;
  let lo = 0;
  let hi = n - 1;
  if (t <= (tr.t[0] as number)) return [tr.lon[0] as number, tr.lat[0] as number];
  if (t >= (tr.t[hi] as number)) return [tr.lon[hi] as number, tr.lat[hi] as number];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((tr.t[mid] as number) <= t) lo = mid;
    else hi = mid;
  }
  const t0 = tr.t[lo] as number;
  const t1 = tr.t[hi] as number;
  if (t1 - t0 > GAP_MS) return null;
  const f = (t - t0) / (t1 - t0);
  return [
    (tr.lon[lo] as number) + ((tr.lon[hi] as number) - (tr.lon[lo] as number)) * f,
    (tr.lat[lo] as number) + ((tr.lat[hi] as number) - (tr.lat[lo] as number)) * f,
  ];
}

/** Last known [lon, lat] at or before t. */
export function lastKnown(tr: Track | null, t: number): [number, number] | null {
  if (!tr || tr.t.length === 0 || t < (tr.t[0] as number)) return null;
  let i = tr.t.length - 1;
  while (i > 0 && (tr.t[i] as number) > t) i--;
  return [tr.lon[i] as number, tr.lat[i] as number];
}

export function metres(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const r = 6_371_008.8;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

/** Metres walked from verified fixes (jumps over a gap are not counted). */
export function walked(tr: Track | null, until = Number.POSITIVE_INFINITY): number {
  if (!tr) return 0;
  let d = 0;
  for (let i = 1; i < tr.t.length && (tr.t[i] as number) <= until; i++) {
    if ((tr.t[i] as number) - (tr.t[i - 1] as number) > GAP_MS) continue;
    d += metres(tr.lon[i - 1] as number, tr.lat[i - 1] as number, tr.lon[i] as number, tr.lat[i] as number);
  }
  return d;
}
