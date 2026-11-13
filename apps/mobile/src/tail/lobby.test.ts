import { describe, expect, test } from "bun:test";
import { type LobbyFacts, lobbyState, startProblem } from "./lobby";

const NOW = 1_800_000_000_000;
const LOCK_MS = 600_000;

/** A full lobby of three, its host looking at it, nothing in flight. */
const facts = (
  o: Partial<Omit<LobbyFacts, "match">> & {
    phase?: "lobby" | "starting" | "failed";
    chain?: Partial<NonNullable<NonNullable<LobbyFacts["match"]>["chain"]>>;
  } = {},
): LobbyFacts => {
  const { phase = "lobby", chain = {}, ...rest } = o;
  return {
    match: {
      phase,
      chain: {
        phase: "lobby",
        lockedUntilMs: null,
        startByMs: NOW + 3_600_000,
        minPlayers: 3,
        players: 3,
        ...chain,
      },
    },
    isHost: true,
    joined: true,
    startPending: false,
    startError: null,
    nowMs: NOW,
    ...rest,
  };
};

describe("the lobby's state", () => {
  test("open: waiting for players, then ready; the host may start, anyone in may leave", () => {
    expect(lobbyState(facts({ chain: { players: 2 } }))).toEqual({
      state: { kind: "waiting", need: 1 },
      may: { join: false, leave: true, start: false, callOff: false },
    });
    expect(lobbyState(facts())).toEqual({
      state: { kind: "ready" },
      may: { join: false, leave: true, start: true, callOff: false },
    });
    expect(lobbyState(facts({ isHost: false, joined: false })).may).toEqual({
      join: true,
      leave: false,
      start: false,
      callOff: false,
    });
  });

  test("starting only while a Start is in flight: this phone's own call, or the relay's phase", () => {
    const starting = {
      state: { kind: "starting" as const },
      may: { join: false, leave: false, start: false, callOff: false },
    };
    expect(lobbyState(facts({ startPending: true }))).toEqual(starting);
    expect(lobbyState(facts({ phase: "starting", chain: { lockedUntilMs: NOW + LOCK_MS } }))).toEqual(
      starting,
    );
  });

  test("locked by a Start that failed: Start didn't go through, why in plain words, the host tries again", () => {
    const f = facts({
      chain: { lockedUntilMs: NOW + LOCK_MS },
      startError: "referee start: request failed: timeout",
    });
    expect(lobbyState(f)).toEqual({
      state: { kind: "retry", reason: "The referee didn't answer." },
      // The lock holds: nobody can join or leave, but the relay reuses it for another Start.
      may: { join: false, leave: false, start: true, callOff: false },
    });
    expect(lobbyState({ ...f, isHost: false }).may).toEqual({
      join: false,
      leave: false,
      start: false,
      callOff: false,
    });
  });

  test("the lock ran out: it can never start; players may leave and the host may call it off", () => {
    const f = facts({ chain: { lockedUntilMs: NOW - 1 }, startError: "the lobby lock ran out; …" });
    expect(lobbyState(f)).toEqual({
      state: { kind: "lapsed", why: "lock" },
      may: { join: false, leave: true, start: false, callOff: true },
    });
    // At the very millisecond the lock ends, the contract no longer counts it as held.
    expect(lobbyState({ ...f, nowMs: NOW - 1 }).state.kind).toBe("lapsed");
    expect(lobbyState({ ...f, isHost: false }).may).toEqual({
      join: false,
      leave: true,
      start: false,
      callOff: false,
    });
    // Someone not in it can do nothing: a lock that ever was closes joins for good.
    expect(lobbyState({ ...f, isHost: false, joined: false }).may).toEqual({
      join: false,
      leave: false,
      start: false,
      callOff: false,
    });
  });

  test("the start time passed: the same, even unlocked", () => {
    expect(lobbyState(facts({ nowMs: NOW + 3_600_001 }))).toEqual({
      state: { kind: "lapsed", why: "deadline" },
      may: { join: false, leave: true, start: false, callOff: true },
    });
  });

  test("a Start the referee answered with a failure: no retry; the way out opens when the lock ends", () => {
    const f = facts({
      phase: "failed",
      chain: { lockedUntilMs: NOW + LOCK_MS },
      startError: "referee start: match already started",
    });
    expect(lobbyState(f)).toEqual({
      state: { kind: "dead", reason: "The referee turned the start down.", freeAtMs: NOW + LOCK_MS },
      may: { join: false, leave: false, start: false, callOff: false },
    });
    expect(lobbyState({ ...f, nowMs: NOW + LOCK_MS })).toMatchObject({
      state: { kind: "lapsed", why: "lock" },
      may: { leave: true, callOff: true },
    });
  });

  test("an unlocked lobby whose Start failed still says why, once it has the players", () => {
    const startError = "not enrolled here: maya.tail.testnet";
    expect(lobbyState(facts({ startError })).state).toEqual({
      kind: "retry",
      reason: "maya isn't set up with this relay.",
    });
    expect(lobbyState(facts({ startError, chain: { players: 2 } })).state).toEqual({
      kind: "waiting",
      need: 1,
    });
  });

  test("loading before the relay answers; called off once the chain aborted it", () => {
    expect(lobbyState({ ...facts(), match: null }).state).toEqual({ kind: "loading" });
    expect(lobbyState(facts({ phase: "failed", chain: { phase: "aborted" } }))).toEqual({
      state: { kind: "aborted" },
      may: { join: false, leave: false, start: false, callOff: false },
    });
  });
});

describe("a failed Start in plain words", () => {
  test("the relay's own texts", () => {
    const cases: [string, string][] = [
      [
        "the referee does not know these players yet; each must open the app to refresh: maya.tail.testnet, sam.tail.testnet",
        "maya and sam need to open TAIL so the referee knows their phone.",
      ],
      ["need 3 players, have 2", "Not enough players yet."],
      [
        "this lobby was made for another referee than the one this relay runs; make a new one",
        "This lobby was made for another referee. Make a new one.",
      ],
      ["The referee didn't answer. Try again.", "The referee didn't answer."],
      ["The referee isn't answering right now. Try again in a minute.", "The referee didn't answer."],
      ["referee devices: HTTP 502: bad gateway", "The referee didn't answer."],
      ["The referee refused: referee start: zero stake", "The referee turned the start down."],
      ["referee start returned no Start verdict", "The referee's answer didn't check out."],
      ["Can't reach the relay (Network request failed).", "Couldn't reach the relay. Check your connection."],
      ["another relay process holds this match", "The relay is busy with this lobby. Try again in a moment."],
    ];
    for (const [raw, line] of cases) expect(startProblem(raw)).toBe(line);
  });

  test("anything else, a NEAR error above all, gets a general line and never the raw text", () => {
    const raw = "Smart contract panicked: lobby was already locked";
    expect(startProblem(raw)).toBe("Something went wrong on the relay.");
    expect(startProblem(null)).toBe("The last start stopped partway.");
  });
});
