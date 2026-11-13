// Merkle log (TECHNICAL.md 4.11): RFC 6962 tree, inclusion proofs (RFC 9162 2.1.3) and
// consistency proofs (2.1.4). Mirrors crates/tail-protocol/src/merkle.rs.
//
// Sizes and indexes are plain numbers (exact up to 2^53, far beyond any match log); bit tests
// use arithmetic rather than 32-bit bitwise operators for that reason.

import { sha256 } from "@noble/hashes/sha2.js";
import { concat, equal } from "./bytes.ts";
import { encodeLogEntry, type LogEntry } from "./messages.ts";

type Hash = Uint8Array;

export const merkleLeaf = (e: LogEntry) => sha256(concat(Uint8Array.of(0), encodeLogEntry(e)));
/** `SHA256(0x01 ‖ l ‖ r)`. */
export const merkleNode = (l: Hash, r: Hash) => sha256(concat(Uint8Array.of(1), l, r));
/** Root of the empty log, `SHA256("")`. */
export const merkleEmptyRoot = () => sha256(new Uint8Array(0));

/** Largest power of two strictly below n (n ≥ 2). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

const odd = (x: number) => x % 2 === 1;
const half = (x: number) => Math.floor(x / 2);
const isPowerOfTwo = (x: number) => x > 0 && split(x + 1) === x;
const isSize = (x: number) => Number.isSafeInteger(x) && x >= 0;

export function merkleRoot(leaves: readonly Hash[]): Hash {
  if (leaves.length === 0) return merkleEmptyRoot();
  if (leaves.length === 1) return leaves[0] as Hash;
  const k = split(leaves.length);
  return merkleNode(merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)));
}

/** Audit path for leaf `index` in a tree of `leaves.length`, deepest sibling first. */
export function merkleProof(leaves: readonly Hash[], index: number): Hash[] {
  if (index < 0 || index >= leaves.length) throw new RangeError("leaf index out of range");
  if (leaves.length === 1) return [];
  const k = split(leaves.length);
  return index < k
    ? [...merkleProof(leaves.slice(0, k), index), merkleRoot(leaves.slice(k))]
    : [...merkleProof(leaves.slice(k), index - k), merkleRoot(leaves.slice(0, k))];
}

/** RFC 9162 2.1.3.2: does `proof` place `leaf` at `index` in the tree of `size` with `root`? */
export function merkleVerify(
  leaf: Hash,
  index: number,
  size: number,
  proof: readonly Hash[],
  root: Hash,
): boolean {
  if (!isSize(index) || !isSize(size) || index >= size) return false;
  let f = index;
  let s = size - 1;
  let r = leaf;
  for (const p of proof) {
    if (s === 0) return false;
    if (odd(f) || f === s) {
      r = merkleNode(p, r);
      while (!odd(f) && f !== 0) {
        f = half(f);
        s = half(s);
      }
    } else r = merkleNode(r, p);
    f = half(f);
    s = half(s);
  }
  return s === 0 && equal(r, root);
}

/** The perfect subtrees a log of `size` leaves is made of, as [lo, hi) leaf ranges, largest first. */
function peakRanges(size: number): [number, number][] {
  const out: [number, number][] = [];
  let lo = 0;
  for (let s = split(size + 1); s >= 1; s /= 2) {
    if (size - lo >= s) {
      out.push([lo, lo + s]);
      lo += s;
    }
  }
  return out;
}

/**
 * Roots of the perfect subtrees that make up the log (one per set bit of its size), largest
 * first: all a writer needs to keep to append and to prove consistency later.
 */
export const merklePeaks = (leaves: readonly Hash[]) =>
  peakRanges(leaves.length).map(([lo, hi]) => merkleRoot(leaves.slice(lo, hi)));

/** SUBPROOF(m, D[lo:hi], complete) of RFC 9162 2.1.4.1, m counted from lo, over an oracle for MTH(D[a:b]). */
function subproof(
  m: number,
  lo: number,
  hi: number,
  complete: boolean,
  mth: (a: number, b: number) => Hash,
): Hash[] {
  if (m === hi - lo) return complete ? [] : [mth(lo, hi)];
  const k = split(hi - lo);
  return m <= k
    ? [...subproof(m, lo, lo + k, complete, mth), mth(lo + k, hi)]
    : [...subproof(m - k, lo + k, hi, false, mth), mth(lo, lo + k)];
}

/** Consistency proof from the tree of the first `m` leaves to the tree of all of them. */
export function consistencyProof(leaves: readonly Hash[], m: number): Hash[] {
  if (!isSize(m) || m > leaves.length) throw new RangeError("old size beyond the log");
  return m === 0 ? [] : subproof(m, 0, leaves.length, true, (a, b) => merkleRoot(leaves.slice(a, b)));
}

/**
 * MTH(D[lo:hi]) from the peaks at size m and the leaves appended since, splitting as the tree
 * does until each part is a peak or lies wholly in the appended leaves. That covers every
 * subtree a consistency proof or a root needs: going down from a node that crosses m (or ends at
 * it), the first node wholly inside the old log is a peak, since peaks are the largest perfect
 * subtrees there. A node strictly inside a peak would bottom out in a single old leaf and throw;
 * no caller asks for one.
 */
function frontier(m: number, peaks: readonly Hash[], appended: readonly Hash[]) {
  if (!isSize(m)) throw new RangeError("bad log size");
  const ranges = peakRanges(m);
  if (ranges.length !== peaks.length)
    throw new Error(`a log of ${m} has ${ranges.length} peaks, got ${peaks.length}`);
  const mth = (lo: number, hi: number): Hash => {
    if (lo >= m) return merkleRoot(appended.slice(lo - m, hi - m));
    const i = ranges.findIndex(([a, b]) => a === lo && b === hi);
    if (i >= 0) return peaks[i] as Hash;
    if (hi - lo < 2) throw new Error("subtree not derivable from the frontier");
    const k = split(hi - lo);
    return merkleNode(mth(lo, lo + k), mth(lo + k, hi));
  };
  return { n: m + appended.length, mth };
}

/**
 * The consistency proof from size `m` to `m + appended.length`, from the peaks at `m` (largest
 * first, as merklePeaks returns them) and the leaf hashes appended since. Equal to
 * consistencyProof(allLeaves, m). Throws if `peaks` does not fit `m`.
 */
export function consistencyProofFromFrontier(
  m: number,
  peaks: readonly Hash[],
  appended: readonly Hash[],
): Hash[] {
  const { n, mth } = frontier(m, peaks, appended);
  return m === 0 ? [] : subproof(m, 0, n, true, mth);
}

/** Root of the log after `appended`, from the peaks at `m`. */
export function merkleRootFromFrontier(m: number, peaks: readonly Hash[], appended: readonly Hash[]): Hash {
  const { n, mth } = frontier(m, peaks, appended);
  return n === 0 ? merkleEmptyRoot() : mth(0, n);
}

/**
 * RFC 9162 2.1.4.2: is the tree of size `m` with `oldRoot` a prefix of the tree of size `n` with
 * `newRoot`? Size 0 is a prefix of every tree (its root must be the empty root), and m == n
 * needs an empty proof and equal roots.
 */
export function verifyConsistency(
  m: number,
  n: number,
  oldRoot: Hash,
  newRoot: Hash,
  proof: readonly Hash[],
): boolean {
  if (!isSize(m) || !isSize(n) || m > n) return false;
  if (m === 0) return proof.length === 0 && equal(oldRoot, merkleEmptyRoot());
  if (m === n) return proof.length === 0 && equal(oldRoot, newRoot);
  // When m is a power of two the old tree is one subtree of the new one, and the proof leaves
  // out its root because the verifier already has it.
  const path = isPowerOfTwo(m) ? [oldRoot, ...proof] : [...proof];
  const first = path[0];
  if (!first) return false;
  let f = m - 1;
  let s = n - 1;
  while (odd(f)) {
    f = half(f);
    s = half(s);
  }
  let fr = first;
  let sr = first;
  for (const c of path.slice(1)) {
    if (s === 0) return false;
    if (odd(f) || f === s) {
      fr = merkleNode(c, fr);
      sr = merkleNode(c, sr);
      while (!odd(f) && f !== 0) {
        f = half(f);
        s = half(s);
      }
    } else sr = merkleNode(sr, c);
    f = half(f);
    s = half(s);
  }
  return equal(fr, oldRoot) && equal(sr, newRoot) && s === 0;
}
