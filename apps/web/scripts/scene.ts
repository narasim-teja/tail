// Cuts the front page's scene (src/landing/scene.ts) from a replay bundle, with the replay's own
// model: trails only from batches whose hash the log holds, the lock from the logged contacts,
// event times from the log (prepare and buildMatch, src/verify/index.ts). Run by make-fixture.ts
// for the generated match and by publish-match.ts for a published one.

import { LOCK_EPOCHS } from "@tail/protocol";
import type { Scene } from "../src/landing/scene.ts";
import { GAP_MS, lockAt, type Match, positionAt } from "../src/model/match.ts";
import { decodeBundle } from "../src/verify/bundle.ts";
import { prepare } from "../src/verify/index.ts";

/** The loop: this long before the first tag, and this long after it. */
const LEAD_MS = 120_000;
const TAIL_MS = 14_000;
/** Fixes closer together than this are dropped; walking pace makes the rest a straight line. */
const STEP_MS = 2_000;
const LOCK_SAMPLE_MS = 1_000;

const tenths = (ms: number) => Math.round(ms / 100);

/** The generated matches stake fake USDC, 6 decimals (scripts/fixture.ts). */
export const FIXTURE_DECIMALS = 6;

export function sceneOf(bundle: unknown, kind: Scene["kind"], place: string, decimals: number): Scene {
  const decoded = decodeBundle(JSON.parse(JSON.stringify(bundle)));
  return sceneOfMatch(prepare(decoded).match, kind, place, decimals);
}

/** The snapshot in force at time t. */
const snapshotAt = (m: Match, t: number) => {
  let s = m.snapshots[0];
  for (const x of m.snapshots) {
    if (x.t > t) break;
    s = x;
  }
  return s;
};

/** `decimals`: the stake token's, as NEAR's ft_metadata gives it, for the hunter's head. */
export function sceneOfMatch(m: Match, kind: Scene["kind"], place: string, decimals: number): Scene {
  const lat0 = (m.zone.lat * Math.PI) / 180;
  // Decimetres east and north of the zone's centre (equirectangular: a park is small).
  const dx = (lon: number) => Math.round((lon - m.zone.lon) * 111_320 * Math.cos(lat0) * 10);
  const dy = (lat: number) => Math.round((lat - m.zone.lat) * 110_574 * 10);
  const tracks = m.tracks.map((tr) => {
    if (!tr) return null;
    const out: number[] = [];
    let last = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < tr.t.length; i++) {
      const t = tr.t[i] as number;
      const isLast = i === tr.t.length - 1;
      const beforeGap = !isLast && (tr.t[i + 1] as number) - t > GAP_MS;
      const afterGap = i > 0 && t - (tr.t[i - 1] as number) > GAP_MS;
      if (t - last < STEP_MS && !isLast && !beforeGap && !afterGap) continue;
      out.push(tenths(t), dx(tr.lon[i] as number), dy(tr.lat[i] as number));
      last = t;
    }
    return out;
  });
  const out: (number | null)[] = m.players.map(() => null);
  for (const e of m.events) {
    if (e.kind === "tag" && e.b !== undefined) out[e.b] = tenths(e.t);
    if (e.kind === "forfeit" && e.a !== undefined) out[e.a] = tenths(e.t);
  }
  const tag = m.events.find((e) => e.kind === "tag" && e.a !== undefined && e.b !== undefined);
  let chase: Scene["chase"] = null;
  if (tag && tag.a !== undefined && tag.b !== undefined) {
    const hunter = tag.a;
    const target = tag.b;
    const from = Math.max(0, tag.t - LEAD_MS);
    const to = Math.min(m.durationMs, tag.t + TAIL_MS);
    const lock: number[] = [];
    const heat: number[] = [];
    const head: [number, string][] = [];
    let [prevLock, prevHeat, prevHead] = [-1, -1, ""];
    for (let t = from; t <= to; t += LOCK_SAMPLE_MS) {
      const n = Math.min(LOCK_EPOCHS, lockAt(m, hunter, target, t));
      if (n !== prevLock) lock.push(tenths(t), n);
      prevLock = n;
      // Heat is the hunter's own hunter's lock on it, as the phone shows it.
      const snap = snapshotAt(m, t);
      if (!snap) throw new Error("the match has no snapshots");
      const by = snap.target.findIndex((tg, p) => tg === hunter && snap.alive[p]);
      const h = by < 0 ? 0 : Math.min(LOCK_EPOCHS, lockAt(m, by, hunter, t));
      if (h !== prevHeat) heat.push(tenths(t), h);
      prevHeat = h;
      const units = (snap.heads[hunter] as bigint).toString();
      if (units !== prevHead) head.push([tenths(t), units]);
      prevHead = units;
    }
    const p = positionAt(m.tracks[target] ?? null, tag.t);
    chase = {
      hunter,
      target,
      tag: tenths(tag.t),
      at: p ? [dx(p[0]), dy(p[1])] : [0, 0],
      from: tenths(from),
      to: tenths(to),
      lock,
      heat,
      head,
    };
  }
  return {
    version: 2,
    kind,
    id: m.id,
    place,
    startMs: m.startMs,
    durationMs: m.durationMs,
    plannedMs: m.plannedMs,
    center: [Math.round(m.zone.lat * 1e7), Math.round(m.zone.lon * 1e7)],
    safehouses: m.safehouses.map((h) => [dx(h.lon), dy(h.lat), Math.round(h.radiusM * 10)]),
    decimals,
    players: m.players.map((p) => p.name),
    radius: Math.round(m.zone.radiusM * 10),
    gap: tenths(GAP_MS),
    tracks,
    out,
    chase,
  };
}

/** Who was still standing at End, from the match model's last snapshot. */
export const survivorsOf = (m: Match) =>
  (m.snapshots[m.snapshots.length - 1]?.alive ?? []).filter(Boolean).length;
