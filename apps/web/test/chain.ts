// What the contract would hold had a bundle's verdicts been applied on NEAR, for the tests,
// verdict head included.

import { toHex } from "@tail/protocol";
import type { ChainState } from "../src/verify/anchor.ts";
import type { DecodedBundle } from "../src/verify/bundle.ts";

/** What the contract would hold had this bundle's verdicts been applied on NEAR. */
export function chainFor(d: DecodedBundle): Extract<ChainState, { kind: "found" }> {
  const vs = d.verdicts.map((x) => x.v);
  const start = vs.find((v) => v?.body.kind === "Start")?.body;
  const end = vs.find((v) => v?.body.kind === "End");
  if (start?.kind !== "Start" || end?.body.kind !== "End") throw new Error("fixture lacks Start/End");
  const out = new Set<number>();
  const heads = d.players.map(() => d.stake);
  for (const v of vs) {
    const b = v?.body;
    if (b?.kind === "Hint") {
      heads[b.from] = (heads[b.from] as bigint) - b.amount;
      heads[b.to] = (heads[b.to] as bigint) + b.amount;
    } else if (b?.kind === "Tag" || b?.kind === "Forfeit") {
      const [l, w] = b.kind === "Tag" ? [b.target, b.hunter] : [b.player, b.to];
      heads[w] = (heads[w] as bigint) + (heads[l] as bigint);
      heads[l] = 0n;
      out.add(l);
    }
  }
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
        paid: String(heads[i]),
      })),
      sponsors: [],
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
