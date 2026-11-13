// Inclusion receipts (TECHNICAL.md 4.11): each phone checks that every report it sent is in the
// match log the referee anchored on NEAR, so the referee cannot silently drop one. For each
// report the phone kept (seq and batch hash, persisted in the match file) it computes the log
// leaf, asks the relay for an audit path at the size of a root it read from NEAR itself
// (src/near/chain.ts), and verifies the path against that root. The relay supplies paths only; a
// path that does not verify counts against it, never for it.
//
// A report the referee refused is in the log too, as a Rejected entry carrying the refusal
// code; the phone tries the code the signed HUD gave it first, then the others.
//
// After End the plaintext log is in the replay bundle, and the same check yields a presence
// proof: "these two phones were near each other", a Contact entry and its path to an anchored
// root, verifiable by anyone from chain data (packages/protocol presence.ts).

import {
  type AnchoredRoot,
  encodePresenceProof,
  type LogEntry,
  merkleLeaf,
  merkleVerify,
  type PresenceProof,
  presenceProof,
  RejectCode,
  toHex,
  verifyPresence,
} from "@tail/protocol";
import { toB64 } from "../lib/b64";
import type { InclusionProof } from "./relay";

/** One report the relay took from this phone: its seq, batch hash, and the refusal code if the HUD named one. */
export interface Report {
  seq: number;
  hash: Uint8Array;
  code?: number;
}

export type ProofSource = (leaf: Uint8Array, size: number) => Promise<InclusionProof | null>;

export interface ReceiptResult {
  /** The anchored log size checked against, and whether it is End's (complete) root. */
  size: number;
  final: boolean;
  total: number;
  /** Seqs found as accepted batches. */
  included: number[];
  /** Seqs found as refused, with the referee's code. */
  refused: { seq: number; code: number }[];
  /** Seqs in neither form. Against End's root that is a dropped report. */
  missing: number[];
  /** Seqs for which the relay sent a path that does not lead to NEAR's root. */
  badProof: number[];
}

/** Every RejectCode value, for looking a refused report up in the log. */
export const REJECT_CODES: readonly number[] = Object.values(RejectCode);

/** Checks a few reports at a time, so a whole match does not open hundreds of requests at once. */
const PARALLEL = 4;

async function found(
  leaf: Uint8Array,
  root: AnchoredRoot,
  proofs: ProofSource,
): Promise<"yes" | "no" | "bad"> {
  const size = Number(root.logSize);
  const p = await proofs(leaf, size);
  if (!p) return "no";
  return p.size === size && merkleVerify(leaf, p.index, size, p.path, root.root) ? "yes" : "bad";
}

export async function checkReceipts(i: {
  player: number;
  reports: readonly Report[];
  root: AnchoredRoot;
  final: boolean;
  proofs: ProofSource;
}): Promise<ReceiptResult> {
  const out: ReceiptResult = {
    size: Number(i.root.logSize),
    final: i.final,
    total: i.reports.length,
    included: [],
    refused: [],
    missing: [],
    badProof: [],
  };
  const one = async (r: Report) => {
    const batch: LogEntry = { kind: "Batch", player: i.player, seq: r.seq, hash: r.hash };
    const asBatch = await found(merkleLeaf(batch), i.root, i.proofs);
    if (asBatch === "yes") return void out.included.push(r.seq);
    if (asBatch === "bad") return void out.badProof.push(r.seq);
    const codes = r.code === undefined ? REJECT_CODES : [r.code, ...REJECT_CODES.filter((c) => c !== r.code)];
    for (const code of codes) {
      const entry: LogEntry = { kind: "Rejected", player: i.player, seq: r.seq, hash: r.hash, code };
      const asRefused = await found(merkleLeaf(entry), i.root, i.proofs);
      if (asRefused === "yes") return void out.refused.push({ seq: r.seq, code });
      if (asRefused === "bad") return void out.badProof.push(r.seq);
    }
    out.missing.push(r.seq);
  };
  const queue = [...i.reports];
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      for (let r = queue.shift(); r; r = queue.shift()) await one(r);
    }),
  );
  for (const list of [out.included, out.missing, out.badProof]) list.sort((a, b) => a - b);
  out.refused.sort((a, b) => a.seq - b.seq);
  return out;
}

/** One presence proof this player can hand out: met `other` (an account) in `epoch`. */
export interface Meeting {
  other: string;
  epoch: number;
  proof: PresenceProof;
}

/**
 * The latest contact with each other player, as presence proofs against End's root, each checked
 * with verifyPresence before it is offered. `log` comes from the replay bundle and is untrusted;
 * a proof built from a tampered log does not verify and is left out.
 */
export function meetings(i: {
  matchId: Uint8Array;
  contract: string;
  log: readonly LogEntry[];
  me: number;
  players: readonly string[];
  root: AnchoredRoot;
}): Meeting[] {
  const size = Number(i.root.logSize);
  const latest = new Map<number, number>();
  i.log.slice(0, size).forEach((e, index) => {
    if (e.kind !== "Contact" || (e.a !== i.me && e.b !== i.me)) return;
    latest.set(e.a === i.me ? e.b : e.a, index);
  });
  const out: Meeting[] = [];
  for (const [other, index] of latest) {
    let proof: PresenceProof;
    try {
      proof = presenceProof({
        matchId: i.matchId,
        contract: i.contract,
        log: i.log,
        index,
        size,
        players: i.players,
      });
    } catch {
      continue;
    }
    const v = verifyPresence(proof, [i.root], i.players);
    if (!v.ok) continue;
    out.push({ other: i.players[other] as string, epoch: v.epoch, proof });
  }
  return out.sort((a, b) => a.other.localeCompare(b.other));
}

/**
 * A presence proof as a JSON document to share. `proof` is the borsh PresenceProof (base64),
 * which is all a verifier needs; the other fields say what it claims and how to check it.
 */
export function presenceJson(m: Meeting): string {
  const p = m.proof;
  return JSON.stringify(
    {
      kind: "tail/presence-proof/v1",
      contract: p.contract,
      match_id: toHex(p.matchId),
      accounts: p.accounts,
      epoch: m.epoch,
      index: Number(p.index),
      size: Number(p.size),
      proof: toB64(encodePresenceProof(p)),
      check:
        "decodePresenceProof(proof), then verifyPresence(proof, roots, players) from @tail/protocol, with roots from get_roots and players from get_match on the contract, for match_id",
    },
    null,
    2,
  );
}
