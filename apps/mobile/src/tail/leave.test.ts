import { describe, expect, test } from "bun:test";
import { DARK_FORFEIT_MS } from "@tail/protocol";
import { leaveCountdown, leaveStep, reports } from "./leave";

const NOW = 1_800_000_000_000;
const END = NOW + 20 * 60_000;
const hunting = { leftAtMs: null, status: "hunting" as const, over: false };

describe("leaving a match", () => {
  test("leave stops reporting; leaving again keeps when the dark run began; rejoin reports again", () => {
    expect(reports(hunting)).toBe(true);
    const left = leaveStep(hunting, { kind: "leave", atMs: NOW });
    expect(left).toBe(NOW);
    expect(reports({ ...hunting, leftAtMs: left })).toBe(false);
    expect(leaveStep({ ...hunting, leftAtMs: NOW }, { kind: "leave", atMs: NOW + 5_000 })).toBe(NOW);
    expect(leaveStep({ ...hunting, leftAtMs: NOW }, { kind: "rejoin" })).toBeNull();
    // Before the referee's first HUD the player is in play too.
    expect(leaveStep({ ...hunting, status: null }, { kind: "leave", atMs: NOW })).toBe(NOW);
  });

  test("once the referee has called it, neither choice changes anything", () => {
    for (const f of [
      { leftAtMs: NOW, status: "out" as const, over: false },
      { leftAtMs: NOW, status: "won" as const, over: false },
      { leftAtMs: NOW, status: "hunting" as const, over: true },
    ]) {
      expect(leaveStep(f, { kind: "rejoin" })).toBe(NOW);
      expect(reports({ ...f, leftAtMs: null })).toBe(false);
    }
    expect(
      leaveStep({ leftAtMs: null, status: "out", over: false }, { kind: "leave", atMs: NOW }),
    ).toBeNull();
  });
});

describe("the forfeit countdown, from the referee's dark_ms", () => {
  const hud = (totalMs: number, counting: boolean, atMs: number) => ({ totalMs, runMs: 0, counting, atMs });

  test("not counted yet: the referee will count the whole run from when the phone stopped", () => {
    expect(leaveCountdown(NOW, NOW, null, END)).toEqual({
      seconds: DARK_FORFEIT_MS / 1000,
      endsFirst: false,
    });
    // A HUD in the grace after leaving still shows the old count; the run is already 15 s long.
    expect(leaveCountdown(NOW + 15_000, NOW, hud(30_000, false, NOW + 10_000), END).seconds).toBe(135);
  });

  test("counting: the referee's own figure, run on from its last HUD", () => {
    // 100 s counted at the HUD 4 s ago, so 76 s are left.
    expect(leaveCountdown(NOW + 60_000, NOW, hud(100_000, true, NOW + 56_000), END).seconds).toBe(76);
  });

  test("dark time from before leaving counts: it is cumulative", () => {
    expect(leaveCountdown(NOW, NOW, hud(150_000, false, NOW - 30_000), END).seconds).toBe(30);
  });

  test("due once the count is in; never negative", () => {
    expect(leaveCountdown(NOW + 400_000, NOW, hud(170_000, true, NOW + 390_000), END)).toEqual({
      seconds: 0,
      endsFirst: false,
    });
  });

  test("a match that ends before the forfeit leaves the head with the player", () => {
    expect(leaveCountdown(NOW, NOW, null, NOW + 60_000)).toEqual({ seconds: 180, endsFirst: true });
  });
});
