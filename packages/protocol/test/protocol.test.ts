import { describe, expect, test } from "bun:test";
import { createHmac, hkdfSync } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  batchClientDataHash,
  batchHash,
  beaconTag,
  beaconToken,
  boxPublicKey,
  buildRing,
  decodeBatch,
  decodeBatchEnvelope,
  decodeLogEntry,
  decodePlayerKeys,
  decodeSignedVerdict,
  decodeVerdict,
  derivePlayerKey,
  deriveTagKey,
  encodeBatch,
  encodeLogEntry,
  encodeSignedVerdict,
  enrollClientDataHash,
  epochAt,
  fromHex,
  HintKind,
  hintPrice,
  hudDigest,
  isLowOrderX25519,
  merkleLeaf,
  merkleProof,
  merkleRoot,
  merkleVerify,
  open,
  playersHash,
  replayDigest,
  requestDigest,
  resolveToken,
  ringCommit,
  seal,
  sealWith,
  signVerdict,
  tagMatches,
  toHex,
  tokenToUuid,
  utf8,
  uuidToToken,
  verdictChainBreak,
  verdictDigest,
  verifySignedVerdict,
} from "../src/index.ts";
import authV from "../vectors/auth.json";
import batchV from "../vectors/batch.json";
import beaconV from "../vectors/beacon.json";
import merkleV from "../vectors/merkle.json";
import ringV from "../vectors/ring.json";
import sealV from "../vectors/seal.json";
import verdictsV from "../vectors/verdicts.json";

const h = fromHex;

describe("beacon", () => {
  const km = h(beaconV.K_m);
  const kTag = deriveTagKey(km);
  const kp = [0, 1, 2].map((i) => derivePlayerKey(km, i));

  test("key derivation matches the vectors and an independent HKDF", () => {
    expect(toHex(kTag)).toBe(beaconV.K_tag);
    for (const [i, k] of kp.entries()) expect(toHex(k)).toBe(beaconV.K_p[i] as string);
    const independent = new Uint8Array(hkdfSync("sha256", km, new Uint8Array(0), utf8("tail/tag"), 32));
    expect(toHex(independent)).toBe(beaconV.K_tag);
  });

  test("tokens match the vectors and an independent HMAC", () => {
    for (const t of beaconV.tokens) {
      const token = beaconToken(kTag, kp[t.player] as Uint8Array, t.epoch);
      expect(toHex(token)).toBe(t.token);
      expect(tokenToUuid(token)).toBe(t.uuid);
      const e = Buffer.alloc(4);
      e.writeUInt32LE(t.epoch);
      const tag = createHmac("sha256", kTag)
        .update(Buffer.concat([Buffer.from("tag"), e]))
        .digest()
        .subarray(0, 4);
      expect(toHex(tag)).toBe(t.tag);
      expect(toHex(uuidToToken(t.uuid))).toBe(t.token);
    }
  });

  test("the tag filter accepts e-1..e+1 of this match and rejects other epochs and matches", () => {
    const token = beaconToken(kTag, kp[1] as Uint8Array, 100);
    for (const e of [99, 100, 101]) expect(tagMatches(kTag, token, e)).toBe(true);
    expect(tagMatches(kTag, token, 103)).toBe(false);
    expect(tagMatches(deriveTagKey(h("00".repeat(32))), token, 100)).toBe(false);
  });

  test("the enclave resolves a token to its player, and an altered token to nobody", () => {
    const token = beaconToken(kTag, kp[2] as Uint8Array, 55);
    expect(resolveToken(kp, kTag, token, 55)).toBe(2);
    expect(resolveToken(kp, kTag, token, 56)).toBeUndefined();
    token[15] = (token[15] as number) ^ 1;
    expect(resolveToken(kp, kTag, token, 55)).toBeUndefined();
  });

  test("epochs count from match start", () => {
    expect(epochAt(1_000, 1_000)).toBe(0);
    expect(epochAt(1_000 + 14_999, 1_000)).toBe(0);
    expect(epochAt(1_000 + 15_000, 1_000)).toBe(1);
    expect(() => epochAt(999, 1_000)).toThrow();
    expect(toHex(beaconTag(kTag, 0))).toBe(beaconV.tokens[0]?.tag as string);
  });
});

describe("batch", () => {
  const b = decodeBatch(h(batchV.borsh));

  test("decode → encode is byte-exact and hashes match the vectors", () => {
    expect(toHex(encodeBatch(b))).toBe(batchV.borsh);
    expect(toHex(batchHash(b))).toBe(batchV.hash);
    expect(toHex(batchClientDataHash(b))).toBe(batchV.clientDataHash);
    expect(b.actions[0]).toEqual({ kind: "Hint", hint: 1, nonce: 42, text: "warmer? 🧊" });
    expect(b.actions[1]).toEqual({ kind: "Hint", hint: 0, nonce: 43 });
    expect(b.sightings[0]?.rssiMed).toBe(-128);
  });

  test("envelope round-trips and trailing bytes are rejected", () => {
    const env = decodeBatchEnvelope(h(batchV.envelope.borsh));
    expect(toHex(env.assertion)).toBe(batchV.envelope.assertion);
    expect(() => decodeBatch(h(`${batchV.borsh}00`))).toThrow("trailing");
    expect(() => decodeBatch(h(batchV.borsh).slice(0, 40))).toThrow();
  });

  test("enrolment binding matches the vector", () => {
    const e = batchV.enroll;
    expect(toHex(enrollClientDataHash(h(e.challenge), e.accountId, h(e.playerBoxPk), h(e.nearPk)))).toBe(
      e.clientDataHash,
    );
  });
});

describe("verdicts", () => {
  const pk = h(verdictsV.refereePk);
  const chain = verdictsV.verdicts.map((v) => decodeSignedVerdict(h(v.signed)));

  test("every verdict decodes, digests and verifies against the referee key", () => {
    for (const [i, v] of verdictsV.verdicts.entries()) {
      const sv = chain[i] as ReturnType<typeof decodeSignedVerdict>;
      expect(sv.seq).toBe(v.seq);
      expect(toHex(verdictDigest(sv))).toBe(v.digest);
      expect(ed25519.verify(sv.sig, verdictDigest(sv), pk)).toBe(true);
      expect(verifySignedVerdict(sv, pk)).toBe(true);
      expect(toHex(sv.sig)).toBe(v.sig);
      expect(toHex(encodeSignedVerdict(sv))).toBe(v.signed);
    }
  });

  test("each verdict's prev is the previous verdict's digest, zeros for the first", () => {
    expect(verdictsV.verdicts[0]?.prev).toBe("00".repeat(32));
    for (let i = 1; i < chain.length; i++)
      expect(toHex(chain[i]?.prev as Uint8Array)).toBe(verdictsV.verdicts[i - 1]?.digest as string);
    expect(verdictChainBreak(chain, pk)).toBeUndefined();
  });

  test("a fork, a gap or a foreign signature breaks the chain where it happens", () => {
    const sk = h(verdictsV.refereeSeed);
    const [first, second, third] = chain as [
      (typeof chain)[0],
      (typeof chain)[0],
      (typeof chain)[0],
      ...(typeof chain)[0][],
    ];
    // A second, validly signed verdict for seq 2 that does not chain to seq 1.
    const fork = signVerdict({ ...second, prev: verdictDigest({ ...first, seq: 9 }) }, sk);
    expect(verdictChainBreak([first, fork, third], pk)).toBe(1);
    expect(verdictChainBreak([first, third], pk)).toBe(1);
    const foreign = signVerdict(first, h("11".repeat(32)));
    expect(verdictChainBreak([foreign], pk)).toBe(0);
  });

  test("a verdict with any changed field no longer verifies", () => {
    const sv = chain[2] as (typeof chain)[0];
    expect(sv.body).toEqual({ kind: "Tag", hunter: 2, target: 0 });
    const swapped = { ...sv, body: { kind: "Tag" as const, hunter: 0, target: 2 } };
    expect(verifySignedVerdict(swapped, pk)).toBe(false);
    expect(verifySignedVerdict({ ...sv, seq: sv.seq + 1 }, pk)).toBe(false);
    expect(verifySignedVerdict({ ...sv, prev: new Uint8Array(32) }, pk)).toBe(false);
  });

  test("a hint verdict carries its kind, and the price follows from it", () => {
    const hint = chain[1]?.body;
    expect(hint).toEqual({ kind: "Hint", from: 0, to: 1, amount: 20_000n, hintId: 3, hint: HintKind.Near });
    if (hint?.kind === "Hint") expect(hint.amount).toBe(hintPrice(1_000_000n, hint.hint as HintKind));
  });

  test("unknown verdict tags are rejected", () => {
    expect(() => decodeVerdict(Uint8Array.of(9))).toThrow("unknown Verdict tag");
  });
});

describe("merkle", () => {
  const leaves = merkleV.entries.map((e) => merkleLeaf(decodeLogEntry(h(e.borsh))));

  test("entries round-trip and leaves match", () => {
    merkleV.entries.forEach((e, i) => {
      expect(toHex(encodeLogEntry(decodeLogEntry(h(e.borsh))))).toBe(e.borsh);
      expect(toHex(leaves[i] as Uint8Array)).toBe(merkleV.leaves[i] as string);
    });
  });

  test("roots for every size 0..n match the vectors", () => {
    for (const r of merkleV.roots) expect(toHex(merkleRoot(leaves.slice(0, r.size)))).toBe(r.root);
  });

  test("every proof verifies; a proof for the wrong leaf or index does not", () => {
    const root = merkleRoot(leaves);
    for (const p of merkleV.proofs) {
      const proof = p.proof.map(h);
      expect(proof.map(toHex)).toEqual(merkleProof(leaves, p.index).map(toHex));
      expect(merkleVerify(leaves[p.index] as Uint8Array, p.index, p.size, proof, root)).toBe(true);
      expect(merkleVerify(leaves[(p.index + 1) % p.size] as Uint8Array, p.index, p.size, proof, root)).toBe(
        false,
      );
    }
    expect(merkleVerify(leaves[0] as Uint8Array, 1, leaves.length, merkleProof(leaves, 0), root)).toBe(false);
  });
});

describe("ring", () => {
  test("players hash, commitment and ring match the vectors", () => {
    expect(toHex(playersHash(ringV.accounts))).toBe(ringV.playersHash);
    expect(toHex(ringCommit(h(ringV.vrfSignature)))).toBe(ringV.ringCommit);
    expect(buildRing(ringV.accounts, h(ringV.vrfSignature))).toEqual(ringV.ring);
  });

  test("the ring does not depend on input order and is a permutation", () => {
    const shuffled = [...ringV.accounts].reverse();
    expect(buildRing(shuffled, h(ringV.vrfSignature))).toEqual(ringV.ring);
    expect([...ringV.ring].sort()).toEqual([...ringV.accounts].sort());
  });
});

describe("sealing", () => {
  const sk = h(sealV.recipientSk);

  test("sealing with a fixed ephemeral key matches the vector, and opens", () => {
    const sealed = sealWith(h(sealV.ephSk), boxPublicKey(sk), h(sealV.plaintext), sealV.context);
    expect(toHex(sealed)).toBe(sealV.sealed);
    expect(toHex(open(sk, sealed, sealV.context))).toBe(sealV.plaintext);
    expect(decodePlayerKeys(open(sk, sealed, sealV.context)).target).toBe("alice.tail.testnet");
  });

  test("a sealed message does not open under another context, key, or after tampering", () => {
    const sealed = seal(boxPublicKey(sk), utf8("hi"), "tail/hud/v2");
    expect(() => open(sk, sealed, "tail/batch")).toThrow();
    expect(() => open(h("11".repeat(32)), sealed, "tail/hud/v2")).toThrow();
    sealed[40] = (sealed[40] as number) ^ 1;
    expect(() => open(sk, sealed, "tail/hud/v2")).toThrow();
  });

  test("every low-order key is refused, to seal to and as a sender's ephemeral key", () => {
    expect(sealV.lowOrder).toHaveLength(14);
    const sealed = h(sealV.sealed);
    for (const k of sealV.lowOrder) {
      expect(isLowOrderX25519(h(k))).toBe(true);
      expect(() => sealWith(h(sealV.ephSk), h(k), utf8("x"), "c")).toThrow("low-order");
      const forged = new Uint8Array(sealed);
      forged.set(h(k), 0);
      expect(() => open(sk, forged, sealV.context)).toThrow("low-order");
    }
    expect(isLowOrderX25519(h(sealV.recipientPk))).toBe(false);
    expect(isLowOrderX25519(boxPublicKey(h(sealV.ephSk)))).toBe(false);
  });
});

test("hint price is basis points of the stake, rounded down", () => {
  expect(hintPrice(1_000_000n, HintKind.Bearing)).toBe(50_000n);
  expect(hintPrice(1_000_000n, HintKind.Near)).toBe(20_000n);
  expect(hintPrice(49n, HintKind.Near)).toBe(0n);
});

describe("relay auth", () => {
  const r = { ...authV.request, body: h(authV.request.body) };

  test("request, HUD and replay digests match the vectors", () => {
    expect(toHex(requestDigest(r))).toBe(r.digest);
    const { hud, replay } = authV;
    expect(toHex(hudDigest(h(hud.nonce), h(hud.matchId), hud.accountId))).toBe(hud.digest);
    expect(toHex(replayDigest(h(replay.nonce), h(replay.matchId), replay.accountId))).toBe(replay.digest);
  });

  test("a request signature is bound to its account and contract", () => {
    expect(toHex(requestDigest({ ...r, accountId: "bob.tail.testnet" }))).not.toBe(r.digest);
    expect(toHex(requestDigest({ ...r, contractId: "tail.testnet" }))).not.toBe(r.digest);
    // The two strings are length-prefixed, so moving bytes from one to the other changes the digest.
    expect(
      toHex(requestDigest({ ...r, contractId: `${r.contractId}a`, accountId: r.accountId.slice(1) })),
    ).not.toBe(r.digest);
  });

  test("the HUD and replay challenges never collide, and the method is case-insensitive", () => {
    const { hud } = authV;
    expect(toHex(replayDigest(h(hud.nonce), h(hud.matchId), hud.accountId))).not.toBe(hud.digest);
    expect(toHex(requestDigest({ ...r, method: "POST" }))).toBe(r.digest);
    expect(toHex(requestDigest({ ...r, method: "PUT" }))).not.toBe(r.digest);
  });
});
