// What Results says about a receipt check (proximity/receipts.ts), in TAIL's words.

import type { Settlement } from "../near/chain";
import type { RelayFault } from "../proximity/monitor";
import type { ReceiptResult } from "../proximity/receipts";
import { RELAY_BAD_PROOF, rejectReason } from "./hud";

/**
 * Results' quiet line about the relay's bad log proofs. It blames the relay, not the referee, so
 * it is no alarm; the phone kept the proof and checked again.
 */
export function relayFaultLine(f: RelayFault | null): string | null {
  if (!f) return null;
  const times = f.count > 1 ? ` ${f.count} times` : "";
  const after = f.outstanding ? "Your phone kept it and is still checking." : "A later check passed.";
  return `${RELAY_BAD_PROOF}${times}. ${after}`;
}

/** The money line on Results: what to call it, the amount, and a plain refund note if any. */
export interface FinalMoney {
  label: string;
  units: bigint | null;
  refund: string | null;
}

/**
 * Before the match settles, the head the contract holds (or the last HUD's). Once it has, heads
 * are 0 and `paid` is what this player got: the head plus any hint credit on a payout, the stake
 * on a refund. A refund says why, in plain words.
 */
export function finalMoney(f: {
  settledAs: Settlement | null;
  violation: string | null;
  paid: bigint | null;
  head: bigint | null;
}): FinalMoney {
  switch (f.settledAs) {
    case null:
      return { label: "Final head", units: f.head, refund: null };
    case "payout":
      return { label: "Final head", units: f.paid, refund: null };
    case "refunded_rule_violation": {
      // "event 3: a Tag did not follow the ring" → "a Tag did not follow the ring".
      const rule = f.violation?.replace(/^event \d+: /, "");
      return {
        label: "Refunded",
        units: f.paid,
        refund: `Refunded: the referee broke a rule${rule ? ` (${rule})` : ""}, so every player got their stake back.`,
      };
    }
    case "refunded_abort":
      return {
        label: "Refunded",
        units: f.paid,
        refund: "Refunded: the match was called off, so every player got their stake back.",
      };
  }
}

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
