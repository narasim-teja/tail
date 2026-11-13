// What Results says about a receipt check (proximity/receipts.ts), in TAIL's words.

import { type AnchoredRoot, toHex } from "@tail/protocol";
import type { Roots, Settlement } from "../near/chain";
import { realTimers, type Timers } from "../proximity/epoch";
import type { RelayFault } from "../proximity/monitor";
import type { ReceiptResult } from "../proximity/receipts";
import { RELAY_BAD_PROOF, rejectReason } from "./hud";

/**
 * Results' check that every report is in the log anchored on NEAR (proximity/receipts.ts).
 * `none.final`: nothing more can change it (not a player, or End's root is in and there was
 * nothing to check); false while no root is anchored yet.
 */
export type Receipts =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none"; why: string; final: boolean }
  | { kind: "done"; result: ReceiptResult }
  | { kind: "error"; message: string };

/** The receipts were checked against End's root, or there is nothing left to check. */
export const receiptsFinal = (r: Receipts): boolean =>
  (r.kind === "done" && r.result.final) || (r.kind === "none" && r.final);

/** How often Results reads the match again while it waits for End. */
export const RESULTS_POLL_MS = 5_000;

/** The root receipts are checked against: End's once it is anchored, else the newest checkpoint. */
export function receiptRoot(r: Roots): { root: AnchoredRoot; final: boolean } | null {
  const root = r.final ?? r.all.at(-1) ?? null;
  return root ? { root, final: r.final !== null } : null;
}

/** Names the receipt root; it changes exactly when a check could come out differently. */
export function receiptRootKey(r: Roots): string {
  const x = receiptRoot(r);
  return x ? `${x.final ? "end" : "checkpoint"}:${x.root.logSize}:${toHex(x.root.root)}` : "none";
}

/**
 * Keeps Results reading until it has all it will get. The lobby poll stops once a hunt runs, and
 * Results can open long before End (a tagged player): without this, End would never be seen, so
 * no replay link, no presence proofs, and receipts checked only to the last checkpoint.
 *
 * Each round reads the match. The receipts are checked on arrival, and after the match has ended
 * again whenever the root NEAR anchored (`rootKey`) is not the one last checked: End's root is a
 * new root, so that is the final check. Against an unchanged root a check would ask the relay the
 * same questions for the same answers, so it is not made; only a check that failed is tried
 * again. A root NEAR did not give this round is no change. Once ended, the presence proofs are
 * looked for. Returns a function that stops it.
 */
export function watchResults(d: {
  refresh: () => Promise<void>;
  ended: () => boolean;
  /** The receipt root NEAR anchors now, as `receiptRootKey` names it. */
  rootKey: () => Promise<string>;
  receipts: () => Receipts;
  checkReceipts: () => Promise<void>;
  findMeetings: () => Promise<void>;
  timers?: Timers;
}): () => void {
  const timers = d.timers ?? realTimers;
  let stopped = false;
  let timer: unknown = null;
  /** The root the last check ran against; undefined before the first. */
  let checked: string | undefined;
  let arrived = false;
  const round = async () => {
    timer = null;
    await d.refresh();
    const ended = d.ended();
    if ((!arrived || ended) && !receiptsFinal(d.receipts())) {
      const key = await d.rootKey().catch(() => null);
      const changed = key === null ? checked === undefined : key !== checked;
      if (changed || d.receipts().kind === "error") {
        await d.checkReceipts();
        checked = key ?? checked;
      }
    }
    arrived = true;
    if (ended) await d.findMeetings();
    if (stopped || (ended && receiptsFinal(d.receipts()))) return;
    timer = timers.setTimeout(() => void round(), RESULTS_POLL_MS);
  };
  void round();
  return () => {
    stopped = true;
    if (timer !== null) timers.clearTimeout(timer);
  };
}

/**
 * Results' quiet line about the relay's bad log proofs. It blames the relay, not the referee, so
 * it is no alarm; the phone kept the proof. `checking`: a hunt still runs on this phone, whose
 * monitor asks again; without one the last check has run (app.ts checkLog) and was not completed.
 */
export function relayFaultLine(f: RelayFault | null, checking: boolean): string | null {
  if (!f) return null;
  const times = f.count > 1 ? ` ${f.count} times` : "";
  if (!f.outstanding) return `${RELAY_BAD_PROOF}${times}. A later check passed.`;
  if (checking) return `${RELAY_BAD_PROOF}${times}. Your phone kept it and is still checking.`;
  const bad = RELAY_BAD_PROOF.charAt(0).toLowerCase() + RELAY_BAD_PROOF.slice(1);
  return `The log check against NEAR was not completed: ${bad}${times}. Your phone kept the proof.`;
}

/** The money line on Results: what to call it, the amount, and a plain note on how it was settled. */
export interface FinalMoney {
  label: string;
  units: bigint | null;
  note: string | null;
}

/**
 * Before the match settles, the head the contract holds (or the last HUD's). Once it has, heads
 * are 0 and `paid` is what this player got: the head plus any hint credit on a payout, the stake
 * on a refund. A refund says why, in plain words, and so does a payout the contract made on its
 * old rules, which never replayed the match.
 */
export function finalMoney(f: {
  settledAs: Settlement | null;
  violation: string | null;
  paid: bigint | null;
  head: bigint | null;
}): FinalMoney {
  switch (f.settledAs) {
    case null:
      return { label: "Final head", units: f.head, note: null };
    case "payout":
      return { label: "Final head", units: f.paid, note: null };
    case "payout_unreplayed":
      return {
        label: "Final head",
        units: f.paid,
        note: "Paid out on the contract's old rules: it paid what the referee's verdicts said, without replaying the match.",
      };
    case "refunded_rule_violation": {
      // "event 3: a Tag did not follow the ring" → "a Tag did not follow the ring".
      const rule = f.violation?.replace(/^event \d+: /, "");
      return {
        label: "Refunded",
        units: f.paid,
        note: `Refunded: the referee broke a rule${rule ? ` (${rule})` : ""}, so every player got their stake back.`,
      };
    }
    case "refunded_abort":
      return {
        label: "Refunded",
        units: f.paid,
        note: "Refunded: the match was called off, so every player got their stake back.",
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
