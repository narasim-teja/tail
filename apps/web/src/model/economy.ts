// The match's money over time, for the economy panel: every head, the hint pool, each Tag and
// Forfeit's transfer, End's payout from the pool, and the hint price. All of it is read off the
// signed verdicts in the bundle, applied in order the way the contract applies them (the match
// model's snapshots, verify/settle.ts); there is no other source.
//
// Hint price: a Hint verdict carries `tMs`, the referee clock when it was charged, and its amount
// is hintPrice(stake, kind, recent hints). From the verdicts' times the panel rebuilds the demand
// multiplier as it stood at every moment (demandBps over the last PRICE_WINDOW_MS), and from each
// amount the multiplier that hint actually paid. A bundle whose Hint verdicts carry no time
// (recorded before demand pricing) shows hints bought per 5 minutes instead.

import { demandBps, HINT_BPS, type HintKind, PRICE_WINDOW_MS, recentHints } from "@tail/protocol";
import type { DecodedBundle } from "../verify/bundle.ts";
import { type Match, type Snapshot, snapshotBefore } from "./match.ts";

/** One step of a step series: `v` holds from `t` (ms after the start) until the next point. */
export interface Step {
  t: number;
  v: number;
}

/** A Tag or Forfeit: the loser's head and the hint money credited onto it, moved to the winner. */
export interface Flow {
  kind: "tag" | "forfeit";
  /** Verdict index (event id for seeking and verification status). */
  event: number;
  t: number;
  winner: number;
  loser: number;
  /** The loser's head just before, without the credit. */
  head: bigint;
  /** Hint money paid onto the loser, moved from the pool onto their head first. */
  credit: bigint;
}

/** End: what the pool paid each survivor (payout), or the refund. */
export interface Payout {
  event: number;
  t: number;
  kind: "payout" | "refunded";
  /** Per player: head change at End (0 for players out). */
  delta: bigint[];
}

export interface HintBuy {
  event: number;
  t: number;
  from: number;
  amount: bigint;
  /** The demand multiplier this hint paid, from its amount (1 = base price), when known. */
  paid: number | null;
}

export type Demand =
  /** Demand multiplier over time (1 to 4), rebuilt from the Hint verdicts' times. */
  | { kind: "price"; series: Step[]; capped: number }
  /** Hints bought per bucket, for bundles whose hints carry no time. */
  | { kind: "count"; bucketMs: number; counts: number[] };

export interface Economy {
  durationMs: number;
  stake: bigint;
  /** Per player: head over time, in token units as numbers (for drawing only). */
  heads: Step[][];
  pool: Step[];
  /** The largest head any player held, for one shared scale. */
  maxHead: number;
  maxPool: number;
  flows: Flow[];
  payout: Payout | null;
  hints: HintBuy[];
  demand: Demand;
  /** The verdicts the figures were computed from (every Hint, Tag, Forfeit and End). */
  moneyVerdicts: number[];
}

export const BUCKET_MS = 5 * 60_000;

/** Snapshots move per hint, tag, forfeit and End; this is the one belonging to each event. */
function after(m: Match, event: number): Snapshot | null {
  const k = m.events.filter(
    (e) =>
      e.index <= event && (e.kind === "hint" || e.kind === "tag" || e.kind === "forfeit" || e.kind === "end"),
  ).length;
  return m.snapshots[k] ?? null;
}

export function buildEconomy(m: Match, d: DecodedBundle): Economy {
  const n = m.players.length;
  const heads: Step[][] = m.players.map(() => []);
  const pool: Step[] = [];
  for (const s of m.snapshots) {
    s.heads.forEach((h, p) => {
      push(heads[p] as Step[], s.t, Number(h));
    });
    push(pool, s.t, Number(s.pool));
  }
  const maxHead = Math.max(1, ...heads.flat().map((x) => x.v));
  const maxPool = Math.max(1, ...pool.map((x) => x.v));

  const flows: Flow[] = [];
  const hints: HintBuy[] = [];
  const moneyVerdicts: number[] = [];
  let payout: Payout | null = null;
  const times: bigint[] = [];
  let timed = true;
  for (const ev of m.events) {
    const body = d.verdicts[ev.index]?.v?.body;
    if (!body) continue;
    if (ev.kind === "hint" && body.kind === "Hint") {
      moneyVerdicts.push(ev.index);
      const tMs = "tMs" in body ? body.tMs : undefined;
      let paid: number | null = null;
      if (tMs === undefined) timed = false;
      else {
        times.push(tMs);
        const base = (m.stake * BigInt(HINT_BPS[body.hint as HintKind] ?? 0)) / 10_000n;
        if (base > 0n) paid = Number((body.amount * 10_000n) / base) / 10_000;
      }
      hints.push({
        event: ev.index,
        t: tMs === undefined ? ev.t : clampT(Number(tMs) - m.startMs, m.durationMs),
        from: body.from,
        amount: body.amount,
        paid,
      });
    } else if ((ev.kind === "tag" || ev.kind === "forfeit") && ev.a !== undefined && ev.b !== undefined) {
      moneyVerdicts.push(ev.index);
      // The match model names a tag hunter → target and a forfeit player → receiver.
      const [winner, loser] = ev.kind === "tag" ? [ev.a, ev.b] : [ev.b, ev.a];
      const before = snapshotBefore(m, ev);
      flows.push({
        kind: ev.kind,
        event: ev.index,
        t: ev.t,
        winner,
        loser,
        head: before.heads[loser] ?? 0n,
        credit: ev.credit ?? 0n,
      });
    } else if (ev.kind === "end") {
      moneyVerdicts.push(ev.index);
      const before = snapshotBefore(m, ev);
      const end = after(m, ev.index);
      if (end && (m.settlement.kind === "payout" || m.settlement.kind === "refunded"))
        payout = {
          event: ev.index,
          t: ev.t,
          kind: m.settlement.kind,
          delta: Array.from({ length: n }, (_, p) => (end.heads[p] ?? 0n) - (before.heads[p] ?? 0n)),
        };
    }
  }

  return {
    durationMs: m.durationMs,
    stake: m.stake,
    heads,
    pool,
    maxHead,
    maxPool,
    flows,
    payout,
    hints,
    demand:
      timed && hints.length > 0 ? priceSeries(times, m.startMs, m.durationMs) : counts(hints, m.durationMs),
    moneyVerdicts,
  };
}

const clampT = (t: number, dur: number) => Math.max(0, Math.min(dur, t));

function push(series: Step[], t: number, v: number) {
  const last = series[series.length - 1];
  if (last && last.t === t) last.v = v;
  else if (!last || last.v !== v) series.push({ t, v });
}

/**
 * The multiplier the next hint would pay at every moment: it rises as each hint is bought and
 * falls back as each one leaves the window, exactly as the referee and contract count it.
 */
function priceSeries(times: bigint[], startMs: number, durationMs: number): Demand {
  const edges = new Set<number>([0]);
  for (const t of times) {
    const rel = Number(t) - startMs;
    edges.add(clampT(rel, durationMs));
    edges.add(clampT(rel + PRICE_WINDOW_MS, durationMs));
  }
  const series: Step[] = [];
  let capped = 0;
  for (const t of [...edges].sort((a, b) => a - b)) {
    const x = Number(demandBps(recentHints(times, BigInt(startMs + t)))) / 10_000;
    push(series, t, x);
    capped = Math.max(capped, x);
  }
  return { kind: "price", series, capped };
}

function counts(hints: HintBuy[], durationMs: number): Demand {
  const out = new Array(Math.max(1, Math.ceil(durationMs / BUCKET_MS))).fill(0) as number[];
  for (const h of hints) {
    const k = Math.min(out.length - 1, Math.floor(h.t / BUCKET_MS));
    out[k] = (out[k] ?? 0) + 1;
  }
  return { kind: "count", bucketMs: BUCKET_MS, counts: out };
}

/** The value of a step series at time t. */
export function valueAt(series: Step[], t: number): number {
  let v = series[0]?.v ?? 0;
  for (const s of series) {
    if (s.t <= t) v = s.v;
    else break;
  }
  return v;
}

/** SVG path of a step series from 0 to `until`, in a w × h box with y = 0 at `max`. */
export function stepPath(
  series: Step[],
  until: number,
  durationMs: number,
  w: number,
  h: number,
  lo: number,
  hi: number,
): string {
  if (series.length === 0) return "";
  const x = (t: number) => (Math.min(t, until) / durationMs) * w;
  const y = (v: number) => h - ((v - lo) / Math.max(1e-9, hi - lo)) * h;
  let d = `M0 ${y((series[0] as Step).v).toFixed(2)}`;
  for (let i = 1; i < series.length; i++) {
    const s = series[i] as Step;
    if (s.t > until) break;
    d += `H${x(s.t).toFixed(2)}V${y(s.v).toFixed(2)}`;
  }
  return `${d}H${x(until).toFixed(2)}`;
}
