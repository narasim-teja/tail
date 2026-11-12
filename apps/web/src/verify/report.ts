// Folds the local checks and the chain anchors into one status per verdict, the thing the page
// shows as a mark, plus a one-line summary.

import type { Anchor, MatchLevel } from "./anchor.ts";
import { type LocalVerdictCheck, localOk } from "./checks.ts";

/**
 * verified: every check passed and NEAR holds the same root.
 * unanchored: every local check passed but NEAR has no such match (fixture) or was unreachable.
 * mismatch: a check failed.
 * pending: not checked yet.
 */
export type VerdictStatus = "pending" | "verified" | "unanchored" | "mismatch";

export function statusOf(local: LocalVerdictCheck | undefined, anchor: Anchor | undefined): VerdictStatus {
  if (!local) return "pending";
  if (!localOk(local)) return "mismatch";
  if (anchor === undefined) return "pending";
  if (anchor === "mismatch") return "mismatch";
  if (anchor === "match") return "verified";
  return "unanchored";
}

export type ChainSummary = "checking" | "found" | "absent" | "unreachable";

export interface Summary {
  total: number;
  checked: number;
  verified: number;
  mismatched: number;
  unanchored: number;
}

export function summarize(statuses: VerdictStatus[]): Summary {
  return {
    total: statuses.length,
    checked: statuses.filter((s) => s !== "pending").length,
    verified: statuses.filter((s) => s === "verified").length,
    mismatched: statuses.filter((s) => s === "mismatch").length,
    unanchored: statuses.filter((s) => s === "unanchored").length,
  };
}

/** The quiet top-right line. Plain words; numbers carry the detail. */
export function summaryLine(
  s: Summary,
  chain: ChainSummary,
  level: MatchLevel | null,
  localDone = s.total,
): string {
  const n = (k: number) => `${k} verdict${k === 1 ? "" : "s"}`;
  if (localDone < s.total) return `Checking ${localDone} of ${s.total}`;
  if (s.mismatched > 0 && s.checked === s.total)
    return `${n(s.mismatched)} ${s.mismatched === 1 ? "doesn't" : "don't"} match NEAR`;
  if (s.checked < s.total || chain === "checking") return "Comparing with NEAR";
  if (chain === "absent") return "Not on NEAR";
  if (chain === "unreachable") return "Couldn't reach NEAR";
  if (level && level.payouts === false) return "Payouts don't match NEAR";
  return s.verified === s.total
    ? `All ${s.total} verdicts match NEAR`
    : `${s.verified} of ${n(s.total)} match NEAR`;
}
