// Money in a match as the contract moves it (TECHNICAL 4.10), and the replay it runs at End before
// any of it can be withdrawn.
//
// During play (protocol v2) a Hint moves its amount from the asker's head into the match's hint
// pool, and a Tag or Forfeit first moves its credit from the pool onto the loser's head, then the
// loser's whole head to the winner. The contract cannot check these as they land: the ring is
// still secret and a Hint doesn't say whom it was about. End reveals both, and the contract
// replays the whole match against them (replaySettlement, @tail/protocol). If every rule held,
// each survivor gets what the pool still owes them and the usual payout follows; if one didn't,
// every player gets their stake back. Money only becomes withdrawable after the contract has
// replayed and checked the whole match. This page runs the same replay.
//
// A v1 bundle (before protocol v2) paid a hint straight to its target and has no pool, credits or
// hint targets, so its heads follow the v1 rule and no settlement replay runs for it.

import { ed25519 } from "@noble/curves/ed25519.js";
import {
  describeViolation,
  equal,
  type PlayEvent,
  playEvent,
  replaySettlement,
  ringOrder,
  type Verdict,
  type Violation,
} from "@tail/protocol";
import type { AnyVerdict, DecodedBundle } from "./bundle.ts";

// ── Heads during play ───────────────────────────────────────────────────────────────

/** Heads, who is out, and the hint pool, as the contract holds them while the match runs. */
export interface Ledger {
  heads: bigint[];
  out: boolean[];
  /** Hint money paid in and not yet credited to anyone (always 0 for v1). */
  pool: bigint;
}

export const startLedger = (players: number, stake: bigint): Ledger => ({
  heads: Array.from({ length: players }, () => stake),
  out: Array.from({ length: players }, () => false),
  pool: 0n,
});

const add = (xs: bigint[], i: number, v: bigint) => {
  xs[i] = (xs[i] ?? 0n) + v;
};

/**
 * Applies one verdict as the contract does when it lands. The decoder gives each version its own
 * shape (v1.ts): a v1 Hint names its target and pays it at once, a v1 Tag or Forfeit has no credit.
 */
export function applyPlay(l: Ledger, b: AnyVerdict): void {
  if (b.kind === "Hint") {
    add(l.heads, b.from, -b.amount);
    if ("to" in b) add(l.heads, b.to, b.amount);
    else l.pool += b.amount;
  } else if (b.kind === "Tag" || b.kind === "Forfeit") {
    const [loser, winner] = b.kind === "Tag" ? [b.target, b.hunter] : [b.player, b.to];
    if ("credit" in b) {
      l.pool -= b.credit;
      add(l.heads, loser, b.credit);
    }
    add(l.heads, winner, l.heads[loser] ?? 0n);
    l.heads[loser] = 0n;
    l.out[loser] = true;
  }
}

/** The ledger after every verdict the bundle holds (undecodable ones are skipped). */
export function playLedger(d: DecodedBundle): Ledger {
  const l = startLedger(d.players.length, d.stake);
  for (const x of d.verdicts) if (x.v) applyPlay(l, x.v.body);
  return l;
}

// ── The replay at End ───────────────────────────────────────────────────────────────

export type Settlement =
  /** Recorded before protocol v2: no pool, credits or hint targets, so no replay. */
  | { kind: "v1" }
  /**
   * Not replayed. no-end: the bundle has no End verdict to take the ring and hint targets from.
   * unsigned: a verdict isn't the referee's (it doesn't decode, names another match or fails its
   * signature), so these aren't the verdicts the contract applied.
   */
  | { kind: "not-run"; why: "no-end" | "unsigned" }
  /** Every rule held. `owed[p]`: what the pool still owed player p at End, credited to their head. */
  | { kind: "payout"; owed: bigint[] }
  /** A rule was broken: every stake is refunded. `text` is the contract's words for it. */
  | { kind: "refunded"; violation: Violation; text: string };

const cache = new WeakMap<DecodedBundle, Settlement>();

/** The contract's End replay over this bundle's verdicts, as `settle_end` runs it. */
export function settlementOf(d: DecodedBundle): Settlement {
  const hit = cache.get(d);
  if (hit) return hit;
  const s = settle(d);
  cache.set(d, s);
  return s;
}

function settle(d: DecodedBundle): Settlement {
  if (d.version === 1) return { kind: "v1" };
  const signed = d.verdicts.every((x) => {
    if (!x.v || !x.digest || !equal(x.v.matchId, d.matchId)) return false;
    try {
      return ed25519.verify(x.v.sig, x.digest, d.refereePk);
    } catch {
      return false;
    }
  });
  if (!signed) return { kind: "not-run", why: "unsigned" };
  // A v2 bundle decodes only v2 verdicts (bundle.ts).
  const bodies = d.verdicts.map((x) => x.v?.body as Verdict);
  const end = bodies.find((b) => b.kind === "End");
  if (end?.kind !== "End") return { kind: "not-run", why: "no-end" };
  const events = bodies.map(playEvent).filter((e): e is PlayEvent => e !== null);
  const r = replaySettlement(
    ringOrder(d.players, end.vrfSignature),
    events,
    end.hintTargets,
    playLedger(d).pool,
  );
  return r.ok
    ? { kind: "payout", owed: r.owed }
    : { kind: "refunded", violation: r.violation, text: describeViolation(r.violation) };
}

/** `settled_as` as the contract's `get_match` reports this outcome, or null when it has none. */
export function settledAs(s: Settlement): "payout" | "refunded_rule_violation" | null {
  return s.kind === "payout" ? "payout" : s.kind === "refunded" ? "refunded_rule_violation" : null;
}

/**
 * What each player is paid: their head (with what the pool owed them, in v2) plus an equal share
 * of the sponsors' pot among survivors, the first `pot % survivors` of them one unit more; or, on
 * a refund, their stake. null when the settlement wasn't replayed.
 */
export function expectedPaid(d: DecodedBundle, s: Settlement, pot: bigint): bigint[] | null {
  if (s.kind === "not-run") return null;
  if (s.kind === "refunded") return d.players.map(() => d.stake);
  const l = playLedger(d);
  const heads = l.heads.map((h, i) => (s.kind === "payout" && !l.out[i] ? h + (s.owed[i] ?? 0n) : h));
  const survivors = BigInt(l.out.filter((o) => !o).length);
  if (survivors === 0n) return heads;
  const share = pot / survivors;
  let extra = pot % survivors;
  return heads.map((h, i) => {
    if (l.out[i]) return h;
    let paid = h + share;
    if (extra > 0n) {
      paid += 1n;
      extra -= 1n;
    }
    return paid;
  });
}
