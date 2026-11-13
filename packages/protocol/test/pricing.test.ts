import { expect, test } from "bun:test";
import {
  demandBps,
  HINT_BPS,
  HintKind,
  hintPrice,
  PRICE_CAP_BPS,
  PRICE_STEP_BPS,
  PRICE_WINDOW_MS,
  priceReason,
  recentHints,
} from "../src/index.ts";
import pricingV from "../vectors/pricing.json";

// crates/tail-protocol/tests/vectors.rs reproduces the same file.
test("constants match the vectors", () => {
  expect(pricingV.windowMs).toBe(PRICE_WINDOW_MS);
  expect(pricingV.stepBps).toBe(PRICE_STEP_BPS);
  expect(pricingV.capBps).toBe(PRICE_CAP_BPS);
  expect(pricingV.hintBps).toEqual([
    HINT_BPS[HintKind.Near],
    HINT_BPS[HintKind.Bearing],
    HINT_BPS[HintKind.Trend],
  ]);
});

test("every priced case matches the vectors", () => {
  for (const c of pricingV.prices) {
    if (c.price === null) continue;
    expect(hintPrice(BigInt(c.stake), c.kind as HintKind, c.recent).toString()).toBe(c.price);
  }
  expect(pricingV.prices.filter((c) => c.price === null).every((c) => c.kind === 3)).toBe(true);
});

test("recent hints count the window open below and closed above", () => {
  for (const c of pricingV.recent) expect(recentHints(c.times.map(BigInt), BigInt(c.now))).toBe(c.recent);
});

test("the Handler's reasons match the vectors", () => {
  for (const c of pricingV.reasons) expect(priceReason(c.kind as HintKind, c.recent)).toBe(c.reason);
});

test("a quiet match pays the base price; demand adds a quarter per hint, up to 4x", () => {
  expect(hintPrice(1_000_000n, HintKind.Bearing, 0)).toBe(50_000n);
  expect(hintPrice(1_000_000n, HintKind.Near, 0)).toBe(20_000n);
  expect(hintPrice(1_000_000n, HintKind.Bearing, 4)).toBe(100_000n);
  expect(hintPrice(1_000_000n, HintKind.Bearing, 99)).toBe(200_000n);
  expect(hintPrice(49n, HintKind.Near, 5)).toBe(0n);
  expect(demandBps(1)).toBe(12_500n);
  expect(priceReason(HintKind.Bearing, 4)).toBe(
    "Intel's dear: 4 hints bought in the last 5 minutes put Bearing at 2x.",
  );
});
