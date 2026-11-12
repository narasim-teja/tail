// Which glyph stands for which verification state, in one place. The ringed check is reserved for
// "Matches NEAR": nothing else on the page may draw it, so a fixture or an unreachable chain can
// never look verified. Pinned by test/marks.test.tsx.

import type { Summary, VerdictStatus } from "../verify/report.ts";

/**
 * check: the brand's ringed check, "Matches NEAR" only.
 * tick: a bare tick, one local check that ran and held (a proof row), never a NEAR claim.
 * hollow: a plain ring, signed and logged but not on NEAR (or NEAR unreachable).
 * bar: a ring with a bar through it, in ink, "Doesn't match NEAR" / a check that failed.
 * dashed: a dashed ring, not checked yet.
 */
export type Glyph = "check" | "tick" | "hollow" | "bar" | "dashed";

export const STATUS_GLYPH: Record<VerdictStatus, Glyph> = {
  verified: "check",
  unanchored: "hollow",
  mismatch: "bar",
  pending: "dashed",
};

export type Check = "pass" | "fail" | "pending" | "info";

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
  }
}

/** The match's overall state, for the header line and the summary sheet. */
export function overall(s: Summary, chain: string): VerdictStatus {
  if (s.mismatched > 0) return "mismatch";
  if (s.checked < s.total || chain === "checking") return "pending";
  return s.verified === s.total ? "verified" : "unanchored";
}
