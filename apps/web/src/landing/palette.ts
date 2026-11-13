// The front page's colours: day to dusk. The page opens on the app's daylight paper and, as the
// visitor reads down from the game to the proof, the ground deepens through a late-afternoon
// sand, falls through a low-sun band (no text sits on it) and lands on the replay's dusk.
// Persimmon is spent only on the game: the hunter, the filling lock, STRIKE.
//
// Brand colours (@tail/brand) are the anchors; the rest is derived here in OKLCH and written
// onto the page as CSS custom properties by mount.tsx. test/landing.test.ts holds every text
// colour to WCAG AA on every ground it is set on.

import { colors } from "@tail/brand";
import { hexToOklch, type Oklch, oklch, oklchToRgb } from "../lib/color.ts";

const paper = hexToOklch(colors.paper);
const ink = hexToOklch(colors.ink);
const dusk = hexToOklch(colors.dusk);
const duskInk = hexToOklch(colors.duskInk);
const persimmon = hexToOklch(colors.persimmon);

/** Grounds, top of the page to the bottom. */
export const ground = {
  /** The hero: the app's paper. */
  day: paper,
  /** The four beats drift a step warmer. */
  noon: oklch(0.965, 0.012, 75),
  /** The money: sand in low sun. */
  afternoon: oklch(0.945, 0.017, 70),
  /** The proof's first steps (the park). */
  evening: oklch(0.925, 0.021, 64),
  /** The proof's last steps, the matches (the sofa): the replay's dusk. */
  dusk,
  /** The dossier and the footer sink a little further. */
  night: oklch(dusk.l - 0.035, dusk.c * 0.95, dusk.h),
  /** STRIKE: the app's lock-full takeover. */
  strike: persimmon,
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
  /** Secondary text on the light grounds. */
  inkSoft: oklch(0.47, 0.018, 58),
  duskInk,
  /** Secondary text on dusk. */
  duskSoft: oklch(duskInk.l - 0.15, duskInk.c + 0.004, duskInk.h),
} as const;

export const accent = { persimmon } as const;

/** Hairlines: separation, never text. */
export const line = {
  day: oklch(0.88, 0.018, 70),
  dusk: oklch(dusk.l + 0.11, dusk.c * 0.8, dusk.h),
} as const;

/** Which text sits on which ground (the pairs the contrast test checks). */
export const PAIRS: { fg: keyof typeof text; bg: keyof typeof ground }[] = [
  ...(["day", "noon", "afternoon", "evening"] as const).flatMap((bg) => [
    { fg: "ink" as const, bg },
    { fg: "inkSoft" as const, bg },
  ]),
  { fg: "ink", bg: "strike" },
  ...(["dusk", "night"] as const).flatMap((bg) => [
    { fg: "duskInk" as const, bg },
    { fg: "duskSoft" as const, bg },
  ]),
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
  out["--persimmon"] = css(accent.persimmon);
  out["--sunset"] = sunset.map(css).join(", ");
  return out;
}
