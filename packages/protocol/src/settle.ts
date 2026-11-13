// The settlement replay: what the contract checks at End before any money in a match becomes
// withdrawable (TECHNICAL 4.10). Twin of crates/tail-protocol/src/settle.rs; the contract, the
// relay's test chain and the web replay all run this one rule.
//
// During play the contract applies each Hint, Tag and Forfeit as it lands but cannot check it:
// the ring is still secret, and a Hint does not say whom it was about. End reveals both (the VRF
// signature and `hintTargets`), and this replays the match in verdict order against them.

import { buildRing, sortAccounts } from "./crypto.ts";
import type { Verdict } from "./messages.ts";

/** A Hint, Tag or Forfeit as the contract applied it, in verdict order. */
export type PlayEvent =
  | { kind: "Hint"; from: number; amount: bigint }
  | { kind: "Tag"; hunter: number; target: number; credit: bigint }
  | { kind: "Forfeit"; player: number; to: number; credit: bigint };

/** Which rule the replay found broken; the order is the contract's stored tag. */
export const SettleCheck = {
  HintCount: 0,
  HintTarget: 1,
  TagRing: 2,
  ForfeitRing: 3,
  Credit: 4,
  Pool: 5,
} as const;
export type SettleCheck = (typeof SettleCheck)[keyof typeof SettleCheck];

/** The first rule the replay found broken, and at which event (`null` for a whole-match check). */
export interface Violation {
  check: SettleCheck;
  event: number | null;
}

const CHECK_TEXT: Record<SettleCheck, string> = {
  [SettleCheck.HintCount]: "End names a different number of hint targets than there were hints",
  [SettleCheck.HintTarget]: "a hint was not about its asker's target",
  [SettleCheck.TagRing]: "a Tag did not follow the ring",
  [SettleCheck.ForfeitRing]: "a Forfeit did not pay the forfeiter's hunter",
  [SettleCheck.Credit]: "a credit is not the hints paid onto its target",
  [SettleCheck.Pool]: "the hint pool does not end at 0",
};

/** The contract's words for a violation, as its `get_match` view reports them. */
export const describeViolation = (v: Violation) =>
  v.event === null ? CHECK_TEXT[v.check] : `event ${v.event}: ${CHECK_TEXT[v.check]}`;

/** The play event of a verdict, or null for Start, Checkpoint and End. */
export function playEvent(v: Verdict): PlayEvent | null {
  switch (v.kind) {
    case "Hint":
      return { kind: "Hint", from: v.from, amount: v.amount };
    case "Tag":
      return { kind: "Tag", hunter: v.hunter, target: v.target, credit: v.credit };
    case "Forfeit":
      return { kind: "Forfeit", player: v.player, to: v.to, credit: v.credit };
    default:
      return null;
  }
}

/** The ring as player indices (positions in the sorted account list): ring[k] hunts ring[k+1 mod n]. */
export function ringOrder(accountIds: readonly string[], vrfSignature: Uint8Array): number[] {
  const sorted = sortAccounts(accountIds);
  return buildRing(accountIds, vrfSignature).map((a) => sorted.indexOf(a));
}

export type Replay = { ok: true; owed: bigint[] } | { ok: false; violation: Violation };

/**
 * Replays `events` against `ring` and the revealed `hintTargets` (one per Hint, in order). Every
 * Tag and Forfeit must follow the ring, every hint must be about its asker's current target, and
 * every credit must equal the hints paid onto that target and not yet credited. The winner of an
 * elimination then hunts the loser's target. `owed[p]` is what player p is still owed from the
 * pool at End (their pending credit if they survived, else 0); it must add up to `pool`.
 */
export function replaySettlement(
  ring: readonly number[],
  events: readonly PlayEvent[],
  hintTargets: readonly number[],
  pool: bigint,
): Replay {
  const n = ring.length;
  const target: (number | null)[] = Array.from({ length: n }, () => null);
  ring.forEach((h, k) => {
    target[h] = ring[(k + 1) % n] as number;
  });
  const fail = (check: SettleCheck, event: number | null): Replay => ({
    ok: false,
    violation: { check, event },
  });
  if (events.filter((e) => e.kind === "Hint").length !== hintTargets.length)
    return fail(SettleCheck.HintCount, null);
  const pending: bigint[] = Array.from({ length: n }, () => 0n);
  const out: boolean[] = Array.from({ length: n }, () => false);
  const current = (p: number) => target[p] ?? null;
  let nextHint = 0;
  for (const [i, e] of events.entries()) {
    if (e.kind === "Hint") {
      const t = hintTargets[nextHint++] as number;
      if (current(e.from) !== t) return fail(SettleCheck.HintTarget, i);
      pending[t] = (pending[t] as bigint) + e.amount;
      continue;
    }
    const [winner, loser, check] =
      e.kind === "Tag"
        ? [e.hunter, e.target, SettleCheck.TagRing]
        : [e.to, e.player, SettleCheck.ForfeitRing];
    // Only a live player is anyone's target, and an out player hunts nobody.
    if (current(winner) !== loser) return fail(check, i);
    if (e.credit !== pending[loser]) return fail(SettleCheck.Credit, i);
    pending[loser] = 0n;
    out[loser] = true;
    const next = target[loser] ?? null;
    target[loser] = null;
    target[winner] = next === winner ? null : next;
  }
  const owed = pending.map((p, i) => (out[i] ? 0n : p));
  if (owed.reduce((a, b) => a + b, 0n) !== pool) return fail(SettleCheck.Pool, null);
  return { ok: true, owed };
}
