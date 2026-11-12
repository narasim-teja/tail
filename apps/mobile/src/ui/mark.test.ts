import { describe, expect, test } from "bun:test";
import { markRotation } from "./mark";

describe("Trail marker", () => {
  test("turns from its drawn north-east heading to the direction of travel", () => {
    expect(markRotation(45)).toBe(0);
    expect(markRotation(0)).toBe(315);
    expect(markRotation(180)).toBe(135);
    expect(markRotation(null)).toBe(0);
  });
});
