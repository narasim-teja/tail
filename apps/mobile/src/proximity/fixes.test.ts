import { describe, expect, test } from "bun:test";
import { FixFlag } from "@tail/protocol";
import type { RadioFix } from "../../modules/tail-radio";
import { currentFix, FIX_MAX_AGE_MS, FixCollector, toWireFix } from "./fixes";

const fix = (tMs: number, o: Partial<RadioFix> = {}): RadioFix => ({
  tMs,
  lat: 42.3551,
  lon: -71.0657,
  acc: 4.2,
  speed: 1.25,
  course: 10,
  simulated: false,
  accessory: false,
  ...o,
});

describe("location fixes", () => {
  test("a CoreLocation fix becomes a wire fix with e7 degrees, accuracy rounded up and speed in cm/s", () => {
    expect(toWireFix(fix(1_000))).toEqual({
      tMs: 1_000n,
      latE7: 423_551_000,
      lonE7: -710_657_000,
      accM: 5,
      speedCmps: 125,
      flags: 0,
    });
  });

  test("the simulated and accessory flags set their bits; unreported flags are clear", () => {
    expect(toWireFix(fix(1, { simulated: true }))?.flags).toBe(FixFlag.SimulatedBySoftware);
    expect(toWireFix(fix(1, { accessory: true }))?.flags).toBe(FixFlag.ProducedByAccessory);
    expect(toWireFix(fix(1, { simulated: null, accessory: null }))?.flags).toBe(0);
  });

  test("fixes without accuracy or with impossible coordinates are dropped, negative speed is zero", () => {
    expect(toWireFix(fix(1, { acc: -1 }))).toBeNull();
    expect(toWireFix(fix(1, { lat: 91 }))).toBeNull();
    expect(toWireFix(fix(1, { speed: -1 }))?.speedCmps).toBe(0);
  });

  test("the collector keeps about one fix a second, strictly increasing in time", () => {
    const c = new FixCollector(() => 4_000);
    for (const t of [1_000, 1_200, 1_900, 2_950, 2_000, 4_000]) c.add(fix(t));
    expect(c.take(10_000n).map((f) => Number(f.tMs))).toEqual([1_000, 1_900, 2_950, 4_000]);
  });

  test("fixes newer than the batch time wait for the next batch", () => {
    const c = new FixCollector(() => 3_000);
    c.add(fix(1_000));
    c.add(fix(3_000));
    expect(c.take(2_000n)).toHaveLength(1);
    expect(c.take(5_000n).map((f) => f.tMs)).toEqual([3_000n]);
  });

  test("a cached fix older than ten seconds is dropped, so it cannot sit before newer fixes", () => {
    const now = 100_000;
    const c = new FixCollector(() => now);
    expect(c.add(fix(now - FIX_MAX_AGE_MS - 1))).toBe(false);
    expect(c.add(fix(now - FIX_MAX_AGE_MS))).toBe(true);
    expect(c.take(BigInt(now)).map((f) => Number(f.tMs))).toEqual([now - FIX_MAX_AGE_MS]);
  });

  test("one age rule says whether a fix is where the phone is now, for the hunt and for Create's zone", () => {
    const now = 100_000;
    expect(currentFix(now - FIX_MAX_AGE_MS, now)).toBe(true);
    // iOS's cached fix after a launch: minutes old, not where the host stands.
    expect(currentFix(now - 5 * 60_000, now)).toBe(false);
  });

  test("after a relaunch the saved last fix time keeps the order: nothing at or before it is sent", () => {
    const before = new FixCollector(() => 50_000);
    before.add(fix(49_000));
    const saved = before.lastT;
    expect(saved).toBe(49_000n);
    const after = new FixCollector(() => 52_000, saved);
    // The cached first fix iOS hands over is the one already sent.
    expect(after.add(fix(49_000))).toBe(false);
    expect(after.add(fix(49_500))).toBe(false);
    expect(after.add(fix(51_000))).toBe(true);
    expect(after.take(52_000n).map((f) => Number(f.tMs))).toEqual([51_000]);
  });
});
