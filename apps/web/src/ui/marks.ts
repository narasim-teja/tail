// Which glyph stands for which verification state, in one place. The ringed check is reserved for
// "Matches NEAR": nothing else on the page may draw it, so a fixture or an unreachable chain can
// never look verified. Pinned by test/marks.test.tsx.

import type { MatchProblem, Summary, VerdictStatus } from "../verify/report.ts";

/**
 * check: the brand's ringed check, "Matches NEAR" only.
 * tick: a bare tick, one local check that ran and held (a proof row), never a NEAR claim.
 * hollow: a plain ring, signed and logged but not on NEAR (or NEAR unreachable).
 * bar: a ring with a bar through it, in ink, "Fails a check" ("Doesn't match NEAR" when NEAR differs).
 * dashed: a dashed ring, not checked yet.
 * earlier: a tick beside a clock, a check that held when a script ran it earlier, not on this page.
 */
export type Glyph = "check" | "tick" | "hollow" | "bar" | "dashed" | "earlier";

export const STATUS_GLYPH: Record<VerdictStatus, Glyph> = {
  verified: "check",
  unanchored: "hollow",
  mismatch: "bar",
  pending: "dashed",
};

/** earlier: passed when scripts/verify-nearai.ts ran (its saved result), not re-run here. */
export type Check = "pass" | "fail" | "pending" | "info" | "earlier";

/** A proof row's glyph. Only the row that compares with NEAR may show the ringed check. */
export function proofGlyph(check: Check, comparesWithNear = false): Glyph {
  switch (check) {
    case "pass":
      return comparesWithNear ? "check" : "tick";
    case "fail":
      return "bar";
    case "pending":
      return "dashed";
    case "info":
      return "hollow";
    case "earlier":
      return "earlier";
  }
}

/**
 * The match's overall state, for the header line and the summary sheet. A problem with the match
 * as a whole (another contract, verdicts left out, payouts) fails it even if every verdict holds.
 */
export function overall(s: Summary, chain: string, problem: MatchProblem | null = null): VerdictStatus {
  if (problem || s.mismatched > 0) return "mismatch";
  if (s.checked < s.total || chain === "checking") return "pending";
  return s.verified === s.total ? "verified" : "unanchored";
}
