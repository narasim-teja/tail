// What TAIL is built on, each with its own site and the one job it does here. The footer shows
// the logos in a row; the docs' "Built on" adds the job. Each line says only what runs (README:
// "Where it stands").

import type { LogoName } from "./logos.tsx";

export interface Tech {
  name: string;
  logo: LogoName;
  href: string;
  /** What it does in TAIL, in a sentence. */
  role: string;
}

export const TECH: Tech[] = [
  {
    name: "NEAR",
    logo: "near",
    href: "https://near.org",
    role: "The contract holds the stakes, applies only verdicts the referee signed, in order, replays the whole match at End before it pays, and keeps each player's Dossier NFT.",
  },
  {
    name: "OutLayer",
    logo: "outlayer",
    href: "https://outlayer.ai",
    role: "The referee is built for its Intel TDX enclave, which holds the match's sealed state, the verdict key and the VRF that draws the targets. Deployed there, but OutLayer's testnet now holds each call for over a minute before running it, too slow for 10-second ticks, so a test referee stands in.",
  },
  {
    name: "NEAR AI Cloud",
    logo: "nearai",
    href: "https://cloud.near.ai",
    role: "The Handler's voice: lines from an open-weight model on private inference. The replay checks the attestation of the key that signed each line.",
  },
  {
    name: "Offline Protocol",
    logo: "offline",
    href: "https://www.offlineprotocol.com",
    role: "Mesh carry: a phone with no signal hands its sealed report to a nearby phone to post. Off by default, because with it on the phones barely heard each other's beacon.",
  },
  {
    name: "Apple App Attest",
    logo: "apple",
    href: "https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity",
    role: "Shows each report comes from the TAIL app on a real iPhone, signed by a key in its Secure Enclave; the referee checks it against Apple's root.",
  },
];
