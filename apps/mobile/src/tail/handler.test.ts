import { describe, expect, test } from "bun:test";
import { type AnchoredRoot, type LogEntry, merkleLeaf, merkleRoot, sha256, utf8 } from "@tail/protocol";
import { checkHandlerLines, handlerLine, handlerProblem } from "./handler";

const salt = new Uint8Array(16);
const receipt = (hintId: number, text: string): LogEntry => ({
  kind: "HintReceipt",
  hintId,
  chatId: "",
  textHash: sha256(utf8(text)),
  signature: new Uint8Array(0),
  signingAddress: "",
  salt,
});

const log: LogEntry[] = [
  { kind: "Tick", tickNo: 0, nowMs: 1n, callId: new Uint8Array(16) },
  receipt(0, "Within 150 m"),
  receipt(1, "Bearing NE"),
  // Another player's hint: this phone never got it, so it is not checked.
  receipt(2, "Closer"),
];
const end: AnchoredRoot = { logSize: BigInt(log.length), root: merkleRoot(log.map(merkleLeaf)) };

describe("Handler lines against the referee's log", () => {
  test("lines that match their logged receipts are fine; a line with no receipt is not counted", () => {
    const lines = [handlerLine(0, "Within 150 m"), handlerLine(1, "Bearing NE"), handlerLine(9, "Same")];
    expect(checkHandlerLines(lines, log, end)).toEqual({ kind: "ok", checked: 2 });
    expect(handlerProblem(checkHandlerLines(lines, log, end))).toBeNull();
  });

  test("a line other than the one the referee logged is named", () => {
    const lines = [handlerLine(0, "Within 150 m"), handlerLine(1, "Bearing SW")];
    const c = checkHandlerLines(lines, log, end);
    expect(c).toEqual({ kind: "mismatch", hintIds: [1] });
    expect(handlerProblem(c)).toBe("The relay delivered a different Handler line than the referee logged.");
    expect(handlerProblem(checkHandlerLines([handlerLine(0, "x"), handlerLine(1, "y")], log, end))).toContain(
      "(2 lines)",
    );
  });

  test("a log that is not the one End anchored proves nothing either way", () => {
    const lines = [handlerLine(1, "Bearing SW")];
    // The relay swapped the receipt to match what it delivered: the root gives it away.
    const swapped = log.map((e) =>
      e.kind === "HintReceipt" && e.hintId === 1 ? receipt(1, "Bearing SW") : e,
    );
    expect(checkHandlerLines(lines, swapped, end)).toEqual({ kind: "unverified" });
    expect(checkHandlerLines(lines, log.slice(0, 3), end)).toEqual({ kind: "unverified" });
    expect(handlerProblem({ kind: "unverified" })).toBeNull();
  });
});
