// The film's direction: how fast match time runs, and which chase the camera is on. Pure
// functions of the match and a time, so scrubbing anywhere gives the same frame.

import { lockAt, type Match, positionAt, snapshotAt } from "./match.ts";

export const FILM_SPEED = 30;

/**
 * Slow to real time around each tag (and to a walk around a forfeit), 30x elsewhere. The
 * approach eases in over a minute so the lock is seen filling; the way out is quicker.
 */
export function filmSpeed(m: Match, t: number): number {
  let s = FILM_SPEED;
  for (const e of m.events) {
    const d = t - e.t;
    if (e.kind === "tag") s = Math.min(s, ramp(d, 5_000, 70_000, 25_000, 1));
    else if (e.kind === "forfeit") s = Math.min(s, ramp(d, 3_000, 30_000, 15_000, 5));
  }
  return s;
}

/** `floor` within `hold` ms of the moment, rising (quadratically) to FILM_SPEED over the span. */
function ramp(d: number, hold: number, before: number, after: number, floor: number): number {
  const x = Math.min(1, Math.max(0, Math.abs(d) - hold) / (d < 0 ? before : after));
  return floor + (FILM_SPEED - floor) * x * x;
}

export type Focus =
  | { kind: "chase"; hunter: number; target: number }
  | { kind: "player"; player: number }
  | { kind: "zone" };

const LOOKAHEAD_MS = 150_000;

/**
 * The chase in focus: the pair of the next tag if it comes within 2.5 minutes, the player who
 * is about to forfeit, else the live pair with the highest lock, else the closest live pair.
 */
export function focusAt(m: Match, t: number): Focus {
  for (const e of m.events) {
    if (e.t < t - 6_000) continue;
    if (e.t > t + LOOKAHEAD_MS) break;
    if (e.kind === "tag" && e.a !== undefined && e.b !== undefined)
      return { kind: "chase", hunter: e.a, target: e.b };
    if (e.kind === "forfeit" && e.a !== undefined && e.t - t < 50_000) return { kind: "player", player: e.a };
  }
  const s = snapshotAt(m, t);
  let best: { h: number; tg: number; score: number } | null = null;
  s.target.forEach((tg, h) => {
    if (tg < 0 || !s.alive[h] || !s.alive[tg]) return;
    const lock = lockAt(m, h, tg, t);
    let score = lock * 1_000;
    const ph = positionAt(m.tracks[h] ?? null, t);
    const pt = positionAt(m.tracks[tg] ?? null, t);
    if (ph && pt) score += 1_000 - Math.min(999, Math.hypot(ph[0] - pt[0], (ph[1] - pt[1]) * 1.35) * 80_000);
    if (score > 0 && (!best || score > best.score)) best = { h, tg, score };
  });
  const b = best as { h: number; tg: number } | null;
  return b ? { kind: "chase", hunter: b.h, target: b.tg } : { kind: "zone" };
}

/** Events crossed when the playhead moves from `from` to `to` (forward only). */
export function crossed(m: Match, from: number, to: number) {
  if (to <= from) return [];
  return m.events.filter((e) => e.t > from && e.t <= to);
}
