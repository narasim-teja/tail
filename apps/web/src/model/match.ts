// Turns a decoded bundle into what the film plays: players, events in time, heads and targets
// after each event, contacts, and per-player tracks from batches whose hash the log holds.
//
// The log has no clock of its own, so event times are reconstructed from its order: batch
// entries carry their batch's time (when trails were released), contacts their epoch, the k-th
// checkpoint its minute, and everything between is placed by position in the log.

import { buildRing, EPOCH_MS, type SignedVerdict, WINDOW_EPOCHS } from "@tail/protocol";
import type { DecodedBundle } from "../verify/bundle.ts";
import { batchKey, type HandlerCheck } from "../verify/checks.ts";

export interface PlayerInfo {
  index: number;
  account: string;
  name: string;
  initials: string;
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
  /** tag: hunter → target; forfeit: player → to (the hunter); hint: from → to. */
  a?: number;
  b?: number;
  amount?: bigint;
  hintId?: number;
  hintKind?: number;
  question?: string;
  /** verified: the quote is the line the log committed to; signature: see HandlerCheck. */
  handler?: { text: string; model: string; verified: boolean; signature: HandlerCheck | null };
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
  durationMs: number;
  stake: bigint;
  token: string;
  network: string;
  contract: string;
  players: PlayerInfo[];
  events: MatchEvent[];
  /** snapshots[0] is the start; one more after each tag, forfeit and hint. */
  snapshots: Snapshot[];
  contacts: Contact[];
  tracks: (Track | null)[];
  hasTrails: boolean;
  zone: { lon: number; lat: number; radiusM: number };
  safehouses: { lon: number; lat: number; radiusM: number }[];
  /** Hunting order from the revealed VRF, empty if the End verdict is missing. */
  ring: number[];
}

// ── Names ────────────────────────────────────────────────────────────────────────

export function displayName(account: string): string {
  const head = account.split(".")[0] ?? account;
  // Ghost accounts are the relay's test players (its testing door); their random handle means nothing.
  if (head.startsWith("ghost-")) return "Test player";
  const clean = head.replace(/[-_]+/g, " ").trim() || account;
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** One letter when it is unique in the match, else the shortest unique pair, else a number. */
export function initialsFor(names: string[]): string[] {
  const firsts = names.map((n) => n.charAt(0).toUpperCase());
  return names.map((n, i) => {
    const f = firsts[i] as string;
    if (firsts.filter((x) => x === f).length === 1) return f;
    const letters = n.replace(/[^a-z0-9]/gi, "").toUpperCase();
    for (let j = 1; j < letters.length; j++) {
      const pair = f + letters.charAt(j);
      const clash = names.some((m, k) => {
        if (k === i) return false;
        const other = m.replace(/[^a-z0-9]/gi, "").toUpperCase();
        return other.charAt(0) === f && other.includes(letters.charAt(j), 1);
      });
      if (!clash) return pair;
    }
    return `${f}${i + 1}`;
  });
}

// ── Build ────────────────────────────────────────────────────────────────────────

const KINDS: Record<SignedVerdict["body"]["kind"], EventKind> = {
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
  const durationMs = m.endMs - m.startMs;
  const names = d.players.map(displayName);
  const initials = initialsFor(names);
  const players = d.players.map((account, index) => ({
    index,
    account,
    name: names[index] as string,
    initials: initials[index] as string,
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
  const verdictLog = new Map<number, number>();
  d.log.forEach((e, i) => {
    if (e.entry?.kind === "Verdict" && !verdictLog.has(e.entry.seq)) verdictLog.set(e.entry.seq, i);
  });
  let checkpointNo = 0;
  for (const x of d.verdicts) {
    const v = x.v;
    if (!v) continue;
    const li = verdictLog.get(v.seq);
    if (li === undefined) continue;
    if (v.body.kind === "Start") anchorT[li] = 0;
    else if (v.body.kind === "Checkpoint") anchorT[li] = ++checkpointNo * 60_000;
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
  const ring = (() => {
    const end = d.verdicts.find((x) => x.v?.body.kind === "End")?.v?.body;
    if (end?.kind !== "End") return [];
    return buildRing(d.players, end.vrfSignature).map((a) => d.players.indexOf(a));
  })();
  const target = d.players.map(() => -1);
  ring.forEach((p, k) => {
    target[p] = ring[(k + 1) % ring.length] as number;
  });
  const snap0: Snapshot = {
    t: 0,
    heads: d.players.map(() => d.stake),
    alive: d.players.map(() => true),
    target,
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
    const next = (): Snapshot => ({
      t,
      heads: [...last.heads],
      alive: [...last.alive],
      target: [...last.target],
    });
    const b = v.body;
    if (b.kind === "Hint") {
      Object.assign(ev, { a: b.from, b: b.to, amount: b.amount, hintId: b.hintId });
      const n = hintsAsked[b.from] ?? 0;
      hintsAsked[b.from] = n + 1;
      const q = hintAction.get(`${b.from}:${n}`);
      if (q) ev.question = q;
      const line = d.handler.find((h) => h.hintId === b.hintId);
      if (line) {
        const check = handlerChecks.get(b.hintId) ?? null;
        ev.handler = { text: line.text, model: line.model, verified: check?.text === true, signature: check };
      }
      const s = next();
      s.heads[b.from] = (s.heads[b.from] ?? 0n) - b.amount;
      s.heads[b.to] = (s.heads[b.to] ?? 0n) + b.amount;
      snapshots.push(s);
    } else if (b.kind === "Tag" || b.kind === "Forfeit") {
      const [loser, winner] = b.kind === "Tag" ? [b.target, b.hunter] : [b.player, b.to];
      ev.a = winner;
      ev.b = loser;
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
      s.heads[winner] = (s.heads[winner] ?? 0n) + (s.heads[loser] ?? 0n);
      s.heads[loser] = 0n;
      s.alive[loser] = false;
      const inherited = s.target[loser] ?? -1;
      s.target[winner] = inherited === winner ? -1 : inherited;
      s.target[loser] = -1;
      snapshots.push(s);
    }
    events.push(ev);
  });

  return {
    id: m.id,
    startMs,
    durationMs,
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
  };
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

/** Heads, targets and who is alive just before an event (snapshots advance per hint, tag, forfeit). */
export function snapshotBefore(m: Match, ev: MatchEvent): Snapshot {
  const k = m.events.filter(
    (e) => e.index < ev.index && (e.kind === "hint" || e.kind === "tag" || e.kind === "forfeit"),
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
