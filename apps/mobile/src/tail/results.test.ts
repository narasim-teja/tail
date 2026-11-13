import { describe, expect, test } from "bun:test";
import { RejectCode } from "@tail/protocol";
import type { RelayFault } from "../proximity/monitor";
import type { ReceiptResult } from "../proximity/receipts";
import { finalMoney, receiptLines, relayFaultLine } from "./results";

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
      refund: null,
    });
    expect(finalMoney({ ...f, head: 0n, settledAs: "payout" })).toEqual({
      label: "Final head",
      units: 2_000_000n,
      refund: null,
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
      refund:
        "Refunded: the referee broke a rule (a Tag did not follow the ring), so every player got their stake back.",
    });
    expect(finalMoney({ ...f, paid: 1_000_000n, settledAs: "refunded_abort" }).refund).toBe(
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
    expect(relayFaultLine(null)).toBeNull();
    expect(relayFaultLine(fault)).toBe(
      "The relay sent a log proof that didn't check out. Your phone kept it and is still checking.",
    );
    expect(relayFaultLine({ ...fault, count: 3, outstanding: false })).toBe(
      "The relay sent a log proof that didn't check out 3 times. A later check passed.",
    );
  });
});
