import { describe, expect, test } from "bun:test";
import { autoBrief, type RouteFacts, routeFor } from "./route";

const base: RouteFacts = {
  ready: true,
  enrolled: true,
  primerSeen: true,
  matchId: "m",
  page: null,
  resultsNow: false,
  session: null,
  phase: "running",
  out: false,
};

describe("which screen shows", () => {
  test("first run: loading, enrol, primer, then home or the page opened from it", () => {
    expect(routeFor({ ...base, ready: false })).toBe("loading");
    expect(routeFor({ ...base, enrolled: false })).toBe("enrol");
    expect(routeFor({ ...base, primerSeen: false })).toBe("primer");
    expect(routeFor({ ...base, matchId: null })).toBe("home");
    expect(routeFor({ ...base, matchId: null, page: "profile" })).toBe("profile");
  });

  test("a running hunt session decides: hunt until over, then results", () => {
    expect(routeFor({ ...base, session: { over: false, shown: true } })).toBe("hunt");
    expect(routeFor({ ...base, session: { over: true, shown: true } })).toBe("results");
  });

  test("the session reports from the moment the orders open; Hunt only leaves the briefing", () => {
    expect(routeFor({ ...base, session: { over: false, shown: false } })).toBe("briefing");
    expect(routeFor({ ...base, session: { over: true, shown: false } })).toBe("results");
  });

  test("reopened mid-match: briefing while still in, results once the chain says you are out", () => {
    expect(routeFor(base)).toBe("briefing");
    expect(routeFor({ ...base, out: true })).toBe("results");
    expect(routeFor({ ...base, phase: "ending", out: true })).toBe("results");
  });

  test("lobby before the start, results after the end, and results on request", () => {
    expect(routeFor({ ...base, phase: "lobby" })).toBe("lobby");
    expect(routeFor({ ...base, phase: undefined })).toBe("lobby");
    expect(routeFor({ ...base, phase: "ended" })).toBe("results");
    expect(routeFor({ ...base, resultsNow: true, session: { over: false, shown: true } })).toBe("results");
  });
});

describe("the briefing reads the orders by itself", () => {
  test("when nothing is in flight and its own last try did not fail; another action's error does not stop it", () => {
    const idle = { briefed: false, busy: null, briefError: null };
    expect(autoBrief(idle)).toBe(true);
    expect(autoBrief({ ...idle, briefed: true })).toBe(false);
    // The host's own Start may still run when the match goes live: wait for it.
    expect(autoBrief({ ...idle, busy: "Starting" })).toBe(false);
    // Its own failure waits for Try again, so it does not loop.
    expect(autoBrief({ ...idle, briefError: "The match is not on chain yet." })).toBe(false);
  });
});
