// The relay against in-memory fakes of the chain and the referee (test/fakes.ts): enrolment,
// signed requests, the ghost door, the lobby, the tick loop's failure handling, the replay and
// the HUD socket. Each refusal has a twin that succeeds. Waits poll with a deadline.

import { afterEach, describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeSignedVerdict, enrollClientDataHash, equal, type ReplayBundle, sha256 } from "@tail/protocol";
import { createRelay, type RelayDeps } from "../src/app.ts";
import { hudDigest, replayDigest, signRequestHeaders } from "../src/auth.ts";
import { Store, type Zone } from "../src/db.ts";
import { zoneHash } from "../src/matches.ts";
import { GuardedReferee } from "../src/referee.ts";
import { FakeChain, FakeReferee, quietLog, seedDevice, until } from "./fakes.ts";

const PARENT = "relay.testnet";
const relays: { stop: () => void }[] = [];
afterEach(() => {
  for (const r of relays.splice(0)) r.stop();
});

function setup(over: Partial<RelayDeps> = {}) {
  const store = new Store(":memory:");
  const chain = new FakeChain();
  const referee = new FakeReferee();
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
    verifyAttestation: async () => new Uint8Array(65).fill(4),
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

type Env = ReturnType<typeof setup>;
interface Player {
  account: string;
  seed: Uint8Array;
}

function player(env: Env, name: string): Player {
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

async function req(
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

const MATCH = {
  stake: "1000000",
  duration_ms: 300_000,
  zone: { lat_e7: 423_550_000, lon_e7: -710_656_000, radius_m: 1500 },
  public_replay: true,
  min_players: 3,
  max_players: 3,
};

async function lobby(env: Env) {
  const [a, b, c] = [player(env, "ana"), player(env, "bo"), player(env, "cy")] as [Player, Player, Player];
  const r = await req(env, "POST", "/matches", { ...MATCH, start_by_ms: Date.now() + 600_000 }, a);
  expect(r.status).toBe(200);
  const id = String(r.json["match_id"]);
  for (const p of [a, b, c]) env.chain.join(id, p.account);
  return { id, a, b, c };
}

async function started(env: Env) {
  const l = await lobby(env);
  const r = await req(env, "POST", `/matches/${l.id}/start`, {}, l.a);
  expect(r.status).toBe(200);
  return { ...l, start: r.json };
}

const ended = (env: Env, id: string) =>
  until(() => env.store.match(id)?.phase === "ended", "the match to end");
const appliedSeqs = (env: Env) =>
  env.chain.applied.map((raw) => new DataView(raw.buffer, raw.byteOffset + 16, 4).getUint32(0, true));

// ── Enrolment ──────────────────────────────────────────────────────────────────────

describe("enrolment", () => {
  async function attempt(verdict: boolean) {
    let seenHash: Uint8Array | undefined;
    const env = setup({
      verifyAttestation: async (i) => {
        seenHash = i.clientDataHash;
        if (!verdict) throw new Error("step 4: nonce");
        return new Uint8Array(65).fill(4);
      },
    });
    const out = await attemptIn(env);
    return { ...out, seenHash };
  }

  async function attemptIn(env: Env) {
    const ch = await req(env, "POST", "/enroll/challenge", { handle: "dana" });
    expect(ch.status).toBe(200);
    const challenge = new Uint8Array(Buffer.from(String(ch.json["challenge"]), "base64"));
    const box = new Uint8Array(32).fill(1);
    const near = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
    const body = {
      challenge: ch.json["challenge"],
      key_id: Buffer.alloc(32, 9).toString("base64"),
      attestation: Buffer.from("attestation").toString("base64"),
      player_box_pk: Buffer.from(box).toString("base64"),
      near_pk: Buffer.from(near).toString("base64"),
    };
    const r = await req(env, "POST", "/enroll", body);
    return {
      env,
      r,
      ch,
      body,
      near,
      expected: enrollClientDataHash(challenge, `dana.${PARENT}`, box, near),
    };
  }

  test("a phone enrols with an attestation over its challenge and gets an account holding its key", async () => {
    const { env, r, near, seenHash, expected } = await attempt(true);
    expect(r.status).toBe(200);
    expect(r.json["account_id"]).toBe(`dana.${PARENT}`);
    expect(seenHash && equal(seenHash, expected)).toBe(true);
    expect(env.chain.accounts.get(`dana.${PARENT}`)).toEqual(near);
    expect(env.store.device(`dana.${PARENT}`)?.kind).toBe("phone");
    // The referee gets the device just after the phone's answer, not before it.
    await until(() => env.store.device(`dana.${PARENT}`)?.receipt, "the referee's receipt");
    expect(env.referee.calls).toContain("enroll");
  });

  test("enrolment answers while the referee is down, and the device reaches the referee once it is back", async () => {
    const env = setup({ refereeRetryMs: [0, 10] });
    env.referee.failEnrolls = 1;
    const { r } = await attemptIn(env);
    expect(r.status).toBe(200);
    await until(() => env.store.device(`dana.${PARENT}`)?.receipt, "the retried receipt");
    expect(env.referee.calls.filter((c) => c === "enroll").length).toBe(2);
    expect(env.store.devicesAwaitingReferee()).toEqual([]);
  });

  test("an enrolment whose attestation does not verify is refused and creates nothing", async () => {
    const { env, r } = await attempt(false);
    expect(r.status).toBe(401);
    expect(env.chain.accounts.size).toBe(0);
    expect(env.store.device(`dana.${PARENT}`)).toBeUndefined();
  });

  test("a challenge works only once", async () => {
    const { env, r, body } = await attempt(true);
    expect(r.status).toBe(200);
    const again = await req(env, "POST", "/enroll", body);
    expect(again.status).toBe(401);
  });

  test("a phone cannot take a ghost- handle, but can take a plain one", async () => {
    const env = setup();
    expect((await req(env, "POST", "/enroll/challenge", { handle: "ghost-dana" })).status).toBe(400);
    expect((await req(env, "POST", "/enroll/challenge", { handle: "dana" })).status).toBe(200);
  });
});

describe("the ghost door", () => {
  const ghostBody = {
    handle: "ghost-ana",
    app_attest_pk: Buffer.alloc(65, 4).toString("base64"),
    player_box_pk: Buffer.alloc(32, 1).toString("base64"),
    near_pk: Buffer.alloc(32, 2).toString("base64"),
  };

  test("the ghost enrolment route does not exist unless ghosts are allowed", async () => {
    const env = setup({ allowGhosts: false });
    expect((await req(env, "POST", "/dev/ghosts/enroll", ghostBody)).status).toBe(404);
    expect(env.chain.accounts.size).toBe(0);
  });

  test("with ghosts allowed, a ghost enrols without an attestation and is recorded as a ghost", async () => {
    const env = setup({ allowGhosts: true });
    const r = await req(env, "POST", "/dev/ghosts/enroll", ghostBody);
    expect(r.status).toBe(200);
    expect(env.store.device(`ghost-ana.${PARENT}`)?.kind).toBe("ghost");
  });

  test("a relay refuses to allow ghosts off testnet", () => {
    expect(() => setup({ allowGhosts: true, testnet: false })).toThrow("testnet only");
  });
});

// ── Signed requests ────────────────────────────────────────────────────────────────

describe("signed requests", () => {
  test("a request signed by another key is refused; the account's own key is accepted", async () => {
    const env = setup();
    const a = player(env, "ana");
    const body = { ...MATCH, start_by_ms: Date.now() + 600_000 };
    const forged = await req(env, "POST", "/matches", body, {
      account: a.account,
      seed: ed25519.utils.randomSecretKey(),
    });
    expect(forged.status).toBe(401);
    expect((await req(env, "POST", "/matches", body, a)).status).toBe(200);
  });

  test("the same signed request sent twice is refused the second time", async () => {
    const env = setup();
    const a = player(env, "ana");
    const bytes = new TextEncoder().encode(JSON.stringify({ ...MATCH, start_by_ms: Date.now() + 600_000 }));
    const headers = {
      "content-type": "application/json",
      ...signRequestHeaders(a.account, a.seed, "POST", "/matches", bytes),
    };
    expect((await env.app.request("/matches", { method: "POST", headers, body: bytes })).status).toBe(200);
    expect((await env.app.request("/matches", { method: "POST", headers, body: bytes })).status).toBe(409);
    expect(env.chain.matches.size).toBe(1);
  });
});

// ── Lobby and start ────────────────────────────────────────────────────────────────

describe("the match view", () => {
  test("serves the zone and safehouses, and they hash to the zone_hash the host was given", async () => {
    const env = setup();
    const a = player(env, "ana");
    const safehouse = { lat_e7: 423_552_000, lon_e7: -710_655_000, radius_m: 25 };
    const created = await req(
      env,
      "POST",
      "/matches",
      { ...MATCH, safehouses: [safehouse], start_by_ms: Date.now() + 600_000 },
      a,
    );
    expect(created.status).toBe(200);
    const view = await req(env, "GET", `/matches/${String(created.json["match_id"])}`);
    expect(view.status).toBe(200);
    const zone = view.json["zone"] as Zone;
    expect(zone).toEqual({
      zone: { latE7: 423_550_000, lonE7: -710_656_000, radiusM: 1500 },
      safehouses: [{ latE7: 423_552_000, lonE7: -710_655_000, radiusM: 25 }],
    });
    expect(Buffer.from(zoneHash(zone)).toString("hex")).toBe(String(created.json["zone_hash"]));
    // Twin: a different zone does not hash to the same value.
    expect(Buffer.from(zoneHash({ ...zone, safehouses: [] })).toString("hex")).not.toBe(
      String(created.json["zone_hash"]),
    );
  });
});

describe("lobby codes", () => {
  const CODE = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{3}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{3}$/;

  async function create(env: Env, host: Player) {
    const r = await req(env, "POST", "/matches", { ...MATCH, start_by_ms: Date.now() + 600_000 }, host);
    expect(r.status).toBe(200);
    return { id: String(r.json["match_id"]), code: String(r.json["code"]) };
  }

  test("creating a match returns a short code, and the match view shows the same code", async () => {
    const env = setup();
    const a = player(env, "ana");
    const one = await create(env, a);
    const two = await create(env, a);
    expect(one.code).toMatch(CODE);
    expect(two.code).not.toBe(one.code);
    expect((await req(env, "GET", `/matches/${one.id}`)).json["code"]).toBe(one.code);
  });

  test("an unknown code is not found; the lobby's own code resolves to its match", async () => {
    const env = setup();
    const { id, code } = await create(env, player(env, "ana"));
    const unknown = code === "ZZZ-ZZZ" ? "YYY-YYY" : "ZZZ-ZZZ";
    expect((await req(env, "GET", `/join/${unknown}`)).status).toBe(404);
    const known = await req(env, "GET", `/join/${code}`);
    expect(known.status).toBe(200);
    expect(known.json).toEqual({ match_id: id });
  });

  test("a code resolves in any case and without its dash; something that cannot be a code is refused", async () => {
    const env = setup();
    const { id, code } = await create(env, player(env, "ana"));
    const loose = code.replace("-", "").toLowerCase();
    expect((await req(env, "GET", `/join/${loose}`)).json).toEqual({ match_id: id });
    expect((await req(env, "GET", `/join/${loose.slice(0, 5)}0`)).status).toBe(400);
  });

  test("a code stops resolving once its match has started", async () => {
    const env = setup();
    const l = await lobby(env);
    const code = String((await req(env, "GET", `/matches/${l.id}`)).json["code"]);
    expect((await req(env, "GET", `/join/${code}`)).status).toBe(200);
    expect((await req(env, "POST", `/matches/${l.id}/start`, {}, l.a)).status).toBe(200);
    expect((await req(env, "GET", `/join/${code}`)).status).toBe(404);
  });

  test("a code stops resolving once its lobby is called off", async () => {
    const env = setup();
    const { id, code } = await create(env, player(env, "ana"));
    expect((await req(env, "GET", `/join/${code}`)).status).toBe(200);
    env.chain.abort(id);
    expect((await req(env, "GET", `/join/${code}`)).status).toBe(404);
  });
});

describe("starting a match", () => {
  test("only the host can start the match", async () => {
    const env = setup();
    const l = await lobby(env);
    expect((await req(env, "POST", `/matches/${l.id}/start`, {}, l.b)).status).toBe(403);
    expect((await req(env, "POST", `/matches/${l.id}/start`, {}, l.a)).status).toBe(200);
  });

  test("start waits for enough players; with them it locks the lobby, starts the referee and applies Start", async () => {
    const env = setup();
    const a = player(env, "ana");
    const r = await req(env, "POST", "/matches", { ...MATCH, start_by_ms: Date.now() + 600_000 }, a);
    const id = String(r.json["match_id"]);
    env.chain.join(id, a.account);
    const early = await req(env, "POST", `/matches/${id}/start`, {}, a);
    expect(early.status).toBe(409);
    expect(env.store.match(id)?.phase).toBe("lobby");
    for (const p of [player(env, "bo"), player(env, "cy")]) env.chain.join(id, p.account);
    const ok = await req(env, "POST", `/matches/${id}/start`, {}, a);
    expect(ok.status).toBe(200);
    expect(env.chain.locked).toEqual([id]);
    expect(ok.json["players"]).toEqual([`ana.${PARENT}`, `bo.${PARENT}`, `cy.${PARENT}`]);
    expect((ok.json["keys"] as unknown[]).length).toBe(3);
    expect(appliedSeqs(env)[0]).toBe(1);
  });

  test("start registers any device the referee does not have yet; while it cannot, the lobby stays open", async () => {
    const env = setup({ refereeRetryMs: [] });
    const [a, b] = [player(env, "ana"), player(env, "bo")];
    const cy = `cy.${PARENT}`;
    seedDevice(env.store, cy, ed25519.getPublicKey(ed25519.utils.randomSecretKey()), "phone", false);
    const r = await req(env, "POST", "/matches", { ...MATCH, start_by_ms: Date.now() + 600_000 }, a);
    const id = String(r.json["match_id"]);
    for (const acc of [a.account, b.account, cy]) env.chain.join(id, acc);

    env.referee.failEnrolls = 1;
    const down = await req(env, "POST", `/matches/${id}/start`, {}, a);
    expect(down.status).toBe(502);
    expect(String(down.json["error"])).toBe("The referee didn't answer. Try again.");
    expect(env.store.match(id)?.phase).toBe("lobby");
    expect(env.chain.locked).toEqual([]);

    const ok = await req(env, "POST", `/matches/${id}/start`, {}, a);
    expect(ok.status).toBe(200);
    expect(env.store.device(cy)?.receipt).not.toBeNull();
  });
});

describe("health", () => {
  test("reports which referee is behind the relay and whether it is answering", async () => {
    const referee = new GuardedReferee(new FakeReferee(), "local");
    const env = setup({ referee, refereeHealth: () => referee.health() });
    const before = await req(env, "GET", "/health");
    expect(before.json["referee"]).toEqual({
      kind: "local",
      status: "unknown",
      last_ok_ms: null,
      last_error: null,
    });
    await referee.pubkeys();
    const after = await req(env, "GET", "/health");
    expect((after.json["referee"] as Record<string, unknown>)["status"]).toBe("up");
  });
});

// ── Batches and the tick loop ──────────────────────────────────────────────────────

const sealed = (n: number) => Buffer.alloc(64, n).toString("base64");

describe("the tick loop", () => {
  test("a player's batch is queued; a non-player's is refused", async () => {
    const env = setup();
    env.referee.overAt = 1_000_000;
    const m = await started(env);
    const outsider = player(env, "eve");
    expect((await req(env, "POST", "/batch", { match_id: m.id, sealed: sealed(1) }, outsider)).status).toBe(
      403,
    );
    const ok = await req(env, "POST", "/batch", { match_id: m.id, sealed: sealed(1) }, m.b);
    expect(ok.status).toBe(200);
    expect(ok.json["player"]).toBe(1);
  });

  test("a match runs to the end: verdicts land in seq order, then End, then the reveal", async () => {
    const env = setup();
    const m = await started(env);
    await req(env, "POST", "/batch", { match_id: m.id, sealed: sealed(1) }, m.a);
    await ended(env, m.id);
    expect(appliedSeqs(env)).toEqual([1, 2, 3]);
    expect(env.store.verdicts(m.id).map((v) => v.kind)).toEqual(["Start", "Hint", "End"]);
    expect(env.store.match(m.id)?.reveal?.["ring"]).toEqual(["a", "b", "c"]);
    expect(env.referee.calls.slice(-3)).toEqual(["end", "declassify", "declassify_batches"]);
    expect(env.matches.active(m.id)).toBe(false);
  });

  test("a referee failure keeps the batches; each reaches a successful tick exactly once", async () => {
    const env = setup();
    env.referee.failTicks = 2;
    const m = await started(env);
    await req(env, "POST", "/batch", { match_id: m.id, sealed: sealed(1) }, m.a);
    await req(env, "POST", "/batch", { match_id: m.id, sealed: sealed(2) }, m.b);
    await ended(env, m.id);
    expect(env.referee.calls.filter((c) => c === "tick").length).toBeGreaterThanOrEqual(5);
    expect(env.referee.ticksSeen.reduce((n, t) => n + t.batches, 0)).toBe(2);
  });

  test("the same bytes are queued once while they wait for a tick", () => {
    const env = setup();
    const b = new Uint8Array(64).fill(7);
    expect(env.store.enqueueBatch("m", 0, b, sha256(b), 1)).toBe(true);
    expect(env.store.enqueueBatch("m", 0, b, sha256(b), 2)).toBe(false);
    expect(env.store.queuedBatches("m", 10)).toHaveLength(1);
  });

  test("bytes the referee already saw can be queued again, so a phone can resend after a seq gap", () => {
    const env = setup();
    const b = new Uint8Array(64).fill(7);
    env.store.enqueueBatch("m", 0, b, sha256(b), 1);
    env.store.markBatchesSent(
      env.store.queuedBatches("m", 10).map((q) => q.id),
      1,
    );
    expect(env.store.enqueueBatch("m", 0, b, sha256(b), 2)).toBe(true);
    expect(env.store.queuedBatches("m", 10)).toHaveLength(1);
    expect(env.store.allBatches("m")).toHaveLength(2);
  });

  test("a lost apply answer does not submit any verdict twice", async () => {
    const env = setup();
    env.chain.loseNextApplyAnswer = true;
    const m = await started(env);
    await ended(env, m.id);
    expect(appliedSeqs(env)).toEqual([1, 2, 3]);
  });

  test("a failed apply is retried before the next tick, and the verdicts still land in order", async () => {
    const env = setup();
    env.chain.failNextApply = true;
    const m = await started(env);
    await ended(env, m.id);
    expect(appliedSeqs(env)).toEqual([1, 2, 3]);
    expect(env.chain.applyCalls).toBeGreaterThan(3);
  });

  test("two ticks of one match never run at the same time", async () => {
    const env = setup({ tickMs: 1 });
    env.referee.tickDelayMs = 20;
    env.referee.overAt = 6;
    const m = await started(env);
    await ended(env, m.id);
    expect(env.referee.maxInFlight).toBe(1);
  });

  test("a tick whose log does not match the relay's copy is discarded; the retry is stored", async () => {
    const env = setup();
    env.referee.lieAboutLog = true;
    const m = await started(env);
    await ended(env, m.id);
    const ticks = env.store.ticks(m.id).map((t) => t.tick_no);
    expect(ticks).toEqual([1, 2, 3]);
    expect(env.referee.calls.filter((c) => c === "tick").length).toBe(4);
    expect(env.store.log(m.id).length).toBeGreaterThan(0);
  });

  test("a hint is voiced and its receipt goes into the next tick", async () => {
    const env = setup();
    const m = await started(env);
    await ended(env, m.id);
    expect(env.referee.calls).toContain("voice");
    expect(env.referee.ticksSeen.map((t) => t.receipts)).toEqual([0, 0, 1]);
    expect(env.store.hints(m.id, "consumed").map((h) => h.text)).toEqual(["line for hint 0"]);
  });
});

// ── Replay ─────────────────────────────────────────────────────────────────────────

describe("the replay", () => {
  test("is refused while the match runs and served as a ReplayBundle once it has ended", async () => {
    const env = setup();
    env.referee.overAt = 1_000_000;
    const m = await started(env);
    expect((await req(env, "GET", `/replay/${m.id}`)).status).toBe(409);
    await req(env, "POST", "/batch", { match_id: m.id, sealed: sealed(1) }, m.a);
    await req(env, "POST", "/batch", { match_id: m.id, sealed: sealed(2) }, m.b);
    env.referee.overAt = 0;
    await ended(env, m.id);
    const r = await req(env, "GET", `/replay/${m.id}`);
    expect(r.status).toBe(200);
    const b = r.json as unknown as ReplayBundle;
    expect(b.version).toBe(1);
    expect(b.match.players).toEqual([`ana.${PARENT}`, `bo.${PARENT}`, `cy.${PARENT}`]);
    expect(b.log.length).toBe(env.store.log(m.id).length);
    expect(
      b.verdicts.map((v) => decodeSignedVerdict(new Uint8Array(Buffer.from(v.signed, "base64"))).body.kind),
    ).toEqual(["Start", "End"]);
    expect(b.verdicts.every((v) => typeof v.txHash === "string")).toBe(true);
    expect(b.reveal).toEqual({ vrfAlpha: "vrf:1:x:y", vrfSignature: "00".repeat(64), ring: ["a", "b", "c"] });
    // Both forwarded batches come back opened; the one the log never held is dropped.
    expect(b.batches).toEqual([sealed(1), sealed(2)]);
  });

  test("after End the relay opens every forwarded batch in chunks of 500 and keeps the logged ones", async () => {
    const env = setup();
    const m = await started(env);
    for (let i = 0; i < 501; i++) {
      const b = new Uint8Array(64);
      new DataView(b.buffer).setUint32(0, i);
      env.store.enqueueBatch(m.id, i % 3, b, sha256(b), Date.now());
    }
    await ended(env, m.id);
    expect(env.referee.declassifyChunks).toEqual([500, 1]);
    expect(env.store.trails(m.id).length).toBe(501);
  });

  test("a private replay is refused without a player's signature and served with one", async () => {
    const env = setup();
    env.referee.overAt = 1;
    const [a, b, c] = [player(env, "ana"), player(env, "bo"), player(env, "cy")] as [Player, Player, Player];
    const created = await req(
      env,
      "POST",
      "/matches",
      { ...MATCH, public_replay: false, start_by_ms: Date.now() + 600_000 },
      a,
    );
    const id = String(created.json["match_id"]);
    for (const p of [a, b, c]) env.chain.join(id, p.account);
    expect((await req(env, "POST", `/matches/${id}/start`, {}, a)).status).toBe(200);
    await ended(env, id);
    expect((await req(env, "GET", `/replay/${id}`)).status).toBe(403);

    const ask = async (signer: Uint8Array) => {
      const ch = await req(env, "POST", `/replay/${id}/challenge`, { account_id: b.account });
      const nonce = new Uint8Array(Buffer.from(String(ch.json["nonce"]), "base64"));
      const sig = ed25519.sign(
        replayDigest(nonce, Uint8Array.from(Buffer.from(id, "hex")), b.account),
        signer,
      );
      const q = new URLSearchParams({
        account_id: b.account,
        nonce: Buffer.from(nonce).toString("base64"),
        sig: Buffer.from(sig).toString("base64"),
      });
      return req(env, "GET", `/replay/${id}?${q}`);
    };
    expect((await ask(ed25519.utils.randomSecretKey())).status).toBe(403);
    const ok = await ask(b.seed);
    expect(ok.status).toBe(200);
    expect((ok.json as unknown as ReplayBundle).match.publicReplay).toBe(false);
  });

  test("a hint's Handler line is in the replay", async () => {
    const env = setup();
    const m = await started(env);
    await ended(env, m.id);
    const b = (await req(env, "GET", `/replay/${m.id}`)).json as unknown as ReplayBundle;
    expect(b.handler).toEqual([{ hintId: 0, text: "line for hint 0", chatId: "", model: "" }]);
  });
});

// ── HUD socket ─────────────────────────────────────────────────────────────────────

describe("the HUD socket", () => {
  async function socket(env: Env, matchId: string, who: Player, signer: Uint8Array) {
    const server = Bun.serve({ port: 0, fetch: env.app.fetch, websocket: env.websocket });
    relays.push({ stop: () => server.stop(true) });
    const ws = new WebSocket(
      `ws://localhost:${server.port}/hud?match_id=${matchId}&account_id=${who.account}`,
    );
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

  test("a socket signed with another key is closed without a HUD", async () => {
    const env = setup();
    env.referee.overAt = 1_000_000;
    const m = await started(env);
    const s = await socket(env, m.id, m.b, ed25519.utils.randomSecretKey());
    await until(() => s.closed.code, "the socket to close");
    expect(s.closed.code).toBe(4401);
    expect(s.got.map((x) => x["type"])).toEqual(["challenge"]);
  });

  test("a socket signed with the player's key gets its sealed keys and then its HUDs", async () => {
    const env = setup();
    env.referee.overAt = 1_000_000;
    const m = await started(env);
    const s = await socket(env, m.id, m.b, m.b.seed);
    await until(() => s.got.some((x) => x["type"] === "hud"), "a HUD");
    expect(s.got.map((x) => x["type"]).slice(0, 3)).toEqual(["challenge", "ready", "keys"]);
    const hud = s.got.find((x) => x["type"] === "hud");
    // The fake referee seals HUD n for player p as the bytes [n, p]; player bo is index 1.
    expect(Buffer.from(String(hud?.["sealed"]), "base64")[1]).toBe(1);
    s.ws.close();
  });
});
