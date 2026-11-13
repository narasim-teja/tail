import { describe, expect, test } from "bun:test";
import { RejectCode } from "@tail/protocol";
import { fakeTime } from "../../test/fake-time";
import type { RelayFault } from "../proximity/monitor";
import type { ReceiptResult } from "../proximity/receipts";
import {
  finalMoney,
  RESULTS_POLL_MS,
  type Receipts,
  receiptLines,
  receiptsFinal,
  relayFaultLine,
  watchResults,
} from "./results";

const result = (o: Partial<ReceiptResult>): ReceiptResult => ({
  size: 8,
  final: true,
  total: 4,
  included: [],
  refused: [],
  missing: [],
  badProof: [],
  ...o,
});

describe("receipt lines", () => {
  test("accepted reports and a refused one with its reason", () => {
    const r = result({ included: [0, 1, 2], refused: [{ seq: 3, code: RejectCode.ClockSkew }] });
    expect(receiptLines(r)).toEqual({
      lines: ["3 of 4 reports are in the log anchored on NEAR.", "1 refused by the referee (clock off)."],
      problems: [],
    });
  });

  test("a report the referee never logged is listed as a problem", () => {
    const r = result({ total: 5, included: [0, 1, 2], refused: [{ seq: 3, code: 0 }], missing: [4] });
    expect(receiptLines(r).problems[0]).toContain("Missing from the log: report 4.");
  });

  test("a path that does not verify is named as the relay's", () => {
    expect(receiptLines(result({ badProof: [0, 1, 2, 3] })).problems).toEqual([
      "The relay's proof for reports 0, 1, 2 and 3 doesn't match NEAR.",
    ]);
  });

  test("against a checkpoint, reports after it are not anchored yet rather than missing", () => {
    expect(receiptLines(result({ size: 4, final: false, included: [0, 1], missing: [2, 3] }))).toEqual({
      lines: [
        "2 of 4 reports are in the log anchored on NEAR so far.",
        "2 not anchored yet; checked again once the match ends.",
      ],
      problems: [],
    });
  });
});

describe("final money", () => {
  const f = { violation: null, paid: 2_000_000n, head: 1_500_000n };

  test("before settlement the head; after a payout what NEAR paid", () => {
    expect(finalMoney({ ...f, settledAs: null })).toEqual({
      label: "Final head",
      units: 1_500_000n,
      note: null,
    });
    expect(finalMoney({ ...f, head: 0n, settledAs: "payout" })).toEqual({
      label: "Final head",
      units: 2_000_000n,
      note: null,
    });
  });

  test("a match paid out before the contract upgrade shows what NEAR paid and says it was never replayed", () => {
    expect(finalMoney({ ...f, head: 0n, settledAs: "payout_unreplayed" })).toEqual({
      label: "Final head",
      units: 2_000_000n,
      note: "Paid out on the contract's old rules: it paid what the referee's verdicts said, without replaying the match.",
    });
  });

  test("a refund is labelled as one and says why", () => {
    const broken = finalMoney({
      ...f,
      paid: 1_000_000n,
      settledAs: "refunded_rule_violation",
      violation: "event 3: a Tag did not follow the ring",
    });
    expect(broken).toEqual({
      label: "Refunded",
      units: 1_000_000n,
      note: "Refunded: the referee broke a rule (a Tag did not follow the ring), so every player got their stake back.",
    });
    expect(finalMoney({ ...f, paid: 1_000_000n, settledAs: "refunded_abort" }).note).toBe(
      "Refunded: the match was called off, so every player got their stake back.",
    );
  });

  test("the relay's bad log proofs are one quiet line, which says whether a later check passed", () => {
    const root = { size: 4, root: new Uint8Array(32), signed: new Uint8Array(0) };
    const fault: RelayFault = {
      atMs: 1,
      count: 1,
      outstanding: true,
      hud: root,
      other: { kind: "hud", hud: { ...root, size: 6 } },
      from: 4,
      to: 6,
      proof: [],
    };
    expect(relayFaultLine(null, true)).toBeNull();
    expect(relayFaultLine(fault, true)).toBe(
      "The relay sent a log proof that didn't check out. Your phone kept it and is still checking.",
    );
    // No hunt runs, so nothing checks again: the line must not say it does.
    expect(relayFaultLine(fault, false)).toBe(
      "The log check against NEAR was not completed: the relay sent a log proof that didn't check out. Your phone kept the proof.",
    );
    expect(relayFaultLine({ ...fault, count: 3, outstanding: false }, false)).toBe(
      "The relay sent a log proof that didn't check out 3 times. A later check passed.",
    );
  });
});

describe("Results keeps reading until the match is over and checked", () => {
  /**
   * A Results watch over a fake match: `root` is what NEAR anchors, and each receipt check asks
   * the relay once per report (3 here) for an inclusion proof, logged as "inclusion".
   */
  const watch = () => {
    const t = fakeTime(0);
    const s = {
      ended: false,
      root: "checkpoint:4:aa" as string | Error,
      receipts: { kind: "idle" } as Receipts,
      calls: [] as string[],
    };
    const stop = watchResults({
      refresh: async () => {
        s.calls.push("refresh");
      },
      ended: () => s.ended,
      rootKey: async () => {
        if (s.root instanceof Error) throw s.root;
        return s.root;
      },
      receipts: () => s.receipts,
      checkReceipts: async () => {
        s.calls.push("inclusion", "inclusion", "inclusion");
        s.receipts = { kind: "done", result: result({ final: s.root.toString().startsWith("end") }) };
      },
      findMeetings: async () => {
        s.calls.push("meetings");
      },
      timers: t.timers,
    });
    const poll = async () => {
      t.advance(RESULTS_POLL_MS);
      for (let i = 0; i < 8; i++) await Promise.resolve();
    };
    return { s, stop, poll };
  };
  const inclusions = (calls: string[]) => calls.filter((c) => c === "inclusion").length;

  test("receipts are checked on arrival, then not while the match runs", async () => {
    const { s, stop, poll } = watch();
    await poll();
    expect(inclusions(s.calls)).toBe(3);
    s.root = "checkpoint:9:bb";
    await poll();
    await poll();
    expect(s.calls.slice(4)).toEqual(["refresh", "refresh"]);
    stop();
  });

  test("after End, a poll with an unchanged root makes no inclusion requests; End's root gets the final check", async () => {
    const { s, stop, poll } = watch();
    await poll();
    s.ended = true;
    // The relay says ended, but End's root is not on NEAR yet: the checkpoint already checked stands.
    await poll();
    await poll();
    expect(inclusions(s.calls)).toBe(3);
    // NEAR not answering is no change either.
    s.root = new Error("NEAR is down");
    await poll();
    expect(inclusions(s.calls)).toBe(3);
    s.root = "end:12:cc";
    await poll();
    expect(inclusions(s.calls)).toBe(6);
    const after = s.calls.length;
    await poll();
    await poll();
    expect(s.calls).toHaveLength(after);
    stop();
  });

  test("a check that failed is tried again on the next poll, root changed or not", async () => {
    const { s, stop, poll } = watch();
    await poll();
    s.ended = true;
    s.receipts = { kind: "error", message: "Can't reach the relay." };
    await poll();
    expect(inclusions(s.calls)).toBe(6);
    stop();
  });

  test("receipts are final once checked against End's root, or when there is nothing to check", () => {
    expect(receiptsFinal({ kind: "done", result: result({ final: true }) })).toBe(true);
    expect(receiptsFinal({ kind: "done", result: result({ final: false }) })).toBe(false);
    expect(receiptsFinal({ kind: "none", why: "x", final: true })).toBe(true);
    expect(receiptsFinal({ kind: "none", why: "No log root is anchored on NEAR yet.", final: false })).toBe(
      false,
    );
    expect(receiptsFinal({ kind: "error", message: "offline" })).toBe(false);
  });
});
