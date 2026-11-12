import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { x25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import {
  BATCH_MS,
  batchClientDataHash,
  batchHash,
  beaconToken,
  decodeBatchEnvelope,
  derivePlayerKey,
  deriveTagKey,
  HintKind,
  open,
  sha256,
  tokenToUuid,
} from "@tail/protocol";
import { AssertionError, credentialKey, signAssertion, verifyAssertion } from "../../test/appattest";
import { fromB64 } from "../lib/b64";
import { ActionQueue } from "./actions";
import { type Assert, BatchBuilder, type ChainState, genesis, type OutboxItem } from "./batch";
import { FixCollector } from "./fixes";
import { SightingAggregator } from "./sightings";

const APP_ID = "LKABS9RZAC.com.lkabs9rzac.tail";
const START = 1_800_000_000_000;
const km = sha256(new TextEncoder().encode("test K_m"));
const kTag = deriveTagKey(km);

/** A stand-in Secure Enclave: a P-256 key and Apple's assertion format, counter from 1. */
function enclave() {
  const sk = p256.utils.randomSecretKey();
  let counter = 0;
  const assert: Assert = async (cdh) => signAssertion(sk, cdh, APP_ID, ++counter);
  return { pk: p256.getPublicKey(sk, false), assert };
}

function rig(assert: Assert) {
  const refereeSk = x25519.utils.randomSecretKey();
  let now = START + 20_000;
  const fixes = new FixCollector();
  const sightings = new SightingAggregator(kTag);
  const actions = new ActionQueue(() => 7);
  const committed: { item: OutboxItem; chain: ChainState }[] = [];
  const builder = new BatchBuilder({
    matchId: new Uint8Array(16).fill(9),
    player: 2,
    refereeBoxPk: x25519.getPublicKey(refereeSk),
    chain: genesis(),
    fixes,
    sightings,
    actions,
    assert,
    commit: (item, chain) => committed.push({ item, chain }),
    now: () => now,
  });
  const openEnvelope = (sealed: Uint8Array) => decodeBatchEnvelope(open(refereeSk, sealed, "tail/batch"));
  return {
    builder,
    fixes,
    sightings,
    actions,
    committed,
    openEnvelope,
    advance: (ms: number) => {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

describe("batch path, phone to referee", () => {
  test("two batches open with the referee box key, chain by hash, and carry valid App Attest assertions", async () => {
    const dev = enclave();
    const r = rig(dev.assert);
    const peer = tokenToUuid(beaconToken(kTag, derivePlayerKey(km, 1), 1));
    r.fixes.add({
      tMs: r.now - 500,
      lat: 42.355,
      lon: -71.0656,
      acc: 6.2,
      speed: 1.3,
      course: 90,
      simulated: false,
      accessory: false,
    });
    r.sightings.add(1, peer, -60);
    r.sightings.add(1, peer, -70);
    r.actions.hint(HintKind.Bearing, "where?");
    await r.builder.build();
    r.advance(BATCH_MS);
    r.sightings.add(1, peer, -65);
    r.actions.strike();
    await r.builder.build();

    expect(r.committed.map((c) => c.item.seq)).toEqual([0, 1]);
    const [a, b] = r.committed.map((c) => r.openEnvelope(c.item.sealed));
    if (!a || !b) throw new Error("missing batch");

    expect(a.batch.seq).toBe(0);
    expect(a.batch.prev).toEqual(new Uint8Array(32));
    expect(b.batch.prev).toEqual(batchHash(a.batch));
    expect(r.committed[1]?.chain).toEqual({ seq: 2, prev: batchHash(b.batch) });

    expect(a.batch.fixes).toEqual([
      {
        tMs: BigInt(START + 19_500),
        latE7: 423_550_000,
        lonE7: -710_656_000,
        accM: 7,
        speedCmps: 130,
        flags: 0,
      },
    ]);
    expect(a.batch.sightings).toEqual([
      { epoch: 1, token: expect.any(Uint8Array), rssiMax: -60, rssiMed: -65, n: 2 },
    ]);
    expect(a.batch.actions).toEqual([{ kind: "Hint", hint: HintKind.Bearing, nonce: 7, text: "where?" }]);
    expect(b.batch.actions).toEqual([{ kind: "Strike", nonce: 7 }]);
    expect(b.batch.tMs - a.batch.tMs).toBe(BigInt(BATCH_MS));

    // The referee's checks (crates/appattest): signature over the nonce, rpIdHash, counter.
    const c1 = verifyAssertion(dev.pk, a.assertion, batchClientDataHash(a.batch), APP_ID, 0);
    const c2 = verifyAssertion(dev.pk, b.assertion, batchClientDataHash(b.batch), APP_ID, c1);
    expect([c1, c2]).toEqual([1, 2]);
  });

  test("an assertion does not verify for an altered batch, another app, or a replayed counter", async () => {
    const dev = enclave();
    const r = rig(dev.assert);
    await r.builder.build();
    const env = r.openEnvelope((r.committed[0] as { item: OutboxItem }).item.sealed);
    const altered = { ...env.batch, player: 3 };
    expect(() => verifyAssertion(dev.pk, env.assertion, batchClientDataHash(altered), APP_ID, 0)).toThrow(
      new AssertionError("Signature"),
    );
    expect(() =>
      verifyAssertion(dev.pk, env.assertion, batchClientDataHash(env.batch), "X.other.app", 0),
    ).toThrow(new AssertionError("RpId"));
    expect(() => verifyAssertion(dev.pk, env.assertion, batchClientDataHash(env.batch), APP_ID, 1)).toThrow(
      new AssertionError("Counter"),
    );
  });

  test("a sealed batch does not open as a HUD or with another key", async () => {
    const r = rig(enclave().assert);
    await r.builder.build();
    const sealed = (r.committed[0] as { item: OutboxItem }).item.sealed;
    expect(() => r.openEnvelope(sealed.slice(0, -1))).toThrow();
    expect(() => open(x25519.utils.randomSecretKey(), sealed, "tail/batch")).toThrow();
  });

  test("a failed assertion consumes no seq and its data goes out with the next batch", async () => {
    const dev = enclave();
    let fail = true;
    const r = rig(async (cdh) => {
      if (fail) throw new Error("App Attest busy");
      return dev.assert(cdh);
    });
    r.actions.strike();
    await expect(r.builder.build()).rejects.toThrow("App Attest busy");
    expect(r.committed).toHaveLength(0);
    expect(r.builder.chain.seq).toBe(0);
    fail = false;
    r.actions.hint(HintKind.Near);
    await r.builder.build();
    const env = r.openEnvelope((r.committed[0] as { item: OutboxItem }).item.sealed);
    expect(env.batch.seq).toBe(0);
    expect(env.batch.actions.map((a) => a.kind)).toEqual(["Strike", "Hint"]);
  });

  test("concurrent build calls produce contiguous seqs in call order", async () => {
    const r = rig(enclave().assert);
    await Promise.all([r.builder.build(), r.builder.build(), r.builder.build()]);
    expect(r.committed.map((c) => c.item.seq)).toEqual([0, 1, 2]);
    const envs = r.committed.map((c) => r.openEnvelope(c.item.sealed));
    expect(envs[2]?.batch.prev).toEqual(
      batchHash((envs[1] as { batch: Parameters<typeof batchHash>[0] }).batch),
    );
  });
});

describe("the assertion checks match Apple's real format", () => {
  // The S3 spike's tail-attest run: an iPhone 17 Pro signed two raw 32-byte clientDataHashes.
  const vector = JSON.parse(
    readFileSync(
      new URL("../../../../crates/appattest/tests/data/s3-tail-attest.json", import.meta.url),
      "utf8",
    ),
  ) as {
    appId: string;
    keyId: string;
    attestation: string;
    assertions: { clientDataHash: string; object: string }[];
  };
  const key = credentialKey(fromB64(vector.attestation), fromB64(vector.keyId));

  test("both real iPhone assertions verify with the same checks, with increasing counters", () => {
    let counter = 0;
    for (const a of vector.assertions) {
      counter = verifyAssertion(key, fromB64(a.object), fromB64(a.clientDataHash), vector.appId, counter);
    }
    expect(counter).toBe(vector.assertions.length);
  });

  test("a real assertion is refused for another clientDataHash", () => {
    const a = vector.assertions[0] as { clientDataHash: string; object: string };
    expect(() => verifyAssertion(key, fromB64(a.object), new Uint8Array(32), vector.appId, 0)).toThrow(
      new AssertionError("Signature"),
    );
  });
});
