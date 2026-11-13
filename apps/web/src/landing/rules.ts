// The rules as the site states them, every number read from @tail/protocol's constants and its
// pricing rule, so the front page and the docs can't drift from what the referee runs and the
// contract checks. Words only; the pages lay them out.

import {
  CHECKPOINT_MS,
  DARK_FORFEIT_MS,
  DARK_LEAK_MS,
  EPOCH_MS,
  HINT_NEAR_M,
  HINT_TREND_MS,
  HintKind,
  hintPrice,
  LEAK_CELL_M,
  LOCK_EPOCHS,
  MAX_HINTS,
  PRICE_CAP_BPS,
  PRICE_STEP_BPS,
  PRICE_WINDOW_MS,
  REFEREE_TIMEOUT_MS,
  WINDOW_EPOCHS,
} from "@tail/protocol";
import { money } from "../lib/format.ts";

/** The example stake every figure on the site is worked at, in USDC's 6-decimal units. */
export const STAKE = 5_000_000n;
export const DECIMALS = 6;
export const usdc = (units: bigint) => money(units, DECIMALS);

const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];
/** A small count in words ("four"), else digits. */
export const say = (n: number) => WORDS[n] ?? String(n);
export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A whole number of minutes or seconds, in words: "three minutes", "45 seconds". */
export function duration(ms: number): string {
  if (ms % 60_000 === 0) {
    const m = ms / 60_000;
    return `${say(m)} minute${m === 1 ? "" : "s"}`;
  }
  return `${ms / 1000} seconds`;
}

export const EPOCH_S = EPOCH_MS / 1000;
/** The lock rule: "four of the last eight 15-second windows". */
export const lockRule = `${say(LOCK_EPOCHS)} of the last ${say(WINDOW_EPOCHS)} ${EPOCH_S}-second windows`;
/** The window those epochs span: "two minutes". */
export const lockWindow = duration(WINDOW_EPOCHS * EPOCH_MS);
export const darkRule = duration(DARK_FORFEIT_MS);
export const leakRule = duration(DARK_LEAK_MS);
export const leakCell = `${LEAK_CELL_M} m`;
export const priceWindow = duration(PRICE_WINDOW_MS);
export const checkpointEvery = CHECKPOINT_MS === 60_000 ? "minute" : duration(CHECKPOINT_MS);
export const silenceRefund = duration(REFEREE_TIMEOUT_MS);
export const maxHints = MAX_HINTS;
/** Each hint bought in the window adds this share of the base price: "25%". */
export const priceStep = `${PRICE_STEP_BPS / 100}%`;
/** The cap on the demand multiplier: "4×". */
export const priceCap = `${PRICE_CAP_BPS / 10_000}×`;
/** Hints bought in the window at which the price reaches its cap. */
export const MAX_RECENT = (PRICE_CAP_BPS - 10_000) / PRICE_STEP_BPS;

export const HINT_KINDS = [HintKind.Near, HintKind.Bearing, HintKind.Trend] as const;
export const HINT_ICON = {
  [HintKind.Near]: "near",
  [HintKind.Bearing]: "bearing",
  [HintKind.Trend]: "trend",
} as const;
/** What each hint answers, as the phone's Handler sheet asks it. */
export const HINT_QUESTION: Record<HintKind, string> = {
  [HintKind.Near]: `Are they within ${HINT_NEAR_M} m?`,
  [HintKind.Bearing]: "Which way are they?",
  [HintKind.Trend]: `Closer than ${HINT_TREND_MS === 60_000 ? "a minute" : duration(HINT_TREND_MS)} ago?`,
};

/** One hint's price at a demand, as the referee charges it and the contract recomputes it. */
export const priceAt = (kind: HintKind, recent: number, stake: bigint = STAKE) =>
  hintPrice(stake, kind, recent);
