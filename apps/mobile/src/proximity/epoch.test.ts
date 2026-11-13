import { describe, expect, test } from "bun:test";
import { EPOCH_MS } from "@tail/protocol";
import { fakeTime } from "../../test/fake-time";
import { currentEpoch, EpochTimer, msToNextEpoch } from "./epoch";

describe("epoch clock", () => {
  test("the epoch is the whole number of 15 s periods since the start", () => {
    expect(currentEpoch(1_000, 1_000)).toBe(0);
    expect(currentEpoch(1_000 + EPOCH_MS - 1, 1_000)).toBe(0);
    expect(currentEpoch(1_000 + EPOCH_MS, 1_000)).toBe(1);
    expect(currentEpoch(999, 1_000)).toBeNull();
  });

  test("the time to the next boundary counts down within an epoch and to the start before it", () => {
    expect(msToNextEpoch(1_000, 1_000)).toBe(EPOCH_MS);
    expect(msToNextEpoch(1_000 + 14_000, 1_000)).toBe(1_000);
    expect(msToNextEpoch(400, 1_000)).toBe(600);
  });

  test("the timer fires once per epoch, at each boundary, from the start on", () => {
    const t = fakeTime(0);
    const seen: number[] = [];
    const timer = new EpochTimer(10_000, (e) => seen.push(e), t.now, t.timers);
    timer.start();
    t.advance(9_000);
    expect(seen).toEqual([]);
    t.advance(1_100);
    expect(seen).toEqual([0]);
    t.advance(3 * EPOCH_MS);
    expect(seen).toEqual([0, 1, 2, 3]);
    timer.stop();
    t.advance(5 * EPOCH_MS);
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  test("after a stall the timer jumps to the current epoch instead of replaying missed ones", () => {
    const t = fakeTime(0);
    const seen: number[] = [];
    new EpochTimer(0, (e) => seen.push(e), t.now, t.timers).start();
    t.set(10 * EPOCH_MS + 3_000);
    t.advance(EPOCH_MS);
    expect(seen).toEqual([0, 10, 11]);
  });
});
