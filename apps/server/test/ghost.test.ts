// A ghost builds what a phone builds: a chained, asserted batch sealed to the referee box key,
// with sightings only of tokens from its own match.

import { describe, expect, test } from "bun:test";
import { p256 } from "@noble/curves/nist.js";
import {
  batchClientDataHash,
  batchHash,
  beaconToken,
  boxPublicKey,
  decodeBatchEnvelope,
  derivePlayerKey,
  deriveTagKey,
  encodePlayerKeys,
  equal,
  open,
  seal,
} from "@tail/protocol";
import { decode } from "cbor-x";
import { Ghost } from "../src/ghosts/ghost.ts";
import { positionAt } from "../src/ghosts/trace.ts";

const km = new Uint8Array(32).fill(3);
const startMs = 1_700_000_000_000;
const refereeSk = new Uint8Array(32).fill(9);

function keyed(player: number) {
  const g = new Ghost(`ghost-${player}`, "http://relay.invalid");
  const keys = {
    matchId: new Uint8Array(16).fill(1),
    player,
    startMs: BigInt(startMs),
    endMs: BigInt(startMs + 300_000),
    kTag: deriveTagKey(km),
    kPlayer: derivePlayerKey(km, player),
    target: "someone",
  };
  g.setKeys(Buffer.from(seal(boxPublicKey(g.boxSk), encodePlayerKeys(keys), "tail/keys")).toString("base64"));
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
