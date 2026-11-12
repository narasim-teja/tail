import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { utf8 } from "@tail/protocol";
import * as relayAuth from "../../../server/src/auth.ts";
import { fromB64, toB64 } from "../lib/b64";
import { hudDigest, requestDigest, type Signer } from "./auth";
import { RelayClient } from "./client";
import { hudAuthFrame, parseHudMessage } from "./hud";

const sk = ed25519.utils.randomSecretKey();
const signer: Signer = { accountId: "alice.tail.testnet", sign: (d) => ed25519.sign(d, sk) };

describe("relay authentication", () => {
  // apps/server/src/auth.ts is the relay's side; these must agree byte for byte.
  test("request digests match the relay's", () => {
    const body = utf8('{"match_id":"00"}');
    expect(requestDigest("post", "/batch", 1_700_000_000_123, body)).toEqual(
      relayAuth.requestDigest("POST", "/batch", 1_700_000_000_123, body),
    );
  });

  test("HUD challenge digests match the relay's", () => {
    const nonce = new Uint8Array(32).fill(5);
    const matchId = new Uint8Array(16).fill(6);
    expect(hudDigest(nonce, matchId, "alice.tail.testnet")).toEqual(
      relayAuth.hudDigest(nonce, matchId, "alice.tail.testnet"),
    );
  });

  test("a signed request carries the headers the relay checks and verifies with the NEAR key", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ queued: true, player: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new RelayClient("http://relay.test:8787/", { fetch: fetchFn, now: () => 1_700_000_000_000 });
    const r = await c.uploadBatch(c.batchRequest(signer, "ab".repeat(16), Uint8Array.of(1, 2, 3)));
    expect(r).toEqual({ queued: true, player: 1 });
    const h = seen?.init.headers as Record<string, string>;
    expect(seen?.url).toBe("http://relay.test:8787/batch");
    expect(h["x-tail-account"]).toBe("alice.tail.testnet");
    expect(h["x-tail-time"]).toBe("1700000000000");
    const digest = relayAuth.requestDigest(
      "POST",
      "/batch",
      1_700_000_000_000,
      utf8(String(seen?.init.body)),
    );
    expect(relayAuth.verifyEd25519(ed25519.getPublicKey(sk), digest, fromB64(h["x-tail-sig"] ?? ""))).toBe(
      true,
    );
    expect(JSON.parse(String(seen?.init.body))).toEqual({ match_id: "ab".repeat(16), sealed: "AQID" });
  });

  test("relay refusals keep the relay's message and an unreachable relay is marked as such", async () => {
    const refusing = new RelayClient("http://r", {
      fetch: (async () =>
        new Response(JSON.stringify({ error: "that handle is taken" }), {
          status: 409,
        })) as unknown as typeof fetch,
    });
    await expect(refusing.enrollChallenge("bob")).rejects.toMatchObject({
      status: 409,
      message: "that handle is taken",
    });
    const down = new RelayClient("http://r", {
      fetch: (async () => {
        throw new TypeError("Network request failed");
      }) as unknown as typeof fetch,
    });
    await expect(down.getMatch("00".repeat(16))).rejects.toMatchObject({ status: null, unreachable: true });
  });

  test("the HUD URL is a WebSocket URL with the match and account", () => {
    expect(new RelayClient("https://relay.example").hudUrl("ab".repeat(16), "a.b.testnet")).toBe(
      `wss://relay.example/hud?match_id=${"ab".repeat(16)}&account_id=a.b.testnet`,
    );
  });
});

describe("HUD socket messages", () => {
  test("the auth frame answers the challenge with a signature the relay accepts", () => {
    const nonce = new Uint8Array(32).fill(9);
    const matchId = new Uint8Array(16).fill(1);
    const frame = JSON.parse(hudAuthFrame(signer, nonce, matchId)) as { type: string; sig: string };
    expect(frame.type).toBe("auth");
    const digest = relayAuth.hudDigest(nonce, matchId, signer.accountId);
    expect(relayAuth.verifyEd25519(ed25519.getPublicKey(sk), digest, fromB64(frame.sig))).toBe(true);
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
    expect(
      parseHudMessage(
        JSON.stringify({
          type: "rejected",
          match_id: "x",
          detail: { player: 1, seq: 3, reason: "FixFlags { flags: 1 }" },
        }),
      ),
    ).toEqual({ type: "rejected", seq: 3, reason: "FixFlags { flags: 1 }" });
    expect(parseHudMessage(JSON.stringify({ type: "handler", hint_id: 2, text: "Warmer." }))).toEqual({
      type: "handler",
      hintId: 2,
      text: "Warmer.",
    });
    expect(parseHudMessage("not json")).toBeNull();
    expect(parseHudMessage(JSON.stringify({ type: "something-new" }))).toBeNull();
    expect(parseHudMessage(JSON.stringify({ type: "keys", sealed: "%%%" }))).toBeNull();
  });
});
