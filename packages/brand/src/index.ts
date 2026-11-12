// TAIL brand: the single source for colours, the Trail mark and the game icons. The phone app
// (react-native-svg `SvgXml`) and the replay (inline SVG) both render from these strings, and
// `scripts/build.ts` writes the static files in `assets/` from the same data.

/** sRGB hex for every surface that needs one; OKLCH originals in the comments. */
export const colors = {
  /** Signature hue. oklch(0.68 0.17 40). Spent only on the game: your marker, lock, STRIKE. */
  persimmon: "#EE6A3F",
  /** Text and strokes on light surfaces. oklch(0.24 0.02 45), warm, never pure black. */
  ink: "#2B211C",
  /** App surface. oklch(0.98 0.008 75), warm, never pure white. */
  paper: "#FBF7F1",
  /** Raised or grouped areas on paper. oklch(0.95 0.012 75). */
  sand: "#F3ECE3",
  /** Hairlines on paper. */
  line: "#E4DACD",
  /** Secondary text on paper (passes AA at 14 px+). */
  mute: "#6E655D",
  /** Replay surface. oklch(0.25 0.025 255), slate, never black. */
  dusk: "#1C2430",
  /** Text on dusk. */
  duskInk: "#F1ECE5",
} as const;

export type BrandColor = keyof typeof colors;

/** The Trail mark: a location dot moving, its trail fading behind it. 64-unit grid. */
export const trail = {
  viewBox: "0 0 64 64",
  tail: "M33.8 11.8 Q14 30 7 57 Q30 46 52.2 30.2 Z",
  dot: { cx: 43, cy: 21, r: 13 },
} as const;

export interface MarkOptions {
  /** Dot colour; the trail is the same colour at `trailOpacity`. */
  color?: string;
  trailOpacity?: number;
  size?: number;
  /** Accessible name; omit for decoration (then aria-hidden). */
  label?: string;
}

/** The Trail mark as a standalone SVG string. */
export function markSvg({
  color = colors.persimmon,
  trailOpacity = 0.38,
  size = 64,
  label,
}: MarkOptions = {}) {
  const a11y = label ? `role="img" aria-label="${escapeXml(label)}"` : `aria-hidden="true"`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${trail.viewBox}" width="${size}" height="${size}" ${a11y}>` +
    `<path d="${trail.tail}" fill="${color}" fill-opacity="${trailOpacity}"/>` +
    `<circle cx="${trail.dot.cx}" cy="${trail.dot.cy}" r="${trail.dot.r}" fill="${color}"/>` +
    `</svg>`
  );
}

/**
 * The iOS app icon (1024 square, no transparency; iOS applies the corner mask). Warm field
 * with a paper mark by default; `light` puts the persimmon mark on sand.
 */
export function appIconSvg(variant: "warm" | "light" = "warm", size = 1024) {
  const field = variant === "warm" ? colors.persimmon : colors.sand;
  const mark = variant === "warm" ? colors.paper : colors.persimmon;
  const trailOpacity = variant === "warm" ? 0.5 : 0.38;
  // The mark spans 2/3 of the tile, centred on its visual weight (the dot sits up-right).
  const inner = (size * 2) / 3;
  const offset = (size - inner) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="TAIL">` +
    `<rect width="${size}" height="${size}" fill="${field}"/>` +
    `<g transform="translate(${offset} ${offset}) scale(${inner / 64})">` +
    `<path d="${trail.tail}" fill="${mark}" fill-opacity="${trailOpacity}"/>` +
    `<circle cx="${trail.dot.cx}" cy="${trail.dot.cy}" r="${trail.dot.r}" fill="${mark}"/>` +
    `</g></svg>`
  );
}

/**
 * Game icons: 24-unit grid, 1.75 stroke, round ends, drawn in `currentColor` so they inherit
 * text colour. No crosshairs anywhere (the tactical-HUD look is an anti-reference).
 */
export const icons = {
  near: '<circle cx="12" cy="12" r="9" stroke-dasharray="2.6 2.6"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/>',
  bearing:
    '<circle cx="12" cy="12" r="9"/><path d="M16 8 L13.2 13.2 L8 16 L10.8 10.8 Z" fill="currentColor"/>',
  trend:
    '<path d="M3.5 17 C7.5 17 9 9 14 9"/><path d="M11.5 6.5 L14 9 L11.5 11.5"/><circle cx="19" cy="9" r="2" fill="currentColor" stroke="none"/>',
  lock: '<circle cx="12" cy="12" r="8" stroke-opacity="0.3"/><path d="M12 4 A8 8 0 1 1 4 12"/>',
  heat: '<circle cx="17" cy="12" r="2.5" fill="currentColor" stroke="none"/><path d="M11.5 8 A6 6 0 0 0 11.5 16"/><path d="M7.5 5 A10 10 0 0 0 7.5 19"/>',
  strike:
    '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/><path d="M5.6 5.6 L7.8 7.8"/><path d="M18.4 5.6 L16.2 7.8"/><path d="M5.6 18.4 L7.8 16.2"/><path d="M18.4 18.4 L16.2 16.2"/>',
  safehouse: '<path d="M4 11 L12 4.5 L20 11 V19.5 H4 Z"/><path d="M10 19.5 V14.5 H14 V19.5"/>',
  verified: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5 L11 15.5 L16.5 9"/>',
  handler: '<path d="M5 5.5 H19 V15.5 H11 L7 19 V15.5 H5 Z"/><path d="M9 10.5 H15"/>',
  dark: '<circle cx="12" cy="12" r="8"/><path d="M6.3 17.7 L17.7 6.3"/>',
  zone: '<circle cx="12" cy="12" r="9" stroke-dasharray="0.1 3.4"/><path d="M12 8.5 C10.3 8.5 9.2 9.7 9.2 11.2 C9.2 13.3 12 15.8 12 15.8 C12 15.8 14.8 13.3 14.8 11.2 C14.8 9.7 13.7 8.5 12 8.5 Z"/>',
  head: '<ellipse cx="12" cy="7" rx="7" ry="2.5"/><path d="M5 7 V12 C5 13.4 8.1 14.5 12 14.5 C15.9 14.5 19 13.4 19 12 V7"/><path d="M5 12 V17 C5 18.4 8.1 19.5 12 19.5 C15.9 19.5 19 18.4 19 17 V12"/>',
} as const;

export type IconName = keyof typeof icons;

/** A game icon as a standalone SVG string. */
export function iconSvg(
  name: IconName,
  { size = 24, color = "currentColor", label }: { size?: number; color?: string; label?: string } = {},
) {
  const a11y = label ? `role="img" aria-label="${escapeXml(label)}"` : `aria-hidden="true"`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" ` +
    `stroke="${color}" color="${color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ${a11y}>` +
    `${icons[name]}</svg>`
  );
}

function escapeXml(s: string) {
  return s.replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] as string,
  );
}
