import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { utf8 } from "@tail/protocol";
import * as relayAuth from "../../../server/src/auth.ts";
import * as relayCodes from "../../../server/src/codes.ts";
import { fromB64, toB64 } from "../lib/b64";
import { hudDigest, requestDigest, type Signer } from "./auth";
import { joinLink, parseLobbyCode, RelayClient, readJoin } from "./client";
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

  test("/health says which referee runs; anything else reads as not said", async () => {
    const health = (body: unknown) =>
      new RelayClient("http://relay.test", {
        fetch: (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch,
      }).info();
    const base = { ok: true, contract: "tail.testnet", test_players: true };
    expect(await health({ ...base, referee: { kind: "local", status: "up" } })).toEqual({
      contract: "tail.testnet",
      testPlayers: true,
      referee: "local",
    });
    expect((await health({ ...base, referee: { kind: "outlayer", status: "down" } })).referee).toBe(
      "outlayer",
    );
    expect((await health(base)).referee).toBeNull();
    expect((await health({ ...base, referee: { kind: "tee-ish" } })).referee).toBeNull();
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

describe("lobby codes", () => {
  const ID = "7f3a9c21e4b85d60a1c2e3f405162738";
  /** A relay that answers one path with one JSON body and status, and records what was asked. */
  function relay(answer: unknown, status = 200) {
    const asked: string[] = [];
    const client = new RelayClient("http://relay.test", {
      fetch: (async (url: string) => {
        asked.push(url);
        return new Response(JSON.stringify(answer), { status });
      }) as unknown as typeof fetch,
    });
    return { client, asked };
  }

  test("a typed code, a full match id or a join link holding either all lead to a lobby", () => {
    expect(readJoin(" k7m-4qx ")).toEqual({ code: "K7M4QX" });
    expect(readJoin("K7M4QX")).toEqual({ code: "K7M4QX" });
    expect(readJoin(joinLink("K7M-4QX"))).toEqual({ code: "K7M4QX" });
    expect(readJoin(ID.toUpperCase())).toEqual({ matchId: ID });
    expect(readJoin(joinLink(ID))).toEqual({ matchId: ID });
  });

  test("anything that is neither a code nor a match id leads nowhere", () => {
    for (const typed of ["", "K7M-4Q", "K7M-4Q0", "OIL-U11", ID.slice(1), "tail://join/", "https://x/K7M4QX"])
      expect(readJoin(typed)).toBeNull();
  });

  test("the phone reads codes exactly as the relay does", () => {
    for (const typed of [
      "K7M-4QX",
      "k7m4qx",
      " k7m 4qx",
      "K7M-4QI",
      "K7M-4Q",
      "222-222",
      "ZZZ-ZZZ",
      "10O-LIU",
    ])
      expect(parseLobbyCode(typed)).toBe(relayCodes.parseCode(typed));
    for (let i = 0; i < 50; i++) {
      const minted = relayCodes.mintCode();
      expect(parseLobbyCode(relayCodes.showCode(minted))).toBe(minted);
    }
  });

  test("a code the relay knows resolves to its match id", async () => {
    const { client, asked } = relay({ match_id: ID });
    expect(await client.resolveCode("K7M4QX")).toBe(ID);
    expect(asked).toEqual(["http://relay.test/join/K7M4QX"]);
  });

  test("a code the relay does not know reads as no open lobby", async () => {
    const { client } = relay({ error: "no open match with that code" }, 404);
    await expect(client.resolveCode("K7M4QX")).rejects.toMatchObject({
      status: 404,
      message: "No open lobby with that code.",
    });
  });

  test("creating a match reads back its code, and the match view carries it", async () => {
    const created = relay({ match_id: ID, zone_hash: "00".repeat(32), code: "K7M-4QX" });
    expect(
      await created.client.createMatch(signer, {
        stake: 1n,
        durationMs: 60_000,
        zone: { latE7: 0, lonE7: 0, radiusM: 100 },
        safehouses: [],
        publicReplay: true,
        minPlayers: 3,
        maxPlayers: 3,
        startByMs: 1,
      }),
    ).toEqual({ matchId: ID, code: "K7M-4QX" });
    const view = {
      match_id: ID,
      host: "h",
      phase: "lobby",
      error: null,
      start_ms: null,
      end_ms: null,
      keys: [],
    };
    expect((await relay({ ...view, code: "K7M-4QX" }).client.getMatch(ID)).code).toBe("K7M-4QX");
    expect((await relay({ ...view, code: null }).client.getMatch(ID)).code).toBeNull();
    await expect(relay({ ...view, code: "nope" }).client.getMatch(ID)).rejects.toThrow("not a lobby code");
  });
});
