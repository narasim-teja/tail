// Design tokens: every colour, size and font the app uses comes from here, so the design pass
// (docs/DESIGN.md) is a restyle of this file, not a rewrite of the screens.
//
// Colours come only from @tail/brand, the single source for the replay too. This file names
// their roles in the app; it defines no colour of its own.

import { colors } from "@tail/brand";

export const color = {
  /** Page background: warm, light, for sunlight. */
  surface: colors.paper,
  /** Grouped rows, inputs, the empty part of a bar, the Handler sheet. */
  surfaceSunk: colors.sand,
  line: colors.line,
  ink: colors.ink,
  inkMuted: colors.mute,
  /** The signature hue, spent only on the game: your marker, a filling lock, STRIKE. */
  signature: colors.persimmon,
  /** The Ink Rule: text on the signature hue is dark ink, never white. */
  onSignature: colors.ink,
  /** Heat: someone is on you. Ink against lock's persimmon, and always with a number. */
  heat: colors.ink,
  /** Errors are ink, bold, and always a sentence: the brand spends no hue on them. */
  danger: colors.ink,
} as const;

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 } as const;

export const radius = { s: 8, m: 14, l: 22 } as const;

/** Apple's minimum hit target. Every control is at least this tall and wide. */
export const HIT = 44;
/** STRIKE is the largest one-handed target on screen. */
export const STRIKE_HEIGHT = 96;

// One placeholder family with true tabular numerals; swap it here. Avenir Next ships with iOS,
// so the seed needs no font files.
const FAMILY = "Avenir Next";

export const type = {
  family: FAMILY,
  /** Lock, heat, head and the clock: numbers are the heroes. */
  number: {
    fontFamily: FAMILY,
    fontVariant: ["tabular-nums"] as "tabular-nums"[],
    fontWeight: "700" as const,
  },
  // Steps of at least 1.25.
  size: { caption: 12, label: 14, body: 17, title: 22, display: 34, hero: 54 },
  weight: { regular: "400" as const, medium: "500" as const, bold: "700" as const },
} as const;
