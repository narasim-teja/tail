// What the contract would hold had a bundle's verdicts been applied on NEAR, for the tests,
// verdict head and settlement included.

import {
  describeViolation,
  type PlayEvent,
  playEvent,
  replaySettlement,
  ringOrder,
  toHex,
  type Verdict,
} from "@tail/protocol";
import type { ChainState } from "../src/verify/anchor.ts";
import type { DecodedBundle } from "../src/verify/bundle.ts";

/**
 * What the contract would hold had this bundle's verdicts been applied on NEAR: heads moved as
 * each verdict landed (a hint into the pool, a credit onto the loser, the loser's head to the
 * winner), then End's replay, which pays out or refunds every stake. Written out here rather than
 * taken from src/verify/settle.ts, so the page's replay is tested against the contract's rules.
 * A v1 bundle follows the v1 contract: a hint paid its target at once, no replay, no `settled_as`.
 */
export function chainFor(d: DecodedBundle): Extract<ChainState, { kind: "found" }> {
  const vs = d.verdicts.map((x) => x.v);
  const start = vs.find((v) => v?.body.kind === "Start")?.body;
  const end = vs.find((v) => v?.body.kind === "End");
  if (start?.kind !== "Start" || end?.body.kind !== "End") throw new Error("fixture lacks Start/End");
  const out = new Set<number>();
  const heads = d.players.map(() => d.stake);
  let pool = 0n;
  const events: PlayEvent[] = [];
  const v1 = d.version === 1;
  for (const v of vs) {
    const b = v?.body;
    if (v1 && b) {
      if (b.kind === "Hint" && "to" in b) {
        heads[b.from] = (heads[b.from] as bigint) - b.amount;
        heads[b.to] = (heads[b.to] as bigint) + b.amount;
      } else if (b.kind === "Tag" || b.kind === "Forfeit") {
        const [l, w] = b.kind === "Tag" ? [b.target, b.hunter] : [b.player, b.to];
        heads[w] = (heads[w] as bigint) + (heads[l] as bigint);
        heads[l] = 0n;
        out.add(l);
      }
      continue;
    }
    if (b?.kind === "Hint") {
      heads[b.from] = (heads[b.from] as bigint) - b.amount;
      pool += b.amount;
    } else if ((b?.kind === "Tag" || b?.kind === "Forfeit") && "credit" in b) {
      const [l, w] = b.kind === "Tag" ? [b.target, b.hunter] : [b.player, b.to];
      pool -= b.credit;
      heads[l] = (heads[l] as bigint) + b.credit;
      heads[w] = (heads[w] as bigint) + (heads[l] as bigint);
      heads[l] = 0n;
      out.add(l);
    }
    const e = b ? playEvent(b as Verdict) : null;
    if (e) events.push(e);
  }
  const endBody = end.body;
  const r =
    v1 || !("hintTargets" in endBody)
      ? null
      : replaySettlement(ringOrder(d.players, endBody.vrfSignature), events, endBody.hintTargets, pool);
  const paid = !r ? heads : r.ok ? heads.map((h, i) => h + (r.owed[i] as bigint)) : heads.map(() => d.stake);
  const settlement = !r
    ? {}
    : {
        settled_as: r.ok ? ("payout" as const) : ("refunded_rule_violation" as const),
        violation: r.ok ? null : describeViolation(r.violation),
        hint_pool: "0",
      };
  return {
    kind: "found",
    match: {
      match_id: d.raw.match.id,
      token: d.raw.match.token,
      stake: d.raw.match.stake,
      phase: "ended",
      players: d.players.map((a, i) => ({
        account_id: a,
        head: "0",
        out: out.has(i),
        paid: String(paid[i]),
      })),
      sponsors: [],
      ...settlement,
      seq: end.seq,
      referee_pk: toHex(d.refereePk),
      vrf_pk: toHex(d.vrfPk),
      ring_commit: toHex(start.ringCommit),
      start_ms: Number(start.startMs),
      end_ms: Number(start.endMs),
      alpha: end.body.alpha,
      vrf_signature: toHex(end.body.vrfSignature),
      public_replay: true,
    },
    roots: {
      checkpoints: vs
        .filter((v) => v?.body.kind === "Checkpoint")
        .map((v) => {
          const b = v?.body as { logSize: bigint; root: Uint8Array };
          return { log_size: Number(b.logSize), root: toHex(b.root) };
        }),
      final_root: { log_size: Number(end.body.logSize), root: toHex(end.body.root) },
    },
    head: { kind: "found", digest: d.verdicts.at(-1)?.digest as Uint8Array, seq: end.seq },
  };
}
