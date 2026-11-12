import { describe, expect, test } from "bun:test";
import { contrast } from "../src/ui/contrast";
import { color, contrastPairs } from "../src/ui/theme";

describe("contrast in sunlight", () => {
  test("the ratio formula matches WCAG's reference values", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
  });

  for (const p of contrastPairs) {
    test(`${p.fg} on ${p.bg} meets ${p.min}:1`, () => {
      expect(contrast(color[p.fg], color[p.bg])).toBeGreaterThanOrEqual(p.min);
    });
  }
});
