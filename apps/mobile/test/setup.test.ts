import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { colors } from "@tail/brand";
import { color } from "../src/ui/theme";

const pkg = (p: string) =>
  JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")) as { dependencies: Record<string, string> };

describe("app setup", () => {
  test("the app pins the same @noble versions as @tail/protocol, which runs on them", () => {
    const app = pkg("../package.json").dependencies;
    const protocol = pkg("../../../packages/protocol/package.json").dependencies;
    for (const [name, version] of Object.entries(protocol)) expect(app[name]).toBe(version);
  });

  test("every colour token is a brand colour", () => {
    const brand: string[] = Object.values(colors);
    for (const c of Object.values(color)) expect(brand).toContain(c);
  });
});
