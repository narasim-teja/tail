import { describe, expect, test } from "bun:test";
import { FixFlag, HINT_TEXT_MAX, HintKind } from "@tail/protocol";
import type { RadioFix } from "../../modules/tail-radio";
import { ActionQueue } from "./actions";
import { FixCollector, toWireFix } from "./fixes";

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
    const c = new FixCollector();
    for (const t of [1_000, 1_200, 1_900, 2_950, 2_000, 4_000]) c.add(fix(t));
    expect(c.take(10_000n).map((f) => Number(f.tMs))).toEqual([1_000, 1_900, 2_950, 4_000]);
  });

  test("fixes newer than the batch time wait for the next batch", () => {
    const c = new FixCollector();
    c.add(fix(1_000));
    c.add(fix(3_000));
    expect(c.take(2_000n)).toHaveLength(1);
    expect(c.take(5_000n).map((f) => f.tMs)).toEqual([3_000n]);
  });
});

describe("actions", () => {
  test("a hint question is trimmed and cut to the protocol's limit; an empty one is left out", () => {
    const q = new ActionQueue(() => 1);
    q.hint(HintKind.Near, `  ${"x".repeat(200)} `);
    q.hint(HintKind.Trend, "   ");
    const [a, b] = q.drain();
    expect(a?.kind === "Hint" && a.text?.length).toBe(HINT_TEXT_MAX);
    expect(b).toEqual({ kind: "Hint", hint: HintKind.Trend, nonce: 1 });
    expect(q.size).toBe(0);
  });
});
