// Keeping the phone's batch chain on the referee's (TECHNICAL.md 4.3). The referee takes a
// player's batches only as one hash chain: seq n must follow seq n-1 and carry its hash. Before,
// one batch the referee never took (refused for its App Attest assertion, or never opened) left
// every later batch chained to it, so all of them were refused until the player forfeited.
//
// Every signed HUD says where the referee's chain stands: `next_seq` (the seq it wants next) and
// `chain_tip` (the hash of the last batch it accepted). After each HUD the phone decides:
//
//   - the tip is the hash the phone has at next_seq-1: everything below next_seq is confirmed;
//   - the tip is something else, or a seq the phone no longer knows: the two chains parted, and
//     nothing the phone holds chains onto the referee's, so it rebuilds from (next_seq, tip);
//   - the referee refused the very batch it is waiting for for its assertion (the only refusal
//     past the seq/prev checks that does not advance the chain, crates/referee-core
//     `authenticate`): rebuild;
//   - the batch it is waiting for reached the relay STALL_MS ago and is still not taken: send it
//     again once (the relay may have lost it, or it never opened), then rebuild.
//
// Seq and Prev refusals never trigger anything by themselves: after a rebuild, batches of the old
// chain still queued at the relay are refused that way, and the tip check covers a real fork.
// The relay is untrusted, but this only reads the referee's signed HUD; a relay that withholds
// batches can make the phone resend or rebuild, which it could cause anyway by dropping them.

import { equal, RejectCode, TICK_MS } from "@tail/protocol";
import type { ChainState, OutboxItem } from "./batch";

/** A batch the relay took this long ago and the referee still has not: resend, then rebuild. */
export const STALL_MS = 3 * TICK_MS;

/** The referee's chain position the phone last agreed with. */
export interface Confirmed {
  nextSeq: number;
  tip: Uint8Array;
}

export const unconfirmed = (): Confirmed => ({ nextSeq: 0, tip: new Uint8Array(32) });

/** What a HUD says about this player's chain. */
export interface ChainView {
  nextSeq: number;
  chainTip: Uint8Array;
  rejected?: { seq: number; code: number };
}

export type ChainPlan =
  /** Drop everything below nextSeq from the outbox; nothing else to do. */
  | { kind: "confirm"; nextSeq: number; tip: Uint8Array }
  /** Confirm, then send every batch from `from` on again. */
  | { kind: "resend"; nextSeq: number; tip: Uint8Array; from: number }
  /** Empty the outbox and continue the chain at `chain`. */
  | { kind: "rebuild"; chain: ChainState; why: "parted" | "refused" | "stalled" | "lost" };

export interface ChainInput {
  items: readonly OutboxItem[];
  confirmed: Confirmed;
  /** The seq the builder gives its next batch. */
  builderSeq: number;
  hud: ChainView;
  /** The refusal this phone already acted on, so a HUD repeating it is not a new one. */
  handled: { seq: number; code: number } | null;
  nowMs: number;
}

const rebuild = (hud: ChainView, why: Extract<ChainPlan, { kind: "rebuild" }>["why"]): ChainPlan => ({
  kind: "rebuild",
  chain: { seq: hud.nextSeq, prev: hud.chainTip },
  why,
});

export function planChain(i: ChainInput): ChainPlan {
  const { hud } = i;
  const at = (seq: number) => i.items.find((it) => it.seq === seq);
  const below = hud.nextSeq - 1;
  const expected =
    hud.nextSeq === 0
      ? new Uint8Array(32)
      : (at(below)?.hash ?? (i.confirmed.nextSeq === hud.nextSeq ? i.confirmed.tip : undefined));
  if (!expected || !equal(expected, hud.chainTip)) return rebuild(hud, "parted");
  const head = at(hud.nextSeq);
  const ok = { nextSeq: hud.nextSeq, tip: hud.chainTip };
  if (!head) {
    // The builder is past the referee but holds nothing at its seq: those batches are gone (an
    // outbox lost with the app's files), so the referee can never get them.
    return i.builderSeq > hud.nextSeq ? rebuild(hud, "lost") : { kind: "confirm", ...ok };
  }
  const r = hud.rejected;
  const fresh = r && !(i.handled && i.handled.seq === r.seq && i.handled.code === r.code);
  if (fresh && r.seq === hud.nextSeq && r.code === RejectCode.Assertion && head.sentMs !== null)
    return rebuild(hud, "refused");
  if (head.sentMs !== null && i.nowMs - head.sentMs >= STALL_MS)
    return head.resent ? rebuild(hud, "stalled") : { kind: "resend", ...ok, from: hud.nextSeq };
  return { kind: "confirm", ...ok };
}
