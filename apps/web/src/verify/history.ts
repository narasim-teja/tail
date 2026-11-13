// Two checks on the match's history as a whole (protocol v2):
//
// Verdict chain. Each verdict's `prev` is the digest of the verdict before it (zeros for seq 1),
// so the stream is one hash chain; the contract refuses a verdict whose `prev` is not the digest
// it stored last, and keeps that digest as the head (`get_verdict_head`). The page checks every
// link (verdictChainBreak) and that the bundle's last digest is NEAR's head. Two different
// verdicts signed for one seq cannot both be on that chain.
//
// Append-only log. For each pair of successive anchored roots (size m, then n), an RFC 9162
// consistency proof m → n is built from the bundle's leaves and verified against the two roots
// (verifyConsistency). The proof comes from the bundle, but it has to fit both roots: it holds
// only if the log anchored at m is a prefix of the one anchored at n, so each checkpoint extends
// the previous one. A failure means that isn't so over this bundle's log: the log changed after a
// checkpoint, or the bundle's leaves aren't the anchored log. The contract runs the same check on
// the referee's proof before it accepts a Checkpoint or End, so a settled match passed it there too.

import {
  consistencyProofFromFrontier,
  equal,
  fromHex,
  type SignedVerdict,
  verdictChainBreak,
  verifyConsistency,
} from "@tail/protocol";
import type { ChainHead, ChainState } from "./anchor.ts";
import type { DecodedBundle } from "./bundle.ts";
import { Frontier } from "./checks.ts";

// ── Verdict chain ────────────────────────────────────────────────────────────────

export type HeadCheck =
  /** NEAR's head is the bundle's last verdict digest (and seq, when the view gives one). */
  | "match"
  | "mismatch"
  /** The contract has no get_verdict_head view (deployed before it), so this wasn't checked. */
  | "no-view"
  /** NEAR has no such match, or couldn't be reached, or the view failed. */
  | "not-checked";

export type VerdictChainCheck =
  /** Recorded before protocol v2: verdicts carry no `prev`. */
  | { kind: "v1" }
  | {
      kind: "checked";
      /** Index of the first verdict that breaks the chain (bad seq, prev, signature or decode). */
      breakAt: number | null;
      /** Digest of the bundle's last verdict, the chain's head. */
      head: Uint8Array | null;
      onNear: HeadCheck;
    };

export function checkVerdictChain(d: DecodedBundle, chain: ChainState | null): VerdictChainCheck {
  if (d.version === 1) return { kind: "v1" };
  const firstBad = d.verdicts.findIndex((x) => !x.v || !x.digest);
  const decoded = d.verdicts
    .slice(0, firstBad < 0 ? undefined : firstBad)
    // A v2 bundle decodes only v2 verdicts (bundle.ts).
    .map((x) => x.v as SignedVerdict);
  const brk = verdictChainBreak(decoded, d.refereePk);
  const breakAt = brk ?? (firstBad < 0 ? null : firstBad);
  const last = d.verdicts.at(-1);
  const head = last?.digest ?? null;
  return {
    kind: "checked",
    breakAt,
    head,
    onNear: headOnNear(chain?.kind === "found" ? chain.head : null, head, last?.v?.seq ?? null),
  };
}

function headOnNear(h: ChainHead | null, head: Uint8Array | null, seq: number | null): HeadCheck {
  if (!h || h.kind === "unreadable") return "not-checked";
  if (h.kind === "no-view") return "no-view";
  if (h.kind === "none" || !head) return "mismatch";
  return equal(h.digest, head) && (h.seq === null || h.seq === seq) ? "match" : "mismatch";
}

export const chainOk = (c: VerdictChainCheck) =>
  c.kind === "checked" && c.breakAt === null && c.onNear !== "mismatch";

// ── Append-only log ──────────────────────────────────────────────────────────────

export interface AnchoredRoot {
  size: number;
  root: Uint8Array;
}

/**
 * The roots the checks prove against, in log order. NEAR's (`get_roots`) when NEAR answered for
 * this match; otherwise the roots the referee signed into its Checkpoint and End verdicts, which
 * is all a fixture or an unreachable chain leaves.
 */
export function anchoredRoots(
  d: DecodedBundle,
  chain: ChainState | null,
): { source: "near" | "signed"; roots: AnchoredRoot[] } {
  if (chain?.kind === "found") {
    const all = [...chain.roots.checkpoints, ...(chain.roots.final_root ? [chain.roots.final_root] : [])];
    const roots = all.map((r) => ({ size: r.log_size, root: safeHex(r.root) }));
    return { source: "near", roots: roots.sort((a, b) => a.size - b.size) };
  }
  const roots: AnchoredRoot[] = [];
  for (const x of d.verdicts) {
    const b = x.v?.body;
    if (b?.kind === "Checkpoint" || b?.kind === "End") roots.push({ size: Number(b.logSize), root: b.root });
  }
  return { source: "signed", roots: roots.sort((a, b) => a.size - b.size) };
}

export interface ConsistencyLink {
  from: number;
  to: number;
  /** Hashes in the proof computed from the bundle's leaves (0 when it couldn't be built). */
  proofLength: number;
  ok: boolean;
}

export interface ConsistencyCheck {
  source: "near" | "signed";
  links: ConsistencyLink[];
  ok: boolean;
}

export function checkConsistency(
  leaves: readonly Uint8Array[],
  anchored: { source: "near" | "signed"; roots: AnchoredRoot[] },
): ConsistencyCheck {
  const { roots } = anchored;
  const links: ConsistencyLink[] = [];
  // The proofs come from the frontier prover (equal to consistencyProof over all the leaves, and
  // what the referee runs), walking the log once: the peaks at each anchored size, then the leaves
  // appended up to the next.
  const walk = new Frontier();
  const peaksAt = (size: number) => {
    while (walk.size < size) walk.push(leaves[walk.size] as Uint8Array);
    return walk.peaksNow();
  };
  for (let i = 1; i < roots.length; i++) {
    const a = roots[i - 1] as AnchoredRoot;
    const b = roots[i] as AnchoredRoot;
    if (b.size > leaves.length || a.size > b.size || a.size < walk.size) {
      links.push({ from: a.size, to: b.size, proofLength: 0, ok: false });
      continue;
    }
    const proof = consistencyProofFromFrontier(a.size, peaksAt(a.size), leaves.slice(a.size, b.size));
    links.push({
      from: a.size,
      to: b.size,
      proofLength: proof.length,
      ok: verifyConsistency(a.size, b.size, a.root, b.root, proof),
    });
  }
  return { source: anchored.source, links, ok: links.every((l) => l.ok) };
}

function safeHex(s: string): Uint8Array {
  try {
    return fromHex(s);
  } catch {
    return new Uint8Array(0);
  }
}
