import { describe, expect, test } from "bun:test";
import { RejectCode } from "@tail/protocol";
import type { OutboxItem } from "./batch";
import { type ChainInput, planChain, STALL_MS, unconfirmed } from "./chain";

const h = (n: number) => new Uint8Array(32).fill(n);
const item = (seq: number, o: Partial<OutboxItem> = {}): OutboxItem => ({
  seq,
  sealed: Uint8Array.of(seq),
  hash: h(seq + 1),
  actions: [],
  sentMs: 0,
  resent: false,
  ...o,
});
const NOW = 100_000;
const input = (o: Partial<ChainInput>): ChainInput => ({
  items: [item(0), item(1), item(2)],
  confirmed: unconfirmed(),
  builderSeq: 3,
  hud: { nextSeq: 0, chainTip: h(0) },
  handled: null,
  nowMs: NOW,
  ...o,
});

describe("chain plan", () => {
  test("a referee one batch behind just confirms what it took", () => {
    const p = planChain(input({ hud: { nextSeq: 2, chainTip: h(2) }, nowMs: 1_000 }));
    expect(p).toEqual({ kind: "confirm", nextSeq: 2, tip: h(2) });
  });

  test("a tip the phone never sent means the chains parted: rebuild from the referee's", () => {
    const p = planChain(input({ hud: { nextSeq: 2, chainTip: h(77) } }));
    expect(p).toEqual({ kind: "rebuild", chain: { seq: 2, prev: h(77) }, why: "parted" });
  });

  test("a referee ahead of a phone that lost its file: rebuild there", () => {
    const p = planChain(input({ items: [], builderSeq: 0, hud: { nextSeq: 9, chainTip: h(9) } }));
    expect(p).toMatchObject({ kind: "rebuild", chain: { seq: 9 }, why: "parted" });
  });

  test("the confirmed tip is trusted once its batch has left the outbox", () => {
    const caughtUp = input({ items: [], builderSeq: 4, confirmed: { nextSeq: 4, tip: h(4) } });
    expect(planChain({ ...caughtUp, hud: { nextSeq: 4, chainTip: h(4) } })).toEqual({
      kind: "confirm",
      nextSeq: 4,
      tip: h(4),
    });
  });

  test("a builder past the referee with nothing held at its seq has lost those batches: rebuild", () => {
    const p = planChain(
      input({
        items: [],
        builderSeq: 6,
        confirmed: { nextSeq: 4, tip: h(4) },
        hud: { nextSeq: 4, chainTip: h(4) },
      }),
    );
    expect(p).toEqual({ kind: "rebuild", chain: { seq: 4, prev: h(4) }, why: "lost" });
  });

  test("the waiting batch refused for its assertion is rebuilt at once, but only once per refusal", () => {
    const rejected = { seq: 1, code: RejectCode.Assertion };
    const hud = { nextSeq: 1, chainTip: h(1), rejected };
    expect(planChain(input({ hud, nowMs: 1_000 }))).toEqual({
      kind: "rebuild",
      chain: { seq: 1, prev: h(1) },
      why: "refused",
    });
    expect(planChain(input({ hud, handled: rejected, nowMs: 1_000 })).kind).toBe("confirm");
  });

  test("seq and prev refusals (an old chain's leftovers) and later-batch refusals change nothing", () => {
    for (const rejected of [
      { seq: 1, code: RejectCode.Seq },
      { seq: 1, code: RejectCode.Prev },
      { seq: 2, code: RejectCode.Assertion },
    ])
      expect(planChain(input({ hud: { nextSeq: 1, chainTip: h(1), rejected }, nowMs: 1_000 })).kind).toBe(
        "confirm",
      );
  });

  test("a batch stuck at the relay is sent again once, then the chain is rebuilt", () => {
    const hud = { nextSeq: 1, chainTip: h(1) };
    expect(planChain(input({ hud, nowMs: STALL_MS - 1 })).kind).toBe("confirm");
    expect(planChain(input({ hud, nowMs: STALL_MS }))).toEqual({
      kind: "resend",
      nextSeq: 1,
      tip: h(1),
      from: 1,
    });
    const resent = [item(0), item(1, { resent: true, sentMs: 10 }), item(2)];
    expect(planChain(input({ items: resent, hud, nowMs: 10 + STALL_MS }))).toMatchObject({
      kind: "rebuild",
      why: "stalled",
    });
  });

  test("a batch not yet with the relay is never called stuck", () => {
    const items = [item(0), item(1, { sentMs: null }), item(2, { sentMs: null })];
    expect(planChain(input({ items, hud: { nextSeq: 1, chainTip: h(1) }, nowMs: 10 * STALL_MS })).kind).toBe(
      "confirm",
    );
  });
});
