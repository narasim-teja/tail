// The docs at /docs: what the front page leaves out, for a curious visitor and for a judge who
// wants to check the claims. Every fact here is one the root README.md and ARCHITECTURE.md state,
// every number comes from @tail/protocol (through landing/rules.ts) or its pricing rule, and
// every section has an anchor (`/docs#proof`).

import { HINT_BPS, HINT_NAME, LOCK_EPOCHS } from "@tail/protocol";
import type { ReactNode } from "react";
import { Hints } from "../landing/Beats.tsx";
import { config, repoFile } from "../landing/config.ts";
import { HeatBar, LockArc } from "../landing/instruments.tsx";
import { demoHref } from "../landing/Matches.tsx";
import { steps } from "../landing/Proof.tsx";
import {
  darkRule,
  EPOCH_S,
  HINT_KINDS,
  HINT_QUESTION,
  leakCell,
  leakRule,
  lockRule,
  lockWindow,
  priceCap,
  priceStep,
  priceWindow,
  say,
  silenceRefund,
} from "../landing/rules.ts";
import { SiteFooter, SiteTop } from "../landing/Site.tsx";
import { explorerAccount } from "../lib/explorer.ts";
import { displayName } from "../lib/names.ts";
import { PINS } from "../verify/pins.ts";
import { Ledger } from "./Ledger.tsx";

export const SECTIONS = [
  { id: "rules", title: "How a match works" },
  { id: "money", title: "One stake, one number" },
  { id: "proof", title: "What a tag proves" },
  { id: "check", title: "Check a match yourself" },
  { id: "dossier", title: "The dossier" },
  { id: "limits", title: "What we don't claim" },
  { id: "today", title: "Where it stands today" },
  { id: "built-on", title: "Built on" },
] as const;
type Id = (typeof SECTIONS)[number]["id"];

const title = (id: Id) => SECTIONS.find((s) => s.id === id)?.title ?? id;

function Section({ id, children }: { id: Id; children: ReactNode }) {
  return (
    <section className="d-section" id={id} aria-labelledby={`${id}-title`} tabIndex={-1}>
      <h2 id={`${id}-title`} className="d-h2">
        <a href={`#${id}`} className="d-anchor">
          {title(id)}
        </a>
      </h2>
      {children}
    </section>
  );
}

function Rule({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="d-rule">
      <h3 className="d-h3">{name}</h3>
      {children}
    </div>
  );
}

const Code = ({ children }: { children: string }) => (
  <pre className="d-code">
    <code>{children}</code>
  </pre>
);

const ext = { rel: "noopener" } as const;

/** The limits, from the root README's opening and "What this does not claim". */
export const NOT_CLAIMED: { title: string; line: string }[] = [
  {
    title: "A test referee, not the enclave",
    line: "The live contract pins a local test referee: the same referee code, run on our machine. While it is pinned, that machine holds the verdict key and could sign any verdict, so trusting the referee means trusting us. The replay says so with a Test referee mark.",
  },
  {
    title: "The enclave build hasn't run a call",
    line: "The referee built for OutLayer's Intel TDX enclave is deployed, but every call to it has timed out, so no match on the current protocol has run in the enclave, and the replay does not pin that build yet.",
  },
  {
    title: "One account runs everything",
    line: "One testnet account owns the relay, the contract and the OutLayer project. With the enclave, that owner could publish a new referee version. Each verdict's attestation record names the build that ran, so a swap is caught after the fact, not prevented.",
  },
  {
    title: "Not proven GPS",
    line: "Apple does not attest the GPS chip. What is claimed: our real app on a real iPhone, two phones in mutual radio contact, and physically plausible movement.",
  },
  {
    title: "Not proximity checked on-chain",
    line: "The contract checks the ring, the hint rules and the money, not the radio evidence. Invented contact behind a tag of the right target, a hint nobody asked for, or a forfeit of a player who never went dark would be paid out. Only tail‑verify catches them, from the released data, after the match.",
  },
  {
    title: "Not the referee's clock",
    line: "Each tick's time is the referee's word, and the relay may hold it back. tail‑verify replays with the logged times and cannot check them; the contract bounds them only loosely.",
  },
  {
    title: "Not censorship-proof",
    line: "The relay can drop a report before the referee sees it. The phone's receipts show the gap afterwards.",
  },
  {
    title: "Not private from the chain",
    line: "Verdicts land on NEAR during play. A hint names only who asked, but a tag or a forfeit names both players. The relay also sees timing, sizes and how many contacts each tick found.",
  },
  {
    title: "Not a full defence against relaying",
    line: "An accomplice relaying Bluetooth both ways within about 30 seconds, plus location spoofing on an attested phone, could fake proximity. There is no distance bounding.",
  },
  {
    title: "Foreground only",
    line: "The app must stay open. Pocket mode turns the screen off with the proximity sensor while the app keeps running.",
  },
  {
    title: "Testnet, iPhone only",
    line: "It runs on NEAR testnet with test USDC. It is an iPhone app, installed directly, not from the App Store.",
  },
];

export function Docs() {
  const replay = demoHref({ name: "boston-common", query: "" });
  const contract = PINS.contract;
  const contractUrl = explorerAccount(PINS.network, contract);
  return (
    <div className="l-page d-page">
      <a className="l-skip" href="#main">
        Skip to content
      </a>
      <SiteTop current="docs" />
      <div className="d-layout">
        <header className="d-header">
          <h1 className="d-h1">How TAIL works, and how to check it</h1>
          <p className="d-lede">
            The rules of a match, where the money goes, what a tag proves, and how to check every claim
            yourself.
          </p>
        </header>
        <nav className="d-toc" aria-label="On this page">
          <p className="l-eyebrow l-eyebrow-muted">On this page</p>
          <ol>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.title}</a>
              </li>
            ))}
          </ol>
        </nav>
        <main id="main" className="d-main">
          <Section id="rules">
            <Rule name="Stake">
              <p>
                Everyone stakes the same amount on their own head when they join. A match takes 3 to 12
                players.
              </p>
            </Rule>
            <Rule name="A secret target">
              <p>
                At Start a VRF draws a ring: each player hunts the next one round it. The ring is committed on
                NEAR at Start and revealed at End, so you see only your own target.
              </p>
            </Rule>
            <Rule name="Lock and heat">
              <p>
                Stay within Bluetooth range of your target. A {EPOCH_S}-second window counts when both phones
                heard each other's code and their GPS fixes put them plausibly close. Your lock is how many
                windows counted: {lockRule}, about {lockWindow}, fills it.
              </p>
              <p>
                Your target sees the same number as heat, and never learns who it is. Inside a safehouse, and
                while riding a car or a train, contact doesn't count.
              </p>
              <div className="d-figure" aria-hidden="true">
                <div className="d-figure-lock">
                  <LockArc value={2} max={LOCK_EPOCHS} />
                </div>
                <div className="d-figure-heat">
                  <HeatBar value={2} max={LOCK_EPOCHS} />
                </div>
              </div>
              <p className="d-caption">
                The same moment from both sides: the hunter's lock at 2 of {say(LOCK_EPOCHS)}, the target's
                heat at 2.
              </p>
            </Rule>
            <Rule name="Strike">
              <p>
                With a full lock, strike while the two phones are still in contact. The referee tags your
                target: their head, with any hint money paid onto it, moves to you, and their target becomes
                yours.
              </p>
            </Rule>
            <Rule name="Hints">
              <p>
                The Handler sells three hints about your target:{" "}
                {HINT_KINDS.map((k, i) => (
                  <span key={k}>
                    {i > 0 && (i === HINT_KINDS.length - 1 ? " and " : ", ")}
                    <b>{HINT_NAME[k]}</b> ({HINT_QUESTION[k].replace(/\?$/, "").toLowerCase()},{" "}
                    {HINT_BPS[k] / 100}% of the stake)
                  </span>
                ))}
                .
              </p>
              <p>
                Each costs its base price plus {priceStep} for every hint anyone in the match bought in the
                last {priceWindow}, at most {priceCap}. The contract recomputes the price and refuses any
                other amount. What you pay leaves your head for the match's hint pool, and lands on your
                target's head when they fall or when the match ends.
              </p>
              <div className="d-sheet">
                <Hints />
              </div>
            </Rule>
            <Rule name="Going dark">
              <p>
                A phone that stops reporting goes dark. After {leakRule} its hunter is shown the {leakCell}{" "}
                square it is in, and {darkRule} of dark time over the whole match forfeits its head to its
                hunter. Time reporting from outside the zone counts as dark too.
              </p>
            </Rule>
            <Rule name="The end">
              <p>
                When time runs out, the contract rebuilds the ring from the VRF reveal and replays every hint,
                tag and forfeit. If every rule holds, survivors keep their heads and the hint money paid onto
                them, and only then can anyone withdraw. If one rule fails, or the referee goes silent for{" "}
                {silenceRefund}, every stake is refunded.
              </p>
            </Rule>
          </Section>

          <Section id="money">
            <p>
              Your stake is your head. Hints come out of it, tags add to it, and survivors keep what they
              hold. Nothing is minted and nobody takes a cut, so the table always adds up to the stakes. A
              worked hunt:
            </p>
            <Ledger />
          </Section>

          <Section id="proof">
            <p>
              From two phones in a park to the page you are reading, every step leaves something you can
              check.
            </p>
            <ol className="d-steps">
              {steps(replay).map((s, i) => (
                <li key={s.title} className="d-step">
                  <span className="d-step-no" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div>
                    <h3 className="d-h3">{s.title}</h3>
                    <p>{s.line}</p>
                    <p className="d-check">
                      <span className="l-eyebrow l-eyebrow-muted">Check it</span>
                      <a className="l-link" href={s.check.href} {...(s.check.external ? ext : {})}>
                        {s.check.text}
                      </a>
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </Section>

          <Section id="check">
            <Rule name="In the replay">
              <p>
                Open any match and choose What was checked. Your browser re-checks every verdict signature and
                the verdict chain, every Merkle root and the consistency between them, the draw of targets,
                the contract's End replay with every head and payout, and each tag's evidence against the lock
                rule, then compares it all with what NEAR holds. It does not re-check the phones' App Attest
                assertions or recompute contact from their sightings: tail‑verify does both.
              </p>
              <p>
                <a className="l-link" href={replay}>
                  Open the generated Boston Common match
                </a>
              </p>
            </Rule>
            <Rule name="On NEAR">
              <p>
                The contract is{" "}
                <a className="l-link" href={contractUrl} {...ext}>
                  {contract}
                </a>{" "}
                on NEAR {PINS.network}. Its views are public: <code>get_match</code>, <code>get_roots</code>{" "}
                and <code>get_verdict_head</code> for a match, <code>get_config</code> for the referee keys it
                pins.
              </p>
              <Code>{`near contract call-function as-read-only ${contract} get_config \\
  json-args '{}' network-config ${PINS.network} now`}</Code>
            </Rule>
            <Rule name="Re-run the referee">
              <p>
                tail‑verify replays a finished match from its released data through the same rules engine the
                referee runs, and requires every log entry and every verdict to come out byte for byte. From
                the repository:
              </p>
              <Code>{`cargo run -q -p referee-verify --example demo-bundle > /tmp/match.json
cargo run -q -p referee-verify -- /tmp/match.json`}</Code>
              <p>
                It ends with <code>PASS</code>. For a real match, save the relay's{" "}
                <code>GET /replay/:id</code> and pin the keys to the contract's <code>get_match</code> values
                with <code>--referee-pk</code> and <code>--vrf-pk</code>.{" "}
                <a className="l-link" href={repoFile("crates/referee-verify/README.md")} {...ext}>
                  The tail‑verify README
                </a>
              </p>
            </Rule>
          </Section>

          <Section id="dossier">
            <p>
              Every player holds a Dossier, an NFT on the TAIL contract minted when they register. Its record
              is written when a match settles: totals over the matches the contract replayed and paid out, and
              the last 12 entries. Refunds are listed and count for nothing. Its picture is an SVG the
              contract draws from the record each time anyone reads it.
            </p>
            <p>
              It is soulbound: it can never be transferred. A dossier is a credential, since a match can
              require a record to join, and if it could be sold the gate would measure money instead of play.
            </p>
            {config.dossierAccount && (
              <p>
                <a
                  className="l-link"
                  href={`${import.meta.env.BASE_URL}dossier/${encodeURIComponent(config.dossierAccount)}`}
                >
                  Open {displayName(config.dossierAccount)}'s dossier
                </a>
              </p>
            )}
          </Section>

          <Section id="limits">
            <ul className="d-limits">
              {NOT_CLAIMED.map((l) => (
                <li key={l.title}>
                  <h3 className="d-h3">{l.title}</h3>
                  <p>{l.line}</p>
                </li>
              ))}
            </ul>
          </Section>

          <Section id="today">
            <Rule name="Has run">
              <ul className="d-list">
                <li>
                  The current protocol (v2) is live on NEAR testnet. On 2026-11-13 the contract was upgraded
                  in place and a full match of test players ran through it and the local test referee.
                </li>
                <li>
                  That evening two iPhones and a test player played a match indoors: a tag from real mutual
                  Bluetooth contact, two demand-priced hints, a forfeit after {darkRule} dark, and End paid
                  the survivor after the contract's replay. tail‑verify re-ran it identically.
                </li>
                <li>
                  A match of test players ran end to end in the OutLayer enclave on 2026-11-12, on the earlier
                  protocol (v1).
                </li>
              </ul>
            </Rule>
            <Rule name="Has not">
              <ul className="d-list">
                <li>A match outdoors in a park. Range and pocket-mode tests haven't run either.</li>
                <li>A v2 match in the hardware enclave.</li>
                <li>
                  A Handler line from the model in a v2 match: the test referee has no network and uses
                  templates.
                </li>
                <li>The App Store.</li>
              </ul>
            </Rule>
          </Section>

          <Section id="built-on">
            <dl className="d-built">
              <div>
                <dt>NEAR</dt>
                <dd>
                  The contract holds the stakes, applies only verdicts the referee signed, in order, replays
                  the match at End before it pays, and keeps each player's dossier.
                </dd>
              </div>
              <div>
                <dt>OutLayer</dt>
                <dd>
                  The referee is built for its Intel TDX enclave, which holds the match's sealed state and the
                  verdict key. Deployed, but it hasn't run a call yet.
                </dd>
              </div>
              <div>
                <dt>NEAR AI Cloud</dt>
                <dd>
                  The Handler's voice: lines from an open-weight model, whose signing key's attestation is
                  checked.
                </dd>
              </div>
              <div>
                <dt>Offline Protocol SDK</dt>
                <dd>
                  Mesh carry: a phone with no signal hands its sealed report to a nearby phone to post. Off by
                  default, because with it on the phones barely heard each other's beacon.
                </dd>
              </div>
              <div>
                <dt>Apple App Attest</dt>
                <dd>
                  Shows each report comes from the TAIL app on a real iPhone; the referee checks it against
                  Apple's root.
                </dd>
              </div>
            </dl>
            <p>
              <a className="l-link" href={config.repoUrl} {...ext}>
                The source on GitHub
              </a>
            </p>
          </Section>
        </main>
      </div>
      <SiteFooter />
    </div>
  );
}
