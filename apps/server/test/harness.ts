// A relay on the fakes (test/fakes.ts) and the requests the tests send it: signed or not, as a
// phone would. Every relay made here is stopped after its test.

import { afterEach, expect } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createRelay, type RelayDeps } from "../src/app.ts";
import { hudDigest, signRequestHeaders } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import { FakeChain, FakeReferee, quietLog, seedDevice, until } from "./fakes.ts";

export const PARENT = "relay.testnet";
const relays: { stop: () => void }[] = [];
afterEach(() => {
  for (const r of relays.splice(0)) r.stop();
});

export function setup(over: Partial<RelayDeps> = {}) {
  const store = over.store ?? new Store(":memory:");
  const chain = (over.chain as FakeChain | undefined) ?? new FakeChain();
  const referee = (over.referee as FakeReferee | undefined) ?? new FakeReferee();
  const relay = createRelay({
    store,
    chain,
    referee,
    log: quietLog(),
    parentAccount: PARENT,
    appId: "TEAM.app",
    environment: "development",
    token: "usdc.fakes.testnet",
    replay: {
      contract: "tail.relay.testnet",
      network: "testnet",
      refereeProject: "relay.testnet/tail-referee",
      outlayerApi: "https://testnet-api.outlayer.ai",
      refereeKind: "outlayer",
    },
    testnet: true,
    allowGhosts: false,
    tickMs: 5,
    // Each attested device its own App Attest key, as a real phone has.
    verifyAttestation: async () => crypto.getRandomValues(new Uint8Array(65)),
    ...over,
  });
  relays.push({
    stop: () => {
      relay.matches.stop();
      relay.enrolment.stop();
    },
  });
  return { store, chain, referee, ...relay };
}

export type Env = ReturnType<typeof setup>;
export interface Player {
  account: string;
  seed: Uint8Array;
}

export function player(env: Env, name: string): Player {
  const seed = ed25519.utils.randomSecretKey();
  const account = `${name}.${PARENT}`;
  seedDevice(env.store, account, ed25519.getPublicKey(seed));
  return { account, seed };
}

// Two identical signed requests in the same millisecond are a replay to the relay; each test
// request gets its own time so none of them is.
let lastTime = 0;
const freshTime = () => {
  lastTime = Math.max(Date.now(), lastTime + 1);
  return lastTime;
};

export async function req(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
  as?: Player,
  timeMs = freshTime(),
) {
  const bytes = new TextEncoder().encode(body === undefined ? "" : JSON.stringify(body));
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (as) Object.assign(headers, signRequestHeaders(as.account, as.seed, method, path, bytes, timeMs));
  const res = await env.app.request(path, { method, headers, ...(method === "GET" ? {} : { body: bytes }) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

export const MATCH = {
  stake: "1000000",
  duration_ms: 300_000,
  zone: { lat_e7: 423_550_000, lon_e7: -710_656_000, radius_m: 1500 },
  public_replay: true,
  min_players: 3,
  max_players: 3,
};

export async function lobby(env: Env, extra: Record<string, unknown> = {}) {
  const [a, b, c] = [player(env, "ana"), player(env, "bo"), player(env, "cy")] as [Player, Player, Player];
  const r = await req(env, "POST", "/matches", { ...MATCH, start_by_ms: Date.now() + 600_000, ...extra }, a);
  expect(r.status).toBe(200);
  const id = String(r.json["match_id"]);
  for (const p of [a, b, c]) env.chain.join(id, p.account);
  return { id, a, b, c };
}

export async function started(env: Env, extra: Record<string, unknown> = {}) {
  const l = await lobby(env, extra);
  const r = await req(env, "POST", `/matches/${l.id}/start`, {}, l.a);
  expect(r.status).toBe(200);
  return { ...l, start: r.json };
}

export const ended = (env: Env, id: string) =>
  until(() => env.store.match(id)?.phase === "ended", "the match to end");
export const appliedSeqs = (env: Env) =>
  env.chain.applied.map((raw) => new DataView(raw.buffer, raw.byteOffset + 16, 4).getUint32(0, true));

/** Opens a HUD socket for `who` and answers the challenge with `signer`'s signature. */
export async function hudSocket(env: Env, matchId: string, who: Player, signer: Uint8Array) {
  const server = Bun.serve({ port: 0, fetch: env.app.fetch, websocket: env.websocket });
  relays.push({ stop: () => server.stop(true) });
  const ws = new WebSocket(`ws://localhost:${server.port}/hud?match_id=${matchId}&account_id=${who.account}`);
  const got: Record<string, unknown>[] = [];
  const closed = { code: 0 };
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
    got.push(m);
    if (m["type"] === "challenge") {
      const nonce = new Uint8Array(Buffer.from(String(m["nonce"]), "base64"));
      const sig = ed25519.sign(
        hudDigest(nonce, Uint8Array.from(Buffer.from(matchId, "hex")), who.account),
        signer,
      );
      ws.send(JSON.stringify({ type: "auth", sig: Buffer.from(sig).toString("base64") }));
    }
  };
  ws.onclose = (ev) => {
    closed.code = ev.code;
  };
  return { ws, got, closed };
}
