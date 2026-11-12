// What the map shows at one instant, computed once per frame and drawn by either renderer (3D
// MapLibre + deck.gl, or the flat 2D canvas).

import { EPOCH_MS } from "@tail/protocol";
import { type Focus, focusAt } from "../model/film.ts";
import { lastKnown, lockAt, type Match, positionAt, snapshotAt } from "../model/match.ts";
import type { PlayState } from "../replay/state.ts";

export type Role = "hunter" | "target" | null;

export interface FramePlayer {
  index: number;
  initials: string;
  /** Live position; null when dark or out of the track. */
  pos: [number, number] | null;
  /** Where they were last seen, for dark players. */
  ghost: [number, number] | null;
  alive: boolean;
  role: Role;
  /** Head as a multiple of the stake, for the needle height. */
  heads: number;
  selected: boolean;
}

export interface Flash {
  kind: "tag" | "forfeit";
  pos: [number, number] | null;
  /** 0 → 1 over the flash's life. */
  age: number;
}

export interface Frame {
  t: number;
  focus: Focus;
  players: FramePlayer[];
  /** The lock line of the chase in focus, when both are on the map. */
  lock: { from: [number, number]; to: [number, number]; lock: number; hunter: number; target: number } | null;
  flashes: Flash[];
  /** An event is happening and no positions are known: the zone itself glows. */
  zoneGlow: number;
}

export const FLASH_MS = 1_600;

export function computeFrame(m: Match, s: PlayState, now: number): Frame {
  const { t } = s;
  const focus = focusAt(m, t);
  const snap = snapshotAt(m, t);
  const stake = Number(m.stake) || 1;
  const sel = s.selection;
  const players = m.players.map((p): FramePlayer => {
    const tr = m.tracks[p.index] ?? null;
    const alive = snap.alive[p.index] ?? false;
    const pos = alive ? positionAt(tr, t) : null;
    let role: Role = null;
    if (focus.kind === "chase")
      role = focus.hunter === p.index ? "hunter" : focus.target === p.index ? "target" : null;
    return {
      index: p.index,
      initials: p.initials,
      pos,
      ghost: alive && !pos ? lastKnown(tr, t) : null,
      alive,
      role,
      heads: Number(snap.heads[p.index] ?? 0n) / stake,
      selected: (sel?.kind === "player" && sel.index === p.index) || s.follow === p.index,
    };
  });

  let lock: Frame["lock"] = null;
  if (focus.kind === "chase") {
    const a = players[focus.hunter]?.pos;
    const b = players[focus.target]?.pos;
    const n = lockAt(m, focus.hunter, focus.target, t);
    if (a && b && n > 0) lock = { from: a, to: b, lock: n, hunter: focus.hunter, target: focus.target };
  }

  const flashes: Flash[] = [];
  let zoneGlow = 0;
  for (const f of s.flashes) {
    const ev = m.events.find((e) => e.index === f.event);
    if (!ev || (ev.kind !== "tag" && ev.kind !== "forfeit")) continue;
    const age = (now - f.born) / FLASH_MS;
    if (age < 0 || age > 1) continue;
    // Tag: where the target was caught. Forfeit: where the dark player was last seen.
    const who = ev.kind === "tag" ? ev.b : ev.a;
    const tr = who === undefined ? null : (m.tracks[who] ?? null);
    const pos = positionAt(tr, ev.t) ?? lastKnown(tr, ev.t);
    flashes.push({ kind: ev.kind, pos, age });
    if (!pos) zoneGlow = Math.max(zoneGlow, 1 - age);
  }
  return { t, focus, players, lock, flashes, zoneGlow };
}

/** Lock as a fraction of the four contact epochs a strike needs. */
export const lockFraction = (n: number) => Math.min(1, n / 4);

export const epochOf = (t: number) => Math.floor(t / EPOCH_MS);
