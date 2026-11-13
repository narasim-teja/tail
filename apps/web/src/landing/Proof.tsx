// What a tag proves. The front page carries it as one strip (four steps, a line each, and where
// things stand today); the docs carry the six steps with where to check each, and every limit.

import { BATCH_MS, EPOCH_MS } from "@tail/protocol";
import { explorerAccount } from "../lib/explorer.ts";
import { PINS } from "../verify/pins.ts";
import { config, repoFile } from "./config.ts";
import { checkpointEvery } from "./rules.ts";

export interface Step {
  title: string;
  line: string;
  check: { text: string; href: string; external?: boolean };
}

/** The path from two phones to the visitor's browser, each step with where to check it. */
export function steps(replayHref: string): Step[] {
  const repo = (path: string, text: string) => ({ text, href: repoFile(path), external: true });
  return [
    {
      title: "Two phones hear each other",
      line: `Each iPhone sends a code that changes every ${EPOCH_MS / 1000} seconds and logs the codes it hears. A tag needs both phones to have heard the other. Apple App Attest shows it is the TAIL app on a real iPhone.`,
      check: repo("README.md#how-a-tag-is-proven", "How a tag is proven"),
    },
    {
      title: "Reports are sealed",
      line: `Every ${BATCH_MS / 1000} seconds each phone signs what it heard and seals it to the referee. The relay that carries it can't read it.`,
      check: repo("ARCHITECTURE.md", "ARCHITECTURE.md"),
    },
    {
      title: "The referee signs a verdict",
      line: `The referee opens the reports, decides contact, lock and tags, and signs each verdict into a log whose root goes on NEAR every ${checkpointEvery}.`,
      check: { text: "Which referee signed, in the replay", href: replayHref },
    },
    {
      title: "NEAR replays the match, then pays",
      line: "The contract checks every verdict's signature. At the end it rebuilds the ring of targets and replays every hint, tag and forfeit. One broken rule refunds every stake.",
      check: {
        text: "The contract on NEAR",
        href: explorerAccount(PINS.network, PINS.contract),
        external: true,
      },
    },
    {
      title: "Your browser checks it again",
      line: "The replay re-checks the signatures, the log, the draw of targets and the payouts against NEAR, and marks each tag with what it found.",
      check: { text: "What was checked, in any replay", href: replayHref },
    },
    {
      title: "Anyone can re-run the referee",
      line: "After the match its data is released. tail‑verify runs it through the same rules and must get every verdict back byte for byte.",
      check: repo("crates/referee-verify/README.md", "tail-verify"),
    },
  ];
}

/** The front page's version: four steps, one line each. */
export const STRIP = [
  "Both phones must hear each other over Bluetooth.",
  "A referee opens their sealed reports and signs each verdict.",
  "NEAR replays the whole match before any money moves.",
  "Your browser checks every signature again.",
];

/** Where things stand, in one line; the docs hold the full list. */
export const STANDING =
  "So far: NEAR testnet with test USDC, a test referee on our machine instead of the enclave, iPhone only.";

export function ProofStrip() {
  return (
    <section className="l-proof" id="proof" aria-labelledby="proof-title" tabIndex={-1}>
      <h2 id="proof-title" className="l-h2">
        How it's checked
      </h2>
      <ol className="l-strip">
        {STRIP.map((line, i) => (
          <li key={line} className="l-strip-step">
            <span className="l-strip-no" aria-hidden="true">
              {i + 1}
            </span>
            {line}
          </li>
        ))}
      </ol>
      <div className="l-proof-foot">
        <a className="l-button" href={`${config.docsUrl}#proof`}>
          How a tag is proven
        </a>
        <p className="l-standing">
          {STANDING}{" "}
          <a className="l-link" href={`${config.docsUrl}#limits`}>
            What we don't claim
          </a>
        </p>
      </div>
    </section>
  );
}
