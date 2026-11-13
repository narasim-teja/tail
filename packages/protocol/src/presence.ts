// Presence proofs: "these two phones were near each other", checked from chain data alone.
// Mirrors crates/tail-protocol/src/presence.rs.
//
// A PresenceProof is a Contact log entry plus its audit path. It holds if the path leads to a
// root the contract anchored for the match at that log size (a Checkpoint or End verdict), and
// the accounts it names are the contract's players at the entry's indexes. The referee's
// signature on that root is the only trust in it; the proof adds no signature of its own. The
// caller fetches `roots` and `players` from `proof.contract` for `proof.matchId`.

import { merkleLeaf, merkleProof, merkleVerify } from "./merkle.ts";
import type { LogEntry, PresenceProof } from "./messages.ts";

/** A root the contract anchored: `logSize` and `root` of a Checkpoint or End verdict. */
export interface AnchoredRoot {
  logSize: bigint;
  root: Uint8Array;
}

export type PresenceResult =
  | { ok: true; a: number; b: number; epoch: number; accounts: [string, string] }
  | { ok: false; why: "not-contact" | "no-root" | "bad-path" | "unknown-player" | "wrong-accounts" };

/** `players` are the match's account ids, index = player number. */
export function verifyPresence(
  proof: PresenceProof,
  roots: readonly AnchoredRoot[],
  players: readonly string[],
): PresenceResult {
  const e = proof.entry;
  if (e.kind !== "Contact") return { ok: false, why: "not-contact" };
  const anchored = roots.find((r) => r.logSize === proof.size);
  if (!anchored) return { ok: false, why: "no-root" };
  if (!merkleVerify(merkleLeaf(e), Number(proof.index), Number(proof.size), proof.path, anchored.root))
    return { ok: false, why: "bad-path" };
  const a = players[e.a];
  const b = players[e.b];
  if (a === undefined || b === undefined) return { ok: false, why: "unknown-player" };
  if (a !== proof.accounts[0] || b !== proof.accounts[1]) return { ok: false, why: "wrong-accounts" };
  return { ok: true, a: e.a, b: e.b, epoch: e.epoch, accounts: [a, b] };
}

/**
 * Builds the proof for the Contact at `index` against the log's first `size` entries (an
 * anchored size). For whoever holds the log: the relay during play, anyone after declassify.
 */
export function presenceProof(p: {
  matchId: Uint8Array;
  contract: string;
  log: readonly LogEntry[];
  index: number;
  size: number;
  players: readonly string[];
}): PresenceProof {
  if (p.size > p.log.length) throw new RangeError("size beyond the log");
  const entry = p.log[p.index];
  if (p.index >= p.size || entry === undefined) throw new RangeError("index outside the anchored log");
  if (entry.kind !== "Contact") throw new Error(`entry ${p.index} is a ${entry.kind}, not a Contact`);
  const a = p.players[entry.a];
  const b = p.players[entry.b];
  if (a === undefined || b === undefined) throw new Error("contact names an unknown player");
  return {
    matchId: p.matchId,
    contract: p.contract,
    entry,
    index: BigInt(p.index),
    size: BigInt(p.size),
    path: merkleProof(p.log.slice(0, p.size).map(merkleLeaf), p.index),
    accounts: [a, b],
  };
}
