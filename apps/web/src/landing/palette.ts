// The site's colours. The surfaces and text are the phone app's own (@tail/brand: paper, sand,
// ink, mute, persimmon); the front page then runs day to dusk: it opens on the app's daylight
// paper and, as the visitor reads down from the game to the matches, deepens through a warmer
// noon and an evening sand, falls through a low-sun band (no text sits on it) and lands on the
// replay's dusk. Persimmon is spent only on the game: the hunter, the filling lock, STRIKE.
//
// The hero's map is drawn in a calm palette derived from the same anchors in OKLCH, in the
// manner of Apple Maps (the app's map): land a step under paper, streets in paper, lawns a muted
// sage and water a muted slate blue, both low in chroma so persimmon stays the only loud colour.
//
// mount.tsx writes these onto the page as CSS custom properties. test/landing.test.tsx holds
// every text colour to WCAG AA on every ground it is set on, the map's labels included.

import { colors } from "@tail/brand";
import { hexToOklch, type Oklch, oklch, oklchToRgb } from "../lib/color.ts";

const paper = hexToOklch(colors.paper);
const sand = hexToOklch(colors.sand);
const ink = hexToOklch(colors.ink);
const mute = hexToOklch(colors.mute);
const dusk = hexToOklch(colors.dusk);
const duskInk = hexToOklch(colors.duskInk);
const persimmon = hexToOklch(colors.persimmon);

/** Grounds, top of the page to the bottom, and the app's raised sand. */
export const ground = {
  /** The hero and the docs: the app's paper. */
  day: paper,
  /** The hints drift a step warmer. */
  noon: oklch(0.965, 0.011, 75),
  /** How it's checked: sand in low sun. */
  evening: oklch(0.94, 0.018, 68),
  /** The matches (the sofa): the replay's dusk. */
  dusk,
  /** The dossier and the footer sink a little further. */
  night: oklch(dusk.l - 0.035, dusk.c * 0.95, dusk.h),
  /** STRIKE: the app's lock-full takeover. */
  strike: persimmon,
  /** The app's second neutral: sheets, rows, secondary buttons. */
  sand,
  /** Sand under a pointer or a press. */
  sandHover: oklch(sand.l - 0.035, sand.c + 0.004, sand.h),
} as const;

/** The low-sun band between evening and dusk, in order. Decorative: nothing is set on it. */
export const sunset: Oklch[] = [
  ground.evening,
  oklch(0.83, 0.045, 52),
  oklch(0.66, 0.06, 28),
  oklch(0.48, 0.045, 340),
  oklch(0.34, 0.032, 280),
  dusk,
];

/** Text, by the ground it sits on. */
export const text = {
  ink,
  /** Secondary text on the light grounds: the app's mute. */
  inkSoft: mute,
  /** The primary button under a pointer. */
  inkHover: oklch(ink.l + 0.09, ink.c, ink.h),
  duskInk,
  /** Secondary text on dusk. */
  duskSoft: oklch(duskInk.l - 0.15, duskInk.c + 0.004, duskInk.h),
} as const;

/** The hero's map. */
export const map = {
  /** Blocks: a step under paper, as Apple Maps sets the built city. */
  land: oklch(0.925, 0.012, 75),
  /** Streets, light on the land. */
  road: oklch(0.985, 0.005, 80),
  park: oklch(0.885, 0.042, 138),
  /** Footpaths across the lawns. */
  path: oklch(0.95, 0.022, 120),
  water: oklch(0.82, 0.042, 232),
  /** Street and place names: ink at low contrast. */
  label: oklch(0.5, 0.018, 60),
  parkLabel: oklch(0.42, 0.06, 140),
  waterLabel: oklch(0.42, 0.06, 236),
} as const;

export const accent = { persimmon } as const;

/** Hairlines: separation, never text. */
export const line = {
  day: hexToOklch(colors.line),
  dusk: oklch(dusk.l + 0.11, dusk.c * 0.8, dusk.h),
} as const;

type Pair = { fg: Oklch; bg: Oklch; what: string };
const on = (fgs: (keyof typeof text)[], bgs: (keyof typeof ground)[]): Pair[] =>
  fgs.flatMap((f) => bgs.map((b) => ({ fg: text[f], bg: ground[b], what: `${f} on ${b}` })));

/** Every text colour on every ground it is set on (the pairs the contrast test checks). */
export const PAIRS: Pair[] = [
  ...on(["ink", "inkSoft"], ["day", "noon", "evening", "sand"]),
  // Only links and buttons darken to sandHover, and they are ink.
  ...on(["ink"], ["sandHover", "strike"]),
  { fg: ground.day, bg: text.ink, what: "paper on the ink button" },
  { fg: ground.day, bg: text.inkHover, what: "paper on the ink button, hovered" },
  ...on(["duskInk", "duskSoft"], ["dusk", "night"]),
  { fg: map.label, bg: map.road, what: "street names on their streets" },
  { fg: map.label, bg: map.land, what: "place names on the land" },
  { fg: map.parkLabel, bg: map.park, what: "park names on the lawns" },
  { fg: map.waterLabel, bg: map.park, what: "water names on the lawns" },
  { fg: text.ink, bg: map.land, what: "the map's credit and names, at worst" },
];

/** CSS colour. Every value here is inside sRGB, so browsers paint what the contrast test measured. */
export const css = (k: Oklch) => `oklch(${k.l.toFixed(4)} ${k.c.toFixed(4)} ${k.h.toFixed(2)})`;

/** WCAG 2.2 contrast ratio between two colours. */
export function contrast(a: Oklch, b: Oklch): number {
  const lum = (k: Oklch) => {
    const [r, g, bl] = oklchToRgb(k).map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The custom properties the stylesheet reads. */
export function cssVars(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ground)) out[`--g-${k}`] = css(v);
  for (const [k, v] of Object.entries(text)) out[`--t-${k}`] = css(v);
  for (const [k, v] of Object.entries(line)) out[`--line-${k}`] = css(v);
  for (const [k, v] of Object.entries(map)) out[`--map-${k}`] = css(v);
  out["--persimmon"] = css(accent.persimmon);
  out["--sunset"] = sunset.map(css).join(", ");
  return out;
}
