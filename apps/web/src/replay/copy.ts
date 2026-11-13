// Every sentence the replay says about the match. Short, plain, no protocol words.

import type { Match, MatchEvent } from "../model/match.ts";
import { snapshotAt } from "../model/match.ts";
import type { VerdictStatus } from "../verify/report.ts";
import type { Settlement } from "../verify/settle.ts";
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

/** How a player the referee enrolled without an Apple attestation is named everywhere. */
export const TEST_PLAYER = "test player (no Apple attestation)";

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

/** The principle behind every settlement line. */
const CHECKED_FIRST =
  "Money only becomes withdrawable after the contract has replayed and checked the whole match.";

/** What the contract's End replay of the match concludes, as a proof line. */
export function settlementProof(s: Settlement): {
  check: "pass" | "fail" | "info";
  title: string;
  detail: string;
} {
  switch (s.kind) {
    case "payout":
      return {
        check: "pass",
        title: "Every rule held, so it pays out",
        detail: `${CHECKED_FIRST} This page ran the same replay: every hint was about its asker's target, every tag and forfeit followed the hunting order, and every credit is the hint money paid onto that player.`,
      };
    case "refunded":
      return {
        check: "fail",
        title: "Refunded: rule violation",
        detail: `${CHECKED_FIRST} This page ran the same replay and found a broken rule (${s.text}), so every player gets their stake back and every sponsor their contribution.`,
      };
    case "not-run":
      return {
        check: "info",
        title: "The settlement wasn't replayed",
        detail:
          s.why === "no-end"
            ? "This replay has no end verdict, which names the hunting order and whom each hint was about, so the check the contract runs at the end can't be run here."
            : "A verdict here isn't the referee's, so these aren't the verdicts the contract applied, and replaying them would say nothing about how it settled.",
      };
    case "v1":
      return {
        check: "info",
        title: "No settlement replay (before protocol v2)",
        detail:
          "This match was recorded before protocol v2: each hint paid its target straight away and the contract didn't replay the match at the end, so there is nothing to re-run.",
      };
  }
}

/** The finale's line under the headline when the match was refunded, else null. */
export function refundLine(s: Settlement): string | null {
  return s.kind === "refunded"
    ? `Refunded: rule violation. Replaying the whole match finds that ${s.text.replace(/^event \d+: /, "")}, so every player gets their stake back.`
    : null;
}
