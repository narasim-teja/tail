// Fetches Boston Common from OpenStreetMap (Overpass API) for two uses, and writes snapshots so
// nothing else needs the network:
//
//   scripts/data/common-paths.json   the walking paths inside the park, which make-fixture.ts
//                                    walks its generated players along
//   public/maps/<name>.json          the front page's map of a place (src/landing/map.ts): lawns,
//                                    water, streets and their names, drawn under the hero's match
//
// Run it only to refresh a snapshot. Data © OpenStreetMap contributors, ODbL 1.0.
//
//   bun apps/web/scripts/fetch-paths.ts                 the paths and every map below
//   bun apps/web/scripts/fetch-paths.ts --map <name>    one map only
//
// A match published in another park needs that park's map: add it to MAPS (its centre, the box
// to fetch, the box the hero frames, the streets and places to name), run with --map, commit the
// file, and publish with `publish-match.ts --map <name>`.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchMap, type MapSpec, outerRings, overpass } from "./osm-map.ts";

const MAPS: Record<string, MapSpec> = {
  "boston-common": {
    place: "Boston Common",
    // The generated match's zone centre (scripts/fixture.ts), so it sits where the map is drawn.
    lat: 42.35505,
    lon: -71.06565,
    extent: [-820, -520, 620, 520],
    view: [-640, -370, 420, 380],
    streets: [
      "Beacon Street",
      "Tremont Street",
      "Boylston Street",
      "Charles Street",
      "Park Street",
      "Arlington Street",
    ],
    places: [
      { osm: "Boston Common", name: "Boston Common", kind: "park", nudge: [60, -150] },
      { osm: "Frog Pond", name: "Frog Pond", kind: "water", nudge: [0, -42] },
      { osm: "Boston Public Garden", name: "Public Garden", kind: "park", nudge: [0, -120] },
      { osm: "Massachusetts State House", name: "State House", kind: "place" },
    ],
  },
};

type LatLon = { lat: number; lon: number };

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

async function writePaths() {
  const BBOX = "42.3515,-71.0710,42.3580,-71.0615";
  const [park] = await overpass(`relation["leisure"="park"]["name"="Boston Common"];out geom;`);
  if (!park) throw new Error("Boston Common not found");
  const [ring] = outerRings(park);
  if (!ring) throw new Error("the park outline does not close");
  const ways = await overpass(`way["highway"~"^(footway|path|pedestrian)$"](${BBOX});out geom;`);
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
}

async function writeMap(name: string) {
  const spec = MAPS[name];
  if (!spec) throw new Error(`no map called ${name}; known: ${Object.keys(MAPS).join(", ")}`);
  const map = await fetchMap(spec);
  const out = join(import.meta.dir, "..", "public", "maps", `${name}.json`);
  const body = `${JSON.stringify(map)}\n`;
  writeFileSync(out, body);
  console.log(
    `wrote ${out}: ${map.parks.length} lawns, ${map.water.length} water, ${map.roads.length} streets, ` +
      `${map.paths.length} paths, ${map.streets.length} street names, ${map.places.length} places, ${body.length} bytes`,
  );
}

const only = process.argv.indexOf("--map");
if (only >= 0) {
  const name = process.argv[only + 1];
  if (!name) throw new Error("--map needs a name");
  await writeMap(name);
} else {
  await writePaths();
  for (const name of Object.keys(MAPS)) await writeMap(name);
}
