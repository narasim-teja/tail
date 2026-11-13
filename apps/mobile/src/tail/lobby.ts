// Where a lobby stands and what each person in it can do now, from the relay's phase and the
// chain's record. The contract decides what is possible (contracts/tail lib.rs):
//   join_match   only while the lobby was never locked and its start time has not passed
//   leave_lobby  any time before Start except while the lock holds (`now < locked_until_ms`)
//   lock_lobby   once per match, so a lock that ran out is never taken again
//   Start        only while the lock holds and the start time has not passed
//   abort        a lobby whose start time passed or whose lock ran out; anyone may call it, but
//                a phone's key may not (PLAYER_METHODS), so the host asks the relay (POST cancel)
// "Starting" means a Start is in flight, nothing else: a lobby left locked by a Start that
// failed says so and offers what is still possible.

import type { ChainPhase, RelayPhase } from "../relay/client";
import { handleOf } from "./huntModel";

export type LobbyState =
  | { kind: "loading" }
  | { kind: "waiting"; need: number }
  | { kind: "ready" }
  | { kind: "starting" }
  /** The last Start failed before the referee answered; the host can start it again. */
  | { kind: "retry"; reason: string }
  /**
   * The referee answered the last Start with a failure, so this lobby never starts. Its lock
   * still holds until `freeAtMs` (null: it holds none); then players may leave, the host call it off.
   */
  | { kind: "dead"; reason: string; freeAtMs: number | null }
  /** The lock ran out, or the start time passed, before a Start landed: it can never start now. */
  | { kind: "lapsed"; why: "lock" | "deadline" }
  | { kind: "aborted" };

/** What this person can do in the lobby now, each only when the chain would take it. */
export interface LobbyMay {
  join: boolean;
  leave: boolean;
  start: boolean;
  /** Host only: the relay aborts the lobby on chain and every stake goes back. */
  callOff: boolean;
}

export interface LobbyFacts {
  /** The relay's view; null before the first read. */
  match: {
    phase: RelayPhase;
    chain: {
      phase: ChainPhase;
      lockedUntilMs: number | null;
      startByMs: number;
      minPlayers: number;
      players: number;
    } | null;
  } | null;
  isHost: boolean;
  joined: boolean;
  /** This phone's own Start call is in flight. */
  startPending: boolean;
  /** Why the last Start failed, as the relay put it (raw; startProblem words it). */
  startError: string | null;
  nowMs: number;
}

const NOTHING: LobbyMay = { join: false, leave: false, start: false, callOff: false };

export function lobbyState(f: LobbyFacts): { state: LobbyState; may: LobbyMay } {
  const m = f.match;
  const c = m?.chain;
  if (!m) return { state: { kind: "loading" }, may: NOTHING };
  if (c?.phase === "aborted") return { state: { kind: "aborted" }, may: NOTHING };
  if (m.phase === "starting" || f.startPending) return { state: { kind: "starting" }, may: NOTHING };
  if (c?.phase !== "lobby") return { state: { kind: "loading" }, may: NOTHING };

  const locked = c.lockedUntilMs !== null && f.nowMs < c.lockedUntilMs;
  const lockRanOut = c.lockedUntilMs !== null && !locked;
  const pastStart = f.nowMs > c.startByMs;
  const may: LobbyMay = {
    join: !f.joined && c.lockedUntilMs === null && !pastStart && m.phase === "lobby",
    leave: f.joined && !locked,
    start: false,
    callOff: f.isHost && (lockRanOut || pastStart),
  };
  if (lockRanOut || pastStart)
    return { state: { kind: "lapsed", why: lockRanOut ? "lock" : "deadline" }, may };
  if (m.phase === "failed") {
    return {
      state: { kind: "dead", reason: startProblem(f.startError), freeAtMs: locked ? c.lockedUntilMs : null },
      may,
    };
  }
  const start = { ...may, start: f.isHost && f.joined && c.players >= c.minPlayers };
  // Locked by a Start that failed: the relay reuses the lock, so the host can simply try again.
  if (locked) return { state: { kind: "retry", reason: startProblem(f.startError) }, may: start };
  if (c.players < c.minPlayers) {
    return { state: { kind: "waiting", need: c.minPlayers - c.players }, may: { ...may, start: false } };
  }
  if (f.startError) return { state: { kind: "retry", reason: startProblem(f.startError) }, may: start };
  return { state: { kind: "ready" }, may: start };
}

const names = (list: string) =>
  list
    .split(",")
    .map((a) => handleOf(a.trim()))
    .filter(Boolean);

const joinNames = (n: string[]) =>
  n.length <= 1 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} and ${n.at(-1)}`;

/**
 * A failed Start in plain words. The relay's own texts (apps/server src/matches.ts start,
 * enroll.ts ensureWithReferee, app.ts onError) are matched; anything else gets a general line,
 * so no raw relay or NEAR text reaches the screen.
 */
export function startProblem(raw: string | null): string {
  if (!raw) return "The last start stopped partway.";
  let m = /^the referee does not know these players yet[^:]*: (.+)$/.exec(raw);
  if (m?.[1]) {
    const n = names(m[1]);
    return `${joinNames(n)} ${n.length === 1 ? "needs" : "need"} to open TAIL so the referee knows their phone.`;
  }
  m = /^not enrolled here: (.+)$/.exec(raw);
  if (m?.[1]) {
    const n = names(m[1]);
    return `${joinNames(n)} ${n.length === 1 ? "isn't" : "aren't"} set up with this relay.`;
  }
  if (/^need \d+ players/.test(raw)) return "Not enough players yet.";
  if (/^the lobby lock ran out/.test(raw)) return "The lobby's hold ran out before the referee answered.";
  if (/made for another referee/.test(raw)) return "This lobby was made for another referee. Make a new one.";
  if (/^another relay process holds/.test(raw))
    return "The relay is busy with this lobby. Try again in a moment.";
  if (/zone was deleted/.test(raw)) return "The relay no longer has this lobby's zone. Make a new one.";
  if (/^match is not on chain/.test(raw)) return "NEAR doesn't show this lobby yet. Try again in a moment.";
  if (/^match is starting/.test(raw)) return "A start is already under way.";
  if (/^Can't reach the relay|^The relay didn't answer/.test(raw)) {
    return "Couldn't reach the relay. Check your connection.";
  }
  // Transport failures first: "referee start: request failed: …" is no refusal.
  if (
    /referee (isn't|didn't) answer/i.test(raw) ||
    /^referee \w+: (request failed|HTTP \d|not answering|local referee exited|unexpected answer|answer)/.test(
      raw,
    )
  ) {
    return "The referee didn't answer.";
  }
  if (/^referee start (returned|times)/.test(raw)) return "The referee's answer didn't check out.";
  if (/^The referee refused|^referee start: /.test(raw)) return "The referee turned the start down.";
  return "Something went wrong on the relay.";
}
