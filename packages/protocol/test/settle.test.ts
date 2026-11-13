import { describe, expect, test } from "bun:test";
import {
  describeViolation,
  type PlayEvent,
  type Replay,
  replaySettlement,
  SettleCheck,
} from "../src/settle.ts";

// Ring 0 → 1 → 2 → 0. Mirrors the unit tests of crates/tail-protocol/src/settle.rs.
const RING = [0, 1, 2];
const hint = (from: number, amount: bigint): PlayEvent => ({ kind: "Hint", from, amount, tMs: 0n });
const tag = (hunter: number, target: number, credit: bigint): PlayEvent => ({
  kind: "Tag",
  hunter,
  target,
  credit,
});
const fail = (check: SettleCheck, event: number | null): Replay => ({
  ok: false,
  violation: { check, event },
});

describe("settlement replay", () => {
  test("an honest match owes each survivor the hints paid onto them", () => {
    const events = [hint(0, 10n), hint(0, 20n), hint(2, 5n), tag(0, 1, 30n)];
    expect(replaySettlement(RING, events, [1, 1, 0], 5n)).toEqual({ ok: true, owed: [5n, 0n, 0n] });
  });

  test("the winner hunts the loser's target next", () => {
    const events = [tag(0, 1, 0n), hint(0, 7n), tag(0, 2, 7n)];
    expect(replaySettlement(RING, events, [2], 0n)).toEqual({ ok: true, owed: [0n, 0n, 0n] });
    expect(replaySettlement(RING, events, [1], 0n)).toEqual(fail(SettleCheck.HintTarget, 1));
  });

  test("each broken rule is named at the event that broke it", () => {
    expect(replaySettlement(RING, [tag(0, 2, 0n)], [], 0n)).toEqual(fail(SettleCheck.TagRing, 0));
    const forfeit: PlayEvent = { kind: "Forfeit", player: 1, to: 2, credit: 0n };
    expect(replaySettlement(RING, [forfeit], [], 0n)).toEqual(fail(SettleCheck.ForfeitRing, 0));
    expect(replaySettlement(RING, [hint(0, 10n)], [2], 10n)).toEqual(fail(SettleCheck.HintTarget, 0));
    expect(replaySettlement(RING, [hint(0, 10n), tag(0, 1, 9n)], [1], 1n)).toEqual(
      fail(SettleCheck.Credit, 1),
    );
    expect(replaySettlement(RING, [hint(0, 10n)], [], 10n)).toEqual(fail(SettleCheck.HintCount, null));
    expect(replaySettlement(RING, [hint(0, 10n)], [1], 11n)).toEqual(fail(SettleCheck.Pool, null));
    expect(replaySettlement(RING, [tag(7, 1, 0n)], [], 0n)).toEqual(fail(SettleCheck.TagRing, 0));
  });

  test("violations read as the contract reports them", () => {
    expect(describeViolation({ check: SettleCheck.TagRing, event: 3 })).toBe(
      "event 3: a Tag did not follow the ring",
    );
    expect(describeViolation({ check: SettleCheck.Pool, event: null })).toBe(
      "the hint pool does not end at 0",
    );
  });
});
