import { describe, expect, test } from "bun:test";
import { RejectCode } from "@tail/protocol";
import type { ReceiptResult } from "../proximity/receipts";
import { receiptLines } from "./results";

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
