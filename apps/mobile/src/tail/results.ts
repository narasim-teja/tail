// What Results says about a receipt check (proximity/receipts.ts), in TAIL's words.

import type { ReceiptResult } from "../proximity/receipts";
import { rejectReason } from "./hud";

/** "3, 4 and 9" style lists for the results screen. */
export function seqList(seqs: readonly number[]): string {
  const s = seqs.map(String);
  if (s.length <= 1) return s.join("");
  return `${s.slice(0, -1).join(", ")} and ${s.at(-1)}`;
}

const reports = (n: number) => (n === 1 ? "report" : "reports");

/** What Results says about a receipt check: plain lines, and problems listed apart. */
export function receiptLines(r: ReceiptResult): { lines: string[]; problems: string[] } {
  const lines = [
    `${r.included.length} of ${r.total} ${reports(r.total)} are in the log anchored on NEAR${r.final ? "." : " so far."}`,
  ];
  if (r.refused.length > 0) {
    const why = [...new Set(r.refused.map((x) => rejectReason(x.code)))].join(", ");
    lines.push(`${r.refused.length} refused by the referee (${why}).`);
  }
  const problems: string[] = [];
  if (r.missing.length > 0) {
    if (r.final)
      problems.push(
        `Missing from the log: ${reports(r.missing.length)} ${seqList(r.missing)}. The referee never logged ${r.missing.length === 1 ? "it" : "them"}.`,
      );
    else lines.push(`${r.missing.length} not anchored yet; checked again once the match ends.`);
  }
  if (r.badProof.length > 0)
    problems.push(
      `The relay's proof for ${reports(r.badProof.length)} ${seqList(r.badProof)} doesn't match NEAR.`,
    );
  return { lines, problems };
}
