// Hint prices: the only place they are defined. Twin of crates/tail-protocol/src/pricing.rs;
// vectors/pricing.json pins both.
//
// The Handler sells intel like a market maker. Each kind has a base price in basis points of the
// stake. Every hint anyone in the match bought in the last PRICE_WINDOW_MS of match time adds
// PRICE_STEP_BPS to it, up to PRICE_CAP_BPS, and the price falls back as those hints age out of
// the window. A hunt that turns into a bidding war gets dearer for everyone; a quiet match stays
// cheap.
//
// The referee charges hintPrice(stake, kind, recentHints(earlier, tMs)) and puts tMs in the Hint
// verdict. The contract recomputes the same number from the match's earlier hints and refuses any
// other amount, so a referee cannot overcharge.

import { HintKind } from "./constants.ts";

/** Demand counts hints bought in the last 5 minutes of match time. */
export const PRICE_WINDOW_MS = 300_000;
/** Each recent hint adds 25 % of the base price. */
export const PRICE_STEP_BPS = 2_500;
/** Never more than 4x the base price. */
export const PRICE_CAP_BPS = 40_000;
const BPS = 10_000n;

/** Base hint price in basis points of the match stake, by kind. */
export const HINT_BPS: Record<HintKind, number> = {
  [HintKind.Near]: 200,
  [HintKind.Bearing]: 500,
  [HintKind.Trend]: 200,
};

/** The kind's name as the phone shows it. */
export const HINT_NAME: Record<HintKind, string> = {
  [HintKind.Near]: "Near",
  [HintKind.Bearing]: "Bearing",
  [HintKind.Trend]: "Warmer",
};

/**
 * How many of `prevHintTimesMs` fall in the window that ends at `nowMs`:
 * `nowMs - PRICE_WINDOW_MS < t <= nowMs`. A hint charged earlier in the same tick (same tMs)
 * counts, so the second hint of a tick already pays for the first.
 */
export const recentHints = (prevHintTimesMs: readonly bigint[], nowMs: bigint): number =>
  prevHintTimesMs.filter((t) => t <= nowMs && t + BigInt(PRICE_WINDOW_MS) > nowMs).length;

/** The demand multiplier in basis points: min(10 000 + PRICE_STEP_BPS × recent, PRICE_CAP_BPS). */
export const demandBps = (recent: number): bigint =>
  BigInt(Math.min(Number(BPS) + PRICE_STEP_BPS * recent, PRICE_CAP_BPS));

/**
 * HINT_BPS[kind] × stake / 10 000 × demandBps(recent) / 10 000, each division rounded down. The
 * price leaves the asker's head for the match's hint pool.
 */
export const hintPrice = (stake: bigint, kind: HintKind, recent: number): bigint =>
  (((stake * BigInt(HINT_BPS[kind])) / BPS) * demandBps(recent)) / BPS;

/** demandBps(recent) as a multiplier: 12 500 → "1.25x", 20 000 → "2x". */
function multiplier(recent: number): string {
  const bps = demandBps(recent);
  const frac = (bps % BPS).toString().padStart(4, "0").replace(/0+$/, "");
  return frac === "" ? `${bps / BPS}x` : `${bps / BPS}.${frac}x`;
}

/**
 * The Handler's one line on the price, the same words on the phone and in the voice prompt:
 * "Intel's dear: 4 hints bought in the last 5 minutes put Bearing at 2x."
 */
export function priceReason(kind: HintKind, recent: number): string {
  const name = HINT_NAME[kind];
  const minutes = PRICE_WINDOW_MS / 60_000;
  const hints = recent === 1 ? "hint" : "hints";
  const x = multiplier(recent);
  const demand = demandBps(recent);
  if (recent === 0)
    return `Intel's cheap: nobody bought a hint in the last ${minutes} minutes, so ${name} is at its base price.`;
  if (demand >= BigInt(PRICE_CAP_BPS))
    return `Intel's at its peak: ${recent} ${hints} bought in the last ${minutes} minutes hold ${name} at ${x}.`;
  if (demand >= 2n * BPS)
    return `Intel's dear: ${recent} ${hints} bought in the last ${minutes} minutes put ${name} at ${x}.`;
  return `Intel's warming: ${recent} ${hints} bought in the last ${minutes} minutes put ${name} at ${x}.`;
}
