// Published matches: the site's list, and where a match link's bundle is read from (the site's
// copy of a listed match, else the relay, as before the site published any).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { featuredOf, parseIndex } from "../src/lib/published.ts";
import { loadBundle, resolveSource } from "../src/replay/load.ts";

const ID = "ab".repeat(16);
const entry = (over: Record<string, unknown> = {}) => ({
  id: ID,
  place: "Boston Common",
  playedAt: "2026-11-13T19:04:00.000Z",
  players: 3,
  minutes: 20,
  ...over,
});

describe("where a match's bundle is read from", () => {
  const listed = async () => parseIndex([entry()]);
  test("a match the site publishes is read from the site's copy, not the relay", async () => {
    expect(await resolveSource(`?match=${ID}`, listed, "/")).toEqual({
      kind: "match",
      matchId: ID,
      url: `/matches/${ID}.json`,
      from: "site",
    });
  });

  test("any other match, a link naming a relay, or an unreadable list goes to the relay as before", async () => {
    const other = "cd".repeat(16);
    expect(await resolveSource(`?match=${other}`, listed, "/")).toMatchObject({
      from: "relay",
      matchId: other,
    });
    expect(await resolveSource(`?match=${ID}&relay=https://r.example`, listed, "/")).toEqual({
      kind: "match",
      matchId: ID,
      url: `https://r.example/replay/${ID}`,
      from: "relay",
    });
    expect(await resolveSource(`?match=${ID}`, async () => null, "/")).toMatchObject({ from: "relay" });
    expect((await resolveSource("?fixture=boston-common", listed, "/")).kind).toBe("fixture");
  });

  test("a player's sign-in goes only to the relay, never with the site's public copy", async () => {
    const urls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: string) => {
      urls.push(String(u));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const signIn = { accountId: "ana.testnet", nonce: "n", sig: "s" };
      await loadBundle({ kind: "match", matchId: ID, url: "/matches/x.json", from: "site" }, signIn);
      await loadBundle(
        { kind: "match", matchId: ID, url: "https://r.example/replay/x", from: "relay" },
        signIn,
      );
    } finally {
      globalThis.fetch = real;
    }
    expect(urls[0]).toBe("/matches/x.json");
    expect(urls[1]).toContain("account_id=ana.testnet");
  });
});

describe("the published list", () => {
  test("reads the documented shape, newest first, and finds the featured match", () => {
    const list = parseIndex([entry({ id: "cd".repeat(16), survivors: 1 }), entry({ featured: true })]);
    expect(list[0]).toEqual(entry({ id: "cd".repeat(16), survivors: 1 }));
    expect(featuredOf(list)?.id).toBe(ID);
    expect(featuredOf(parseIndex([entry()]))?.id).toBe(ID);
    expect(featuredOf([])).toBeNull();
    expect(parseIndex([])).toEqual([]);
  });

  test("anything else is refused whole, not shown as fewer matches", () => {
    expect(() => parseIndex({})).toThrow("isn't a list");
    expect(() => parseIndex([entry({ id: "AB".repeat(16) })])).toThrow("entry 0: id");
    expect(() => parseIndex([entry(), entry()])).toThrow("listed twice");
    expect(() => parseIndex([entry({ playedAt: "yesterday" })])).toThrow("playedAt");
    expect(() => parseIndex([entry({ players: 2.5 })])).toThrow("players");
    expect(() => parseIndex([entry({ survivors: 4 })])).toThrow("survivors");
    expect(() => parseIndex([entry({ place: " " })])).toThrow("place");
    expect(() => parseIndex([entry({ map: "../x" })])).toThrow("map");
    expect(parseIndex([entry({ map: "boston-common" })])[0]?.map).toBe("boston-common");
  });

  test("the committed list parses (it ships empty until a match is published)", () => {
    const committed = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "public", "matches", "index.json"), "utf8"),
    );
    expect(() => parseIndex(committed)).not.toThrow();
  });
});
