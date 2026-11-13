// Every sentence the replay says about the match. Short, plain, no protocol words.

import type { Match, MatchEvent } from "../model/match.ts";
import { snapshotAt } from "../model/match.ts";
import type { VerdictStatus } from "../verify/report.ts";
import type { Signer } from "../verify/signer.ts";

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
 * Where the target draw's randomness came from, as the end of a sentence. "The enclave" only when
 * the End verdict, which reveals the draw, has an attestation record for a published build.
 */
export function drawSource(s: Signer, endInEnclave: boolean): string {
  if (s === "enclave" && endInEnclave) return "the enclave's random source";
  if (s === "local" || s === "fixture") return "the test referee's random source";
  return "the referee's random source";
}
