// The proximity layer is game-agnostic: nothing in it may reach into TAIL's rules, screens or app
// state. Every relative import under src/proximity must stay inside it or land in one of the
// shared places below; packages (@tail/protocol, @noble/*, …) are fine.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const here = import.meta.dir;
const src = resolve(here, "..");
const app = resolve(src, "..");

/** Where proximity code may import from outside itself. */
const ALLOWED = [
  here,
  join(src, "lib"), // byte helpers
  join(app, "modules"), // native module types (the radio)
  join(app, "test"), // test helpers
  resolve(app, "../server/src"), // tests check against the relay's own code
];

/** Named so a violation says what it reached for. */
const FORBIDDEN = [
  join(src, "tail"),
  join(src, "screens"),
  join(src, "ui"),
  join(src, "preview"),
  join(src, "relay"),
  join(src, "state", "app.ts"),
  join(src, "App.tsx"),
];

const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);

function violations(file: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[1] as string;
    if (!spec.startsWith(".")) continue;
    const target = resolve(dirname(file), spec);
    const bad = FORBIDDEN.find((f) => inside(target, f) || target === f.replace(/\.tsx?$/, ""));
    if (bad || !ALLOWED.some((a) => inside(target, a)))
      out.push(`${relative(app, file)} imports ${spec}${bad ? ` (${relative(app, bad)})` : ""}`);
  }
  return out;
}

const files = (readdirSync(here, { recursive: true }) as string[])
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => join(here, f))
  // This file quotes forbidden imports as test data.
  .filter((f) => f !== import.meta.path);

describe("proximity boundary", () => {
  test("nothing in src/proximity imports TAIL's rules, screens, UI or app state", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.flatMap((f) => violations(f, readFileSync(f, "utf8")))).toEqual([]);
  });

  test("the scan catches every import form", () => {
    const f = join(here, "client.ts");
    const text = [
      'import { TailHunt } from "../tail/hunt";',
      'import type { Note } from "../tail/hunt";',
      'export { app } from "../state/app";',
      'const m = await import("../screens/Hunt");',
      'import "../ui/theme";',
      'import { RelayClient } from "../relay/client";',
      'import { fromB64 } from "../lib/b64";',
      'import { Outbox } from "./outbox";',
    ].join("\n");
    expect(violations(f, text)).toHaveLength(6);
  });
});
