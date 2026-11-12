// Writes the replay fixtures to public/fixtures for the page (it runs before dev, build and
// preview). The bundles themselves come from scripts/fixture.ts; see the warning there about
// the test keys.
//
//   bun apps/web/scripts/make-fixture.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_FILES, makeFixtures } from "./fixture.ts";

const dir = join(import.meta.dir, "..", "public", "fixtures");
mkdirSync(dir, { recursive: true });
const fx = makeFixtures();
for (const [variant, name] of Object.entries(FIXTURE_FILES))
  writeFileSync(join(dir, name), `${JSON.stringify(fx[variant as keyof typeof FIXTURE_FILES])}\n`);
console.log(`wrote ${Object.values(FIXTURE_FILES).join(", ")} to ${dir}`);
for (const line of fx.summary) console.log(line);
