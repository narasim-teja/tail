// The game in three folds, each one sentence with the phone's instruments doing the talking:
// lock and heat (one number seen from both sides: the hunter's arc and the target's bar climb
// together), STRIKE (the lock-full takeover), and the Handler's hints with the real pricing rule.

import { HINT_BPS, HINT_NAME, HintKind, LOCK_EPOCHS, priceReason } from "@tail/protocol";
import { Timer, VenetianMask } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Eyebrow, GameIcon, HeatBar, LockArc, useClimb } from "./instruments.tsx";
import {
  HINT_ICON,
  HINT_KINDS,
  HINT_QUESTION,
  MAX_RECENT,
  priceAt,
  priceWindow,
  STAKE,
  usdc,
} from "./rules.ts";

/** The whole game in four lines: the rules in one breath, before the instruments show the middle. */
const RUNDOWN: { icon: ReactNode; title: string; line: string }[] = [
  {
    icon: <GameIcon name="head" size={28} />,
    title: "Everyone stakes",
    line: `Say $${usdc(STAKE)} each. That money is your head.`,
  },
  {
    icon: <VenetianMask size={28} strokeWidth={1.75} aria-hidden="true" />,
    title: "You get a secret target",
    line: "And someone secretly has you. Nobody sees the whole circle, so anyone could be your hunter.",
  },
  {
    icon: <GameIcon name="strike" size={28} />,
    title: "Close in and strike",
    line: "Stay near your target until your lock fills, then strike. Their head and their target become yours.",
  },
  {
    icon: <Timer size={28} strokeWidth={1.75} aria-hidden="true" />,
    title: "Outlast the clock",
    line: "When time runs out, everyone still standing keeps what is on their head. You can win without a tag.",
  },
];

function Rundown() {
  return (
    <div className="l-rundown">
      <h2 id="game" className="l-h2">
        How a match goes
      </h2>
      <p className="l-lede">Three to twelve friends, one park, 15 to 60 minutes.</p>
      <ol className="l-rundown-list">
        {RUNDOWN.map((r) => (
          <li key={r.title} className="l-rundown-step">
            <span className="l-rundown-icon">{r.icon}</span>
            <h3 className="l-rundown-title">{r.title}</h3>
            <p>{r.line}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function Beats({ reduced }: { reduced: boolean }) {
  return (
    <section className="l-beats" aria-labelledby="game">
      <Rundown />
      <LockAndHeat reduced={reduced} />
      <Strike />
      <div className="l-fold l-fold-hints">
        <div className="l-fold-words">
          <h3 className="l-fold-title">Hints</h3>
          <p className="l-fold-line">
            Stuck? The Handler sells hints about your target. You pay from your head, the money lands on your
            target's, and prices climb the more anyone buys.
          </p>
        </div>
        <Hints />
      </div>
    </section>
  );
}

function LockAndHeat({ reduced }: { reduced: boolean }) {
  // One number seen from both sides, so one climb drives both instruments.
  const { ref, n } = useClimb(LOCK_EPOCHS - 1, reduced);
  return (
    <div className="l-fold l-fold-pair" ref={ref}>
      <article className="l-side" aria-labelledby="beat-lock">
        <h3 id="beat-lock" className="l-fold-title">
          Lock
        </h3>
        <p className="l-fold-line">Stay within Bluetooth range of your target and your lock fills.</p>
        <div className="l-side-instrument">
          <LockArc value={n} max={LOCK_EPOCHS} alt={`Your lock at ${n} of ${LOCK_EPOCHS}`} />
        </div>
      </article>
      <article className="l-side" aria-labelledby="beat-heat">
        <h3 id="beat-heat" className="l-fold-title">
          Heat
        </h3>
        <p className="l-fold-line">When someone is on you, your heat fills. You never learn who.</p>
        <div className="l-side-instrument">
          <HeatBar value={n} max={LOCK_EPOCHS} alt={`Their heat at ${n} of ${LOCK_EPOCHS}`} />
        </div>
      </article>
    </div>
  );
}

function Strike() {
  return (
    <article className="l-fold l-strike" aria-labelledby="beat-strike">
      <div className="l-strike-lock">
        <LockArc
          value={LOCK_EPOCHS}
          max={LOCK_EPOCHS}
          alt={`A full lock, ${LOCK_EPOCHS} of ${LOCK_EPOCHS}`}
        />
      </div>
      <div className="l-strike-words">
        {/* The phone's STRIKE button, drawn: on the lock-full takeover it is ink with persimmon caps. */}
        <h3 id="beat-strike" className="l-strike-panel">
          <GameIcon name="strike" size={44} />
          Strike
        </h3>
        <p className="l-fold-line">
          Full lock? Strike while you're still close. Their head is yours, and so is their target.
        </p>
      </div>
    </article>
  );
}

/** The Handler's sheet: the three hints at a 5 USDC stake, priced for the demand the visitor sets. */
export function Hints() {
  const [recent, setRecent] = useState(1);
  return (
    <div className="l-sheet">
      <div className="l-sheet-head">
        <GameIcon name="handler" size={24} />
        <span className="l-sheet-title">Ask the Handler</span>
      </div>
      <p className="l-sheet-caption">Prices at a ${usdc(STAKE)} stake, paid from your head.</p>
      <ul className="l-hints" aria-live="polite">
        {HINT_KINDS.map((k) => (
          <li key={k} className="l-hint">
            <GameIcon name={HINT_ICON[k]} size={26} />
            <span className="l-hint-name">{HINT_NAME[k]}</span>
            <span className="l-hint-ask">
              {HINT_QUESTION[k]} <span className="l-hint-base">Base {HINT_BPS[k] / 100}%.</span>
            </span>
            <span className="l-hint-price" data-hint={k}>
              ${usdc(priceAt(k, recent))}
            </span>
          </li>
        ))}
      </ul>
      <q className="l-sheet-line">{priceReason(HintKind.Bearing, recent)}</q>
      <fieldset className="l-demand">
        <legend className="l-demand-label">
          <Eyebrow>Hints bought, last {priceWindow}</Eyebrow>
        </legend>
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
  );
}
