// Writes the economy fixture, public/fixtures/boston-common-economy.json: a 12-player, 60-minute
// match on Boston Common played through the real referee engine (referee-core) by scripted
// walkers, from crates/referee-verify/examples/economy-bundle.rs. Its bundle passes
// `tail-verify --strict`; the keys in it are public test keys, never used on NEAR.
//
// The match takes about a minute to play in a debug build, so it is played again only when the
// example binary is newer than the file (cargo rebuilds it whenever the engine, the protocol or
// the example change). Without cargo the fixture is skipped and the page says it is missing.
//
//   bun apps/web/scripts/economy-fixture.ts

import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ECONOMY_FILE = "boston-common-economy.json";

const root = join(import.meta.dir, "..", "..", "..");

export function writeEconomyFixture(dir: string): string {
  const out = join(dir, ECONOMY_FILE);
  if (!Bun.which("cargo")) return `skipped ${ECONOMY_FILE}: cargo is not installed`;
  const build = Bun.spawnSync(
    ["cargo", "build", "-q", "-p", "referee-verify", "--example", "economy-bundle"],
    {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (build.exitCode !== 0) throw new Error("cargo could not build the economy-bundle example");
  const bin = join(
    process.env["CARGO_TARGET_DIR"] ?? join(root, "target"),
    "debug",
    "examples",
    "economy-bundle",
  );
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(bin).mtimeMs)
    return `${ECONOMY_FILE} is up to date`;
  const run = Bun.spawnSync([bin], { cwd: root, stdout: "pipe", stderr: "inherit" });
  if (run.exitCode !== 0) throw new Error("the economy-bundle example failed");
  writeFileSync(out, run.stdout);
  return `wrote ${ECONOMY_FILE} (${Math.round(run.stdout.length / 1024)} KB)`;
}

if (import.meta.main) console.log(writeEconomyFixture(join(import.meta.dir, "..", "public", "fixtures")));
