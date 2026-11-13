// Writes the replay fixtures to public/fixtures for the page (it runs before dev, build and
// preview). The bundles themselves come from scripts/fixture.ts; see the warning there about
// the test keys. The economy fixture comes from the Rust engine (scripts/economy-fixture.ts).
// Beside them: the front page's scene of the Boston Common match (scripts/scene.ts) and
// demos.json, the facts of each demo the front page offers, read from each bundle.
//
//   bun apps/web/scripts/make-fixture.ts

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DemoFacts } from "../src/landing/demos.ts";
import { decodeBundle } from "../src/verify/bundle.ts";
import { prepare } from "../src/verify/index.ts";
import { ECONOMY_FILE, writeEconomyFixture } from "./economy-fixture.ts";
import { FIXTURE_FILES, makeFixtures } from "./fixture.ts";
import { FIXTURE_DECIMALS, sceneOfMatch, survivorsOf } from "./scene.ts";

const dir = join(import.meta.dir, "..", "public", "fixtures");
mkdirSync(dir, { recursive: true });
const fx = makeFixtures();
for (const [variant, name] of Object.entries(FIXTURE_FILES))
  writeFileSync(join(dir, name), `${JSON.stringify(fx[variant as keyof typeof FIXTURE_FILES])}\n`);
console.log(`wrote ${Object.values(FIXTURE_FILES).join(", ")} to ${dir}`);
for (const line of fx.summary) console.log(line);
console.log(writeEconomyFixture(dir));

const matchOf = (bundle: unknown) => prepare(decodeBundle(JSON.parse(JSON.stringify(bundle)))).match;
const full = matchOf(fx.full);
writeFileSync(
  join(dir, "boston-common.scene.json"),
  `${JSON.stringify(sceneOfMatch(full, "fixture", "Boston Common", FIXTURE_DECIMALS))}\n`,
);
const facts = (name: string, m: ReturnType<typeof matchOf>): DemoFacts => ({
  name,
  players: m.players.length,
  minutes: Math.round(m.durationMs / 60_000),
  survivors: survivorsOf(m),
});
const demos: DemoFacts[] = [
  facts("boston-common", full),
  facts("boston-common-tampered", matchOf(fx.tampered)),
  facts("boston-common-tampered-log", matchOf(fx.tamperedLog)),
];
const economy = join(dir, ECONOMY_FILE);
if (existsSync(economy))
  demos.push(facts("boston-common-economy", matchOf(JSON.parse(readFileSync(economy, "utf8")))));
writeFileSync(join(dir, "demos.json"), `${JSON.stringify(demos)}\n`);
console.log(`wrote boston-common.scene.json and demos.json (${demos.map((d) => d.name).join(", ")})`);
