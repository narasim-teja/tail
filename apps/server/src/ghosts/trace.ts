// Scripted traces for ghost players. A trace gives each role a path (match-relative seconds,
// metres east and north of the zone centre, interpolated linearly) and a few actions. Roles are
// bound to players only after Start, because the ring is the referee's secret: the ghost that is
// player 0 hunts, its target (from its own sealed PlayerKeys) is the target, the rest stand by.

export type Waypoint = readonly [tS: number, eastM: number, northM: number];

export interface Trace {
  name: string;
  /** Ghosts within this distance hear each other's beacons. */
  radioM: number;
  rssi: number;
  accM: number;
  paths: { hunter: readonly Waypoint[]; target: readonly Waypoint[]; bystander: readonly Waypoint[] };
  /** The hunter asks this hint at this match second. */
  hint?: { atS: number; kind: number; text?: string };
  /** The hunter strikes as soon as its HUD lock reaches LOCK_EPOCHS. */
  strikeWhenLocked: boolean;
}

/**
 * The hunter walks 150 m to its target in 45 s (3.3 m/s, under the vehicle speed), asks one NEAR
 * hint on the way, stays within radio range, and strikes when its lock is full (≥ 4 contact
 * epochs, about a minute). The bystander stays 1.1 km away, inside the zone.
 */
export const CLEAN_TAG: Trace = {
  name: "clean-tag",
  radioM: 15,
  rssi: -60,
  accM: 5,
  paths: {
    hunter: [
      [0, -150, 0],
      [45, -2, 1],
    ],
    target: [[0, 0, 0]],
    bystander: [[0, 800, 800]],
  },
  hint: { atS: 15, kind: 0, text: "are they close?" },
  strikeWhenLocked: true,
};

export function positionAt(
  path: readonly Waypoint[],
  tS: number,
): { east: number; north: number; speed: number } {
  const first = path[0];
  if (!first) throw new Error("empty path");
  if (tS <= first[0] || path.length === 1) return { east: first[1], north: first[2], speed: 0 };
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Waypoint;
    const b = path[i] as Waypoint;
    if (tS <= b[0]) {
      const f = (tS - a[0]) / (b[0] - a[0]);
      const speed = Math.hypot(b[1] - a[1], b[2] - a[2]) / (b[0] - a[0]);
      return { east: a[1] + f * (b[1] - a[1]), north: a[2] + f * (b[2] - a[2]), speed };
    }
  }
  const last = path[path.length - 1] as Waypoint;
  return { east: last[1], north: last[2], speed: 0 };
}

/** Metres from a centre (lat/lon in 1e-7 degrees) to lat/lon, on a local flat plane. */
export function toLatLonE7(centre: { latE7: number; lonE7: number }, east: number, north: number) {
  const lat = centre.latE7 / 1e7;
  const dLat = north / 111_320;
  const dLon = east / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { latE7: Math.round(centre.latE7 + dLat * 1e7), lonE7: Math.round(centre.lonE7 + dLon * 1e7) };
}
