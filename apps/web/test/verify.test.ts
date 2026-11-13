import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  concat,
  encodeSignedVerdict,
  merkleLeaf,
  merkleRoot,
  type ReplayBundle,
  type ReplayBundleV2,
  type SignedVerdict,
  sha256,
  toHex,
  utf8,
} from "@tail/protocol";
import { makeFixtures } from "../scripts/fixture.ts";
import type { Expect } from "../src/verify/anchor.ts";
import { BundleError, decodeBundle } from "../src/verify/bundle.ts";
import { Frontier, prefixRoots } from "../src/verify/checks.ts";
import { verifyAll } from "../src/verify/index.ts";
import { matchProblem, summarize, summaryLine } from "../src/verify/report.ts";
import { settlementOf } from "../src/verify/settle.ts";
import { chainFor } from "./chain.ts";

// Built in memory, through JSON as the relay would send it: no generated files needed.
const fixture = JSON.stringify(makeFixtures().full);
const clone = () => JSON.parse(fixture) as ReplayBundleV2;
/** The verdict and log checks do not read batches; leaving them out keeps the byte sweeps fast. */
const lean = () => ({ ...clone(), batches: [] });
const SWEEP_MS = 120_000;
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/** The fixture names the pinned contract; with no `?match=` link there is no id to hold it to. */
const EXPECT: Expect = { contract: "tail.tail-dev-a38d13.testnet", network: "testnet", matchId: null };

const good = decodeBundle(clone());
const onChain = chainFor(good);

describe("the fixture verifies", () => {
  test("against a matching chain, every verdict is verified and payouts match", () => {
    const r = verifyAll(good, onChain, EXPECT);
    expect(r.statuses.every((s) => s === "verified")).toBe(true);
    expect(r.level).toEqual({ identity: true, complete: true, ended: true, payouts: true });
    expect(summaryLine(summarize(r.statuses), "found", matchProblem(r.binding, r.level))).toBe(
      `All ${r.statuses.length} verdicts match NEAR`,
    );
  });

  test("with no such match on NEAR, every verdict is signed and logged but unanchored", () => {
    const r = verifyAll(good, { kind: "absent" }, EXPECT);
    expect(r.statuses.every((s) => s === "unanchored")).toBe(true);
    expect(summaryLine(summarize(r.statuses), "absent", null)).toBe("Not on NEAR");
  });

  test("an unreachable chain claims nothing", () => {
    const r = verifyAll(good, { kind: "unreachable", reason: "offline" }, EXPECT);
    expect(r.statuses.every((s) => s === "unanchored")).toBe(true);
    expect(r.anchors.every((a) => a === "unknown")).toBe(true);
  });

  test("every released batch is in the log with an unbroken chain, every Handler line matches", () => {
    const r = verifyAll(good, { kind: "absent" }, EXPECT);
    expect(r.batches.failed).toEqual([]);
    expect(r.batches.verified.size).toBe(good.batches.length);
    expect([...r.handler.values()].every((h) => h.text === null && h.signature === "signed")).toBe(true);
    expect(r.handler.size).toBe(3);
  });

  test("the frontier root equals the full Merkle root at every size", () => {
    const leaves = good.log.slice(0, 70).map((e) => merkleLeaf(e.entry as NonNullable<typeof e.entry>));
    const f = new Frontier();
    for (let i = 0; i < leaves.length; i++) {
      f.push(leaves[i] as Uint8Array);
      expect(toHex(f.root())).toBe(toHex(merkleRoot(leaves.slice(0, i + 1))));
    }
    const roots = prefixRoots(good.leaves.slice(0, 70), [0, 1, 33, 70]);
    expect(toHex(roots.get(33) as Uint8Array)).toBe(toHex(merkleRoot(leaves.slice(0, 33))));
  });
});

// ── Tamper tests: one changed byte must never pass ─────────────────────────────────

const flip = (s: string, i: number) => {
  const b = unb64(s);
  b[i] = (b[i] as number) ^ 0x01;
  return b64(b);
};

describe("one changed byte fails", () => {
  const tagAt = good.verdicts.findIndex((x) => x.v?.body.kind === "Tag");

  test(
    "in a Tag verdict, at every byte position",
    () => {
      const len = (good.verdicts[tagAt]?.bytes.length as number) ?? 0;
      expect(len).toBeGreaterThan(100);
      for (let i = 0; i < len; i++) {
        const b = lean();
        const v = b.verdicts[tagAt] as { signed: string };
        v.signed = flip(v.signed, i);
        const r = verifyAll(decodeBundle(b), onChain, EXPECT);
        expect(r.statuses[tagAt]).toBe("mismatch");
      }
    },
    SWEEP_MS,
  );

  test(
    "in a log entry: every verdict whose anchored root covers it stops matching",
    () => {
      const at = 600;
      const len = good.log[at]?.bytes.length as number;
      const sizes = good.verdicts
        .map((x) => x.v?.body)
        .filter((b) => b?.kind === "Checkpoint" || b?.kind === "End")
        .map((b) => Number((b as { logSize: bigint }).logSize));
      for (let i = 0; i < len; i++) {
        const b = lean();
        b.log[at] = flip(b.log[at] as string, i);
        const r = verifyAll(decodeBundle(b), onChain, EXPECT);
        r.local.forEach((l, k) => {
          const cover =
            l.kind === "End" ? Number.POSITIVE_INFINITY : (sizes.find((s) => s > (l.logIndex ?? 0)) ?? 0);
          expect(r.statuses[k]).toBe(cover > at ? "mismatch" : "verified");
        });
      }
    },
    SWEEP_MS,
  );

  test(
    "in a released batch: its hash no longer matches the log",
    () => {
      const len = good.batches[300]?.bytes.length as number;
      for (let i = 0; i < len; i++) {
        const b = clone();
        b.batches[300] = flip(b.batches[300] as string, i);
        const r = verifyAll(decodeBundle(b), onChain, EXPECT);
        expect(r.batches.verified.size).toBe(good.batches.length - 1);
        expect(r.batches.failed.length).toBe(1);
      }
    },
    SWEEP_MS,
  );

  test("in a Handler line of a v1 replay: the quote no longer matches its receipt", () => {
    const b = JSON.parse(JSON.stringify(makeFixtures().v1)) as ReplayBundle;
    expect(verifyAll(decodeBundle(b), { kind: "absent" }, EXPECT).handler.get(0)?.text).toBe(true);
    const h = b.handler[0] as { text: string };
    h.text = `${h.text.slice(0, -1)}!`;
    expect(verifyAll(decodeBundle(b), onChain, EXPECT).handler.get(0)?.text).toBe(false);
  });

  test("in the VRF reveal: the rebuilt ring is refused", () => {
    const b = clone();
    const sig = b.reveal.vrfSignature;
    b.reveal.vrfSignature = `${sig.slice(0, 10)}${sig[10] === "0" ? "1" : "0"}${sig.slice(11)}`;
    const r = verifyAll(decodeBundle(b), onChain, EXPECT);
    const end = r.local.findIndex((l) => l.kind === "End");
    expect(r.local[end]?.ring?.ringRebuilt).toBe(false);
    expect(r.statuses[end]).toBe("mismatch");
  });

  test("in a root NEAR holds: the verdicts it covers stop matching", () => {
    const chain = structuredClone(onChain);
    const cp = chain.roots.checkpoints[4] as { root: string };
    cp.root = `${cp.root[0] === "0" ? "1" : "0"}${cp.root.slice(1)}`;
    const r = verifyAll(good, chain, EXPECT);
    expect(r.statuses.filter((s) => s === "mismatch").length).toBeGreaterThan(0);
    expect(r.statuses.at(-1)).toBe("verified");
  });

  test("in the referee key NEAR pinned: nothing matches", () => {
    const chain = structuredClone(onChain);
    chain.match.referee_pk = `${chain.match.referee_pk[0] === "0" ? "1" : "0"}${chain.match.referee_pk.slice(1)}`;
    expect(verifyAll(good, chain, EXPECT).statuses.every((s) => s === "mismatch")).toBe(true);
  });

  test("in a payout NEAR made: the payout check fails", () => {
    const chain = structuredClone(onChain);
    const p = chain.match.players.find((x) => x.paid !== "0") as { paid: string };
    p.paid = String(BigInt(p.paid) + 1n);
    expect(verifyAll(good, chain, EXPECT).level?.payouts).toBe(false);
  });

  test("swapping two verdicts breaks their order", () => {
    const b = clone();
    [b.verdicts[2], b.verdicts[3]] = [b.verdicts[3] as never, b.verdicts[2] as never];
    const r = verifyAll(decodeBundle(b), onChain, EXPECT);
    expect(r.local[2]?.order).toBe(false);
    expect(r.statuses[2]).toBe("mismatch");
  });

  test("a Tag re-signed by another key is refused", async () => {
    const { ed25519 } = await import("@noble/curves/ed25519.js");
    const { verdictDigest } = await import("@tail/protocol");
    const v = good.verdicts[tagAt]?.v as SignedVerdict | undefined;
    if (!v) throw new Error("no tag");
    const sk = ed25519.utils.randomSecretKey();
    const body = { ...v, sig: ed25519.sign(verdictDigest(v), sk) };
    const b = clone();
    (b.verdicts[tagAt] as { signed: string }).signed = b64(encodeSignedVerdict(body));
    expect(verifyAll(decodeBundle(b), onChain, EXPECT).statuses[tagAt]).toBe("mismatch");
  });
});

describe("decoding", () => {
  test("rejects a bundle that is not one", () => {
    expect(() => decodeBundle({ version: 2 })).toThrow(BundleError);
    expect(() => decodeBundle(null)).toThrow(BundleError);
  });

  test("keeps an undecodable verdict as null so the page can say so", () => {
    const b = clone();
    (b.verdicts[1] as { signed: string }).signed = "AAAA";
    const d = decodeBundle(b);
    expect(d.verdicts[1]?.v).toBeNull();
    expect(verifyAll(d, onChain, EXPECT).statuses[1]).toBe("mismatch");
  });
});

describe("signatures are strict", () => {
  test("a signature only ZIP-215 accepts (a non-canonical R) fails the verdict and stops the settlement replay", () => {
    // The fixture's public test referee key (scripts/fixture.ts) signs verdict 1 with R the
    // identity point encoded as y = p + 1: noble's permissive default decodes it, RFC 8032 doesn't.
    const sk = sha256(utf8("TAIL replay fixture referee key. Test only, public, never on NEAR."));
    const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(sk);
    const { Fp, Fn } = ed25519.Point;
    const le = (n: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
    const x = good.verdicts[1];
    if (!x?.v || !x.digest) throw new Error("no verdict");
    const r = le(Fp.ORDER + 1n);
    const k = Fn.create(BigInt(`0x${toHex(sha512(concat(r, pointBytes, x.digest)).reverse())}`));
    const sig = concat(r, le(Fn.create(k * scalar)));
    expect(ed25519.verify(sig, x.digest, pointBytes)).toBe(true);
    expect(ed25519.verify(sig, x.digest, pointBytes, { zip215: false })).toBe(false);

    const b = clone();
    (b.verdicts[1] as { signed: string }).signed = b64(
      encodeSignedVerdict({ ...(x.v as SignedVerdict), sig }),
    );
    const d = decodeBundle(b);
    const r2 = verifyAll(d, chainFor(d), EXPECT);
    expect(r2.local[1]?.signature).toBe(false);
    expect(r2.statuses[1]).toBe("mismatch");
    expect(settlementOf(d)).toEqual({ kind: "not-run", why: "unsigned" });
  });
});
