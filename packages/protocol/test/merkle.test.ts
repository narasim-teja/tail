import { describe, expect, test } from "bun:test";
import {
  consistencyProof,
  consistencyProofFromFrontier,
  fromHex,
  merkleEmptyRoot,
  merkleNode,
  merklePeaks,
  merkleProof,
  merkleRoot,
  merkleRootFromFrontier,
  merkleVerify,
  sha256,
  toHex,
  utf8,
  verifyConsistency,
} from "../src/index.ts";
import consistencyV from "../vectors/consistency.json";

const h = fromHex;
const MAX = 70;
const leaves = Array.from({ length: MAX }, (_, i) => sha256(utf8(`leaf ${i}`)));

/**
 * Independent reference: the tree built level by level, an odd node carried up unchanged. It
 * is the same tree as RFC 6962's largest-power-of-two split, built a different way.
 */
function naiveRoot(ls: readonly Uint8Array[]): Uint8Array {
  if (ls.length === 0) return merkleEmptyRoot();
  let level = [...ls];
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const r = level[i + 1];
      next.push(r ? merkleNode(level[i] as Uint8Array, r) : (level[i] as Uint8Array));
    }
    level = next;
  }
  return level[0] as Uint8Array;
}
const roots = Array.from({ length: MAX + 1 }, (_, n) => naiveRoot(leaves.slice(0, n)));
const flip = (b: Uint8Array) => {
  const c = new Uint8Array(b);
  c[0] = (c[0] as number) ^ 1;
  return c;
};

describe("roots and inclusion against the level-by-level reference", () => {
  test("every root, every peak fold and every audit path for n ≤ 70", () => {
    for (let n = 0; n <= MAX; n++) {
      const ls = leaves.slice(0, n);
      expect(toHex(merkleRoot(ls))).toBe(toHex(roots[n] as Uint8Array));
      expect(toHex(merkleRootFromFrontier(0, [], ls))).toBe(toHex(roots[n] as Uint8Array));
      const peaks = merklePeaks(ls);
      expect(peaks.length).toBe(n.toString(2).replace(/0/g, "").length);
      for (let i = 0; i < n; i++) {
        const p = merkleProof(ls, i);
        const root = roots[n] as Uint8Array;
        expect(merkleVerify(ls[i] as Uint8Array, i, n, p, root)).toBe(true);
        expect(merkleVerify(flip(ls[i] as Uint8Array), i, n, p, root)).toBe(false);
        if (n > 1) expect(merkleVerify(ls[i] as Uint8Array, (i + 1) % n, n, p, root)).toBe(false);
        if (p.length) expect(merkleVerify(ls[i] as Uint8Array, i, n, p.slice(1), root)).toBe(false);
      }
    }
  });
});

describe("consistency proofs (RFC 9162 2.1.4)", () => {
  test("for all 0 < m ≤ n ≤ 70 the proof verifies, the frontier prover agrees, and tampering fails", () => {
    for (let n = 1; n <= MAX; n++) {
      for (let m = 1; m <= n; m++) {
        const full = consistencyProof(leaves.slice(0, n), m);
        const peaks = merklePeaks(leaves.slice(0, m));
        const fromFrontier = consistencyProofFromFrontier(m, peaks, leaves.slice(m, n));
        expect(fromFrontier.map(toHex)).toEqual(full.map(toHex));
        expect(toHex(merkleRootFromFrontier(m, peaks, leaves.slice(m, n)))).toBe(
          toHex(roots[n] as Uint8Array),
        );

        const oldRoot = roots[m] as Uint8Array;
        const newRoot = roots[n] as Uint8Array;
        expect(verifyConsistency(m, n, oldRoot, newRoot, full)).toBe(true);
        expect(verifyConsistency(m, n, flip(oldRoot), newRoot, full)).toBe(false);
        expect(verifyConsistency(m, n, oldRoot, flip(newRoot), full)).toBe(false);
        if (m < n) {
          expect(verifyConsistency(m, n, oldRoot, newRoot, full.slice(0, -1))).toBe(false);
          expect(verifyConsistency(m, n, oldRoot, newRoot, [...full, oldRoot])).toBe(false);
          for (let i = 0; i < full.length; i++) {
            const bad = full.map((x, j) => (j === i ? flip(x) : x));
            expect(verifyConsistency(m, n, oldRoot, newRoot, bad)).toBe(false);
          }
        }
      }
    }
  });

  test("a log whose old part was rewritten is not consistent with the old root", () => {
    for (const [m, n] of [
      [3, 7],
      [8, 13],
      [13, 70],
    ] as const) {
      const rewritten = leaves.slice(0, n).map((l, i) => (i === m - 1 ? flip(l) : l));
      const proof = consistencyProof(rewritten, m);
      expect(verifyConsistency(m, n, roots[m] as Uint8Array, merkleRoot(rewritten), proof)).toBe(false);
    }
  });

  test("size 0 is a prefix of every log; m > n and a wrong peak count are refused", () => {
    expect(verifyConsistency(0, 9, merkleEmptyRoot(), roots[9] as Uint8Array, [])).toBe(true);
    expect(verifyConsistency(0, 9, roots[1] as Uint8Array, roots[9] as Uint8Array, [])).toBe(false);
    expect(verifyConsistency(5, 4, roots[5] as Uint8Array, roots[4] as Uint8Array, [])).toBe(false);
    expect(() => consistencyProofFromFrontier(5, merklePeaks(leaves.slice(0, 4)), [])).toThrow("peaks");
    expect(() => consistencyProof(leaves.slice(0, 3), 4)).toThrow();
  });

  test("the golden proofs match", () => {
    const ls = consistencyV.leaves.map(h);
    for (const c of consistencyV.proofs) {
      expect(toHex(merkleRoot(ls.slice(0, c.m)))).toBe(c.oldRoot);
      expect(toHex(merkleRoot(ls.slice(0, c.n)))).toBe(c.newRoot);
      expect(merklePeaks(ls.slice(0, c.m)).map(toHex)).toEqual(c.peaks);
      expect(consistencyProof(ls.slice(0, c.n), c.m).map(toHex)).toEqual(c.proof);
      expect(consistencyProofFromFrontier(c.m, c.peaks.map(h), ls.slice(c.m, c.n)).map(toHex)).toEqual(
        c.proof,
      );
      expect(verifyConsistency(c.m, c.n, h(c.oldRoot), h(c.newRoot), c.proof.map(h))).toBe(true);
    }
  });
});
