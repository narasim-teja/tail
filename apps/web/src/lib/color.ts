// OKLCH is the colour space every TAIL token is designed in. WebGL (MapLibre paint, deck.gl
// accessors) needs sRGB numbers, so tokens are written as OKLCH here, or derived from the brand's
// hex values in OKLCH, and converted once.

export type Oklch = { l: number; c: number; h: number };
export type Rgba = [number, number, number, number];

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

export function hexToOklch(hex: string): Oklch {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => toLinear(v / 255)) as [
    number,
    number,
    number,
  ];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

export function oklchToRgb({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return rgb.map((v) => Math.round(Math.min(1, Math.max(0, toGamma(v))) * 255)) as [number, number, number];
}

export const oklch = (l: number, c: number, h: number): Oklch => ({ l, c, h });

/** deck.gl colour: [r, g, b, a] with alpha 0..255. */
export const rgba = (k: Oklch, alpha = 1): Rgba => [...oklchToRgb(k), Math.round(alpha * 255)];

/** MapLibre paint colour string. */
export const css = (k: Oklch, alpha = 1) => {
  const [r, g, b] = oklchToRgb(k);
  return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

export const shift = (k: Oklch, d: Partial<Oklch>): Oklch => ({
  l: k.l + (d.l ?? 0),
  c: Math.max(0, k.c + (d.c ?? 0)),
  h: d.h === undefined ? k.h : d.h,
});
