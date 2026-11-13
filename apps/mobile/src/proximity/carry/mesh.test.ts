import { describe, expect, test } from "bun:test";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { encodeCarryAck, openCarry, sealCarry, signCarryAck, toHex, utf8 } from "@tail/protocol";
import type { CarryReply, SignedRequest } from "../relay";
import {
  carryEnvelope,
  decodeMeshMessage,
  encodeMeshMessage,
  envelopeDigest,
  MeshCarry,
  type MeshLink,
  meshProfile,
} from "./mesh";

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

// The relay's carry keys, and its POST /carry: open, sign the receipt over the envelope.
const boxSk = x25519.utils.randomSecretKey();
const ackSk = ed25519.utils.randomSecretKey();
const key = { boxPk: x25519.getPublicKey(boxSk), ackPk: ed25519.getPublicKey(ackSk) };
const relayCarry =
  (seen: Uint8Array[]) =>
  async (envelope: Uint8Array): Promise<CarryReply> => {
    seen.push(envelope);
    openCarry(boxSk, envelope);
    const ack = signCarryAck(ackSk, envelope, 200, 42n);
    return { ack, ackBytes: encodeCarryAck(ack), hud: Uint8Array.of(7, 7) };
  };

/** Bluetooth between named phones: each one's link delivers to the others it is linked with. */
function air() {
  const phones = new Map<string, Parameters<MeshLink["start"]>[0]>();
  const log: { from: string; to: string; content: string }[] = [];
  const link = (me: string): MeshLink => ({
    start: async (on) => {
      phones.set(me, on);
      for (const [other, them] of phones) {
        if (other === me) continue;
        on.neighbour(other);
        them.neighbour(me);
      }
    },
    send: async (to, content) => {
      log.push({ from: me, to, content });
      phones.get(to)?.message(me, content);
    },
    stop: async () => {
      phones.delete(me);
    },
  });
  return { link, log };
}

const request = (account: string): SignedRequest => ({
  method: "POST",
  path: "/batch",
  signedPath: "/batch",
  body: JSON.stringify({ match_id: "ab".repeat(16), sealed: "AQID" }),
  account,
  timeMs: 1_800_000_000_000,
  sig: new Uint8Array(64).fill(1),
});

function phone(a: ReturnType<typeof air>, name: string, online: boolean, forwarded: Uint8Array[] = []) {
  const delivered: { digest: Uint8Array; hud: Uint8Array | null }[] = [];
  const m = new MeshCarry({
    link: a.link(name),
    key,
    online: () => online,
    forward: relayCarry(forwarded),
    delivered: (d) => delivered.push({ digest: d.digest, hud: d.hud }),
    onChange: () => {},
  });
  return { m, delivered, forwarded };
}

describe("mesh carry", () => {
  test("an envelope is a fixed-size ciphertext with no account, path or match id in it", () => {
    const env = carryEnvelope(key.boxPk, request("alice.tail.testnet"));
    expect(env.length).toBe(32 + 4096 + 16);
    const hex = toHex(env);
    for (const plain of ["alice.tail.testnet", "/batch", "ab".repeat(16)])
      expect(hex.includes(toHex(utf8(plain)))).toBe(false);
    expect(openCarry(boxSk, env).account).toBe("alice.tail.testnet");
    expect(meshProfile(new Uint8Array(16).fill(0xab))).not.toContain("ab".repeat(16));
  });

  test("an online phone posts the envelope unchanged and sends the relay's answer back to the sender", async () => {
    const a = air();
    const forwarder = phone(a, "off1fwd", true);
    const sender = phone(a, "off1me", false);
    await forwarder.m.start();
    await sender.m.start();
    const env = carryEnvelope(key.boxPk, request("alice.tail.testnet"));
    sender.m.send(env);
    await flush();
    expect(forwarder.forwarded).toEqual([env]);
    expect(sender.delivered).toEqual([{ digest: envelopeDigest(env), hud: Uint8Array.of(7, 7) }]);
    expect(sender.m.status).toMatchObject({ kind: "on", carried: 1 });
    expect(forwarder.m.status).toMatchObject({ kind: "on", forwarded: 1 });
  });

  test("an envelope heard twice is posted once; an offline phone forwards nothing", async () => {
    const a = air();
    const forwarder = phone(a, "off1fwd", true);
    const dark = phone(a, "off1dark", false);
    await forwarder.m.start();
    await dark.m.start();
    const env = sealCarry(key.boxPk, {
      account: "x",
      timeMs: 1n,
      method: "POST",
      path: "/batch",
      body: new Uint8Array(0),
      sig: new Uint8Array(64),
    });
    const msg = encodeMeshMessage({ kind: "request", envelope: env });
    await a.link("off1a").send("off1fwd", msg);
    await a.link("off1b").send("off1fwd", msg);
    await a.link("off1a").send("off1dark", msg);
    await flush();
    expect(forwarder.forwarded).toHaveLength(1);
    expect(dark.forwarded).toHaveLength(0);
    expect(a.log.filter((x) => x.from === "off1fwd").map((x) => x.to)).toEqual(["off1a", "off1b"]);
  });

  test("a reply whose receipt the relay did not sign, or for someone else's envelope, delivers nothing", async () => {
    const a = air();
    const sender = phone(a, "off1me", false);
    await sender.m.start();
    const env = carryEnvelope(key.boxPk, request("alice.tail.testnet"));
    sender.m.send(env);
    const forged = signCarryAck(ed25519.utils.randomSecretKey(), env, 200, 1n);
    const reply = (ack: Uint8Array, digest = envelopeDigest(env)) =>
      encodeMeshMessage({ kind: "reply", digest, ack, hud: null });
    await a.link("off1evil").send("off1me", reply(encodeCarryAck(forged)));
    const other = carryEnvelope(key.boxPk, request("bob.tail.testnet"));
    const realForOther = encodeCarryAck(signCarryAck(ackSk, other, 200, 1n));
    await a.link("off1evil").send("off1me", reply(realForOther, envelopeDigest(other)));
    await a.link("off1evil").send("off1me", reply(realForOther));
    expect(sender.delivered).toEqual([]);
    await a.link("off1evil").send("off1me", reply(encodeCarryAck(signCarryAck(ackSk, env, 200, 1n))));
    expect(sender.delivered).toHaveLength(1);
  });

  test("mesh messages hold only the envelope, or a digest, a receipt and a sealed HUD", () => {
    const env = new Uint8Array(4144).fill(2);
    const m = { kind: "reply", digest: envelopeDigest(env), ack: Uint8Array.of(1), hud: null } as const;
    expect(decodeMeshMessage(encodeMeshMessage(m))).toEqual(m);
    expect(Object.keys(JSON.parse(encodeMeshMessage({ kind: "request", envelope: env })))).toEqual([
      "v",
      "e",
    ]);
    expect(decodeMeshMessage("{}")).toBeNull();
    expect(decodeMeshMessage("nope")).toBeNull();
  });
});
