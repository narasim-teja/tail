// The relay's caps on what one caller can make it do: mint test tokens, send big bodies, hold
// HUD sockets, ask for replay challenges. Each cap has a twin that still goes through.

import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { MAX_HUD_SOCKETS_PER_ACCOUNT } from "../src/hub.ts";
import { Buckets, proxyHeaderWarning } from "../src/limits.ts";
import { MAX_REPLAY_CHALLENGES_PER_PLAYER } from "../src/routes/replay.ts";
import { MAX_BODY } from "../src/routes/util.ts";
import { DAILY_TOPUP_CAP, MAX_TOPUP, TOPUP_WINDOW_MS } from "../src/topup.ts";
import { until } from "./fakes.ts";
import { ended, hudSocket, MATCH, player, req, setup, started } from "./harness.ts";

const topup = (env: ReturnType<typeof setup>, as: ReturnType<typeof player>, amount: bigint) =>
  req(env, "POST", "/dev/topup", { account_id: as.account, amount: amount.toString() }, as);

describe("dev top-ups", () => {
  test("an account's top-ups are capped per rolling day; another account's are not", async () => {
    let now = Date.now();
    const env = setup({ now: () => now });
    const [a, b] = [player(env, "ana"), player(env, "bo")];
    const fits = Number(DAILY_TOPUP_CAP / MAX_TOPUP);
    for (let i = 0; i < fits; i++) expect((await topup(env, a, MAX_TOPUP)).status).toBe(200);
    const over = await topup(env, a, 1n);
    expect(over.status).toBe(429);
    expect(env.chain.topUps.length).toBe(fits);
    expect((await topup(env, b, MAX_TOPUP)).status).toBe(200);
    now += TOPUP_WINDOW_MS + 1;
    expect((await topup(env, a, MAX_TOPUP)).status).toBe(200);
  });

  test("a mint that failed does not count against the cap", async () => {
    const env = setup();
    const a = player(env, "ana");
    const mint = env.chain.topUp.bind(env.chain);
    let fail = true;
    env.chain.topUp = async (id, amount) => {
      if (fail) {
        fail = false;
        throw new Error("rpc down");
      }
      return mint(id, amount);
    };
    expect((await topup(env, a, MAX_TOPUP)).status).toBe(500);
    for (let i = 0; i < Number(DAILY_TOPUP_CAP / MAX_TOPUP); i++)
      expect((await topup(env, a, MAX_TOPUP)).status).toBe(200);
  });

  test("a test player's stake counts against its host's cap, and a refusal makes no ghost", async () => {
    const env = setup({ allowGhosts: true });
    const [a, b] = [player(env, "ana"), player(env, "bo")];
    const r = await req(env, "POST", "/matches", { ...MATCH, start_by_ms: Date.now() + 600_000 }, a);
    const id = String(r.json["match_id"]);
    for (const p of [a, b]) env.chain.join(id, p.account);
    for (let i = 0; i < Number(DAILY_TOPUP_CAP / MAX_TOPUP); i++) await topup(env, a, MAX_TOPUP);
    const accounts = env.chain.accounts.size;
    const fill = await req(env, "POST", "/dev/ghosts/fill", { match_id: id }, a);
    expect(fill.status).toBe(429);
    expect(env.chain.accounts.size).toBe(accounts);
    // bo has minted nothing today, but only the host may seat a test player.
    expect((await req(env, "POST", "/dev/ghosts/fill", { match_id: id }, b)).status).toBe(403);
  });
});

describe("request bodies", () => {
  const stream = (size: number) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (let left = size; left > 0; left -= 8_192)
          c.enqueue(new Uint8Array(Math.min(8_192, left)).fill(32));
        c.close();
      },
    });

  test("a streamed body past 64 KiB is refused without a declared length; a smaller one is read", async () => {
    const env = setup();
    const send = (size: number) =>
      env.app.request("/enroll/challenge", {
        method: "POST",
        body: stream(size),
        duplex: "half",
      } as RequestInit);
    const big = await send(MAX_BODY + 1);
    expect(big.status).toBe(413);
    // Spaces only: read in full, then refused as JSON, not as size.
    const small = await send(MAX_BODY - 1);
    expect(small.status).toBe(400);
  });

  test("a declared length past 64 KiB is refused before reading", async () => {
    const env = setup();
    const r = await env.app.request("/enroll/challenge", {
      method: "POST",
      headers: { "content-length": String(MAX_BODY + 1) },
      body: "{}",
    });
    expect(r.status).toBe(413);
  });
});

describe("HUD sockets", () => {
  test("an account holds a few sockets; a newer one closes the oldest", async () => {
    const env = setup();
    env.referee.overAt = 1_000_000;
    const m = await started(env);
    const socks: Awaited<ReturnType<typeof hudSocket>>[] = [];
    for (let i = 0; i <= MAX_HUD_SOCKETS_PER_ACCOUNT; i++) {
      const s = await hudSocket(env, m.id, m.b, m.b.seed);
      await until(() => s.got.some((x) => x["type"] === "ready"), "the socket to be ready");
      socks.push(s);
    }
    await until(() => socks[0]?.closed.code, "the oldest socket to close");
    expect(socks[0]?.closed.code).toBe(4408);
    expect(socks.slice(1).every((s) => s.closed.code === 0)).toBe(true);
    // Another player's socket is not affected by bo's.
    const c = await hudSocket(env, m.id, m.c, m.c.seed);
    await until(() => c.got.some((x) => x["type"] === "ready"), "cy's socket");
    for (const s of [...socks, c]) s.ws.close();
  });

  test("a socket that never proves the key does not take one of the account's places", async () => {
    const env = setup();
    env.referee.overAt = 1_000_000;
    const m = await started(env);
    const strangers: Awaited<ReturnType<typeof hudSocket>>[] = [];
    for (let i = 0; i < MAX_HUD_SOCKETS_PER_ACCOUNT; i++)
      strangers.push(await hudSocket(env, m.id, m.b, ed25519.utils.randomSecretKey()));
    const real = await hudSocket(env, m.id, m.b, m.b.seed);
    await until(() => real.got.some((x) => x["type"] === "ready"), "the real socket");
    await until(() => strangers.every((s) => s.closed.code === 4401), "the strangers to be closed");
    expect(real.closed.code).toBe(0);
    real.ws.close();
  });
});

describe("replay challenges", () => {
  test("a player can hold a few unanswered replay challenges; another player still gets one", async () => {
    const env = setup();
    const m = await started(env, { public_replay: false });
    await ended(env, m.id);
    const ask = (account: string) => req(env, "POST", `/replay/${m.id}/challenge`, { account_id: account });
    for (let i = 0; i < MAX_REPLAY_CHALLENGES_PER_PLAYER; i++)
      expect((await ask(m.b.account)).status).toBe(200);
    expect((await ask(m.b.account)).status).toBe(429);
    expect((await ask(m.c.account)).status).toBe(200);
  });
});

describe("client buckets", () => {
  test("a refunded token can be taken again, never past the burst", () => {
    const b = new Buckets({ burst: 1, everyMs: 1e9 }, () => 0);
    expect(b.take("a")).toBe(true);
    expect(b.take("a")).toBe(false);
    b.refund("a");
    b.refund("a");
    expect(b.take("a")).toBe(true);
    expect(b.take("a")).toBe(false);
  });

  test("startup warns when no proxy header is set and the relay listens beyond loopback", () => {
    expect(proxyHeaderWarning(undefined, "0.0.0.0")).toContain("RELAY_CLIENT_IP_HEADER");
    expect(proxyHeaderWarning(undefined, "192.168.1.5")).not.toBeNull();
    for (const host of ["localhost", "127.0.0.1", "::1", "[::1]"])
      expect(proxyHeaderWarning(undefined, host)).toBeNull();
    expect(proxyHeaderWarning("cf-connecting-ip", "0.0.0.0")).toBeNull();
  });
});
