// The game in four beats, each one fold with one instrument from the phone: the lock, the heat,
// STRIKE, the Handler's hints. The rules in the words come from @tail/protocol's constants and
// the prices from its pricing rule, so the page can't drift from what the referee runs.

import {
  DARK_FORFEIT_MS,
  EPOCH_MS,
  HINT_BPS,
  HINT_NAME,
  HintKind,
  hintPrice,
  LOCK_EPOCHS,
  PRICE_CAP_BPS,
  PRICE_STEP_BPS,
  PRICE_WINDOW_MS,
  priceReason,
  WINDOW_EPOCHS,
} from "@tail/protocol";
import { useState } from "react";
import { money } from "../lib/format.ts";
import { GameIcon, HeatBar, LockArc, useClimb } from "./instruments.tsx";

/** The example stake every figure on the page is worked at, in USDC's 6-decimal units. */
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
const minutes = (ms: number) => {
  const m = ms / 60_000;
  return `${say(m)} minute${m === 1 ? "" : "s"}`;
};

/** The lock rule in words: "four of the last eight 15-second windows". */
export const lockRule = `${say(LOCK_EPOCHS)} of the last ${say(WINDOW_EPOCHS)} ${EPOCH_MS / 1000}-second windows`;
export const darkRule = minutes(DARK_FORFEIT_MS);

/** Hints bought in the window at which the price reaches its cap. */
export const MAX_RECENT = (PRICE_CAP_BPS - 10_000) / PRICE_STEP_BPS;
const KINDS = [HintKind.Near, HintKind.Bearing, HintKind.Trend] as const;

export function Beats({ reduced }: { reduced: boolean }) {
  return (
    <section className="l-beats" aria-labelledby="game">
      <h2 id="game" className="l-visually-hidden">
        The game
      </h2>
      <Lock reduced={reduced} />
      <Heat reduced={reduced} />
      <Strike />
      <Hints />
    </section>
  );
}

function Lock({ reduced }: { reduced: boolean }) {
  const { ref, n } = useClimb(LOCK_EPOCHS - 1, reduced);
  return (
    <article className="l-beat l-beat-lock" aria-labelledby="beat-lock">
      <div className="l-beat-instrument" ref={ref}>
        <LockArc value={n} max={LOCK_EPOCHS} alt={`A lock at ${LOCK_EPOCHS - 1} of ${LOCK_EPOCHS}`} />
      </div>
      <div className="l-beat-words">
        <p className="l-beat-no" aria-hidden="true">
          01
        </p>
        <h3 id="beat-lock" className="l-beat-title">
          Lock
        </h3>
        <p className="l-beat-line">
          Stay within Bluetooth range of your target and your lock fills: {lockRule} where both phones heard
          each other.
        </p>
      </div>
    </article>
  );
}

function Heat({ reduced }: { reduced: boolean }) {
  const { ref, n } = useClimb(LOCK_EPOCHS - 1, reduced, 620);
  return (
    <article className="l-beat l-beat-heat" aria-labelledby="beat-heat">
      <div className="l-beat-words">
        <p className="l-beat-no" aria-hidden="true">
          02
        </p>
        <h3 id="beat-heat" className="l-beat-title">
          Heat
        </h3>
        <p className="l-beat-line">When someone is on you, your heat fills. You never learn who.</p>
      </div>
      <div className="l-beat-instrument" ref={ref}>
        <HeatBar value={n} max={LOCK_EPOCHS} alt={`Heat at ${LOCK_EPOCHS - 1} of ${LOCK_EPOCHS}`} />
      </div>
    </article>
  );
}

function Strike() {
  return (
    <article className="l-beat l-strike" aria-labelledby="beat-strike">
      <p className="l-beat-no" aria-hidden="true">
        03
      </p>
      <h3 id="beat-strike" className="l-strike-word">
        Strike
      </h3>
      <div className="l-strike-row">
        <LockArc
          value={LOCK_EPOCHS}
          max={LOCK_EPOCHS}
          tone="strike"
          alt={`A full lock, ${LOCK_EPOCHS} of ${LOCK_EPOCHS}`}
        />
        <p className="l-beat-line">
          Full lock, press Strike while still close: their head is yours, and so is their target.
        </p>
      </div>
    </article>
  );
}

/** One hint's price at a demand, as the referee charges it and the contract recomputes it. */
export const priceAt = (kind: HintKind, recent: number, stake: bigint = STAKE) =>
  hintPrice(stake, kind, recent);

export function Hints() {
  const [recent, setRecent] = useState(1);
  const window = minutes(PRICE_WINDOW_MS);
  return (
    <article className="l-beat l-beat-hints" aria-labelledby="beat-hints">
      <div className="l-beat-words">
        <p className="l-beat-no" aria-hidden="true">
          04
        </p>
        <h3 id="beat-hints" className="l-beat-title">
          Hints
        </h3>
        <p className="l-beat-line">
          The Handler sells three hints about your target. Prices climb as more get bought, and what you pay
          ends up on your target's head.
        </p>
      </div>
      <div className="l-handler">
        <div className="l-handler-head">
          <span className="l-eyebrow">
            <GameIcon name="handler" size={16} />
            The Handler
          </span>
          <span className="l-handler-stake">At a {usdc(STAKE)} USDC stake</span>
        </div>
        <ul className="l-hint-list" aria-live="polite">
          {KINDS.map((k) => (
            <li key={k} className="l-hint">
              <GameIcon
                name={k === HintKind.Near ? "near" : k === HintKind.Bearing ? "bearing" : "trend"}
                size={22}
              />
              <span className="l-hint-name">{HINT_NAME[k]}</span>
              <span className="l-hint-base">{HINT_BPS[k] / 100}% base</span>
              <span className="l-hint-price" data-hint={k}>
                {usdc(priceAt(k, recent))}
              </span>
            </li>
          ))}
        </ul>
        <q className="l-handler-line">{priceReason(HintKind.Bearing, recent)}</q>
        <fieldset className="l-demand">
          <legend className="l-demand-label">Hints anyone bought in the last {window}</legend>
          <div className="l-stepper">
            <button
              type="button"
              aria-label="One fewer"
              disabled={recent <= 0}
              onClick={() => setRecent((r) => Math.max(0, r - 1))}
            >
              <span aria-hidden="true">−</span>
            </button>
            <output className="l-demand-num" aria-live="polite">
              {recent}
            </output>
            <button
              type="button"
              aria-label="One more"
              disabled={recent >= MAX_RECENT}
              onClick={() => setRecent((r) => Math.min(MAX_RECENT, r + 1))}
            >
              <span aria-hidden="true">+</span>
            </button>
          </div>
        </fieldset>
      </div>
    </article>
  );
}
