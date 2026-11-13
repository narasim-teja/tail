import { describe, expect, test } from "bun:test";
import { HINT_TEXT_MAX, HintKind } from "@tail/protocol";
import { TailActions } from "./actions";

describe("actions", () => {
  test("a hint question is trimmed and cut to the protocol's limit; an empty one is left out", () => {
    const q = new TailActions(() => 1);
    const a = q.hint(HintKind.Near, `  ${"x".repeat(200)} `);
    const b = q.hint(HintKind.Trend, "   ");
    expect(a.kind === "Hint" && a.text?.length).toBe(HINT_TEXT_MAX);
    expect(b).toEqual({ kind: "Hint", hint: HintKind.Trend, nonce: 1 });
    expect(q.strike()).toEqual({ kind: "Strike", nonce: 1 });
  });
});
