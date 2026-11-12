// Design tokens: every colour, size, font and timing the app uses comes from here.
//
// Colours come only from @tail/brand (`colors`), the single source the replay uses too. This
// file names their roles in the app and defines no colour of its own. Strategy (DESIGN.md,
// docs/briefs/mobile.md): Committed. Persimmon is spent on the game only (your Trail marker,
// lock, STRIKE, the lock-full takeover); everything else is warm paper and ink.

import { colors } from "@tail/brand";

export const color = {
  /** Page background: warm, light, for low autumn sun. */
  paper: colors.paper,
  /** Second neutral layer: inputs, empty segments, the hint sheet, the map well. */
  sand: colors.sand,
  line: colors.line,
  ink: colors.ink,
  mute: colors.mute,
  /** The signature hue. Text on it is always ink (the Ink Rule). */
  persimmon: colors.persimmon,
} as const;

/**
 * Every text colour on every surface the app draws, with the WCAG minimum it must meet.
 * test/contrast.test.ts computes each ratio. 3:1 rows are display-size text or non-text marks.
 *
 * Persimmon on paper is 2.9:1, under the 3:1 non-text minimum, so it is never text on paper and
 * never the only carrier of a state there: lock segments also change shape (filled vs outlined)
 * and the ink numeral states the value. Your map marker carries a paper halo.
 */
export const contrastPairs = [
  { fg: "ink", bg: "paper", min: 4.5 },
  { fg: "ink", bg: "sand", min: 4.5 },
  { fg: "mute", bg: "paper", min: 4.5 },
  { fg: "mute", bg: "sand", min: 4.5 },
  { fg: "ink", bg: "persimmon", min: 4.5 },
  { fg: "paper", bg: "ink", min: 4.5 },
  { fg: "sand", bg: "ink", min: 4.5 },
  { fg: "paper", bg: "mute", min: 4.5 },
  { fg: "persimmon", bg: "ink", min: 3 },
  { fg: "ink", bg: "line", min: 3 },
] as const satisfies readonly { fg: keyof typeof color; bg: keyof typeof color; min: number }[];

/** 4-point scale, named by relationship. */
export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32, x3: 48, x4: 64 } as const;

export const radius = { s: 10, m: 16, l: 24, pill: 999 } as const;

/** Apple's minimum hit target. Every control is at least this tall and wide. */
export const HIT = 44;
/** STRIKE: the largest one-handed target on screen. */
export const STRIKE_HEIGHT = 112;

// ── Type ─────────────────────────────────────────────────────────────────────────────────
// One family, Archivo, shared with the replay. Embedded at build time (expo-font config plugin)
// and addressed by PostScript name, so no weight is ever synthesised. Every number uses
// tabular figures so digits do not jitter as they change.

export const font = {
  regular: "Archivo-Regular",
  medium: "Archivo-Medium",
  semibold: "Archivo-SemiBold",
  bold: "Archivo-Bold",
  heavy: "Archivo-ExtraBold",
  black: "Archivo-Black",
} as const;

const tabular = ["tabular-nums"] as "tabular-nums"[];

/**
 * Semantic text styles. Steps of about 1.33. `maxScale` caps Dynamic Type for the huge
 * numerals only, so a large text setting cannot push the hunt readouts off screen.
 */
export const text = {
  /** All-caps eyebrow: LOCK, HEAT, HEAD. Tracked out as caps need. */
  eyebrow: { fontFamily: font.bold, fontSize: 12, letterSpacing: 1.4, textTransform: "uppercase" as const },
  caption: { fontFamily: font.medium, fontSize: 13 },
  label: { fontFamily: font.semibold, fontSize: 15 },
  body: { fontFamily: font.regular, fontSize: 17, lineHeight: 24 },
  bodyStrong: { fontFamily: font.semibold, fontSize: 17, lineHeight: 24 },
  title: { fontFamily: font.bold, fontSize: 24, lineHeight: 30, letterSpacing: -0.2 },
  display: { fontFamily: font.heavy, fontSize: 40, lineHeight: 44, letterSpacing: -0.8 },
  /** Briefing: the target's name is the whole screen. */
  poster: { fontFamily: font.black, fontSize: 76, lineHeight: 78, letterSpacing: -2.5 },
  /** Small numbers inline: time left, prices, counts. */
  figure: { fontFamily: font.semibold, fontSize: 15, fontVariant: tabular },
  /** Mid numbers: head, heat. */
  number: { fontFamily: font.heavy, fontSize: 40, lineHeight: 44, fontVariant: tabular, letterSpacing: -0.5 },
  /** The lock numeral: the hero of the hunt screen. */
  hero: { fontFamily: font.black, fontSize: 96, lineHeight: 100, fontVariant: tabular, letterSpacing: -3 },
} as const;

/** Dynamic Type ceilings: labels may grow a lot, giant numerals only a little. */
export const maxScale = { hero: 1.1, number: 1.25, text: 1.8 } as const;

// ── Motion ───────────────────────────────────────────────────────────────────────────────
// Responsive and weighted, exponential ease-out only (no bounce). Exits run at ~75% of entries.
// With Reduce Motion on, every one of these becomes an instant change (ui/motion.ts).

export const motion = {
  fast: 150,
  base: 240,
  slow: 420,
  /** The lock-full flood and the tagged drop. */
  takeover: 360,
  /** Cubic-bezier control points; ui/motion.ts turns them into Easing functions. */
  out: [0.16, 1, 0.3, 1] as const,
  in: [0.7, 0, 0.84, 0] as const,
} as const;

/** A brand colour at an opacity, for map overlays only (tiles behind them vary). */
export function alpha(hex: string, a: number): string {
  const v = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(v.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${a})`;
}
