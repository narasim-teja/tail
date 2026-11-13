// What a tag proves. The front page carries it as the reasons a tag can't be faked (a headline and
// a line each, every number from @tail/protocol, and where things stand today); the docs carry
// the steps from two phones to the visitor's browser with where to check each, and every limit.

import { BATCH_MS, EPOCH_MS, GEO_SLACK_M, TELEPORT_MPS, VEHICLE_FREEZE_MS } from "@tail/protocol";
import { Bluetooth, Dices, LockKeyhole, MapPin, MonitorCheck, Network, Smartphone } from "lucide-react";
import type { ReactNode } from "react";
import { explorerAccount } from "../lib/explorer.ts";
import { PINS } from "../verify/pins.ts";
import { config, repoFile } from "./config.ts";
import { Logo } from "./logos.tsx";
import { checkpointEvery, duration } from "./rules.ts";

export interface Step {
  title: string;
  line: string;
  check: { text: string; href: string; external?: boolean };
}

/** A beacon token is one 128-bit service UUID (`tokenToUuid` in @tail/protocol). */
const TOKEN_BYTES = 16;
const EPOCH_S = EPOCH_MS / 1000;
const BATCH_S = BATCH_MS / 1000;
const architecture = (anchor: string) => `ARCHITECTURE.md#${anchor}`;

/** The path from two phones to the visitor's browser, each step with where to check it. */
export function steps(replayHref: string): Step[] {
  const repo = (path: string, text: string) => ({ text, href: repoFile(path), external: true });
  return [
    {
      title: "Two phones hear each other",
      line: `Each iPhone broadcasts a ${TOKEN_BYTES}-byte code that changes every ${EPOCH_S} seconds and logs the codes it hears. Only the referee can tell whose code is whose. A window counts only when both phones heard the other. Apple App Attest shows it is the TAIL app on a real iPhone.`,
      check: repo("README.md#how-a-tag-is-proven", "How a tag is proven"),
    },
    {
      title: "The movement is plausible",
      line: `The two GPS fixes must sit within ${GEO_SLACK_M} m plus their accuracy. A simulated location, or a jump faster than ${TELEPORT_MPS} m/s, gets the report refused; riding a car or a train freezes contact for ${duration(VEHICLE_FREEZE_MS)}. These are plausibility checks: Apple does not attest the GPS chip.`,
      check: repo(architecture("5-the-movement-was-physically-plausible"), "The movement checks"),
    },
    {
      title: "Reports are sealed",
      line: `Every ${BATCH_S} seconds each phone signs what it heard and where it was, and seals it to the referee. The relay that carries it can't read it.`,
      check: repo("ARCHITECTURE.md", "ARCHITECTURE.md"),
    },
    {
      title: "The draw is fair",
      line: "At Start a VRF draws the ring of targets and the contract stores a commitment to it. At End the reveal must open that commitment, so the ring can't be swapped mid-match.",
      check: repo(architecture("6-the-ring-of-targets-was-drawn-fairly"), "The draw"),
    },
    {
      title: "The referee signs a verdict",
      line: `The referee opens the reports, decides contact, lock and tags, and signs each verdict into a Merkle log. Every ${checkpointEvery} the log's root goes on NEAR with a consistency proof, so nothing logged earlier can be rewritten.`,
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

const icon = { size: 26, strokeWidth: 1.75, "aria-hidden": true } as const;

/** The front page's version: why a tag can't be faked, a headline and one line each. */
export const REASONS: { icon: ReactNode; title: string; line: string }[] = [
  {
    icon: <Bluetooth {...icon} />,
    title: "Phones hear each other",
    line: `Each phone broadcasts a ${TOKEN_BYTES}-byte code that changes every ${EPOCH_S} seconds. To anyone else it is noise; only the referee can tell whose it is. Your lock counts a window only when both phones logged each other.`,
  },
  {
    icon: <Smartphone {...icon} />,
    title: "A real iPhone, the real app",
    line: `Every ${BATCH_S}-second report is signed with an Apple App Attest key kept in the phone's Secure Enclave, and checked against Apple's root.`,
  },
  {
    icon: <MapPin {...icon} />,
    title: "GPS has to add up",
    line: `Both fixes must sit within ${GEO_SLACK_M} m plus their accuracy. Simulated locations and jumps faster than ${TELEPORT_MPS} m/s are refused, and car speeds freeze your lock for ${duration(VEHICLE_FREEZE_MS)}.`,
  },
  {
    icon: <LockKeyhole {...icon} />,
    title: "Nobody sees where you are",
    line: "Reports are sealed (X25519, ChaCha20-Poly1305) to the referee, which is built to run in an Intel TDX enclave on OutLayer. The relay carrying them can't open them.",
  },
  {
    icon: <Dices {...icon} />,
    title: "A draw nobody picks",
    line: "A VRF draws the circle of targets. Its commitment goes on NEAR at Start and must open at End, so anyone can rebuild who hunted whom.",
  },
  {
    icon: <Network {...icon} />,
    title: "History you can't rewrite",
    line: `Every verdict is signed into a Merkle log. Its root lands on NEAR every ${checkpointEvery} with a consistency proof, and your phone checks its own reports are in it.`,
  },
  {
    icon: <Logo name="near" size={22} />,
    title: "NEAR checks before it pays",
    line: "At the end the contract rebuilds the ring and replays every hint price, tag and forfeit. One broken rule and every stake is refunded.",
  },
  {
    icon: <MonitorCheck {...icon} />,
    title: "Check it yourself",
    line: "The replay re-checks every signature, root and payout in your browser. tail‑verify re-runs the referee and must match every verdict byte for byte.",
  },
];

/** Where things stand, in one line; the docs hold the full list. */
export const STANDING =
  "So far: NEAR testnet with test USDC, a test referee on our machine instead of the enclave, iPhone only.";

export function ProofStrip() {
  return (
    <section className="l-proof" id="proof" aria-labelledby="proof-title" tabIndex={-1}>
      <div className="l-proof-in">
        <h2 id="proof-title" className="l-h2">
          Why a tag can't be faked from the couch
        </h2>
        <p className="l-lede">
          Plenty of location games trust your phone's GPS, and spoofers win. Here, a tag needs two phones that
          were really there, and a trail of signatures anyone can check.
        </p>
        <ul className="l-reasons">
          {REASONS.map((r) => (
            <li key={r.title} className="l-reason">
              <span className="l-reason-icon">{r.icon}</span>
              <h3 className="l-reason-title">{r.title}</h3>
              <p>{r.line}</p>
            </li>
          ))}
        </ul>
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
      </div>
    </section>
  );
}
