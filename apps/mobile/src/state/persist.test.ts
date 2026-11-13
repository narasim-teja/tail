import { describe, expect, test } from "bun:test";
import { RejectCode } from "@tail/protocol";
import { freshMonitor, type LogFork } from "../proximity/monitor";
import { decodeMatchRecord, emptyRecord, encodeMatchRecord, type MatchRecord } from "./persist";

const h = (n: number) => new Uint8Array(32).fill(n);

describe("match record", () => {
  test("chain, outbox, confirmation, reports, tags, fix time, unsent actions and the log monitor survive a write and read", () => {
    const fork: LogFork = {
      atMs: 1_800_000_200_000,
      hud: { size: 4, root: h(4), signed: Uint8Array.of(4, 4) },
      other: { kind: "hud", hud: { size: 6, root: h(6), signed: Uint8Array.of(6) } },
      proof: [h(5)],
    };
    const r: MatchRecord = {
      matchId: "ab".repeat(16),
      chain: { seq: 3, prev: h(7) },
      outbox: [
        {
          seq: 1,
          sealed: Uint8Array.of(1, 2),
          hash: h(1),
          actions: ["Strike"],
          sentMs: 1_800_000_000_000,
          resent: true,
        },
        { seq: 2, sealed: Uint8Array.of(3), hash: h(2), actions: [], sentMs: null, resent: false },
      ],
      confirmed: { nextSeq: 1, tip: h(9) },
      reports: [
        { seq: 0, hash: h(9) },
        { seq: 1, hash: h(1), code: RejectCode.ClockSkew },
      ],
      hudTick: 12,
      tags: 2,
      lastFixMs: 1_800_000_123_456,
      actions: [
        { kind: "Strike", nonce: 9 },
        { kind: "Hint", hint: 1, nonce: 10, text: "north?" },
        { kind: "Hint", hint: 2, nonce: 11 },
      ],
      monitor: {
        verified: { size: 4, root: h(4), signed: Uint8Array.of(4, 4) },
        pending: null,
        anchored: 3,
        fork,
      },
    };
    expect(decodeMatchRecord(encodeMatchRecord(r))).toEqual(r);
    const anchor = {
      ...r,
      monitor: {
        ...freshMonitor(),
        fork: { ...fork, other: { kind: "anchor" as const, anchor: { size: 9, root: h(9) } } },
      },
    };
    expect(decodeMatchRecord(encodeMatchRecord(anchor))).toEqual(anchor);
  });

  test("a file from before protocol v2 keeps its counts but drops batches no HUD can confirm", () => {
    const old = JSON.stringify({
      matchId: "cd".repeat(16),
      seq: 4,
      prev: "11".repeat(32),
      outbox: [{ seq: 3, sealed: "AQ==" }],
      tags: 1,
    });
    expect(decodeMatchRecord(old)).toEqual({
      ...emptyRecord("cd".repeat(16)),
      chain: { seq: 4, prev: h(0x11) },
      tags: 1,
    });
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
