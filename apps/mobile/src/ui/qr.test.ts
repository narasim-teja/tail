import { describe, expect, test } from "bun:test";
import { qrPath } from "./qr";

describe("lobby QR", () => {
  test("encodes a join link as a square of modules with a quiet zone", () => {
    const q = qrPath(`tail://join/${"ab".repeat(16)}`);
    expect(q.count).toBeGreaterThanOrEqual(25);
    expect(q.d.startsWith("M4 4h1v1h-1z")).toBe(true);
  });
});
