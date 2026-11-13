// Protocol v2 additions: new log entries, HUD v2, referee-signed sealed messages, presence
// proofs and mesh carry.

import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  boxPublicKey,
  carryAckDigest,
  decodeCarryAck,
  decodeCarryRequest,
  decodeHud,
  decodeLogEntry,
  decodePresenceProof,
  decodeSignedHud,
  decodeSignedPlayerKeys,
  decodeSignedVoiceLine,
  encodeHud,
  encodeLogEntry,
  encodePresenceProof,
  fromHex,
  hudSigDigest,
  keysSigDigest,
  merkleLeaf,
  open,
  openCarry,
  openSignedHud,
  openSignedPlayerKeys,
  openSignedVoiceLine,
  padCarry,
  presenceProof,
  RejectCode,
  requestDigest,
  SealContext,
  sealCarry,
  sealSignedHud,
  signHud,
  TargetStatus,
  toHex,
  unpadCarry,
  verifyCarryAck,
  verifyEd25519,
  verifyPresence,
  voiceSigDigest,
} from "../src/index.ts";
import authV from "../vectors/auth.json";
import carryV from "../vectors/carry.json";
import hudV from "../vectors/hud.json";
import logV from "../vectors/log.json";
import merkleV from "../vectors/merkle.json";
import presenceV from "../vectors/presence.json";

const h = fromHex;

describe("log entries", () => {
  test("v2 entries round-trip and their leaves match", () => {
    for (const e of logV.entries) {
      const entry = decodeLogEntry(h(e.borsh));
      expect(entry.kind as string).toBe(e.entry.kind);
      expect(toHex(encodeLogEntry(entry))).toBe(e.borsh);
      expect(toHex(merkleLeaf(entry))).toBe(e.leaf);
    }
    expect(decodeLogEntry(h(logV.entries[3]?.borsh as string))).toMatchObject({ code: RejectCode.Teleport });
    expect(decodeLogEntry(h(logV.entries[1]?.borsh as string))).toMatchObject({ attested: false });
  });

  test("v1 entries keep their tags and bytes", () => {
    const tags = merkleV.entries.map((e) => e.borsh.slice(0, 2));
    expect(tags).toEqual(["00", "01", "02", "03", "00", "01", "02"]);
    for (const e of merkleV.entries) expect(toHex(encodeLogEntry(decodeLogEntry(h(e.borsh))))).toBe(e.borsh);
  });

  test("an unknown tag, or a bool that is not 0 or 1, is refused", () => {
    expect(() => decodeLogEntry(Uint8Array.of(8))).toThrow("unknown LogEntry tag");
    const enrolled = h(logV.entries[0]?.borsh as string);
    enrolled[enrolled.length - 1] = 2;
    expect(() => decodeLogEntry(enrolled)).toThrow("invalid bool");
  });
});

describe("HUD v2", () => {
  test("with and without optional fields, and for an out player, round-trips", () => {
    const full = decodeHud(h(hudV.hud.borsh));
    expect(full.leak).toEqual({ latE7: 423_551_000, lonE7: -710_651_000 });
    expect(full.rejected).toEqual({ seq: 30, code: RejectCode.ClockSkew });
    expect(full.nextSeq).toBe(34);
    expect(full.logSize).toBe(1234n);
    expect(full.taggedBy).toBeUndefined();
    const bare = decodeHud(h(hudV.hudNoOptions.borsh));
    expect(bare.leak).toBeUndefined();
    expect(bare.hintFact).toBeUndefined();
    expect(bare.rejected).toBeUndefined();
    const out = decodeHud(h(hudV.hudOut.borsh));
    expect(out.status).toBe(TargetStatus.Out);
    expect(out.taggedBy).toBe("carol.tail.testnet");
    for (const v of [hudV.hud, hudV.hudNoOptions, hudV.hudOut])
      expect(toHex(encodeHud(decodeHud(h(v.borsh))))).toBe(v.borsh);
  });
});

describe("referee-signed sealed messages", () => {
  const pk = h(hudV.refereePk);
  const boxSk = h(hudV.recipientSk);
  const [hudS, keysS, voiceS] = hudV.signed as [
    (typeof hudV.signed)[0],
    (typeof hudV.signed)[0],
    (typeof hudV.signed)[0],
  ];

  test("digests, signatures and sealed bytes match the vectors, and open", () => {
    const hud = decodeSignedHud(h(hudS.signed));
    expect(toHex(hudSigDigest(hud.hud))).toBe(hudS.digest);
    expect(toHex(hud.sig)).toBe(hudS.sig);
    const keys = decodeSignedPlayerKeys(h(keysS.signed));
    expect(toHex(keysSigDigest(keys.keys))).toBe(keysS.digest);
    const voice = decodeSignedVoiceLine(h(voiceS.signed));
    expect(toHex(voiceSigDigest(voice.line))).toBe(voiceS.digest);
    for (const s of hudV.signed) expect(verifyEd25519(pk, h(s.digest), h(s.sig))).toBe(true);
    expect(SealContext.hud as string).toBe(hudS.context);

    expect(openSignedHud(boxSk, h(hudS.sealed), pk)).toEqual(hud.hud);
    expect(openSignedPlayerKeys(boxSk, h(keysS.sealed), pk).target).toBe("alice.tail.testnet");
    expect(openSignedVoiceLine(boxSk, h(voiceS.sealed), pk).text).toBe(
      "Your mark drifts east. Mind the café. ☕",
    );
  });

  test("a HUD sealed by someone without the referee key does not open", () => {
    const hud = decodeHud(h(hudV.hud.borsh));
    const forged = sealSignedHud(
      boxPublicKey(boxSk),
      signHud({ ...hud, head: 10n ** 9n }, h("22".repeat(32))),
    );
    expect(() => openSignedHud(boxSk, forged, pk)).toThrow("not signed by the referee");
    // Re-sealing the genuine signature over a changed HUD fails too.
    const resealed = sealSignedHud(boxPublicKey(boxSk), {
      hud: { ...hud, head: 10n ** 9n },
      sig: decodeSignedHud(h(hudS.signed)).sig,
    });
    expect(() => openSignedHud(boxSk, resealed, pk)).toThrow("not signed by the referee");
  });

  test("each kind opens only under its own context", () => {
    expect(() => openSignedHud(boxSk, h(keysS.sealed), pk)).toThrow();
    expect(() => openSignedVoiceLine(boxSk, h(hudS.sealed), pk)).toThrow();
    expect(() => open(boxSk, h(hudS.sealed), "tail/hud")).toThrow();
  });
});

describe("presence proofs", () => {
  const roots = presenceV.roots.map((r) => ({ logSize: BigInt(r.logSize), root: h(r.root) }));
  const proof = decodePresenceProof(h(presenceV.proof.borsh));

  test("the golden proof round-trips and verifies", () => {
    expect(toHex(encodePresenceProof(proof))).toBe(presenceV.proof.borsh);
    expect(verifyPresence(proof, roots, presenceV.players)).toEqual({
      ok: true,
      ...presenceV.expect,
      accounts: ["alice.tail.testnet", "bob.tail.testnet"],
    });
  });

  test("it fails without an anchored root of its size, with a bad path, or with other accounts", () => {
    expect(verifyPresence(proof, roots.slice(0, 1), presenceV.players)).toEqual({
      ok: false,
      why: "no-root",
    });
    const badPath = { ...proof, path: proof.path.map((p, i) => (i === 0 ? new Uint8Array(32) : p)) };
    expect(verifyPresence(badPath, roots, presenceV.players)).toEqual({ ok: false, why: "bad-path" });
    const otherEpoch = { ...proof, entry: { kind: "Contact" as const, a: 0, b: 1, epoch: 4_000_001 } };
    expect(verifyPresence(otherEpoch, roots, presenceV.players)).toEqual({ ok: false, why: "bad-path" });
    const swapped = { ...proof, accounts: ["bob.tail.testnet", "alice.tail.testnet"] as [string, string] };
    expect(verifyPresence(swapped, roots, presenceV.players)).toEqual({ ok: false, why: "wrong-accounts" });
    expect(verifyPresence(proof, roots, ["mallory.testnet"])).toEqual({ ok: false, why: "unknown-player" });
    const notContact = { ...proof, entry: { kind: "Verdict" as const, seq: 1, digest: new Uint8Array(32) } };
    expect(verifyPresence(notContact, roots, presenceV.players)).toEqual({ ok: false, why: "not-contact" });
  });

  test("the builder refuses an entry that is not a Contact, or one outside the anchored size", () => {
    const log = [
      decodeLogEntry(h(merkleV.entries[0]?.borsh as string)),
      decodeLogEntry(h(merkleV.entries[1]?.borsh as string)),
    ];
    const base = { matchId: proof.matchId, contract: proof.contract, log, players: presenceV.players };
    expect(() => presenceProof({ ...base, index: 0, size: 2 })).toThrow("not a Contact");
    expect(() => presenceProof({ ...base, index: 1, size: 1 })).toThrow("outside");
    expect(verifyPresence(presenceProof({ ...base, index: 1, size: 2 }), roots, presenceV.players).ok).toBe(
      false,
    );
  });
});

describe("mesh carry", () => {
  const relayBoxSk = h(carryV.relayBoxSk);
  const relayPk = h(carryV.relayPk);
  const envelope = h(carryV.envelope);

  test("the envelope is fixed-size, opens to the signed request, and the sender's signature holds", () => {
    expect(envelope.length).toBe(32 + 4096 + 16);
    const req = openCarry(relayBoxSk, envelope);
    expect(toHex(req.body)).toBe(carryV.request.input.body);
    expect(req).toEqual(decodeCarryRequest(h(carryV.request.borsh)));
    const digest = requestDigest({
      contractId: carryV.contractId,
      accountId: req.account,
      method: req.method,
      path: req.path,
      timeMs: Number(req.timeMs),
      body: req.body,
    });
    expect(toHex(digest)).toBe(authV.request.digest);
    expect(verifyEd25519(h(carryV.senderPk), digest, req.sig)).toBe(true);
    // A fresh seal of the same request is a different envelope of the same size.
    const again = sealCarry(boxPublicKey(relayBoxSk), req);
    expect(again.length).toBe(envelope.length);
    expect(toHex(again)).not.toBe(carryV.envelope);
  });

  test("padding is strict", () => {
    expect(toHex(padCarry(h(carryV.request.borsh)))).toBe(carryV.request.padded);
    const padded = h(carryV.request.padded);
    padded[4095] = 1;
    expect(() => unpadCarry(padded)).toThrow("padding");
    expect(() => padCarry(new Uint8Array(4093))).toThrow();
    expect(unpadCarry(padCarry(new Uint8Array(4092))).length).toBe(4092);
  });

  test("the relay's ack verifies for this envelope only", () => {
    const ack = decodeCarryAck(h(carryV.ack.borsh));
    expect(toHex(carryAckDigest(envelope, ack.status, ack.receivedMs))).toBe(carryV.ack.digest);
    expect(verifyCarryAck(relayPk, envelope, ack)).toBe(true);
    expect(ed25519.verify(ack.sig, h(carryV.ack.digest), relayPk)).toBe(true);
    expect(verifyCarryAck(relayPk, envelope, { ...ack, status: 500 })).toBe(false);
    const other = new Uint8Array(envelope);
    other[100] = (other[100] as number) ^ 1;
    expect(verifyCarryAck(relayPk, other, ack)).toBe(false);
  });
});
