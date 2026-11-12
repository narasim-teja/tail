// The replay's dusk palette. Brand colours come from @tail/brand; everything else is derived
// from them in OKLCH so the map, the layers and the chrome share one temperature.

import { colors } from "@tail/brand";
import { hexToOklch, oklch, shift } from "../lib/color.ts";

const dusk = hexToOklch(colors.dusk);
const duskInk = hexToOklch(colors.duskInk);
const persimmon = hexToOklch(colors.persimmon);
const ink = hexToOklch(colors.ink);

export const palette = {
  persimmon,
  ink,
  duskInk,
  dusk,
  // Map ground: the brand dusk, a touch deeper so the park reads as lit.
  land: shift(dusk, { l: -0.03 }),
  landEdge: shift(dusk, { l: 0.02 }),
  park: oklch(0.262, 0.024, 172),
  parkEdge: oklch(0.3, 0.024, 172),
  wood: oklch(0.245, 0.026, 165),
  water: oklch(0.285, 0.048, 238),
  waterEdge: oklch(0.4, 0.05, 236),
  // Paths read as lamplit gravel: warm, low chroma, the brightest thing on the ground.
  path: oklch(0.6, 0.032, 72),
  road: shift(dusk, { l: 0.06, c: -0.008 }),
  roadMajor: shift(dusk, { l: 0.09, c: -0.01 }),
  building: shift(dusk, { l: 0.05, c: -0.005 }),
  buildingTop: shift(dusk, { l: 0.12, c: -0.008 }),
  label: shift(duskInk, { l: -0.25, c: 0.004 }),
  labelHalo: shift(dusk, { l: -0.03 }),
  sky: oklch(0.3, 0.04, 262),
  horizon: oklch(0.42, 0.035, 25),
  // People: warm light neutral markers with ink initials; the chase in focus is persimmon.
  marker: duskInk,
  markerOut: shift(duskInk, { l: -0.45, c: -0.004 }),
  trail: shift(duskInk, { l: -0.12 }),
  zone: shift(duskInk, { l: -0.2 }),
  shade: shift(dusk, { l: -0.08 }),
} as const;
