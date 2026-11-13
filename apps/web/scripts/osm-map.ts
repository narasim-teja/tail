// Builds the front page's map of one place (src/landing/map.ts) from OpenStreetMap through the
// Overpass API: lawns and gardens, water, street centre lines with their names, the footpaths
// inside the parks, and a few place names. Shapes are clipped to the box, simplified to about a
// metre and rounded to whole metres, so the file stays a few tens of kilobytes. Used by
// fetch-paths.ts; it needs the network, the site never does.

import type { MapData, PlaceLabel, StreetLabel } from "../src/landing/map.ts";
import { M_PER_DEG_LAT, M_PER_DEG_LON } from "../src/landing/map.ts";

const OVERPASS = "https://overpass-api.de/api/interpreter";

type LatLon = { lat: number; lon: number };
interface Element {
  type: "way" | "relation";
  id: number;
  tags?: Record<string, string>;
  geometry?: LatLon[];
  members?: { type: string; role: string; geometry?: LatLon[] }[];
}
type P = [number, number];

/** One Overpass query; a busy server (429, 502, 504) is asked again, up to four times. */
export async function overpass(query: string): Promise<Element[]> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(OVERPASS, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "tail-replay-fixture/1" },
      body: `data=${encodeURIComponent(`[out:json][timeout:90];${query}`)}`,
    });
    if (res.ok) return ((await res.json()) as { elements: Element[] }).elements;
    if (attempt >= 4 || ![429, 502, 504].includes(res.status))
      throw new Error(`Overpass answered ${res.status}`);
    await new Promise((r) => setTimeout(r, 5_000 * attempt));
  }
}

/** Joins a relation's outer ways end to end into closed rings. */
export function outerRings(rel: Element): LatLon[][] {
  const parts = (rel.members ?? [])
    .filter((m) => m.role === "outer" && m.geometry && m.geometry.length > 1)
    .map((m) => [...(m.geometry ?? [])]);
  const same = (a: LatLon | undefined, b: LatLon | undefined) =>
    !!a && !!b && a.lat === b.lat && a.lon === b.lon;
  const rings: LatLon[][] = [];
  while (parts.length > 0) {
    const ring = parts.shift() ?? [];
    while (!same(ring[0], ring.at(-1))) {
      const tail = ring.at(-1);
      const i = parts.findIndex((p) => same(p[0], tail) || same(p.at(-1), tail));
      if (i < 0) break;
      const [next] = parts.splice(i, 1);
      if (!next) break;
      if (!same(next[0], tail)) next.reverse();
      ring.push(...next.slice(1));
    }
    if (same(ring[0], ring.at(-1))) rings.push(ring);
  }
  return rings;
}

/** Perpendicular distance from p to the segment a–b. */
function offLine(p: P, a: P, b: P): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Douglas–Peucker. */
export function simplify(pts: P[], tol: number): P[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [i, j] = stack.pop() as [number, number];
    let worst = -1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const d = offLine(pts[k] as P, pts[i] as P, pts[j] as P);
      if (d > worst) {
        worst = d;
        at = k;
      }
    }
    if (worst > tol) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

/** Sutherland–Hodgman against an axis-aligned box. */
export function clipRing(ring: P[], [w, s, e, n]: [number, number, number, number]): P[] {
  const edges: [(p: P) => boolean, (a: P, b: P) => P][] = [
    [(p) => p[0] >= w, (a, b) => [w, a[1] + ((b[1] - a[1]) * (w - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= e, (a, b) => [e, a[1] + ((b[1] - a[1]) * (e - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= s, (a, b) => [a[0] + ((b[0] - a[0]) * (s - a[1])) / (b[1] - a[1]), s]],
    [(p) => p[1] <= n, (a, b) => [a[0] + ((b[0] - a[0]) * (n - a[1])) / (b[1] - a[1]), n]],
  ];
  let out = ring;
  for (const [inside, cut] of edges) {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const cur = src[i] as P;
      const prev = src[(i + src.length - 1) % src.length] as P;
      if (inside(cur)) {
        if (!inside(prev)) out.push(cut(prev, cur));
        out.push(cur);
      } else if (inside(prev)) out.push(cut(prev, cur));
    }
    if (out.length === 0) break;
  }
  return out;
}

/** The runs of a line inside a box, each extended by the one point past the edge so it reaches it. */
export function clipLine(line: P[], [w, s, e, n]: [number, number, number, number]): P[][] {
  const inside = (p: P) => p[0] >= w && p[0] <= e && p[1] >= s && p[1] <= n;
  const runs: P[][] = [];
  let run: P[] = [];
  line.forEach((p, i) => {
    const near =
      inside(p) || (i > 0 && inside(line[i - 1] as P)) || (i < line.length - 1 && inside(line[i + 1] as P));
    if (near) run.push(p);
    else if (run.length > 0) {
      runs.push(run);
      run = [];
    }
  });
  if (run.length > 0) runs.push(run);
  return runs.filter((r) => r.length >= 2);
}

const area = (r: P[]) =>
  Math.abs(
    r.reduce((a, p, i) => {
      const q = r[(i + 1) % r.length] as P;
      return a + p[0] * q[1] - q[0] * p[1];
    }, 0),
  ) / 2;

function centroid(r: P[]): P {
  let [a, cx, cy] = [0, 0, 0];
  r.forEach((p, i) => {
    const q = r[(i + 1) % r.length] as P;
    const f = p[0] * q[1] - q[0] * p[1];
    a += f;
    cx += (p[0] + q[0]) * f;
    cy += (p[1] + q[1]) * f;
  });
  return [cx / (3 * a), cy / (3 * a)];
}

function inRing(p: P, ring: P[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as P;
    const b = ring[j] as P;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0])
      hit = !hit;
  }
  return hit;
}

/** "Beacon Street" → "Beacon St", as Apple Maps and the phone's map write it. */
export const shortName = (name: string) =>
  name
    .replace(/\bStreet\b/, "St")
    .replace(/\bAvenue\b/, "Ave")
    .replace(/\bPlace\b/, "Pl");

/**
 * Where a street's name may sit: points along its centre line where it runs straight for the
 * length of a label, with the angle that keeps the text upright. The hero picks the one nearest
 * the middle of what it shows.
 */
export function labelSpots(lines: P[][], half = 55, step = 30): [number, number, number][] {
  const spots: [number, number, number][] = [];
  for (const line of lines) {
    // Cumulative length along the line, to sample it evenly.
    const cum = [0];
    for (let i = 1; i < line.length; i++)
      cum.push(
        (cum[i - 1] as number) +
          Math.hypot((line[i] as P)[0] - (line[i - 1] as P)[0], (line[i] as P)[1] - (line[i - 1] as P)[1]),
      );
    const total = cum.at(-1) as number;
    const along = (d: number): P => {
      let i = 1;
      while (i < cum.length - 1 && (cum[i] as number) < d) i++;
      const [a, b] = [line[i - 1] as P, line[i] as P];
      const seg = (cum[i] as number) - (cum[i - 1] as number) || 1;
      const f = (d - (cum[i - 1] as number)) / seg;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    };
    for (let d = half; d <= total - half; d += step) {
      const [a, b] = [along(d - half), along(d + half)];
      // Straight enough: the chord is nearly the walked length, and the middle is on the chord.
      const mid = along(d);
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 2 * half * 0.985 || offLine(mid, a, b) > 3) continue;
      let deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      if (deg > 90) deg -= 180;
      if (deg <= -90) deg += 180;
      if (spots.some((s) => Math.hypot(s[0] - mid[0], s[1] - mid[1]) < step * 1.5)) continue;
      spots.push([Math.round(mid[0]), Math.round(mid[1]), Math.round(deg)]);
    }
  }
  return spots;
}

export interface MapSpec {
  place: string;
  /** The map's centre. */
  lat: number;
  lon: number;
  /** The data's box and the hero's frame, metres around the centre: [west, south, east, north]. */
  extent: [number, number, number, number];
  view: [number, number, number, number];
  /** Streets whose names are set on the map, as OSM names them. */
  streets: string[];
  /** Places named on the map: an OSM name, how to draw it, and an optional nudge in metres. */
  places: { osm: string; name: string; kind: PlaceLabel["kind"]; nudge?: P }[];
}

const round = (r: P[]) => r.flatMap(([x, y]) => [Math.round(x), Math.round(y)]);

export async function fetchMap(spec: MapSpec): Promise<MapData> {
  const cos = Math.cos((spec.lat * Math.PI) / 180);
  const toP = (p: LatLon): P => [
    (p.lon - spec.lon) * M_PER_DEG_LON * cos,
    (p.lat - spec.lat) * M_PER_DEG_LAT,
  ];
  const [w, s, e, n] = spec.extent;
  const bbox = [
    spec.lat + s / M_PER_DEG_LAT,
    spec.lon + w / (M_PER_DEG_LON * cos),
    spec.lat + n / M_PER_DEG_LAT,
    spec.lon + e / (M_PER_DEG_LON * cos),
  ]
    .map((v) => v.toFixed(6))
    .join(",");
  const ringsOf = (els: Element[]) =>
    els
      .flatMap((el) => (el.type === "relation" ? outerRings(el) : el.geometry ? [el.geometry] : []))
      .map((r) => r.map(toP));
  // The same lawn is often mapped twice (a park and its grass); each shape is kept once.
  const polygons = (els: Element[], minArea: number) => [
    ...new Map(
      ringsOf(els)
        .map((r) => simplify(clipRing(r, spec.extent), 1.2))
        .filter((r) => r.length >= 3 && area(r) >= minArea)
        .map(round)
        .map((r) => [r.join(","), r] as const),
    ).values(),
  ];

  const green = await overpass(
    `(way["leisure"~"^(park|garden)$"](${bbox});relation["leisure"~"^(park|garden)$"](${bbox});` +
      `way["landuse"~"^(grass|village_green|cemetery|recreation_ground)$"](${bbox});` +
      `relation["landuse"~"^(grass|village_green|cemetery)$"](${bbox}););out geom;`,
  );
  const water = await overpass(
    `(way["natural"="water"](${bbox});relation["natural"="water"](${bbox}););out geom;`,
  );
  // An outdoor public pool reads as water on a map (Boston's Frog Pond is one); small ones are
  // rooftop pools and are left out.
  const pools = await overpass(
    `way["leisure"="swimming_pool"]["access"!="private"]["indoor"!="yes"](${bbox});out geom;`,
  );
  const roads = await overpass(
    `way["highway"~"^(primary|secondary|tertiary|residential|unclassified|living_street|pedestrian)$"]["area"!="yes"](${bbox});out geom;`,
  );
  const foot = await overpass(`way["highway"~"^(footway|path)$"](${bbox});out geom;`);
  const named = await overpass(
    `(${spec.places.map((p) => `way["name"="${p.osm}"](${bbox});relation["name"="${p.osm}"](${bbox});`).join("")});out geom;`,
  );

  // The parks the footpaths are kept inside: the named parks of the place.
  const parkRings = ringsOf(green.filter((el) => el.tags?.["leisure"] === "park" && el.tags?.["name"]));
  const CLASS: Record<string, 1 | 2 | 3> = { primary: 1, secondary: 2, tertiary: 2 };
  const roadLines = roads.map((r) => ({
    name: r.tags?.["name"] ?? "",
    c: CLASS[r.tags?.["highway"] ?? ""] ?? 3,
    line: (r.geometry ?? []).map(toP),
  }));

  const streets: StreetLabel[] = spec.streets.flatMap((osm) => {
    const lines = roadLines.filter((r) => r.name === osm).map((r) => r.line);
    const at = labelSpots(lines).filter(([x, y]) => x > w && x < e && y > s && y < n);
    return at.length > 0 ? [{ name: shortName(osm), at }] : [];
  });

  const places: PlaceLabel[] = spec.places.flatMap((p) => {
    const rings = ringsOf(named.filter((el) => el.tags?.["name"] === p.osm));
    const biggest = rings.sort((a, b) => area(b) - area(a))[0];
    if (!biggest) return [];
    const [cx, cy] = centroid(biggest);
    const [dx, dy] = p.nudge ?? [0, 0];
    return [
      { name: p.name, kind: p.kind, at: [Math.round(cx + dx), Math.round(cy + dy)] as [number, number] },
    ];
  });

  return {
    version: 1,
    place: spec.place,
    source: `OpenStreetMap contributors, ODbL 1.0, via Overpass API, ${new Date().toISOString().slice(0, 10)}`,
    center: [Math.round(spec.lat * 1e7), Math.round(spec.lon * 1e7)],
    extent: spec.extent,
    view: [spec.view[0], spec.view[1], spec.view[2] - spec.view[0], spec.view[3] - spec.view[1]],
    parks: polygons(green, 150),
    water: [...polygons(water, 60), ...polygons(pools, 800)],
    roads: roadLines.flatMap((r) =>
      clipLine(r.line, spec.extent).map((run) => ({ c: r.c, d: round(simplify(run, 1.2)) })),
    ),
    paths: foot
      .filter((f) => !["sidewalk", "crossing", "traffic_island"].includes(f.tags?.["footway"] ?? ""))
      .map((f) => (f.geometry ?? []).map(toP))
      .flatMap((line) => {
        // Keep the stretches inside a park; the sidewalks along the streets are left to the streets.
        const runs: P[][] = [];
        let run: P[] = [];
        for (const p of line) {
          if (parkRings.some((r) => inRing(p, r))) run.push(p);
          else if (run.length > 0) {
            runs.push(run);
            run = [];
          }
        }
        if (run.length > 0) runs.push(run);
        return runs.filter((r) => r.length >= 2);
      })
      .map((r) => round(simplify(r, 1))),
    streets,
    places,
  };
}
