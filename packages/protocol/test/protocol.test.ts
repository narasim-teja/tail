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
  decodeHud,
  decodeLogEntry,
  decodePlayerKeys,
  decodeSignedVerdict,
  decodeVerdict,
  derivePlayerKey,
  deriveTagKey,
  encodeBatch,
  encodeHud,
  encodeLogEntry,
  enrollClientDataHash,
  epochAt,
  fromHex,
  HintKind,
  hintPrice,
  hudDigest,
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
  TargetStatus,
  tagMatches,
  toHex,
  tokenToUuid,
  utf8,
  uuidToToken,
  verdictDigest,
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

  test("every verdict decodes, digests and verifies against the referee key", () => {
    for (const v of verdictsV.verdicts) {
      const sv = decodeSignedVerdict(h(v.signed));
      expect(sv.seq).toBe(v.seq);
      expect(toHex(verdictDigest(sv))).toBe(v.digest);
      expect(ed25519.verify(sv.sig, verdictDigest(sv), pk)).toBe(true);
      expect(toHex(sv.sig)).toBe(v.sig);
    }
  });

  test("a verdict with any changed field no longer verifies", () => {
    const sv = decodeSignedVerdict(h(verdictsV.verdicts[2]?.signed as string));
    expect(sv.body).toEqual({ kind: "Tag", hunter: 2, target: 0 });
    const swapped = { ...sv, body: { kind: "Tag" as const, hunter: 0, target: 2 } };
    expect(ed25519.verify(sv.sig, verdictDigest(swapped), pk)).toBe(false);
    expect(ed25519.verify(sv.sig, verdictDigest({ ...sv, seq: sv.seq + 1 }), pk)).toBe(false);
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
    const sealed = seal(boxPublicKey(sk), utf8("hi"), "tail/hud");
    expect(() => open(sk, sealed, "tail/batch")).toThrow();
    expect(() => open(h("11".repeat(32)), sealed, "tail/hud")).toThrow();
    sealed[40] = (sealed[40] as number) ^ 1;
    expect(() => open(sk, sealed, "tail/hud")).toThrow();
  });

  test("HUD with and without optional fields round-trips", () => {
    const full = decodeHud(h(sealV.hud.borsh));
    expect(full.leak).toEqual({ latE7: 423_551_000, lonE7: -710_651_000 });
    expect(full.head).toBe(1_020_000n);
    const bare = decodeHud(h(sealV.hudNoOptions.borsh));
    expect(bare.leak).toBeUndefined();
    expect(bare.hintFact).toBeUndefined();
    expect(toHex(encodeHud(full))).toBe(sealV.hud.borsh);
    expect(toHex(encodeHud(bare))).toBe(sealV.hudNoOptions.borsh);
  });

  test("an out player's HUD names who took their head", () => {
    const out = decodeHud(h(sealV.hudOut.borsh));
    expect(out.status).toBe(TargetStatus.Out);
    expect(out.taggedBy).toBe("carol.tail.testnet");
    expect(toHex(encodeHud(out))).toBe(sealV.hudOut.borsh);
  });

  test("a HUD of a player still in names no one", () => {
    expect(decodeHud(h(sealV.hud.borsh)).taggedBy).toBeUndefined();
    expect(decodeHud(h(sealV.hudNoOptions.borsh)).taggedBy).toBeUndefined();
  });
});

test("hint price is basis points of the stake, rounded down", () => {
  expect(hintPrice(1_000_000n, HintKind.Bearing)).toBe(50_000n);
  expect(hintPrice(1_000_000n, HintKind.Near)).toBe(20_000n);
  expect(hintPrice(49n, HintKind.Near)).toBe(0n);
});

describe("relay auth", () => {
  test("request, HUD and replay digests match the vectors", () => {
    const r = authV.request;
    expect(toHex(requestDigest(r.method, r.path, r.timeMs, h(r.body)))).toBe(r.digest);
    const { hud, replay } = authV;
    expect(toHex(hudDigest(h(hud.nonce), h(hud.matchId), hud.accountId))).toBe(hud.digest);
    expect(toHex(replayDigest(h(replay.nonce), h(replay.matchId), replay.accountId))).toBe(replay.digest);
  });

  test("the HUD and replay challenges never collide, and the method is case-insensitive", () => {
    const { hud } = authV;
    expect(toHex(replayDigest(h(hud.nonce), h(hud.matchId), hud.accountId))).not.toBe(hud.digest);
    const r = authV.request;
    expect(toHex(requestDigest("POST", r.path, r.timeMs, h(r.body)))).toBe(r.digest);
    expect(toHex(requestDigest("PUT", r.path, r.timeMs, h(r.body)))).not.toBe(r.digest);
  });
});
