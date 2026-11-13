import { describe, expect, test } from "bun:test";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import {
  encodeCarryAck,
  encodeLogEntry,
  merkleProof,
  openCarry,
  signCarryAck,
  toHex,
  utf8,
} from "@tail/protocol";
import * as relayAuth from "../../../server/src/auth.ts";
import * as relayCodes from "../../../server/src/codes.ts";
import type { Store } from "../../../server/src/db.ts";
import { HttpError } from "../../../server/src/errors.ts";
import { RequestAuth } from "../../../server/src/routes/util.ts";
import { fromB64, toB64 } from "../lib/b64";
import { hudDigest, type Signer } from "./auth";
import { joinLink, OpenLobbyError, parseLobbyCode, RelayClient, RelayError, readJoin } from "./client";
import { hudAuthFrame, parseHudMessage } from "./hud";

const sk = ed25519.utils.randomSecretKey();
const signer: Signer = { accountId: "alice.tail.testnet", sign: (d) => ed25519.sign(d, sk) };
const CONTRACT = "tail.tail-dev.testnet";
const digestFor = (method: string, path: string, timeMs: number, body: Uint8Array, contractId = CONTRACT) =>
  relayAuth.requestDigest({ contractId, accountId: signer.accountId, method, path, timeMs, body });

describe("relay authentication", () => {
  test("signing reads the relay's contract from /health once and names it in every request", async () => {
    const asked: string[] = [];
    const c = new RelayClient("http://relay.test", {
      now: () => 5,
      fetch: (async (url: string) => {
        asked.push(url);
        return new Response(JSON.stringify({ ok: true, contract: CONTRACT }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const a = await c.sign(signer, "POST", "/batch", "{}");
    await c.sign(signer, "POST", "/batch", "{}");
    expect(asked).toEqual(["http://relay.test/health"]);
    const ok = (contractId: string) =>
      relayAuth.verifyEd25519(
        ed25519.getPublicKey(sk),
        digestFor("POST", "/batch", 5, utf8("{}"), contractId),
        a.sig,
      );
    expect(ok(CONTRACT)).toBe(true);
    expect(ok("tail.other.testnet")).toBe(false);
  });

  test("a relay that names no contract gets no signature", async () => {
    const c = new RelayClient("http://relay.test", {
      fetch: (async () =>
        new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(c.sign(signer, "POST", "/batch", "{}")).rejects.toThrow("which contract");
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
    const c = new RelayClient("http://relay.test:8787/", {
      fetch: fetchFn,
      now: () => 1_700_000_000_000,
      contractId: CONTRACT,
    });
    await c.uploadBatch(await c.batchRequest(signer, "ab".repeat(16), Uint8Array.of(1, 2, 3)));
    const h = seen?.init.headers as Record<string, string>;
    expect(seen?.url).toBe("http://relay.test:8787/batch");
    expect(h["x-tail-account"]).toBe("alice.tail.testnet");
    expect(h["x-tail-time"]).toBe("1700000000000");
    const digest = digestFor("POST", "/batch", 1_700_000_000_000, utf8(String(seen?.init.body)));
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

describe("lobby codes", () => {
  const ID = "7f3a9c21e4b85d60a1c2e3f405162738";
  /** A relay that answers one path with one JSON body and status, and records what was asked. */
  function relay(answer: unknown, status = 200) {
    const asked: string[] = [];
    const client = new RelayClient("http://relay.test", {
      contractId: CONTRACT,
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
    const zone = { zone: { latE7: 1, lonE7: 2, radiusM: 300 }, safehouses: [] };
    const { client, asked } = relay({ match_id: ID, zone });
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
      start_ms: null,
      end_ms: null,
      tick_no: 0,
      last_seq: {},
      players: null,
      chain: null,
    };
    expect((await relay({ ...view, code: "K7M-4QX" }).client.getMatch(ID)).code).toBe("K7M-4QX");
    expect((await relay({ ...view, code: null }).client.getMatch(ID)).code).toBeNull();
    await expect(relay({ ...view, code: "nope" }).client.getMatch(ID)).rejects.toThrow("not a lobby code");
  });
});

describe("signed match view and refusals", () => {
  const ID = "7f3a9c21e4b85d60a1c2e3f405162738";
  const NOW = 1_700_000_000_000;

  /**
   * The relay's own signature check (apps/server src/routes/util.ts RequestAuth) over the request
   * the phone sends, so a signed GET is accepted or refused by the very code the relay runs. The
   * context is the part of Hono's that RequestAuth reads (hono itself is the relay's dependency).
   */
  function realRelay(answer: (account: string) => unknown) {
    const seen: { method: string; url: string; hasBody: boolean }[] = [];
    const store = {
      device: (a: string) => (a === signer.accountId ? { near_pk: ed25519.getPublicKey(sk) } : undefined),
      firstSight: () => true,
    } as unknown as Store;
    const auth = new RequestAuth(store, CONTRACT, () => NOW);
    const client = new RelayClient("http://relay.test", {
      now: () => NOW,
      contractId: CONTRACT,
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ method: String(init.method), url, hasBody: init.body !== undefined });
        const r = new Request(url, init);
        const c = {
          req: { header: (n: string) => r.headers.get(n) ?? undefined, raw: r, url: r.url, method: r.method },
        } as unknown as Parameters<RequestAuth["signed"]>[0];
        try {
          const { account } = await auth.signed(c);
          return new Response(JSON.stringify(answer(account)), { status: 200 });
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          return new Response(JSON.stringify({ ...e.extra, error: e.message }), { status: e.status });
        }
      }) as unknown as typeof fetch,
    });
    return { client, seen };
  }

  test("the zone view is a signed GET with no body that the relay's own check accepts", async () => {
    const sealed = toB64(Uint8Array.of(7, 8, 9));
    const { client, seen } = realRelay((account) => ({
      match_id: ID,
      zone: { zone: { latE7: 423_550_800, lonE7: -710_655_000, radiusM: 400 }, safehouses: [] },
      keys: [{ player: 2, account_id: account, sealed }],
      error: null,
    }));
    expect(await client.matchZone(signer, ID)).toEqual({
      matchId: ID,
      zone: { zone: { latE7: 423_550_800, lonE7: -710_655_000, radiusM: 400 }, safehouses: [] },
      keys: [{ player: 2, accountId: signer.accountId, sealed: Uint8Array.of(7, 8, 9) }],
      error: null,
    });
    expect(seen).toEqual([{ method: "GET", url: `http://relay.test/matches/${ID}/zone`, hasBody: false }]);
  });

  test("a signature over the wrong method or path is refused by the relay", async () => {
    const { client } = realRelay(() => ({}));
    const forged = {
      ...(await client.sign(signer, "POST", `/matches/${ID}/zone`, "")),
      method: "GET" as const,
    };
    const send = (client as unknown as { send(r: typeof forged): Promise<unknown> }).send.bind(client);
    await expect(send(forged)).rejects.toMatchObject({ status: 401, message: "bad request signature" });
  });

  test("the query is part of what is signed, as the relay reads it", async () => {
    const c = new RelayClient("http://relay.test/base/", { now: () => NOW, contractId: CONTRACT });
    const req = await c.sign(signer, "GET", "/replay/x?after=3", "");
    expect(req.signedPath).toBe("/base/replay/x?after=3");
    const digest = digestFor("GET", "/base/replay/x?after=3", NOW, new Uint8Array(0));
    expect(relayAuth.verifyEd25519(ed25519.getPublicKey(sk), digest, req.sig)).toBe(true);
    await expect(c.sign(signer, "GET", "/x", "{}")).rejects.toThrow("a GET has no body");
  });

  test("before Start the zone view has no keys, and a stranger is told they are not in the match", async () => {
    const empty = new RelayClient("http://r", {
      contractId: CONTRACT,
      fetch: (async () =>
        new Response(
          JSON.stringify({ match_id: ID, zone: null, keys: [], error: "need 3 players, have 2" }),
          {
            status: 200,
          },
        )) as unknown as typeof fetch,
    });
    expect(await empty.matchZone(signer, ID)).toEqual({
      matchId: ID,
      zone: null,
      keys: [],
      error: "need 3 players, have 2",
    });
    const stranger = new RelayClient("http://r", {
      contractId: CONTRACT,
      fetch: (async () =>
        new Response(JSON.stringify({ error: "not in this match" }), {
          status: 403,
        })) as unknown as typeof fetch,
    });
    await expect(stranger.matchZone(signer, ID)).rejects.toMatchObject({ status: 403 });
  });

  const form = {
    stake: 1n,
    durationMs: 60_000,
    zone: { latE7: 0, lonE7: 0, radiusM: 100 },
    safehouses: [],
    publicReplay: true,
    minPlayers: 3,
    maxPlayers: 3,
    startByMs: 1,
  };
  const answering = (status: number, body: unknown) =>
    new RelayClient("http://r", {
      contractId: CONTRACT,
      fetch: (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch,
    });

  test("a host with an open lobby is told so plainly, with the lobby to open", async () => {
    const refused = answering(409, {
      match_id: ID,
      error: "you already have an open lobby; start it or let it lapse first",
    });
    const e = await refused.createMatch(signer, form).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(OpenLobbyError);
    expect(e).toBeInstanceOf(RelayError);
    expect(e).toMatchObject({ status: 409, matchId: ID, message: "You already have an open lobby." });
    // Any other 409 (a create already in flight) stays the relay's own refusal.
    const busy = answering(409, { error: "a lobby is already being made for you" });
    const other = await busy.createMatch(signer, form).catch((x: unknown) => x);
    expect(other).not.toBeInstanceOf(OpenLobbyError);
    expect(other).toMatchObject({ status: 409, message: "a lobby is already being made for you" });
  });

  test("too many and too large read as short plain sentences", async () => {
    const limit = answering(429, { error: "daily top-up limit reached (300 USDC.e); try tomorrow" });
    await expect(limit.topUp(signer, signer.accountId, 1n)).rejects.toMatchObject({
      status: 429,
      message: "Daily top-up limit reached (300 USDC.e); try tomorrow.",
    });
    await expect(answering(429, {}).enrollChallenge("bob")).rejects.toMatchObject({
      message: "The relay is busy. Try again in a minute.",
    });
    await expect(answering(413, { error: "request too large" }).enrollChallenge("bob")).rejects.toMatchObject(
      {
        status: 413,
        message: "That was too big for the relay to take.",
      },
    );
  });
});

describe("carry, receipts and the replay log", () => {
  const ID = "7f3a9c21e4b85d60a1c2e3f405162738";
  const answer = (body: unknown, status = 200, seen?: (url: string, init: RequestInit) => void) =>
    new RelayClient("http://relay.test", {
      contractId: CONTRACT,
      fetch: (async (url: string, init: RequestInit) => {
        seen?.(url, init);
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch,
    });

  test("a carried request is the signed request exactly, and the relay opens it to the same signature", async () => {
    const boxSk = x25519.utils.randomSecretKey();
    const c = new RelayClient("http://relay.test", { now: () => 77, contractId: CONTRACT });
    const req = await c.batchRequest(signer, ID, Uint8Array.of(1, 2));
    const { carryEnvelope } = await import("../carry/mesh");
    const inner = openCarry(boxSk, carryEnvelope(x25519.getPublicKey(boxSk), req));
    expect(inner.account).toBe(signer.accountId);
    const digest = digestFor(inner.method, inner.path, Number(inner.timeMs), inner.body);
    expect(relayAuth.verifyEd25519(ed25519.getPublicKey(sk), digest, inner.sig)).toBe(true);
  });

  test("forwarding posts the envelope as raw bytes and reads back the receipt and HUD", async () => {
    const ackSk = ed25519.utils.randomSecretKey();
    const env = new Uint8Array(4144).fill(3);
    const ack = encodeCarryAck(signCarryAck(ackSk, env, 200, 9n));
    let body: unknown;
    const c = answer({ ack: toB64(ack), hud: toB64(Uint8Array.of(5)) }, 200, (_u, init) => {
      body = init.body;
    });
    const r = await c.forwardCarry(env);
    expect(new Uint8Array(body as ArrayBuffer)).toEqual(env);
    expect(r.ack).toMatchObject({ status: 200, receivedMs: 9n });
    expect(r.ackBytes).toEqual(ack);
    expect(r.hud).toEqual(Uint8Array.of(5));
    expect(
      await answer({ box_pk: toB64(new Uint8Array(32)), ack_pk: toB64(new Uint8Array(32)) }).carryKey(),
    ).toEqual({ boxPk: new Uint8Array(32), ackPk: new Uint8Array(32) });
  });

  test("an inclusion path is read as hashes, and a leaf the relay does not have reads as none", async () => {
    const leaves = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
    const path = merkleProof(leaves, 1).map(toHex);
    let url = "";
    const p = await answer({ index: 1, size: 3, path }, 200, (u) => {
      url = u;
    }).inclusion(ID, leaves[1] as Uint8Array, 3);
    expect(url).toBe(
      `http://relay.test/matches/${ID}/inclusion?leaf=${toHex(leaves[1] as Uint8Array)}&size=3`,
    );
    expect(p).toEqual({ index: 1, size: 3, path: merkleProof(leaves, 1) });
    expect(
      await answer({ error: "that leaf is not in the first 3 leaves" }, 404).inclusion(
        ID,
        leaves[0] as Uint8Array,
        3,
      ),
    ).toBeNull();
    await expect(
      answer({ index: 0, size: 3, path: ["zz"] }).inclusion(ID, leaves[0] as Uint8Array, 3),
    ).rejects.toThrow("path");
  });

  test("the replay log is asked for as a player: challenge, then the signed nonce", async () => {
    const nonce = new Uint8Array(32).fill(8);
    const entry = { kind: "Contact", a: 0, b: 1, epoch: 4, salt: new Uint8Array(16) } as const;
    const asked: string[] = [];
    const c = new RelayClient("http://relay.test", {
      contractId: CONTRACT,
      fetch: (async (url: string) => {
        asked.push(url);
        const body = url.endsWith("/challenge")
          ? { nonce: toB64(nonce) }
          : { version: 2, log: [toB64(encodeLogEntry(entry))] };
        return new Response(JSON.stringify(body), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await c.replayLog(signer, ID)).toEqual([entry]);
    const q = new URL(asked[1] as string).searchParams;
    const sig = fromB64(q.get("sig") ?? "");
    expect(q.get("account_id")).toBe(signer.accountId);
    expect(
      relayAuth.verifyEd25519(
        ed25519.getPublicKey(sk),
        relayAuth.replayDigest(nonce, fromHexId(ID), signer.accountId),
        sig,
      ),
    ).toBe(true);
  });
});

const fromHexId = (id: string) => Uint8Array.from(Buffer.from(id, "hex"));
