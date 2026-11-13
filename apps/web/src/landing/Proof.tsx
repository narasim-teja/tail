// What a tag proves: the path from two phones to the visitor's browser, as one trail the eye
// follows down the page, each step with where to check it. The first three steps happen in the
// park, by day; the ground falls to dusk on the way to the last three, which happen afterwards.
// Then what is not claimed, in plain lines (README.md, top section).

import { BATCH_MS, CHECKPOINT_MS, EPOCH_MS } from "@tail/protocol";
import { explorerAccount } from "../lib/explorer.ts";
import { PINS } from "../verify/pins.ts";
import { repoFile } from "./config.ts";

interface Step {
  title: string;
  line: string;
  check: { text: string; href: string | null; external?: boolean } | null;
}

export function steps(replayHref: string): { day: Step[]; dusk: Step[] } {
  const repo = (path: string, text: string) => {
    const href = repoFile(path);
    return href ? { text, href, external: true } : null;
  };
  return {
    day: [
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
        line: `The referee opens the reports, decides contact, lock and tags, and signs each verdict into a log whose root goes on NEAR every ${CHECKPOINT_MS === 60_000 ? "minute" : `${CHECKPOINT_MS / 1000} seconds`}.`,
        check: { text: "Which referee signed, in the replay", href: replayHref },
      },
    ],
    dusk: [
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
        line: "After the match its data is released. tail-verify runs it through the same rules and must get every verdict back byte for byte.",
        check: repo("crates/referee-verify/README.md", "tail-verify"),
      },
    ],
  };
}

/** The limits, as README.md's top section states them. Each is one plain line. */
export const NOT_CLAIMED = [
  "So far every match was judged by a test referee on the developer's machine, not the hardware enclave TAIL is built for. While it is, trusting the referee means trusting us.",
  "It runs on NEAR testnet, with test USDC.",
  "iPhone only, installed directly. It is not on the App Store.",
  "GPS is only checked for being plausible. What is proven is that two phones were near each other.",
  "Two iPhones have played it indoors. No match has run outdoors in a park yet.",
];

function StepList({ list, start }: { list: Step[]; start: number }) {
  return (
    <ol className="l-steps" start={start}>
      {list.map((s, i) => (
        <li key={s.title} className="l-step">
          <span className="l-step-no" aria-hidden="true">
            {String(start + i).padStart(2, "0")}
          </span>
          <div className="l-step-body">
            <h3 className="l-step-title">{s.title}</h3>
            <p className="l-step-line">{s.line}</p>
          </div>
          {s.check?.href ? (
            <a
              className="l-step-check"
              href={s.check.href}
              {...(s.check.external ? { rel: "noopener" } : {})}
            >
              <span className="l-step-check-k">Check it</span>
              {s.check.text}
            </a>
          ) : (
            <span className="l-step-check l-step-check-none" aria-hidden="true" />
          )}
        </li>
      ))}
    </ol>
  );
}

export function Proof({ replayHref }: { replayHref: string }) {
  const { day, dusk } = steps(replayHref);
  return (
    <section className="l-proof" id="proof" aria-labelledby="proof-title" tabIndex={-1}>
      <div className="l-proof-day">
        <h2 id="proof-title" className="l-h2">
          What a tag proves
        </h2>
        <p className="l-lede">
          From two phones in a park to the page you are reading, every step leaves something you can check.
        </p>
        <StepList list={day} start={1} />
      </div>
      <div className="l-sunset" aria-hidden="true">
        <span className="l-sunset-line" />
      </div>
      <div className="l-proof-dusk">
        <StepList list={dusk} start={day.length + 1} />
        <div className="l-limits">
          <h3 className="l-limits-title">What we don't claim</h3>
          <ul>
            {NOT_CLAIMED.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
