// Shared state of one replay: the playhead and camera (written by the film loop and the
// controls) and the verification results (written as checks finish).

import { createStore } from "../lib/store.ts";
import type { Anchor, Binding, ChainState, MatchLevel } from "../verify/anchor.ts";
import type { Attestation } from "../verify/attestation.ts";
import type { TokenMeta } from "../verify/chain.ts";
import type { LocalVerdictCheck } from "../verify/checks.ts";
import type { ChainSummary, VerdictStatus } from "../verify/report.ts";
import type { Signer } from "../verify/signer.ts";

export type Selection =
  | { kind: "event"; index: number }
  | { kind: "player"; index: number }
  | { kind: "contact"; hunter: number; target: number }
  | { kind: "summary" };

export type SpeedMode = "film" | 1 | 10 | 60;

export interface PlayState {
  /** Match time, ms after the start. */
  t: number;
  playing: boolean;
  mode: SpeedMode;
  /** The rate the film is running at this frame. */
  speed: number;
  /** follow: the director (or `follow`) drives the camera; free: the viewer has it. */
  camera: "follow" | "free";
  follow: number | null;
  selection: Selection | null;
  /** The event line on screen, if any, and when it appeared (performance.now()). */
  caption: { event: number; born: number } | null;
  /** Tag/forfeit flashes in flight. */
  flashes: { event: number; born: number }[];
  ended: boolean;
}

export const initialPlay = (t = 0): PlayState => ({
  t,
  playing: true,
  mode: "film",
  speed: 30,
  camera: "follow",
  follow: null,
  selection: null,
  caption: null,
  flashes: [],
  ended: false,
});

export interface VerifyState {
  local: (LocalVerdictCheck | undefined)[];
  anchors: (Anchor | undefined)[];
  statuses: VerdictStatus[];
  chain: ChainState | null;
  chainSummary: ChainSummary;
  /** The bundle names the pinned contract, network and the linked match. */
  binding: Binding;
  level: MatchLevel | null;
  /** From NEAR's referee key; null until NEAR answers. */
  signer: Signer | null;
  /** Each verdict's OutLayer record, fetched only when the signer is the enclave project. */
  attestations: (Attestation | undefined)[];
  token: TokenMeta;
  /** 0..1 progress of loading and checking, for the slim line at the top. */
  progress: number;
}

export const createPlayStore = (t = 0) => createStore<PlayState>(initialPlay(t));
export const createVerifyStore = (n: number, token: TokenMeta, binding: Binding = { ok: true }) =>
  createStore<VerifyState>({
    local: new Array(n).fill(undefined),
    anchors: new Array(n).fill(undefined),
    statuses: new Array(n).fill("pending"),
    chain: null,
    chainSummary: "checking",
    binding,
    level: null,
    signer: null,
    attestations: new Array(n).fill(undefined),
    token,
    progress: 0.4,
  });

export type PlayStore = ReturnType<typeof createPlayStore>;
export type VerifyStore = ReturnType<typeof createVerifyStore>;
