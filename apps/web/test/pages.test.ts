// The pages with no film to play: what each relay answer and NEAR state leads to, and what the
// page then says.

import { afterEach, describe, expect, test } from "bun:test";
import { pageState } from "../src/replay/copy.ts";
import { loadBundle, type Source } from "../src/replay/load.ts";
import type { ChainMatch } from "../src/verify/anchor.ts";

const SOURCE: Source = {
  kind: "match",
  matchId: "ab".repeat(16),
  url: "https://relay.example/replay/x",
  from: "relay",
};
const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});
const answer = (status: number) => {
  globalThis.fetch = (async () => new Response("{}", { status })) as unknown as typeof fetch;
  return loadBundle(SOURCE);
};

describe("pages with no film", () => {
  test("a 410 says the trails were deleted, not to check the connection", async () => {
    expect(await answer(410)).toEqual({ kind: "purged" });
    const p = pageState({ kind: "purged" });
    expect(p).toMatchObject({ title: "This replay is gone", retry: false });
    expect(p.body).toContain("deleted this match's trails");
    expect(p.body).not.toContain("connection");
  });

  test("an aborted match says it was called off, with nothing to retry", () => {
    const chain = { phase: "aborted", settled_as: "refunded_abort" } as ChainMatch;
    expect(pageState({ kind: "not-finished", chain })).toEqual({
      title: "This match was called off",
      body: "It was called off before it ended and every stake was refunded, so there's nothing to replay.",
      retry: false,
    });
    const running = { phase: "running", end_ms: null } as unknown as ChainMatch;
    expect(pageState({ kind: "not-finished", chain: running })).toMatchObject({
      title: "This match isn't over yet",
      retry: true,
    });
  });

  test("a private replay with no sign-in sends a player to the TAIL app", async () => {
    expect(await answer(403)).toEqual({ kind: "private", refused: false });
    const p = pageState({ kind: "private", players: 4, refused: false });
    expect(p.title).toBe("This replay is private");
    expect(p.body).toBe(
      "The host kept it for the 4 players. If you played, open it from the TAIL app, which signs you in for one viewing.",
    );
    expect(p.retry).toBe(false);
  });
});
