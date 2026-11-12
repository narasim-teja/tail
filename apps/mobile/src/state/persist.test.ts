import { describe, expect, test } from "bun:test";
import { decodeMatchRecord, encodeMatchRecord, type MatchRecord } from "./persist";

describe("match record", () => {
  test("the chain position and outbox survive a write and read unchanged", () => {
    const r: MatchRecord = {
      matchId: "ab".repeat(16),
      chain: { seq: 3, prev: new Uint8Array(32).fill(7) },
      outbox: [
        { seq: 1, sealed: Uint8Array.of(1, 2) },
        { seq: 2, sealed: Uint8Array.of(3) },
      ],
    };
    expect(decodeMatchRecord(encodeMatchRecord(r))).toEqual(r);
  });
});
