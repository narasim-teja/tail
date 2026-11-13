import { describe, expect, test } from "bun:test";
import { decodeMatchRecord, emptyRecord, encodeMatchRecord, type MatchRecord } from "./persist";

describe("match record", () => {
  test("the chain, outbox, tags, last fix time and unsent actions survive a write and read unchanged", () => {
    const r: MatchRecord = {
      matchId: "ab".repeat(16),
      chain: { seq: 3, prev: new Uint8Array(32).fill(7) },
      outbox: [
        { seq: 1, sealed: Uint8Array.of(1, 2) },
        { seq: 2, sealed: Uint8Array.of(3) },
      ],
      tags: 2,
      lastFixMs: 1_800_000_123_456,
      actions: [
        { kind: "Strike", nonce: 9 },
        { kind: "Hint", hint: 1, nonce: 10, text: "north?" },
        { kind: "Hint", hint: 2, nonce: 11 },
      ],
    };
    expect(decodeMatchRecord(encodeMatchRecord(r))).toEqual(r);
  });

  test("a file from before tags, fix times and actions were kept reads with empty ones", () => {
    const old = JSON.stringify({ matchId: "cd".repeat(16), seq: 0, prev: "00".repeat(32), outbox: [] });
    expect(decodeMatchRecord(old)).toEqual(emptyRecord("cd".repeat(16)));
  });

  test("a malformed saved action is dropped, not sent", () => {
    const text = encodeMatchRecord({
      ...emptyRecord("ef".repeat(16)),
      actions: [{ kind: "Strike", nonce: 1 }],
    });
    const j = JSON.parse(text) as { actions: unknown[] };
    j.actions.push({ kind: "Strike", nonce: -1 }, { kind: "Teleport" }, null);
    expect(decodeMatchRecord(JSON.stringify(j)).actions).toEqual([{ kind: "Strike", nonce: 1 }]);
  });
});
