// Fetches the walking paths inside Boston Common from OpenStreetMap (Overpass API) and writes
// them to scripts/data/common-paths.json, which make-fixture.ts walks its players along. Run it
// only to refresh the snapshot: the fixture must stay reproducible without the network.
// Data © OpenStreetMap contributors, ODbL 1.0.
//
//   bun apps/replay/scripts/fetch-paths.ts

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const OVERPASS = "https://overpass-api.de/api/interpreter";
const BBOX = "42.3515,-71.0710,42.3580,-71.0615";

type LatLon = { lat: number; lon: number };
interface Way {
  type: "way";
  id: number;
  tags?: Record<string, string>;
  geometry?: LatLon[];
}
interface Relation {
  type: "relation";
  members: { type: string; role: string; geometry?: LatLon[] }[];
}

async function overpass<T>(query: string): Promise<T[]> {
  const res = await fetch(OVERPASS, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "tail-replay-fixture/1" },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`Overpass answered ${res.status}`);
  return ((await res.json()) as { elements: T[] }).elements;
}

/** Joins the relation's outer ways end to end into one closed ring. */
function outerRing(rel: Relation): LatLon[] {
  const parts = rel.members
    .filter((m) => m.role === "outer" && m.geometry)
    .map((m) => [...(m.geometry ?? [])]);
  const same = (a: LatLon | undefined, b: LatLon | undefined) =>
    !!a && !!b && a.lat === b.lat && a.lon === b.lon;
  const ring = parts.shift() ?? [];
  while (parts.length > 0) {
    const tail = ring.at(-1);
    const i = parts.findIndex((p) => same(p[0], tail) || same(p.at(-1), tail));
    if (i < 0) throw new Error("the park outline does not close");
    const [next] = parts.splice(i, 1);
    if (!next) break;
    if (!same(next[0], tail)) next.reverse();
    ring.push(...next.slice(1));
  }
  return ring;
}

function inside(p: LatLon, ring: LatLon[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as LatLon;
    const b = ring[j] as LatLon;
    if (
      a.lat > p.lat !== b.lat > p.lat &&
      p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon
    )
      hit = !hit;
  }
  return hit;
}

const [park] = await overpass<Relation>(
  `[out:json][timeout:50];relation["leisure"="park"]["name"="Boston Common"];out geom;`,
);
if (!park) throw new Error("Boston Common not found");
const ring = outerRing(park);
const ways = await overpass<Way>(
  `[out:json][timeout:50];way["highway"~"^(footway|path|pedestrian)$"](${BBOX});out geom;`,
);
const paths = ways
  .filter((w) => !["sidewalk", "crossing", "traffic_island"].includes(w.tags?.["footway"] ?? ""))
  .map((w) => (w.geometry ?? []).filter((p) => inside(p, ring)))
  .filter((g) => g.length >= 2)
  .map((g) => g.map((p) => [Math.round(p.lon * 1e7), Math.round(p.lat * 1e7)]));

const out = join(import.meta.dir, "data", "common-paths.json");
writeFileSync(
  out,
  `${JSON.stringify({
    source: "OpenStreetMap contributors, ODbL 1.0, via Overpass API",
    note: "Walking paths inside Boston Common as [lonE7, latE7] polylines.",
    outline: ring.map((p) => [Math.round(p.lon * 1e7), Math.round(p.lat * 1e7)]),
    paths,
  })}\n`,
);
console.log(`wrote ${paths.length} paths and a ${ring.length}-point outline to ${out}`);
