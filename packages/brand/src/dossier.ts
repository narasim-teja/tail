// The Dossier card: a player's trail through their last settled matches, drawn as one SVG.
//
// The contract builds the same picture on every `nft_token` read (`contracts/tail/src/art.rs`),
// so the two builders must agree byte for byte; `vectors/dossier.json` pins that, and both sides
// test against it. To keep them equal the drawing uses integers only (no trigonometry, no float
// formatting): every coordinate is an integer, divisions truncate toward zero, and the only
// randomness is the 32-byte `seed` (SHA-256 of the account id) the contract puts in the view.
//
// The picture, from back to front:
//  - a case-file folder in dusk, its tab reading DOSSIER and a file number from the seed;
//  - three contour loops around a seeded centre, a faint map of the ground walked;
//  - the route: 13 waypoints on a seeded serpentine (three rows climbing the card), one segment
//    per match, oldest first. Walked segments fade with age in three bands, like the mark's
//    trail; a refunded match is a dashed grey segment; the route not yet walked is dotted;
//  - at the end of each segment its result: survived, a filled persimmon dot; tagged, a hollow
//    ring; forfeit, a ring with a slash; refunded, a small grey dot. Each tag the player landed
//    in that match is a persimmon tick across the segment;
//  - the Trail mark at the head of the route, facing the way the last segment went;
//  - the footer: handle, counts (matches, survived, tags) and "verified on NEAR".
// Persimmon is spent only on the player's own marks: survivals, tags and the head.

import { colors, trail } from "./index.ts";

export type DossierResult = "survived" | "tagged" | "forfeit" | "refunded";

/** One settled match in a dossier, as the contract's `get_dossier` returns it. */
export interface DossierEntry {
  match_id: string;
  result: DossierResult;
  /** Tags the player landed in that match (0 for a refunded one: nothing in it counted). */
  tags: number;
  /** What settlement credited the player, smallest token units, decimal. */
  payout: string;
  /** The log root the match anchored last (End's, or the last checkpoint's for an abort). */
  log_size: string;
  root: string;
}

/** `get_dossier(account_id)`: counts over settled matches, entries newest first. */
export interface DossierView {
  account_id: string;
  /** SHA-256 of the account id, hex: the only input the art draws randomness from. */
  seed: string;
  matches: number;
  survived: number;
  tags: number;
  forfeits: number;
  refunded: number;
  /** Total payouts of the settled matches, smallest token units, decimal. */
  won: string;
  entries: DossierEntry[];
}

/** Segments on the route; the contract keeps exactly this many entries per player. */
export const DOSSIER_ENTRIES = 12;
/** The hard limit for the SVG, so wallets and the contract view stay light. */
export const DOSSIER_SVG_MAX = 4096;

const W = 400;
const H = 500;
const SANS = "system-ui,sans-serif";
const MONO = "ui-monospace,Menlo,monospace";

/** Route waypoints before jitter: rows of 5, 4 and 4, bottom to top, snaking. */
const BASE: readonly (readonly [number, number])[] = [
  [64, 320],
  [132, 320],
  [200, 320],
  [268, 320],
  [336, 320],
  [312, 232],
  [236, 232],
  [164, 232],
  [88, 232],
  [88, 144],
  [164, 144],
  [236, 144],
  [312, 144],
];

/** cos and sin of the eight compass points, times 1000. */
const DIRS: readonly (readonly [number, number])[] = [
  [1000, 0],
  [707, 707],
  [0, 1000],
  [-707, 707],
  [-1000, 0],
  [-707, -707],
  [0, -1000],
  [707, -707],
];

type Pt = readonly [number, number];

const div = (a: number, b: number) => Math.trunc(a / b);
const pt = (p: Pt) => `${p[0]} ${p[1]}`;
/** A relative pair; a minus sign separates the numbers by itself. */
const rel = (dx: number, dy: number) => `${dx}${dy < 0 ? "" : " "}${dy}`;

function seedBytes(hex: string): number[] {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("dossier seed must be 64 lowercase hex chars");
  return Array.from({ length: 32 }, (_, i) => Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16));
}

/** The 13 waypoints and the 12 control points of the route. */
function route(s: number[]): { w: Pt[]; c: Pt[] } {
  const mirror = (s[31] as number) >= 128;
  const w: Pt[] = BASE.map(([x, y], k) => {
    const jx = x + ((s[k] as number) % 33) - 16;
    const jy = y + ((s[k + 13] as number) % 33) - 16;
    return [mirror ? W - jx : jx, jy];
  });
  const c: Pt[] = [];
  for (let k = 0; k < DOSSIER_ENTRIES; k++) {
    const [a, b] = [w[k] as Pt, w[k + 1] as Pt];
    const byte = s[26 + (k >> 1)] as number;
    const bend = (k % 2 === 0 ? byte & 15 : byte >> 4) * 4 - 30;
    const mx = div(a[0] + b[0], 2);
    const my = div(a[1] + b[1], 2);
    if (Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1])) c.push([mx, my + bend]);
    else {
      // A turn between rows bulges outward, away from the middle of the card.
      const out = mx > W / 2 ? Math.abs(bend) : -Math.abs(bend);
      c.push([Math.min(W - 16, Math.max(16, mx + out)), my]);
    }
  }
  return { w, c };
}

/** Three closed contour loops, quadratic curves through the midpoints of 8 jittered points. */
function contours(s: number[]): string {
  const cx = 150 + ((s[24] as number) % 101);
  const cy = 210 + ((s[25] as number) % 41);
  let d = "";
  for (let loop = 0; loop < 3; loop++) {
    const p: Pt[] = DIRS.map(([ux, uy], j) => {
      const r = 40 * (loop + 1) + ((s[(loop * 8 + j) % 32] as number) % 21) - 10;
      return [cx + div(r * ux, 1000), cy + div(r * uy * 3, 4000)];
    });
    const mid = (j: number): Pt => {
      const [a, b] = [p[j % 8] as Pt, p[(j + 1) % 8] as Pt];
      return [div(a[0] + b[0], 2), div(a[1] + b[1], 2)];
    };
    d += `M${pt(mid(7))}`;
    for (let j = 0; j < 8; j++) d += `Q${pt(p[j] as Pt)} ${pt(mid(j))}`;
    d += "Z";
  }
  return d;
}

/** Segments `ks` of the route as one path's `d`, joining runs that continue each other. */
function segments(ks: number[], w: Pt[], c: Pt[]): string {
  let d = "";
  let last = -1;
  for (const k of ks) {
    if (k !== last + 1 || d === "") d += `M${pt(w[k] as Pt)}`;
    d += `Q${pt(c[k] as Pt)} ${pt(w[k + 1] as Pt)}`;
    last = k;
  }
  return d;
}

/** The Dossier card for `view`, as an SVG string of at most `DOSSIER_SVG_MAX` bytes. */
export function dossierSvg(view: DossierView): string {
  // Read here, not at module load: index.ts re-exports this module, so `colors` is not
  // initialised yet while this file's top level runs.
  const INK = colors.duskInk;
  const stroke = (d: string, attrs: string) =>
    d ? `<path d="${d}" fill="none" stroke="${INK}" ${attrs}/>` : "";
  const s = seedBytes(view.seed);
  const { w, c } = route(s);
  // Oldest first: the route is walked in the order the matches settled.
  const entries = view.entries.slice(0, DOSSIER_ENTRIES).reverse();
  const n = entries.length;

  let walked = "";
  // Three age bands, newest brightest: the trail fades behind the head, like the mark's.
  for (const [band, opacity] of [
    [2, ".3"],
    [1, ".55"],
    [0, ".9"],
  ] as const) {
    const ks = entries.flatMap((e, k) => (e.result !== "refunded" && div(n - 1 - k, 4) === band ? [k] : []));
    walked += stroke(
      segments(ks, w, c),
      `stroke-opacity="${opacity}" stroke-width="2.5" stroke-linecap="round"`,
    );
  }
  const refunded = entries.flatMap((e, k) => (e.result === "refunded" ? [k] : []));
  const ahead = Array.from({ length: DOSSIER_ENTRIES - n }, (_, i) => n + i);

  let ticks = "";
  // Each tick is a move then an 8-unit stroke; after the first, the move is relative.
  let pen: Pt | null = null;
  let won = "";
  let rings = "";
  let slashes = "";
  let grey = "";
  entries.forEach((e, k) => {
    const [a, b, q] = [w[k] as Pt, w[k + 1] as Pt, c[k] as Pt];
    const flat = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
    const t = e.result === "refunded" ? 0 : e.tags;
    for (let i = 1; i <= t; i++) {
      // The point at i/(t+1) along the segment's quadratic curve.
      const m = t + 1;
      const [u, v, z] = [(m - i) * (m - i), 2 * i * (m - i), i * i];
      const x = div(u * a[0] + v * q[0] + z * b[0], m * m);
      const y = div(u * a[1] + v * q[1] + z * b[1], m * m);
      const start: Pt = flat ? [x, y - 4] : [x - 4, y];
      ticks += pen ? `m${rel(start[0] - pen[0], start[1] - pen[1])}` : `M${pt(start)}`;
      ticks += flat ? "v8" : "h8";
      pen = flat ? [start[0], start[1] + 8] : [start[0] + 8, start[1]];
    }
    const dot = (r: number) => `<circle cx="${b[0]}" cy="${b[1]}" r="${r}"/>`;
    if (e.result === "survived") won += dot(5);
    else if (e.result === "refunded") grey += dot(3);
    else {
      rings += dot(5);
      if (e.result === "forfeit") slashes += `M${b[0] - 3} ${b[1] + 3}l6-6`;
    }
  });

  const head = w[n] as Pt;
  const from = w[n === 0 ? 0 : n - 1] as Pt;
  const to = n === 0 ? (w[1] as Pt) : head;
  // The mark faces north-east; flipped, north-west. Its trail's tip lands on the head.
  const flip = to[0] < from[0];
  const mark =
    `<g transform="translate(${flip ? head[0] + 5 : head[0] - 5} ${head[1] - 43}) scale(${flip ? "-.75" : ".75"} .75)" fill="${colors.persimmon}">` +
    `<path d="${trail.tail}" fill-opacity=".38"/><circle cx="${trail.dot.cx}" cy="${trail.dot.cy}" r="${trail.dot.r}"/></g>`;

  // NEAR account ids are lowercase letters, digits and `-_.`, so nothing in them needs escaping.
  if (!/^[a-z0-9._-]{2,64}$/.test(view.account_id)) throw new Error("not a NEAR account id");
  const handle = view.account_id.split(".")[0] as string;
  const fs = Math.min(34, div(600, handle.length));
  const file = view.seed.slice(0, 8).toUpperCase();
  const count = (v: number, label: string) =>
    `<tspan font-weight="700" fill-opacity="1">${v}</tspan> ${label}`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="TAIL dossier">` +
    `<path d="M0 56V20Q0 0 20 0H128Q140 0 146 10L154 26Q160 36 174 36H380Q400 36 400 56V480Q400 500 380 500H20Q0 500 0 480Z" fill="${colors.dusk}"/>` +
    stroke(contours(s), `stroke-opacity=".07"`) +
    stroke(
      segments(ahead, w, c),
      `stroke-opacity=".2" stroke-width="2" stroke-dasharray="0 7" stroke-linecap="round"`,
    ) +
    stroke(segments(refunded, w, c), `stroke-opacity=".32" stroke-width="2" stroke-dasharray="5 5"`) +
    walked +
    `<circle cx="${(w[0] as Pt)[0]}" cy="${(w[0] as Pt)[1]}" r="3" fill="${INK}" fill-opacity=".5"/>` +
    (ticks
      ? `<path d="${ticks}" stroke="${colors.persimmon}" stroke-width="2" stroke-linecap="round"/>`
      : "") +
    (won ? `<g fill="${colors.persimmon}">${won}</g>` : "") +
    (rings
      ? `<g fill="${colors.dusk}" stroke="${INK}" stroke-width="2">${rings}${slashes ? `<path d="${slashes}"/>` : ""}</g>`
      : "") +
    (grey ? `<g fill="${INK}" fill-opacity=".32">${grey}</g>` : "") +
    mark +
    `<g font-family="${SANS}" fill="${INK}">` +
    `<text x="24" y="24" font-size="11" font-weight="600" letter-spacing="3" fill-opacity=".6">DOSSIER</text>` +
    `<text x="376" y="66" text-anchor="end" font-family="${MONO}" font-size="11" letter-spacing="1" fill-opacity=".45">FILE ${file}</text>` +
    `<path d="M24 372H376" stroke="${INK}" stroke-opacity=".14"/>` +
    `<text x="24" y="416" font-size="${fs}" font-weight="700">${handle}</text>` +
    `<text x="24" y="446" font-size="14" fill-opacity=".7">${count(view.matches, "matches")} · ${count(view.survived, "survived")} · ${count(view.tags, "tags")}</text>` +
    `<g transform="translate(24 460) scale(.67)" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke-opacity=".7"><circle cx="12" cy="12" r="9"/><path d="M8 12.5L11 15.5L16.5 9"/></g>` +
    `<text x="46" y="474" font-size="12" fill-opacity=".7">verified on NEAR</text>` +
    `</g></svg>`
  );
}
