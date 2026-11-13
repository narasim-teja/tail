// scripts/publish-match.ts: a private match is never published; a public one is written with its
// scene, listed first, and the script says the file holds every player's trail.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixtures } from "../scripts/fixture.ts";
import { PublishError, publishMatch } from "../scripts/publish-match.ts";
import { parseIndex } from "../src/lib/published.ts";

const fx = makeFixtures();
const ID = "ab".repeat(16);
const entry = (over: Record<string, unknown> = {}) => ({
  id: ID,
  place: "Boston Common",
  playedAt: "2026-11-13T19:04:00.000Z",
  players: 3,
  minutes: 20,
  ...over,
});

describe("publishing a match", () => {
  const six = async () => 6;
  const relay = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const id = fx.full.match.id;

  test("a private match is refused and nothing is written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tail-publish-"));
    const run = (f: typeof fetch) =>
      publishMatch({ id, place: "Boston Common", dir, fetch: f, tokenDecimals: six });
    await expect(run(relay(403, { error: "private" }))).rejects.toThrow("private");
    const notPublic = { ...fx.full, match: { ...fx.full.match, publicReplay: false } };
    await expect(run(relay(200, notPublic))).rejects.toThrow(PublishError);
    await expect(run(relay(200, notPublic))).rejects.toThrow("private");
    await expect(run(relay(409, {}))).rejects.toThrow("hasn't finished");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a public match is written with its scene and listed first, with a warning about trails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tail-publish-"));
    writeFileSync(join(dir, "index.json"), JSON.stringify([entry({ featured: true })]));
    const lines = await publishMatch({
      id,
      place: "Boston Common",
      dir,
      featured: true,
      fetch: relay(200, fx.full),
      tokenDecimals: six,
    });
    const index = parseIndex(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")));
    expect(index.map((m) => [m.id, m.featured ?? false])).toEqual([
      [id, true],
      [ID, false],
    ]);
    expect(index[0]).toMatchObject({ players: 5, minutes: 20, survivors: 2 });
    expect(readdirSync(dir).sort()).toEqual([`${id}.json`, `${id}.scene.json`, "index.json"].sort());
    expect(lines.join("\n")).toContain("EVERY PLAYER'S LOCATION TRAIL");
  });

  test("a public match names its place's map only if the map is there, and needs its token's decimals", async () => {
    const root = mkdtempSync(join(tmpdir(), "tail-publish-"));
    const dir = join(root, "matches");
    const run = (o: { map?: string; tokenDecimals?: () => Promise<number | null> }) =>
      publishMatch({ id, place: "Boston Common", dir, fetch: relay(200, fx.full), tokenDecimals: six, ...o });
    await expect(run({ map: "boston-common" })).rejects.toThrow("no map public/maps/boston-common.json");
    await expect(run({ map: "../etc" })).rejects.toThrow("map name");
    await expect(run({ tokenDecimals: async () => null })).rejects.toThrow("decimals");
    mkdirSync(join(root, "maps"));
    writeFileSync(join(root, "maps", "boston-common.json"), "{}");
    await run({ map: "boston-common" });
    const index = parseIndex(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")));
    expect(index[0]?.map).toBe("boston-common");
    const scene = JSON.parse(readFileSync(join(dir, `${id}.scene.json`), "utf8"));
    expect(scene.decimals).toBe(6);
  });
});
