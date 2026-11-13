// A ghost builds what a phone builds: a chained, asserted batch sealed to the referee box key,
// with sightings only of tokens from its own match; it takes only keys the pinned referee signed;
// and it can hand a v2-signed request to the mesh.

import { describe, expect, test } from "bun:test";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import {
  batchClientDataHash,
  batchHash,
  beaconToken,
  boxPublicKey,
  decodeBatchEnvelope,
  derivePlayerKey,
  deriveTagKey,
  equal,
  open,
  openCarry,
  requestDigest,
  sealSignedPlayerKeys,
  signPlayerKeys,
  verifyEd25519,
} from "@tail/protocol";
import { decode } from "cbor-x";
import { Ghost } from "../src/ghosts/ghost.ts";
import { positionAt } from "../src/ghosts/trace.ts";

const km = new Uint8Array(32).fill(3);
const startMs = 1_700_000_000_000;
const refereeSk = new Uint8Array(32).fill(9);
const signingSk = new Uint8Array(32).fill(8);
const trust = { contract: "tail.relay.testnet", refereePk: ed25519.getPublicKey(signingSk) };

function keyed(player: number, signer = signingSk) {
  const g = new Ghost(`ghost-${player}`, "http://relay.invalid", trust);
  const keys = {
    matchId: new Uint8Array(16).fill(1),
    player,
    startMs: BigInt(startMs),
    endMs: BigInt(startMs + 300_000),
    kTag: deriveTagKey(km),
    kPlayer: derivePlayerKey(km, player),
    target: "someone",
  };
  g.setKeys(
    Buffer.from(sealSignedPlayerKeys(boxPublicKey(g.boxSk), signPlayerKeys(keys, signer))).toString("base64"),
  );
  return g;
}

describe("a ghost", () => {
  test("seals a batch the referee box key opens, chained and asserted with its P-256 key", () => {
    const a = keyed(0);
    const b = keyed(1);
    const t = startMs + 20_000;
    a.hear(t, b.token(t), -60);
    a.hear(t + 1000, b.token(t + 1000), -62);
    const first = decodeBatchEnvelope(
      open(refereeSk, a.sealedBatch(t + 2000, boxPublicKey(refereeSk), "TEAM.app"), "tail/batch"),
    );
    const second = decodeBatchEnvelope(
      open(refereeSk, a.sealedBatch(t + 7000, boxPublicKey(refereeSk), "TEAM.app"), "tail/batch"),
    );
    expect(first.batch.seq).toBe(0);
    expect(second.batch.seq).toBe(1);
    expect(equal(second.batch.prev, batchHash(first.batch))).toBe(true);
    expect(first.batch.sightings).toHaveLength(1);
    expect(first.batch.sightings[0]?.n).toBe(2);
    expect(
      equal(
        first.batch.sightings[0]?.token as Uint8Array,
        beaconToken(deriveTagKey(km), derivePlayerKey(km, 1), 1),
      ),
    ).toBe(true);
    const m = decode(first.assertion) as { signature: Uint8Array; authenticatorData: Uint8Array };
    const nonce = new Bun.CryptoHasher("sha256")
      .update(m.authenticatorData)
      .update(batchClientDataHash(first.batch))
      .digest();
    expect(
      p256.verify(new Uint8Array(m.signature), new Uint8Array(nonce), p256.getPublicKey(a.attestSk, false), {
        prehash: true,
        format: "der",
      }),
    ).toBe(true);
  });

  test("ignores a token from another match; keeps one from its own", () => {
    const a = keyed(0);
    const t = startMs + 20_000;
    const stranger = beaconToken(deriveTagKey(new Uint8Array(32).fill(4)), new Uint8Array(32), 1);
    a.hear(t, stranger, -50);
    expect(
      decodeBatchEnvelope(open(refereeSk, a.sealedBatch(t, boxPublicKey(refereeSk), "X.y"), "tail/batch"))
        .batch.sightings,
    ).toHaveLength(0);
    a.hear(t, keyed(2).token(t), -50);
    expect(
      decodeBatchEnvelope(
        open(refereeSk, a.sealedBatch(t + 5000, boxPublicKey(refereeSk), "X.y"), "tail/batch"),
      ).batch.sightings,
    ).toHaveLength(1);
  });
});

describe("a ghost's trust", () => {
  test("takes PlayerKeys only when the pinned referee signed them", () => {
    expect(() => keyed(0, new Uint8Array(32).fill(7))).toThrow("not signed by the referee");
  });

  test("hands the mesh a request sealed to the relay, signed for the relay's contract", () => {
    const g = keyed(0);
    g.accountId = "ghost-0.relay.testnet";
    const relaySk = x25519.utils.randomSecretKey();
    const envelope = g.carried("POST", "/batch", { match_id: "ab".repeat(16) }, x25519.getPublicKey(relaySk));
    const r = openCarry(relaySk, envelope);
    expect(r.account).toBe(g.accountId);
    const digest = requestDigest({
      contractId: trust.contract,
      accountId: r.account,
      method: r.method,
      path: r.path,
      timeMs: Number(r.timeMs),
      body: r.body,
    });
    expect(verifyEd25519(ed25519.getPublicKey(g.nearSeed), digest, r.sig)).toBe(true);
  });
});

describe("a trace path", () => {
  test("interpolates between waypoints and reports the walking speed", () => {
    const p = positionAt(
      [
        [0, -150, 0],
        [45, 0, 0],
      ],
      30,
    );
    expect(p.east).toBeCloseTo(-50);
    expect(p.speed).toBeCloseTo(150 / 45);
    expect(positionAt([[0, 5, 5]], 100)).toEqual({ east: 5, north: 5, speed: 0 });
  });
});
