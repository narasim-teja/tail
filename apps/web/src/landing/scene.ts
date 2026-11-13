// The front page's picture of a match: its players' trails and its first chase, cut from a replay
// bundle by scripts/scene.ts so the landing draws a real match without loading the bundle, the
// map or the verifier. It is a drawing, not evidence: the replay it links to checks the bundle.
//
// Coordinates are decimetres east and north of the zone's centre, times tenths of a second after
// Start, all integers, so the file stays small. The zone's centre is given on Earth, so the hero
// can lay the match on its place's map (map.ts).

export interface Scene {
  version: 2;
  /** fixture: a generated match (scripts/fixture.ts); published: a match this site ships. */
  kind: "fixture" | "published";
  /** The match id, lowercase hex. */
  id: string;
  /** Where it was played: "Boston Common". */
  place: string;
  /** Start, ms since the epoch. */
  startMs: number;
  durationMs: number;
  /** How long it was set to run; the hunt screen's "time left" counts down to it. */
  plannedMs: number;
  /** The zone's centre: [latE7, lonE7]. */
  center: [number, number];
  /** Safehouses: [x, y, radius], decimetres. */
  safehouses: [number, number, number][];
  /** The stake token's decimals, for the heads below. */
  decimals: number;
  players: string[];
  /** Zone radius, decimetres. */
  radius: number;
  /** The longest gap between fixes still drawn as walking, tenths of a second; past it a player is dark. */
  gap: number;
  /** Per player: [t, x, y, t, x, y, …], or null without released trails. */
  tracks: (number[] | null)[];
  /** When each player left the board (tag or forfeit), tenths of a second; null if they survived. */
  out: (number | null)[];
  /** The first tag: the stretch before it the front page plays on a loop. */
  chase: {
    hunter: number;
    target: number;
    /** The Tag verdict's time, tenths of a second. */
    tag: number;
    /** Where the target was then, decimetres. */
    at: [number, number];
    /** The loop: from, to (tenths of a second). */
    from: number;
    to: number;
    /** The hunter's lock on the target as it changed: [t, n, t, n, …]. */
    lock: number[];
    /** The hunter's heat (its own hunter's lock on it) as it changed: [t, n, t, n, …]. */
    heat: number[];
    /** The hunter's head as it changed: [t, amount in the token's smallest units]. */
    head: [number, string][];
  } | null;
}

export class SceneError extends Error {
  override name = "SceneError";
}

const ints = (v: unknown) => Array.isArray(v) && v.every((n) => Number.isInteger(n));

/** A scene file as the site serves it; anything else throws. */
export function parseScene(json: unknown): Scene {
  const s = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
  const fail = (what: string) => new SceneError(`scene: ${what}`);
  if (s["version"] !== 2) throw fail("not version 2");
  if (s["kind"] !== "fixture" && s["kind"] !== "published") throw fail("unknown kind");
  if (typeof s["id"] !== "string" || typeof s["place"] !== "string") throw fail("no id or place");
  if (!Number.isFinite(s["startMs"]) || !Number.isFinite(s["durationMs"])) throw fail("no times");
  const players = s["players"];
  if (!Array.isArray(players) || !players.every((p) => typeof p === "string")) throw fail("no players");
  if (!Number.isFinite(s["plannedMs"])) throw fail("no planned length");
  if (!ints(s["center"]) || (s["center"] as number[]).length !== 2) throw fail("no zone centre");
  if (!Number.isInteger(s["radius"]) || !Number.isInteger(s["gap"])) throw fail("no zone or gap");
  const houses = s["safehouses"];
  if (!Array.isArray(houses) || !houses.every((h) => ints(h) && (h as number[]).length === 3))
    throw fail("safehouses aren't [x, y, r]");
  if (!Number.isInteger(s["decimals"]) || (s["decimals"] as number) < 0) throw fail("no decimals");
  const tracks = s["tracks"];
  if (!Array.isArray(tracks) || tracks.length !== players.length) throw fail("tracks don't match players");
  if (!tracks.every((t) => t === null || (ints(t) && (t as number[]).length % 3 === 0)))
    throw fail("a track isn't [t, x, y, …]");
  const out = s["out"];
  if (
    !Array.isArray(out) ||
    out.length !== players.length ||
    !out.every((o) => o === null || Number.isInteger(o))
  )
    throw fail("out doesn't match players");
  const c = s["chase"] as Record<string, unknown> | null | undefined;
  if (c !== null) {
    if (typeof c !== "object" || c === undefined) throw fail("no chase");
    const n = players.length;
    const idx = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < n;
    if (!idx(c["hunter"]) || !idx(c["target"])) throw fail("the chase names no players");
    if (![c["tag"], c["from"], c["to"]].every(Number.isInteger)) throw fail("the chase has no times");
    if (!ints(c["at"]) || (c["at"] as number[]).length !== 2) throw fail("the chase has no place");
    if (!ints(c["lock"]) || (c["lock"] as number[]).length % 2 !== 0) throw fail("the lock isn't [t, n, …]");
    if (!ints(c["heat"]) || (c["heat"] as number[]).length % 2 !== 0) throw fail("the heat isn't [t, n, …]");
    const head = c["head"];
    if (
      !Array.isArray(head) ||
      head.length === 0 ||
      !head.every(
        (h) =>
          Array.isArray(h) &&
          h.length === 2 &&
          Number.isInteger(h[0]) &&
          typeof h[1] === "string" &&
          /^\d+$/.test(h[1]),
      )
    )
      throw fail("the head isn't [t, amount] pairs");
  }
  return s as unknown as Scene;
}

/**
 * Position on a track at time t (tenths of a second), or null before it starts, after it ends or
 * inside a gap longer than `gap` (the phone was dark).
 */
export function at(track: readonly number[] | null, t: number, gap: number): [number, number] | null {
  if (!track || track.length < 3) return null;
  const n = track.length / 3;
  const first = track[0] as number;
  const last = track[(n - 1) * 3] as number;
  if (t < first || t > last) return null;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((track[mid * 3] as number) <= t) lo = mid;
    else hi = mid;
  }
  const t0 = track[lo * 3] as number;
  const t1 = track[hi * 3] as number;
  if (t1 - t0 > gap) return null;
  const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  const x0 = track[lo * 3 + 1] as number;
  const y0 = track[lo * 3 + 2] as number;
  return [x0 + ((track[hi * 3 + 1] as number) - x0) * f, y0 + ((track[hi * 3 + 2] as number) - y0) * f];
}

/** A step value at time t from a change list [t, n, t, n, …]: the lock, or the heat. */
export function lockAt(lock: readonly number[], t: number): number {
  let n = 0;
  for (let i = 0; i < lock.length; i += 2) {
    if ((lock[i] as number) > t) break;
    n = lock[i + 1] as number;
  }
  return n;
}

/** The hunter's head at time t, in the token's smallest units. */
export function headAt(head: readonly [number, string][], t: number): bigint {
  // parseScene refuses an empty list, so the first change is the head at the loop's start.
  let v = BigInt((head[0] as [number, string])[1]);
  for (const [at, units] of head) {
    if (at > t) break;
    v = BigInt(units);
  }
  return v;
}
