// Every sentence the replay says about the match. Short, plain, no protocol words.

import { minutes, timeOfDay } from "../lib/format.ts";
import type { Match, MatchEvent } from "../model/match.ts";
import { snapshotAt } from "../model/match.ts";
import type { Anchor, ChainMatch } from "../verify/anchor.ts";
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

/** How long the match ran: "60 min", or "23 of 60 min" when it ended before its planned end. */
export function lengthLine(m: Match): string {
  const ran = minutes(m.durationMs);
  return ran === minutes(m.plannedMs) ? ran : `${ran.replace(/ min$/, "")} of ${minutes(m.plannedMs)}`;
}

export function list(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** How a player the referee enrolled without an Apple attestation is named everywhere. */
export const TEST_PLAYER = "test player (no Apple attestation)";

/**
 * A verdict's mark in words, from its status alone. "mismatch" covers a check that failed in this
 * browser as well as a root NEAR holds differently, so on its own it can only say a check failed:
 * a fixture that never went to NEAR must not read "Doesn't match NEAR".
 */
export const statusLabel: Record<VerdictStatus, string> = {
  pending: "Checking",
  verified: "Matches NEAR",
  unanchored: "Signed, not on NEAR",
  mismatch: "Fails a check",
};

/** The words for a verdict NEAR was asked about and holds something else for. */
export const NEAR_DIFFERS = "Doesn't match NEAR";

/** A verdict's mark in words when its anchor is known: NEAR is named only when NEAR differs. */
export function markLabel(status: VerdictStatus, anchor: Anchor | undefined): string {
  return status === "mismatch" && anchor === "mismatch" ? NEAR_DIFFERS : statusLabel[status];
}

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

/** A page with no film to play, as the relay and NEAR left it (ui/App.tsx). */
export type PagePhase =
  /** `refused`: the page offered the relay a player's sign-in and it said no. */
  | { kind: "private"; players: number | null; refused: boolean }
  | { kind: "not-finished"; chain: ChainMatch | null }
  | { kind: "purged" }
  | { kind: "missing" }
  | { kind: "error"; message: string };

/** What such a page says, and whether trying again could change it. */
export function pageState(p: PagePhase): { title: string; body: string; retry: boolean } {
  switch (p.kind) {
    case "private":
      // The relay serves a private replay only to a player who signs its challenge with their NEAR
      // key. This page holds no key: the TAIL app signs on the phone and opens the replay with a
      // sign-in that works once, for two minutes. Without one (a plain link, a reload) or after
      // the relay refused it, all the page can do is send the player back to the app.
      return {
        title: "This replay is private",
        body: p.refused
          ? "This sign-in link had expired or was already used. Each one works once, within two minutes. If you played, open the replay again from the TAIL app."
          : `The host kept it for the ${p.players ? `${p.players} ` : ""}players. If you played, open it from the TAIL app, which signs you in for one viewing.`,
        retry: false,
      };
    case "not-finished":
      return p.chain?.phase === "aborted"
        ? { title: "This match was called off", body: notFinishedLine(p.chain), retry: false }
        : { title: "This match isn't over yet", body: notFinishedLine(p.chain), retry: true };
    case "purged":
      return {
        title: "This replay is gone",
        body: "The relay deleted this match's trails, so it no longer serves the replay. It does that a day after a private match ends, and its operator can delete any match.",
        retry: false,
      };
    case "missing":
      return {
        title: "No match here",
        body: "There's no match with this link. Check that it was copied whole.",
        retry: false,
      };
    case "error":
      return {
        title: "This replay didn't load",
        body: `${p.message} Check your connection and try again.`,
        retry: true,
      };
  }
}

function notFinishedLine(m: ChainMatch | null): string {
  if (!m) return "The replay opens a minute or so after the match ends and the referee settles it.";
  if (m.phase === "lobby") return "Players are still joining. The replay opens after the match ends.";
  if (m.phase === "running" && m.end_ms)
    return `It ends at ${timeOfDay(m.end_ms)}. The replay opens a minute or so after that, once the referee settles it.`;
  if (m.phase === "aborted")
    return m.settled_as === "refunded_abort"
      ? "It was called off before it ended and every stake was refunded, so there's nothing to replay."
      : "It was called off before it ended, so there's nothing to replay.";
  return "It has just ended. The replay opens once the referee settles it, usually within a minute.";
}
