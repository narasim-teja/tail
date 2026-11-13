// Every sentence the replay says about the match. Short, plain, no protocol words.

import type { ReplayBundle } from "@tail/protocol";
import type { Match, MatchEvent } from "../model/match.ts";
import { snapshotAt } from "../model/match.ts";
import type { VerdictStatus } from "../verify/report.ts";
import type { Source } from "./load.ts";

const name = (m: Match, i: number | undefined) =>
  i === undefined ? "Someone" : (m.players[i]?.name ?? "Someone");

export function eventLine(m: Match, e: MatchEvent): string {
  switch (e.kind) {
    case "tag":
      return `${name(m, e.a)} tagged ${name(m, e.b)}`;
    case "hint":
      return `${name(m, e.a)} asked the Handler`;
    case "forfeit":
      return e.leftZone ? `${name(m, e.a)} left the zone` : `${name(m, e.a)} went dark`;
    case "start":
      return "The hunt starts";
    case "end":
      return endLine(m);
    case "checkpoint":
      return "Saved to NEAR";
  }
}

export function endLine(m: Match): string {
  const s = snapshotAt(m, m.durationMs);
  const left = m.players.filter((p) => s.alive[p.index]).map((p) => p.name);
  if (left.length === 1) return `${left[0]} is the last one standing`;
  return `Time. ${list(left)} ${left.length === 2 ? "both" : "all"} made it`;
}

export function list(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export const statusLabel: Record<VerdictStatus, string> = {
  pending: "Checking",
  verified: "Matches NEAR",
  unanchored: "Signed, not on NEAR",
  mismatch: "Doesn't match NEAR",
};

/**
 * Who signed this match's verdicts: the referee in OutLayer's enclave, the local test referee
 * (the same code run on the relay's machine while OutLayer is unavailable), or the fixture's
 * public test key. Only the first has an enclave record behind it.
 */
export type Signer = "enclave" | "local" | "fixture";

export function signerOf(source: Source, bundle: ReplayBundle): Signer {
  if (source.kind === "fixture") return "fixture";
  return bundle.referee.kind === "local" ? "local" : "enclave";
}

/** Where the target draw's randomness came from, as the end of a sentence. */
export function drawSource(s: Signer): string {
  return s === "enclave" ? "the enclave's random source" : "the test referee's random source";
}
