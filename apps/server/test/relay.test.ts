// The relay against in-memory fakes of the chain and the referee (test/fakes.ts): enrolment,
// signed requests, the ghost door, the lobby, the tick loop's failure handling, the replay and
// the HUD socket. Each refusal has a twin that succeeds. Waits poll with a deadline.

import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  badLogSalts,
  decodeLogEntry,
  decodeSignedVerdict,
  enrollClientDataHash,
  equal,
  fromHex,
  merkleLeaf,
  openSignedHud,
  openSignedVoiceLine,
  type ReplayBundle,
  type ReplayBundleV2,
  sha256,
  toHex,
} from "@tail/protocol";
import { replayDigest, signRequestHeaders } from "../src/auth.ts";
import { CHAIN_VIEW_MS } from "../src/chainview.ts";
import type { Store, Zone } from "../src/db.ts";
import { MAX_OPEN_CHALLENGES_PER_HANDLE } from "../src/enroll.ts";
import { zoneHash } from "../src/matches.ts";
import { GuardedReferee } from "../src/referee.ts";
import { FakeReferee, seedDevice, until } from "./fakes.ts";
import {
  appliedSeqs,
  CONTRACT,
  type Env,
  ended,
  hudSocket,
  lobby,
  MATCH,
  PARENT,
  type Player,
  player,
  req,
  setup,
  started,
} from "./harness.ts";

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

  async function attemptIn(
    env: Env,
    handle = "dana",
    near = ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
  ) {
    const ch = await req(env, "POST", "/enroll/challenge", { handle });
    expect(ch.status).toBe(200);
    const challenge = new Uint8Array(Buffer.from(String(ch.json["challenge"]), "base64"));
    const box = new Uint8Array(32).fill(1);
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
      challenge,
      expected: enrollClientDataHash(challenge, `${handle}.${PARENT}`, box, near),
    };
  }

  test("the referee gets the attestation and challenge exactly as sent; the relay drops them after", async () => {
    const env = setup({ refereeRetryMs: [] });
    const { r, challenge } = await attemptIn(env);
    expect(r.status).toBe(200);
    const kept = env.store.device(`dana.${PARENT}`);
    expect(kept?.attestation).toEqual(new Uint8Array(Buffer.from("attestation")));
    expect(kept?.challenge).toEqual(challenge);
    await env.enrolment.ensureWithReferee([`dana.${PARENT}`]);
    expect(env.referee.enrolls[0]?.attestation).toEqual(new Uint8Array(Buffer.from("attestation")));
    expect(env.referee.enrolls[0]?.challenge).toEqual(challenge);
    const done = env.store.device(`dana.${PARENT}`);
    expect(done?.receipt).not.toBeNull();
    expect(done?.attestation).toBeNull();
    expect(done?.challenge).toBeNull();
  });

  test("one device enrols once: its NEAR key under a second handle is refused", async () => {
    const env = setup();
    const near = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
    expect((await attemptIn(env, "dana", near)).r.status).toBe(200);
    const twice = await attemptIn(env, "dana2", near);
    expect(twice.r.status).toBe(409);
    expect(twice.r.json["error"]).toBe("this device is already enrolled");
    expect(env.chain.accounts.has(`dana2.${PARENT}`)).toBe(false);
    expect((await attemptIn(env, "dana3")).r.status).toBe(200);
  });

  test("the store refuses a second device with a known App Attest key", () => {
    const env = setup();
    const a = player(env, "ana");
    const pk = env.store.device(a.account)?.app_attest_pk as Uint8Array;
    expect(env.store.deviceWithKey(pk, new Uint8Array(32).fill(9))).toBe(a.account);
    expect(() =>
      env.store.putDevice({
        ...(env.store.device(a.account) as NonNullable<ReturnType<Store["device"]>>),
        account_id: `bo.${PARENT}`,
        near_pk: new Uint8Array(32).fill(9),
      }),
    ).toThrow("UNIQUE");
  });

  test("unanswered challenges are capped per handle; another handle still gets one", async () => {
    const env = setup();
    for (let i = 0; i < MAX_OPEN_CHALLENGES_PER_HANDLE; i++)
      expect((await req(env, "POST", "/enroll/challenge", { handle: "dana" })).status).toBe(200);
    const over = await req(env, "POST", "/enroll/challenge", { handle: "dana" });
    expect(over.status).toBe(429);
    expect((await req(env, "POST", "/enroll/challenge", { handle: "eli" })).status).toBe(200);
  });

  test("unanswered challenges are capped in all", () => {
    const env = setup();
    const caps = { total: 2, perAccount: 5 };
    const put = (n: number, now: number) =>
      env.store.putEnrolChallenge(new Uint8Array(32).fill(n), `h${n}`, now + 100, now, caps);
    expect(put(1, 0)).toBe(true);
    expect(put(2, 0)).toBe(true);
    expect(put(3, 0)).toBe(false);
    // Expired ones no longer count.
    expect(put(3, 1_000)).toBe(true);
  });

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
  const ghostKeys = (n: number) => ({
    appAttestPk: new Uint8Array(65).fill(n),
    playerBoxPk: new Uint8Array(32).fill(1),
    nearPk: ed25519.getPublicKey(new Uint8Array(32).fill(n)),
  });

  test("no HTTP route enrols a ghost, with the door open or shut", async () => {
    for (const allowGhosts of [false, true]) {
      const env = setup({ allowGhosts });
      expect((await req(env, "POST", "/dev/ghosts/enroll", ghostBody)).status).toBe(404);
      expect(env.chain.accounts.size).toBe(0);
    }
  });

  test("a ghost enrols in-process without an attestation and is recorded as a ghost", async () => {
    const env = setup({ allowGhosts: true });
    const r = await env.enrolment.enrollGhost({ handle: "ghost-ana", ...ghostKeys(4) });
    expect(r.account_id).toBe(`ghost-ana.${PARENT}`);
    expect(env.store.device(`ghost-ana.${PARENT}`)?.kind).toBe("ghost");
    // The referee gets no attestation for a ghost: it has none.
    await until(() => env.referee.enrolls.length, "the referee registration");
    expect(env.referee.enrolls[0]?.attestation).toBeUndefined();
  });

  test("a relay refuses to allow ghosts off testnet", () => {
    expect(() => setup({ allowGhosts: true, testnet: false })).toThrow("testnet only");
  });
});

describe("test players", () => {
  /** A lobby of `seats` hosted by ana, with ana and bo in it. */
  async function twoPhones(env: Env, seats = 3, extra: Record<string, unknown> = {}) {
    const [a, b] = [player(env, "ana"), player(env, "bo")];
    const r = await req(
      env,
      "POST",
      "/matches",
      { ...MATCH, max_players: seats, start_by_ms: Date.now() + 600_000, ...extra },
      a,
    );
    expect(r.status).toBe(200);
    const id = String(r.json["match_id"]);
    for (const p of [a, b]) env.chain.join(id, p.account);
    return { id, a, b };
  }
  const fill = (env: Env, id: string, as: Player) =>
    req(env, "POST", "/dev/ghosts/fill", { match_id: id }, as);

  test("the fill route does not exist unless ghosts are allowed", async () => {
    const env = setup({ allowGhosts: false });
    const l = await twoPhones(env);
    expect((await fill(env, l.id, l.a)).status).toBe(404);
    expect(env.chain.accounts.size).toBe(0);
  });

  test("only the host can add a test player", async () => {
    const env = setup({ allowGhosts: true });
    const l = await twoPhones(env);
    const r = await fill(env, l.id, l.b);
    expect(r.status).toBe(403);
    expect(r.json["error"]).toBe("only the host can add a test player");
    expect((await fill(env, l.id, l.a)).status).toBe(200);
  });

  test("a full, started or invite-only lobby gets no test player", async () => {
    const refusal = async (env: Env, l: { id: string; a: Player }) => {
      const r = await fill(env, l.id, l.a);
      expect(r.status).toBe(409);
      expect(env.chain.accounts.size).toBe(0);
      return r.json["error"];
    };
    const full = setup({ allowGhosts: true });
    expect(await refusal(full, await lobby(full))).toBe("the match is full");
    const run = setup({ allowGhosts: true });
    expect(await refusal(run, await started(run))).toBe("match is running");
    const inv = setup({ allowGhosts: true });
    expect(await refusal(inv, await twoPhones(inv, 3, { invites: [`ana.${PARENT}`, `bo.${PARENT}`] }))).toBe(
      "a test player cannot join an invite-only match",
    );
  });

  test("a fill enrols one ghost, tops it up by the stake, joins it, and the match can start", async () => {
    const env = setup({ allowGhosts: true });
    const l = await twoPhones(env);
    const r = await fill(env, l.id, l.a);
    expect(r.status).toBe(200);
    const ghost = String(r.json["account_id"]);
    expect(ghost).toMatch(new RegExp(`^ghost-[a-z0-9]{8}\\.${PARENT.replace(".", "\\.")}$`));
    expect(env.store.device(ghost)?.kind).toBe("ghost");
    expect(env.chain.topUps).toEqual([{ accountId: ghost, amount: BigInt(MATCH.stake) }]);
    const chain = await env.chain.getMatch(l.id);
    expect(chain?.players.map((p) => p.account_id)).toContain(ghost);
    expect(await env.chain.getBalance(ghost)).toBe(0n);
    const s = await req(env, "POST", `/matches/${l.id}/start`, {}, l.a);
    expect(s.status).toBe(200);
    expect(s.json["players"]).toContain(ghost);
  });

  test("a double tap seats one test player; a later call seats another", async () => {
    const env = setup({ allowGhosts: true });
    const l = await twoPhones(env, 4);
    let entered = false;
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const create = env.chain.createPlayerAccount.bind(env.chain);
    env.chain.createPlayerAccount = async (id, pk) => {
      entered = true;
      await gate;
      return create(id, pk);
    };
    const first = fill(env, l.id, l.a);
    await until(() => entered, "the first fill to be under way");
    const second = await fill(env, l.id, l.a);
    expect(second.status).toBe(409);
    expect(second.json["error"]).toBe("a test player is already joining");
    release();
    expect((await first).status).toBe(200);
    expect((await fill(env, l.id, l.a)).status).toBe(200);
    expect((await env.chain.getMatch(l.id))?.players.length).toBe(4);
    expect((await fill(env, l.id, l.a)).json["error"]).toBe("the match is full");
  });

  test("a player who joins just before the lock still reaches the referee before Start", async () => {
    const env = setup({ allowGhosts: true, refereeRetryMs: [] });
    const l = await twoPhones(env, 4);
    env.chain.join(l.id, player(env, "cy").account);
    const late = `ghost-late.${PARENT}`;
    seedDevice(env.store, late, ed25519.getPublicKey(ed25519.utils.randomSecretKey()), "ghost", false);
    const lock = env.chain.lockLobby.bind(env.chain);
    env.chain.lockLobby = async (id) => {
      env.chain.join(id, late);
      return lock(id);
    };
    const s = await req(env, "POST", `/matches/${l.id}/start`, {}, l.a);
    expect(s.status).toBe(200);
    expect(s.json["players"]).toContain(late);
    expect(env.store.device(late)?.receipt).not.toBeNull();
  });
});

// ── Signed requests ────────────────────────────────────────────────────────────────

describe("signed requests", () => {
  test("a request signed by another key is refused; the account's own key is accepted", async () => {
    const env = setup();
    const a = player(env, "ana");
    const body = { ...MATCH, start_by_ms: Date.now() + 600_000 };
    const forged = await req(env, "POST", "/matches", body, { ...a, seed: ed25519.utils.randomSecretKey() });
    expect(forged.status).toBe(401);
    expect((await req(env, "POST", "/matches", body, a)).status).toBe(200);
  });

  test("the same signed request sent twice is refused the second time", async () => {
    const env = setup();
    const a = player(env, "ana");
    const bytes = new TextEncoder().encode(JSON.stringify({ ...MATCH, start_by_ms: Date.now() + 600_000 }));
    const headers = {
      "content-type": "application/json",
      ...signRequestHeaders(
        { contractId: CONTRACT, accountId: a.account, method: "POST", path: "/matches", body: bytes },
        a.seed,
      ),
    };
    expect((await env.app.request("/matches", { method: "POST", headers, body: bytes })).status).toBe(200);
    const again = await env.app.request("/matches", { method: "POST", headers, body: bytes });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ code: "duplicate", error: "request already seen" });
    expect(env.chain.matches.size).toBe(1);
  });

  test("a signature made for another deployment's contract is refused", async () => {
    const env = setup();
    const a = player(env, "ana");
    const bytes = new TextEncoder().encode(JSON.stringify({ ...MATCH, start_by_ms: Date.now() + 600_000 }));
    const send = (contractId: string) =>
      env.app.request("/matches", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...signRequestHeaders(
            { contractId, accountId: a.account, method: "POST", path: "/matches", body: bytes },
            a.seed,
          ),
        },
        body: bytes,
      });
    expect((await send("tail.other.testnet")).status).toBe(401);
    expect((await send(CONTRACT)).status).toBe(200);
  });

  test("the relay names the contract it serves, the one requests are signed for", async () => {
    expect((await req(setup(), "GET", "/health")).json["contract"]).toBe(CONTRACT);
  });
});

// ── Lobby and start ────────────────────────────────────────────────────────────────

describe("the match view", () => {
  async function withSafehouse(env: Env, host: Player, extra: Record<string, unknown> = {}) {
    const safehouse = { lat_e7: 423_552_000, lon_e7: -710_655_000, radius_m: 25 };
    const created = await req(
      env,
      "POST",
      "/matches",
      { ...MATCH, safehouses: [safehouse], start_by_ms: Date.now() + 600_000, ...extra },
      host,
    );
    expect(created.status).toBe(200);
    return { id: String(created.json["match_id"]), zoneHash: String(created.json["zone_hash"]) };
  }

  test("the public view shows the lobby but not the zone, the sealed keys or the relay's error", async () => {
    const env = setup();
    env.referee.overAt = 1_000_000;
    const m = await started(env);
    const view = await req(env, "GET", `/matches/${m.id}`);
    expect(view.status).toBe(200);
    expect(Object.keys(view.json).sort()).toEqual(
      [
        "chain",
        "code",
        "end_ms",
        "host",
        "last_seq",
        "match_id",
        "phase",
        "players",
        "start_ms",
        "tick_no",
      ].sort(),
    );
    expect(view.json["phase"]).toBe("running");
  });

  test("the host gets the zone and safehouses, and they hash to the zone_hash it was given", async () => {
    const env = setup();
    const a = player(env, "ana");
    const { id, zoneHash: zh } = await withSafehouse(env, a);
    const view = await req(env, "GET", `/matches/${id}/zone`, undefined, a);
    expect(view.status).toBe(200);
    const zone = view.json["zone"] as Zone;
    expect(zone).toEqual({
      zone: { latE7: 423_550_000, lonE7: -710_656_000, radiusM: 1500 },
      safehouses: [{ latE7: 423_552_000, lonE7: -710_655_000, radiusM: 25 }],
    });
    expect(Buffer.from(zoneHash(zone)).toString("hex")).toBe(zh);
    // Twin: a different zone does not hash to the same value.
    expect(Buffer.from(zoneHash({ ...zone, safehouses: [] })).toString("hex")).not.toBe(zh);
    expect(view.json["keys"]).toEqual([]);
    expect(view.json["error"]).toBeNull();
  });

  test("the zone is refused unsigned and to strangers; an invitee and a player who just joined get it", async () => {
    const env = setup();
    const [a, b, eve] = [player(env, "ana"), player(env, "bo"), player(env, "eve")];
    const inv = player(env, "ivy");
    const { id } = await withSafehouse(env, a, { invites: [inv.account, a.account, b.account] });
    expect((await req(env, "GET", `/matches/${id}/zone`)).status).toBe(401);
    expect((await req(env, "GET", `/matches/${id}/zone`, undefined, eve)).status).toBe(403);
    expect((await req(env, "GET", `/matches/${id}/zone`, undefined, inv)).status).toBe(200);
    // bo is invited too; now take a non-invited lobby to check a fresh joiner.
    const open = await withSafehouse(env, b);
    expect((await req(env, "GET", `/matches/${open.id}`)).status).toBe(200); // fills the view cache
    env.chain.join(open.id, eve.account);
    expect((await req(env, "GET", `/matches/${open.id}/zone`, undefined, eve)).status).toBe(200);
    expect((await req(env, "GET", `/matches/${open.id}/zone`, undefined, a)).status).toBe(403);
  });

  test("after Start each player gets only its own sealed keys", async () => {
    const env = setup();
    env.referee.overAt = 1_000_000;
    const m = await started(env);
    const view = await req(env, "GET", `/matches/${m.id}/zone`, undefined, m.b);
    expect(view.status).toBe(200);
    const mine = (m.start["keys"] as { player: number }[]).filter((k) => k.player === 1);
    expect(view.json["keys"]).toEqual(mine);
    expect(mine).toHaveLength(1);
  });

  test("the public view reads the chain at most once per few seconds", async () => {
    let now = Date.now();
    const env = setup({ now: () => now });
    const { id } = await withSafehouse(env, player(env, "ana"));
    let reads = 0;
    const get = env.chain.getMatch.bind(env.chain);
    env.chain.getMatch = (mid) => {
      reads++;
      return get(mid);
    };
    for (let i = 0; i < 5; i++) expect((await req(env, "GET", `/matches/${id}`)).status).toBe(200);
    expect(reads).toBe(1);
    now += CHAIN_VIEW_MS;
    await req(env, "GET", `/matches/${id}`);
    expect(reads).toBe(2);
  });
});

describe("creating a match", () => {
  test("a match with no stake is refused before anyone can join; the referee would never start it", async () => {
    const env = setup();
    const a = player(env, "ana");
    const at = { ...MATCH, start_by_ms: Date.now() + 600_000 };
    const free = await req(env, "POST", "/matches", { ...at, stake: "0" }, a);
    expect(free.status).toBe(400);
    expect(free.json["error"]).toBe("stake must be more than 0");
    expect((await req(env, "POST", "/matches", at, a)).status).toBe(200);
  });

  test("a host holds one open lobby; once the chain calls it off, a new one opens", async () => {
    const env = setup();
    const [a, b] = [player(env, "ana"), player(env, "bo")];
    const at = () => ({ ...MATCH, start_by_ms: Date.now() + 600_000 });
    const first = await req(env, "POST", "/matches", at(), a);
    const id = String(first.json["match_id"]);
    const again = await req(env, "POST", "/matches", at(), a);
    expect(again.status).toBe(409);
    expect(again.json["match_id"]).toBe(id);
    expect(env.chain.matches.size).toBe(1);
    // Another host is not held up by ana's lobby.
    expect((await req(env, "POST", "/matches", at(), b)).status).toBe(200);
    env.chain.abort(id);
    expect((await req(env, "POST", "/matches", at(), a)).status).toBe(200);
    expect(env.store.match(id)?.phase).toBe("failed");
    expect(env.store.match(id)?.error).toBe("the lobby was aborted on chain");
  });

  test("a lobby whose start time passed no longer counts as open", async () => {
    let now = Date.now();
    const env = setup({ now: () => now });
    const a = player(env, "ana");
    const first = await req(env, "POST", "/matches", { ...MATCH, start_by_ms: Date.now() + 120_000 }, a);
    now += 180_000;
    const next = await req(env, "POST", "/matches", { ...MATCH, start_by_ms: Date.now() + 600_000 }, a);
    expect(next.status).toBe(200);
    expect(env.store.match(String(first.json["match_id"]))?.error).toBe("the lobby's start time passed");
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
    const one = await create(env, player(env, "ana"));
    const two = await create(env, player(env, "bo"));
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
    // The code is what lets people in, so it also shows them where the match is played.
    expect(known.json).toEqual({
      match_id: id,
      zone: { zone: { latE7: 423_550_000, lonE7: -710_656_000, radiusM: 1500 }, safehouses: [] },
    });
  });

  test("a code resolves in any case and without its dash; something that cannot be a code is refused", async () => {
    const env = setup();
    const { id, code } = await create(env, player(env, "ana"));
    const loose = code.replace("-", "").toLowerCase();
    expect((await req(env, "GET", `/join/${loose}`)).json["match_id"]).toBe(id);
    expect((await req(env, "GET", `/join/${loose.slice(0, 5)}0`)).status).toBe(400);
  });

  test("a code stops resolving once its match has started", async () => {
    const env = setup();
    const l = await lobby(env);
    const code = String((await req(env, "GET", `/matches/${l.id}`)).json["code"]);
    // /join reads the relay's own phase first, so a start shows at once.
    expect((await req(env, "GET", `/join/${code}`)).status).toBe(200);
    expect((await req(env, "POST", `/matches/${l.id}/start`, {}, l.a)).status).toBe(200);
    expect((await req(env, "GET", `/join/${code}`)).status).toBe(404);
  });

  test("a code stops resolving once its lobby is called off (after the view's few seconds)", async () => {
    let now = Date.now();
    const env = setup({ now: () => now });
    const { id, code } = await create(env, player(env, "ana"));
    expect((await req(env, "GET", `/join/${code}`)).status).toBe(200);
    env.chain.abort(id);
    now += CHAIN_VIEW_MS;
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
    expect(after.json["contract"]).toBe("tail.relay.testnet");
  });

  test("says test players are on offer only when the ghost door is open", async () => {
    expect((await req(setup(), "GET", "/health")).json["test_players"]).toBe(false);
    expect((await req(setup({ allowGhosts: true }), "GET", "/health")).json["test_players"]).toBe(true);
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
    const [h] = env.store.voiceHints(m.id, "consumed");
    // The relay keeps the line sealed to the asker and the receipt sealed to the referee.
    expect(openSignedVoiceLine(m.a.boxSk, h?.sealed as Uint8Array, env.referee.pk).text).toBe(
      "line for hint 0",
    );
    expect(h?.signed_text).toStartWith("fake-model:");
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
    const b = r.json as unknown as ReplayBundleV2;
    expect(b.version).toBe(2);
    expect(b.leaves).toEqual(env.store.leaves(m.id).map(toHex));
    expect(
      b.log.map((e) => toHex(merkleLeaf(decodeLogEntry(new Uint8Array(Buffer.from(e, "base64")))))),
    ).toEqual(b.leaves);
    expect(b.match.players).toEqual([`ana.${PARENT}`, `bo.${PARENT}`, `cy.${PARENT}`]);
    expect(b.log.length).toBe(env.store.log(m.id).length);
    expect(
      b.verdicts.map((v) => decodeSignedVerdict(new Uint8Array(Buffer.from(v.signed, "base64"))).body.kind),
    ).toEqual(["Start", "End"]);
    expect(b.verdicts.every((v) => typeof v.txHash === "string")).toBe(true);
    expect(b.reveal).toEqual({
      vrfAlpha: "vrf:1:x:y",
      vrfSignature: "00".repeat(64),
      ring: ["a", "b", "c"],
      kM: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // K_m is released with the log, so every salt checks.
    expect(
      badLogSalts(
        fromHex(b.reveal.kM),
        b.log.map((e) => decodeLogEntry(new Uint8Array(Buffer.from(e, "base64")))),
      ),
    ).toEqual([]);
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
    expect((ok.json as unknown as ReplayBundleV2).match.publicReplay).toBe(false);
  });

  test("the replay says per player what device it was and whether the referee checked its attestation", async () => {
    const env = setup({ allowGhosts: true });
    const [a, b] = [player(env, "ana"), player(env, "bo")];
    const r = await req(env, "POST", "/matches", { ...MATCH, start_by_ms: Date.now() + 600_000 }, a);
    const id = String(r.json["match_id"]);
    for (const p of [a, b]) env.chain.join(id, p.account);
    const ghost = String(
      (await req(env, "POST", "/dev/ghosts/fill", { match_id: id }, a)).json["account_id"],
    );
    env.referee.overAt = 1;
    expect((await req(env, "POST", `/matches/${id}/start`, {}, a)).status).toBe(200);
    await ended(env, id);
    const bundle = (await req(env, "GET", `/replay/${id}`)).json;
    const devices = bundle["devices"] as { accountId: string; kind: string; attested: boolean }[];
    expect(devices.find((x) => x.accountId === ghost)).toEqual({
      accountId: ghost,
      kind: "ghost",
      attested: false,
    });
    expect(devices.find((x) => x.accountId === a.account)).toEqual({
      accountId: a.account,
      kind: "phone",
      attested: true,
    });
  });

  test("a hint's Handler line is in the replay by its receipt's hint id, with the signed message only", async () => {
    const env = setup();
    const m = await started(env);
    await ended(env, m.id);
    const b = (await req(env, "GET", `/replay/${m.id}`)).json as unknown as ReplayBundleV2;
    const signedText = env.store.voiceHints(m.id, "consumed")[0]?.signed_text;
    expect(b.handler).toEqual([{ hintId: 0, signedText: signedText as string }]);
    expect(JSON.stringify(b)).not.toContain("line for hint 0");
  });

  test("a match from before protocol v2 is still served as the version 1 bundle it was", async () => {
    const env = setup();
    const m = await started(env);
    await ended(env, m.id);
    env.store.db.query("UPDATE matches SET protocol = NULL WHERE match_id = ?").run(m.id);
    env.store.db
      .query(
        "INSERT INTO hints (match_id, hint_id, asker, hint, value, issued_ms, text, chat_id, model, status) VALUES (?, 3, 0, 0, 1, 0, 'warmer', 'c', 'm', 'consumed')",
      )
      .run(m.id);
    const b = (await req(env, "GET", `/replay/${m.id}`)).json as unknown as ReplayBundle;
    expect(b.version).toBe(1);
    expect(b.handler).toEqual([{ hintId: 3, text: "warmer", chatId: "c", model: "m" }]);
    expect("leaves" in b).toBe(false);
  });
});

// ── HUD socket ─────────────────────────────────────────────────────────────────────

describe("the HUD socket", () => {
  const socket = hudSocket;

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
    const sealedHud = new Uint8Array(Buffer.from(String(hud?.["sealed"]), "base64"));
    // Sealed to bo's box key and signed by the referee; bo is player 1.
    expect(openSignedHud(m.b.boxSk, sealedHud, env.referee.pk).player).toBe(1);
    s.ws.close();
  });
});
