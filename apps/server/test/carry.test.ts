// Mesh carry: a signed request sealed to the relay's carry key, posted by whichever phone has
// signal. The relay opens it, runs it as if it came directly, and signs a receipt. A carried
// batch may be older than a direct one, every copy after the first (through another carrier, or
// after the request came directly) is answered as a duplicate and queued once, and the sender's
// latest HUD rides back. The Handler's line goes only to the player who asked.

import { describe, expect, test } from "bun:test";
import {
  decodeCarryAck,
  openSignedHud,
  openSignedVoiceLine,
  sealCarry,
  toHex,
  verifyCarryAck,
} from "@tail/protocol";
import { signRequest } from "../src/auth.ts";
import { CARRY_ENVELOPE_BYTES } from "../src/routes/carry.ts";
import { until } from "./fakes.ts";
import { CONTRACT, type Env, hudSocket, type Player, req, setup, started } from "./harness.ts";

const sealed = (n: number) => Buffer.alloc(64, n).toString("base64");

/** What a phone without signal hands to the mesh: its signed request, sealed to the relay. */
function envelope(env: Env, who: Player, path: string, body: unknown, timeMs = Date.now(), method = "POST") {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const { sig } = signRequest(
    { contractId: CONTRACT, accountId: who.account, method, path, body: bytes, timeMs },
    who.seed,
  );
  return sealCarry(env.carryKeys.boxPk, {
    account: who.account,
    timeMs: BigInt(timeMs),
    method,
    path,
    body: bytes,
    sig,
  });
}

async function carry(env: Env, e: Uint8Array) {
  const res = await env.app.request("/carry", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: e,
  });
  const json = (await res.json()) as Record<string, unknown>;
  const ack =
    typeof json["ack"] === "string"
      ? decodeCarryAck(new Uint8Array(Buffer.from(json["ack"], "base64")))
      : null;
  return { status: res.status, json, ack };
}

/** A running match that started two minutes ago, so a carried batch can be older than 60 s. */
async function runningForAWhile() {
  const env = setup();
  env.referee.overAt = 1_000_000;
  const m = await started(env);
  env.store.db.query("UPDATE matches SET start_ms = start_ms - 120000 WHERE match_id = ?").run(m.id);
  return { env, m };
}

const ackKey = async (env: Env) => {
  const k = (await req(env, "GET", "/carry/key")).json;
  return {
    box: new Uint8Array(Buffer.from(String(k["box_pk"]), "base64")),
    ack: new Uint8Array(Buffer.from(String(k["ack_pk"]), "base64")),
  };
};

describe("mesh carry", () => {
  test("the relay publishes its box key and receipt key", async () => {
    const env = setup();
    const k = await ackKey(env);
    expect(toHex(k.box)).toBe(toHex(env.carryKeys.boxPk));
    expect(toHex(k.ack)).toBe(toHex(env.carryKeys.ackPk));
  });

  test("a carried batch 90 s old is queued, with a receipt that verifies under the published key", async () => {
    const { env, m } = await runningForAWhile();
    const e = envelope(env, m.b, "/batch", { match_id: m.id, sealed: sealed(1) }, Date.now() - 90_000);
    expect(e.length).toBe(CARRY_ENVELOPE_BYTES);
    const r = await carry(env, e);
    expect(r.status).toBe(200);
    expect(r.ack?.status).toBe(200);
    expect(verifyCarryAck((await ackKey(env)).ack, e, r.ack as NonNullable<typeof r.ack>)).toBe(true);
    expect(env.store.queuedCount(m.id, 1)).toBe(1);
    // The same age sent directly is refused: only the mesh gets the longer window.
    const direct = await req(
      env,
      "POST",
      "/batch",
      { match_id: m.id, sealed: sealed(2) },
      m.b,
      Date.now() - 90_000,
    );
    expect(direct.status).toBe(401);
  });

  test("a second copy of a carried batch is a duplicate and is not queued again", async () => {
    const { env, m } = await runningForAWhile();
    const t = Date.now();
    const e = envelope(env, m.b, "/batch", { match_id: m.id, sealed: sealed(1) }, t);
    expect((await carry(env, e)).ack?.status).toBe(200);
    // The same envelope from another carrier, and the same signed request sealed afresh.
    for (const copy of [e, envelope(env, m.b, "/batch", { match_id: m.id, sealed: sealed(1) }, t)]) {
      expect(copy.length).toBe(e.length);
      expect((await carry(env, copy)).ack?.status).toBe(200);
    }
    expect(env.store.queuedCount(m.id, 1)).toBe(1);
    expect(env.store.allBatches(m.id)).toHaveLength(1);
  });

  test("a batch sent directly twice is delivered once; the copy is answered as a duplicate", async () => {
    const { env, m } = await runningForAWhile();
    const t = Date.now();
    const body = { match_id: m.id, sealed: sealed(4) };
    expect((await req(env, "POST", "/batch", body, m.b, t)).json).toEqual({ queued: true, player: 1 });
    const again = await req(env, "POST", "/batch", body, m.b, t);
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ duplicate: true, code: "duplicate" });
    expect(env.store.allBatches(m.id).filter((b) => b.player === 1)).toHaveLength(1);
  });

  test("a batch that came directly is refused when it is replayed through the mesh, even after 60 s", async () => {
    const { env, m } = await runningForAWhile();
    const t = Date.now();
    const body = { match_id: m.id, sealed: sealed(3) };
    expect((await req(env, "POST", "/batch", body, m.b, t)).status).toBe(200);
    await until(() => env.store.queuedCount(m.id, 1) === 0, "the batch to reach a tick");
    const replayed = await carry(env, envelope(env, m.b, "/batch", body, t));
    expect(replayed.ack?.status).toBe(200);
    // Not queued again: the digest is kept until the match ends, not for 60 s.
    expect(env.store.queuedCount(m.id, 1)).toBe(0);
    expect(env.store.allBatches(m.id).filter((b) => b.player === 1)).toHaveLength(1);
    const row = env.store.db
      .query<{ expires_ms: number }, []>("SELECT MAX(expires_ms) AS expires_ms FROM seen_requests")
      .get();
    expect(row?.expires_ms).toBeGreaterThan(env.store.match(m.id)?.end_ms ?? Infinity);
  });

  test("a carried batch dated before the match started is refused, and the receipt says so", async () => {
    const { env, m } = await runningForAWhile();
    const start = env.store.match(m.id)?.start_ms as number;
    const r = await carry(
      env,
      envelope(env, m.b, "/batch", { match_id: m.id, sealed: sealed(1) }, start - 1),
    );
    expect(r.ack?.status).toBe(401);
    expect(r.json["hud"]).toBeUndefined();
    expect(env.store.queuedCount(m.id, 1)).toBe(0);
  });

  test("a carried request signed by another key gets a 401 receipt and no HUD", async () => {
    const { env, m } = await runningForAWhile();
    await until(() => env.store.hud(m.id, 1), "a HUD");
    const forged = { ...m.b, seed: m.a.seed };
    const r = await carry(env, envelope(env, forged, "/batch", { match_id: m.id, sealed: sealed(1) }));
    expect(r.ack?.status).toBe(401);
    expect(r.json["hud"]).toBeUndefined();
  });

  test("the sender's latest sealed HUD rides back with an accepted batch", async () => {
    const { env, m } = await runningForAWhile();
    await until(() => env.store.hud(m.id, 1), "a HUD");
    const r = await carry(env, envelope(env, m.b, "/batch", { match_id: m.id, sealed: sealed(1) }));
    const hud = openSignedHud(
      m.b.boxSk,
      new Uint8Array(Buffer.from(String(r.json["hud"]), "base64")),
      env.referee.pk,
    );
    expect(hud.player).toBe(1);
  });

  test("an envelope that does not open, has the wrong size, or carries a GET or a carry is refused", async () => {
    const { env, m } = await runningForAWhile();
    const e = envelope(env, m.b, "/batch", { match_id: m.id, sealed: sealed(1) });
    const bad = Uint8Array.from(e, (b, i) => (i === 100 ? b ^ 1 : b));
    expect((await carry(env, bad)).status).toBe(400);
    expect((await carry(env, e.slice(1))).status).toBe(400);
    expect(
      (await carry(env, envelope(env, m.b, `/matches/${m.id}/zone`, {}, Date.now(), "GET"))).status,
    ).toBe(400);
    expect((await carry(env, envelope(env, m.b, "/carry", {}))).status).toBe(400);
    expect(env.store.queuedCount(m.id, 1)).toBe(0);
  });

  test("a carry hidden behind dot segments or escapes is refused; a plain path still goes through", async () => {
    const { env, m } = await runningForAWhile();
    for (const path of ["/batch/../carry", "/./carry", "/%63arry", "/x/..%2Fcarry", "/\\carry"]) {
      expect((await carry(env, envelope(env, m.b, path, {}))).status).toBe(400);
    }
    const ok = await carry(env, envelope(env, m.b, "/batch", { match_id: m.id, sealed: sealed(1) }));
    expect(ok.status).toBe(200);
    expect(env.store.queuedCount(m.id, 1)).toBe(1);
  });
});

describe("the Handler's line", () => {
  test("reaches only the player who asked, sealed to them and signed by the referee", async () => {
    const env = setup();
    env.referee.overAt = 1_000_000;
    env.referee.hintAtTick = 0;
    const m = await started(env);
    const asker = await hudSocket(env, m.id, m.a, m.a.seed);
    const other = await hudSocket(env, m.id, m.b, m.b.seed);
    const ready = (s: typeof asker) => s.got.some((x) => x["type"] === "ready");
    await until(() => ready(asker) && ready(other), "both sockets");
    // The fake referee charges a hint for player 0 (ana) two ticks from now.
    env.referee.hintAtTick = (env.store.match(m.id)?.tick_no ?? 0) + 2;
    const open = (x: Record<string, unknown> | undefined) =>
      openSignedVoiceLine(
        m.a.boxSk,
        new Uint8Array(Buffer.from(String(x?.["sealed"]), "base64")),
        env.referee.pk,
      );
    const live = await until(() => asker.got.find((x) => x["type"] === "handler"), "the Handler's line");
    expect(open(live)).toMatchObject({ player: 0, text: "line for hint 0" });
    await until(() => other.got.filter((x) => x["type"] === "hud").length >= 5, "more HUDs for bo");
    expect(other.got.some((x) => x["type"] === "handler")).toBe(false);
    // A socket opened later gets the asker's line again, and still nobody else does.
    const again = await hudSocket(env, m.id, m.a, m.a.seed);
    const late = await hudSocket(env, m.id, m.c, m.c.seed);
    await until(() => again.got.find((x) => x["type"] === "handler") && ready(late), "the line on reconnect");
    expect(open(again.got.find((x) => x["type"] === "handler")).hintId).toBe(0);
    expect(late.got.some((x) => x["type"] === "handler")).toBe(false);
    for (const s of [asker, other, again, late]) s.ws.close();
  });
});
