import { describe, expect, test } from "bun:test";
import { heatIntervalMs } from "./cadence";

describe("heat haptic cadence", () => {
  test("is silent at zero heat and beats faster as heat rises", () => {
    const steps = [0, 1, 2, 3, 4, 9].map(heatIntervalMs);
    expect(steps[0]).toBeNull();
    const beats = steps.slice(1) as number[];
    for (let i = 1; i < 4; i++) expect(beats[i] as number).toBeLessThan(beats[i - 1] as number);
    expect(beats[4]).toBe(beats[3]);
  });
});
