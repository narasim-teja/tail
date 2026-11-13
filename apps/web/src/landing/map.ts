// The map under the front page's hero: one place drawn from OpenStreetMap as light vector data
// (scripts/fetch-paths.ts writes it to public/maps/<name>.json). No tiles and no map library: the
// hero draws these shapes in SVG in the brand's own colours.
//
// Coordinates are whole metres east and north of the map's centre, the same flat projection the
// scene uses (scripts/scene.ts), so a scene is placed on the map by the distance between the two
// centres. Map data © OpenStreetMap contributors, ODbL 1.0.

export interface StreetLabel {
  /** As the map writes it: "Beacon St". */
  name: string;
  /** Where the label may sit: [x, y, angle in degrees, counter-clockwise from east, upright]. */
  at: [number, number, number][];
}

export interface PlaceLabel {
  name: string;
  kind: "park" | "water" | "place";
  at: [number, number];
}

export interface MapData {
  version: 1;
  /** The place, as a match names it: "Boston Common". */
  place: string;
  source: string;
  /** The map's centre: [latE7, lonE7]. */
  center: [number, number];
  /** The box the data covers: [west, south, east, north], metres. */
  extent: [number, number, number, number];
  /** The box the hero frames: [west, south, width, height], metres; cropped to fit the panel. */
  view: [number, number, number, number];
  /** Lawns and gardens, closed rings [x, y, x, y, …]. */
  parks: number[][];
  water: number[][];
  /** Street centre lines; class 1 is a main road, 3 a side street. */
  roads: { c: 1 | 2 | 3; d: number[] }[];
  /** Footpaths inside the parks. */
  paths: number[][];
  streets: StreetLabel[];
  places: PlaceLabel[];
}

export class MapError extends Error {
  override name = "MapError";
}

const ints = (v: unknown, min = 2): v is number[] =>
  Array.isArray(v) && v.length >= min && v.length % 2 === 0 && v.every((n) => Number.isInteger(n));
const box = (v: unknown): v is [number, number, number, number] =>
  Array.isArray(v) && v.length === 4 && v.every((n) => Number.isFinite(n));

/** A map file as the site serves it; anything else throws, and the hero draws the zone alone. */
export function parseMap(json: unknown): MapData {
  const m = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
  const fail = (what: string) => new MapError(`map: ${what}`);
  if (m["version"] !== 1) throw fail("not version 1");
  if (typeof m["place"] !== "string" || typeof m["source"] !== "string") throw fail("no place or source");
  const c = m["center"];
  if (!Array.isArray(c) || c.length !== 2 || !c.every(Number.isInteger)) throw fail("no centre");
  if (!box(m["extent"]) || !box(m["view"])) throw fail("no extent or view");
  for (const k of ["parks", "water", "paths"] as const) {
    const v = m[k];
    if (!Array.isArray(v) || !v.every((r) => ints(r, 4))) throw fail(`${k} aren't [x, y, …] lines`);
  }
  const roads = m["roads"];
  if (
    !Array.isArray(roads) ||
    !roads.every(
      (r) => [1, 2, 3].includes((r as { c?: unknown })?.c as number) && ints((r as { d?: unknown }).d, 4),
    )
  )
    throw fail("roads aren't classed lines");
  const streets = m["streets"];
  if (
    !Array.isArray(streets) ||
    !streets.every(
      (s) =>
        typeof s?.name === "string" &&
        Array.isArray(s.at) &&
        s.at.every((a: unknown) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite)),
    )
  )
    throw fail("street labels aren't [x, y, angle]");
  const places = m["places"];
  if (
    !Array.isArray(places) ||
    !places.every(
      (p) =>
        typeof p?.name === "string" &&
        ["park", "water", "place"].includes(p.kind) &&
        Array.isArray(p.at) &&
        p.at.length === 2 &&
        p.at.every(Number.isFinite),
    )
  )
    throw fail("place labels aren't named points");
  return m as unknown as MapData;
}

/** Metres per degree, as scripts/scene.ts places a match. */
export const M_PER_DEG_LON = 111_320;
export const M_PER_DEG_LAT = 110_574;

/** Where a point given as [latE7, lonE7] sits on the map, in metres east and north of its centre. */
export function onMap(map: Pick<MapData, "center">, latE7: number, lonE7: number): [number, number] {
  const [lat0, lon0] = [map.center[0] / 1e7, map.center[1] / 1e7];
  return [
    (lonE7 / 1e7 - lon0) * M_PER_DEG_LON * Math.cos((lat0 * Math.PI) / 180),
    (latE7 / 1e7 - lat0) * M_PER_DEG_LAT,
  ];
}
