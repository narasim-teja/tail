import { describe, expect, test } from "bun:test";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import {
  encodeHud,
  HintKind,
  type Hud,
  RejectCode,
  SealContext,
  sealSignedPlayerKeys,
  sealToPhone,
  signPlayerKeys,
} from "@tail/protocol";
import * as relayAuth from "../../../server/src/auth.ts";
import { hudOf, refereePk, refereeSk, sealedHud } from "../../test/referee";
import { fromB64, toB64 } from "../lib/b64";
import type { Signer } from "./auth";
import { hudAuthFrame, openHud, openPlayerKeys, parseHudMessage } from "./hud";

const sk = x25519.utils.randomSecretKey();
const pk = x25519.getPublicKey(sk);
const seat = { matchId: new Uint8Array(16).fill(4), player: 0 };
const base: Hud = hudOf({ tick: 7, epoch: 30, lock: 2, heat: 1, head: 5_250_000n });
const otherSk = ed25519.utils.randomSecretKey();

describe("opening the referee's word", () => {
  test("a signed, sealed HUD opens with the player box key and reads back field for field", () => {
    const hud: Hud = {
      ...base,
      leak: { latE7: 423_550_000, lonE7: -710_650_000 },
      hintFact: { hintId: 3, hint: HintKind.Near, value: 1 },
      rejected: { seq: 4, code: RejectCode.ClockSkew },
    };
    expect(openHud(sk, sealedHud(pk, hud), refereePk, seat)).toEqual(hud);
  });

  test("a HUD signed by anyone but the match's referee does not open", () => {
    expect(() => openHud(sk, sealedHud(pk, base, otherSk), refereePk, seat)).toThrow("not signed");
  });

  test("a HUD sealed without a signature (what the relay could forge) does not open", () => {
    expect(() => openHud(sk, sealToPhone(pk, encodeHud(base), SealContext.hud), refereePk, seat)).toThrow();
  });

  test("a signed HUD for another seat or match is refused", () => {
    expect(() => openHud(sk, sealedHud(pk, { ...base, player: 1 }), refereePk, seat)).toThrow(
      "another player",
    );
    expect(() =>
      openHud(sk, sealedHud(pk, { ...base, matchId: new Uint8Array(16) }), refereePk, seat),
    ).toThrow("another match");
  });

  const keys = {
    matchId: seat.matchId,
    player: 0,
    startMs: 1n,
    endMs: 2n,
    kTag: new Uint8Array(32),
    kPlayer: new Uint8Array(32),
    target: "bob",
  };

  test("player keys open only when the referee signed them, for the expected match and seat", () => {
    const sealed = sealSignedPlayerKeys(pk, signPlayerKeys(keys, refereeSk));
    expect(openPlayerKeys(sk, sealed, refereePk, seat)).toEqual(keys);
    expect(() => openPlayerKeys(sk, sealed, refereePk, { ...seat, player: 1 })).toThrow("another player");
    const forged = sealSignedPlayerKeys(pk, signPlayerKeys({ ...keys, target: "mallory" }, otherSk));
    expect(() => openPlayerKeys(sk, forged, refereePk, seat)).toThrow("not signed");
  });
});

const nearSk = ed25519.utils.randomSecretKey();
const signer: Signer = { accountId: "alice.tail.testnet", sign: (d) => ed25519.sign(d, nearSk) };

describe("HUD socket messages", () => {
  test("the auth frame answers the challenge with a signature the relay accepts", () => {
    const nonce = new Uint8Array(32).fill(9);
    const matchId = new Uint8Array(16).fill(1);
    const frame = JSON.parse(hudAuthFrame(signer, nonce, matchId)) as { type: string; sig: string };
    expect(frame.type).toBe("auth");
    const digest = relayAuth.hudDigest(nonce, matchId, signer.accountId);
    expect(relayAuth.verifyEd25519(ed25519.getPublicKey(nearSk), digest, fromB64(frame.sig))).toBe(true);
  });

  test("relay frames parse into typed messages and junk is dropped", () => {
    expect(
      parseHudMessage(
        JSON.stringify({ type: "hud", match_id: "x", tick: 4, sealed: toB64(Uint8Array.of(7)) }),
      ),
    ).toEqual({
      type: "hud",
      tick: 4,
      sealed: Uint8Array.of(7),
    });
    // The relay's own rejection frames and plain-text Handler lines are not the referee's word.
    expect(
      parseHudMessage(JSON.stringify({ type: "rejected", detail: { player: 1, seq: 3, reason: 6 } })),
    ).toBeNull();
    expect(parseHudMessage(JSON.stringify({ type: "handler", hint_id: 2, text: "Warmer." }))).toBeNull();
    expect(parseHudMessage(JSON.stringify({ type: "handler", sealed: toB64(Uint8Array.of(9)) }))).toEqual({
      type: "handler",
      sealed: Uint8Array.of(9),
    });
    expect(
      parseHudMessage(JSON.stringify({ type: "refused", detail: { nonce: 4, action: "strike", reason: 3 } })),
    ).toEqual({ type: "refused", nonce: 4, action: "strike", reason: 3 });
    expect(parseHudMessage("not json")).toBeNull();
    expect(parseHudMessage(JSON.stringify({ type: "something-new" }))).toBeNull();
    expect(parseHudMessage(JSON.stringify({ type: "keys", sealed: "%%%" }))).toBeNull();
  });
});
