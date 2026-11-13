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
  rebindDigest,
  sha256,
  toHex,
} from "@tail/protocol";
import { replayDigest, signRequestHeaders } from "../src/auth.ts";
import { CHAIN_VIEW_MS } from "../src/chainview.ts";
import type { Store, Zone } from "../src/db.ts";
import { MAX_OPEN_CHALLENGES_PER_HANDLE } from "../src/enroll.ts";
import { RATES } from "../src/limits.ts";
import { zoneHash } from "../src/matches.ts";
import { AccountTakenError } from "../src/near.ts";
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

describe("signed requests", () => {
  test("a signature only ZIP 215 accepts is refused: the small-order key that verifies anything", async () => {
    const env = setup();
    // The identity point as the account's key, and R = identity, S = 0: every message verifies
    // under the cofactored ZIP 215 rules, none under the strict ones.
    const identity = new Uint8Array(32);
    identity[0] = 1;
    seedDevice(env.store, `zed.${PARENT}`, identity, "phone", env.referee);
    const sig = new Uint8Array(64);
    sig[0] = 1;
    const res = await env.app.request("/enroll/status", {
      headers: {
        "x-tail-account": `zed.${PARENT}`,
        "x-tail-time": String(Date.now()),
        "x-tail-sig": Buffer.from(sig).toString("base64"),
      },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toBe("bad request signature");
  });
});

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
    extra: Record<string, unknown> = {},
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
      ...extra,
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

  test("the referee gets the attestation, challenge and rebind_sig exactly as sent, before the answer", async () => {
    const env = setup();
    const rebind = new Uint8Array(64).fill(5);
    const { r, challenge } = await attemptIn(env, "dana", undefined, {
      rebind_sig: Buffer.from(rebind).toString("base64"),
    });
    expect(r.status).toBe(200);
    expect(env.referee.enrolls[0]?.attestation).toEqual(new Uint8Array(Buffer.from("attestation")));
    expect(env.referee.enrolls[0]?.challenge).toEqual(challenge);
    expect(env.referee.enrolls[0]?.rebindSig).toEqual(rebind);
    const done = env.store.device(`dana.${PARENT}`);
    expect(done?.receipt).not.toBeNull();
    expect(done?.referee_pk).toEqual(env.referee.pk);
    expect(done?.attestation).toBeNull();
    expect(done?.challenge).toBeNull();
    // Without one, none is sent.
    expect((await attemptIn(env, "eli")).r.status).toBe(200);
    expect(env.referee.enrolls[1]?.rebindSig).toBeUndefined();
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

  test("a handle's open challenges are kept per client: a stranger asking for it cannot lock its owner out", async () => {
    const env = setup({ clientIpHeader: "x-client" });
    const ask = async (ip: string) => {
      const r = await env.app.request("/enroll/challenge", {
        method: "POST",
        headers: { "content-type": "application/json", "x-client": ip },
        body: JSON.stringify({ handle: "dana" }),
      });
      expect(r.status).toBe(200);
      return new Uint8Array(Buffer.from(((await r.json()) as { challenge: string }).challenge, "base64"));
    };
    const owner = await ask("10.0.0.1");
    // Past its slots, the stranger's own oldest goes; nobody is refused.
    const stranger: Uint8Array[] = [];
    for (let i = 0; i <= MAX_OPEN_CHALLENGES_PER_HANDLE; i++) stranger.push(await ask("10.0.0.2"));
    expect(env.store.takeEnrolChallenge(stranger[0] as Uint8Array)).toBeUndefined();
    expect(env.store.takeEnrolChallenge(stranger.at(-1) as Uint8Array)?.account_id).toBe(`dana.${PARENT}`);
    expect(env.store.takeEnrolChallenge(owner)?.account_id).toBe(`dana.${PARENT}`);
  });

  test("unanswered challenges are capped in all", () => {
    const env = setup();
    const caps = { total: 2, perAccount: 5 };
    const put = (n: number, now: number) =>
      env.store.putEnrolChallenge(new Uint8Array(32).fill(n), `h${n}`, "c", now + 100, now, caps);
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
    // The phone hears "enrolled" only once the referee holds the device.
    expect(env.store.device(`dana.${PARENT}`)?.receipt).not.toBeNull();
    expect(env.referee.calls).toContain("enroll");
  });

  test("while the referee does not answer, enrolment fails and leaves the handle free", async () => {
    const env = setup();
    env.referee.failEnrolls = 1;
    const down = await attemptIn(env);
    expect(down.r.status).toBe(502);
    expect(env.store.device(`dana.${PARENT}`)).toBeUndefined();
    expect(env.chain.accounts.has(`dana.${PARENT}`)).toBe(false);
    // The same phone tries again with the same keys and gets in.
    expect((await attemptIn(env, "dana", down.near)).r.status).toBe(200);
  });

  test("a referee refusal frees the handle and makes no account", async () => {
    const env = setup();
    env.referee.refuseEnrolls = 1;
    const refused = await attemptIn(env);
    expect(refused.r.status).toBe(502);
    expect(String(refused.r.json["error"])).toContain("The referee refused");
    expect(env.store.device(`dana.${PARENT}`)).toBeUndefined();
    expect(env.chain.accounts.size).toBe(0);
    expect((await attemptIn(env)).r.status).toBe(200);
  });

  test("a phone whose account was not made gets the handle with a new App Attest key and its own NEAR key's consent", async () => {
    const box = new Uint8Array(32).fill(1);
    const [k1, k2] = [new Uint8Array(65).fill(1), new Uint8Array(65).fill(2)];
    let attested = 0;
    const env = setup({ verifyAttestation: async () => (attested++ === 0 ? k1 : k2) });
    const account = `dana.${PARENT}`;
    const seed = ed25519.utils.randomSecretKey();
    const near = ed25519.getPublicKey(seed);
    const consent = (signer: Uint8Array) =>
      Buffer.from(
        ed25519.sign(rebindDigest(account, k2, box, ed25519.getPublicKey(signer)), signer),
      ).toString("base64");
    const create = env.chain.createPlayerAccount.bind(env.chain);
    env.chain.createPlayerAccount = async () => {
      throw new Error("rpc down");
    };
    expect((await attemptIn(env, "dana", near)).r.status).toBe(500);
    // The relay freed the handle; the referee keeps the record it stored, under this NEAR key.
    expect(env.store.device(account)).toBeUndefined();
    expect(env.referee.records.get(account)?.appAttestPk).toEqual(k1);
    env.chain.createPlayerAccount = create;
    // App Attest attests a key once, so the retry brings K2: without consent the referee refuses,
    const bare = await attemptIn(env, "dana", near);
    expect(String(bare.r.json["error"])).toContain("rebind_sig");
    // and another NEAR key cannot consent for the one the referee holds.
    const other = ed25519.utils.randomSecretKey();
    const stranger = await attemptIn(env, "dana", ed25519.getPublicKey(other), {
      rebind_sig: consent(other),
    });
    expect(String(stranger.r.json["error"])).toContain("not the enrolled device's signature");
    expect(env.store.device(account)).toBeUndefined();
    const ok = await attemptIn(env, "dana", near, { rebind_sig: consent(seed) });
    expect(ok.r.status).toBe(200);
    expect(env.store.device(account)?.app_attest_pk).toEqual(k2);
    expect(env.referee.records.get(account)?.appAttestPk).toEqual(k2);
    expect(env.chain.accounts.get(account)).toEqual(near);
  });

  test("an enrolment that fails gives the address back its share", async () => {
    const env = setup({ enrolCaps: { perDay: 10, perIpPerDay: 1 } });
    env.referee.refuseEnrolls = 1;
    expect((await attemptIn(env)).r.status).toBe(502);
    const create = env.chain.createPlayerAccount.bind(env.chain);
    env.chain.createPlayerAccount = async () => {
      throw new Error("rpc down");
    };
    expect((await attemptIn(env)).r.status).toBe(500);
    env.chain.createPlayerAccount = create;
    // (Another handle: the referee now holds dana under the failed attempt's NEAR key.)
    expect((await attemptIn(env, "fay")).r.status).toBe(200);
    // The one that went through counts.
    expect((await attemptIn(env, "eli")).r.status).toBe(429);
  });

  test("a handle taken on chain frees the row again", async () => {
    const env = setup();
    const create = env.chain.createPlayerAccount.bind(env.chain);
    env.chain.createPlayerAccount = async () => {
      throw new AccountTakenError("taken");
    };
    const taken = await attemptIn(env);
    expect(taken.r.status).toBe(409);
    expect(env.store.device(`dana.${PARENT}`)).toBeUndefined();
    env.chain.createPlayerAccount = create;
    expect((await attemptIn(env, "eli")).r.status).toBe(200);
  });

  test("new phones are capped per client address and per day", async () => {
    const env = setup({ enrolCaps: { perDay: 3, perIpPerDay: 2 }, clientIpHeader: "x-client" });
    const from = (ip: string) => ({ "x-client": ip });
    const enrol = async (handle: string, ip: string) => {
      const ch = await env.app.request("/enroll/challenge", {
        method: "POST",
        headers: { "content-type": "application/json", ...from(ip) },
        body: JSON.stringify({ handle }),
      });
      const challenge = ((await ch.json()) as { challenge: string }).challenge;
      const r = await env.app.request("/enroll", {
        method: "POST",
        headers: { "content-type": "application/json", ...from(ip) },
        body: JSON.stringify({
          challenge,
          key_id: Buffer.alloc(32, 9).toString("base64"),
          attestation: Buffer.from("attestation").toString("base64"),
          player_box_pk: Buffer.alloc(32, 1).toString("base64"),
          near_pk: Buffer.from(ed25519.getPublicKey(ed25519.utils.randomSecretKey())).toString("base64"),
        }),
      });
      return r.status;
    };
    expect(await enrol("a1", "10.0.0.1")).toBe(200);
    expect(await enrol("a2", "10.0.0.1")).toBe(200);
    expect(await enrol("a3", "10.0.0.1")).toBe(429);
    expect(await enrol("b1", "10.0.0.2")).toBe(200);
    // The relay's own daily share is used up, from any address.
    expect(await enrol("c1", "10.0.0.3")).toBe(429);
    expect(env.chain.accounts.size).toBe(3);
  });

  test("enrolment challenges are rate limited per client address", async () => {
    const env = setup({ clientIpHeader: "x-client" });
    const ask = (handle: string, ip: string) =>
      env.app.request("/enroll/challenge", {
        method: "POST",
        headers: { "content-type": "application/json", "x-client": ip },
        body: JSON.stringify({ handle }),
      });
    for (let i = 0; i < RATES.enrolChallenge.burst; i++)
      expect((await ask(`h${i}`, "10.0.0.1")).status).toBe(200);
    expect((await ask("hx", "10.0.0.1")).status).toBe(429);
    expect((await ask("hx", "10.0.0.2")).status).toBe(200);
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

// ── A referee re-pinned ────────────────────────────────────────────────────────────

describe("after the contract pins another referee", () => {
  /** A relay on the same database and chain as `env`, with a new referee (keys of its own). */
  function repinned(env: Env) {
    return setup({ store: env.store, chain: env.chain, referee: new FakeReferee() });
  }

  async function refresh(env: Env, p: Player, verified = true) {
    const ch = await req(env, "POST", "/enroll/refresh/challenge", {}, p);
    expect(ch.status).toBe(200);
    expect(ch.json["account_id"]).toBe(p.account);
    const body = {
      challenge: ch.json["challenge"],
      key_id: Buffer.alloc(32, 3).toString("base64"),
      attestation: Buffer.from(verified ? "fresh attestation" : "stale").toString("base64"),
      player_box_pk: Buffer.alloc(32, 2).toString("base64"),
      rebind_sig: Buffer.alloc(64, 6).toString("base64"),
    };
    return req(env, "POST", "/enroll/refresh", body, p);
  }

  test("Start names the players the new referee does not know, and each refresh brings one back", async () => {
    const old = setup();
    // Enrolled under the old referee; the lobby is made after the repin, so it pins the new one.
    const env = repinned(old);
    const l = await lobby(env, {}, (name) => player(old, name));
    const s = await req(env, "POST", `/matches/${l.id}/start`, {}, l.a);
    expect(s.status).toBe(409);
    expect(s.json["code"]).toBe("refresh");
    expect(s.json["accounts"]).toEqual([l.a.account, l.b.account, l.c.account]);
    expect(env.store.match(l.id)?.phase).toBe("lobby");
    expect((await req(env, "GET", "/enroll/status", undefined, l.b)).json).toEqual({
      account_id: l.b.account,
      with_referee: false,
      // Apple's keyId of the key the relay holds: SHA256 of the uncompressed key, base64.
      app_attest_key_id: Buffer.from(
        sha256(env.store.device(l.b.account)?.app_attest_pk ?? new Uint8Array()),
      ).toString("base64"),
    });

    for (const p of [l.a, l.b, l.c]) expect((await refresh(env, p)).status).toBe(200);
    const sent = env.referee.enrolls[0];
    expect(sent?.accountId).toBe(l.a.account);
    expect(sent?.attestation).toEqual(new Uint8Array(Buffer.from("fresh attestation")));
    expect(sent?.rebindSig).toEqual(new Uint8Array(64).fill(6));
    // The NEAR key stays the account's; the box key is the one the phone sent now.
    expect(sent?.nearPk).toEqual(ed25519.getPublicKey(l.a.seed));
    expect(env.store.device(l.a.account)?.player_box_pk).toEqual(new Uint8Array(32).fill(2));
    expect((await req(env, "GET", "/enroll/status", undefined, l.b)).json["with_referee"]).toBe(true);
    expect((await req(env, "POST", `/matches/${l.id}/start`, {}, l.a)).status).toBe(200);
  });

  test("Start asks the referee first: a device it cannot read is refreshed while the lobby stays open", async () => {
    const env = setup();
    const l = await lobby(env);
    env.referee.makeUnreadable(l.b.account);
    // The relay's receipt alone still says the referee holds it.
    expect((await req(env, "GET", "/enroll/status", undefined, l.b)).json["with_referee"]).toBe(true);
    const s = await req(env, "POST", `/matches/${l.id}/start`, {}, l.a);
    expect(s.status).toBe(409);
    expect(s.json["code"]).toBe("refresh");
    expect(s.json["accounts"]).toEqual([l.b.account]);
    // Nothing irreversible happened: no lock on chain, no referee start.
    expect(env.store.match(l.id)?.phase).toBe("lobby");
    expect(env.chain.locked).toEqual([]);
    expect(env.referee.calls).not.toContain("start");
    expect((await req(env, "GET", "/enroll/status", undefined, l.b)).json["with_referee"]).toBe(false);
    expect((await refresh(env, l.b)).status).toBe(200);
    expect((await req(env, "POST", `/matches/${l.id}/start`, {}, l.a)).status).toBe(200);
  });

  test("a lobby made under another referee's pins is refused before the lock", async () => {
    const old = setup();
    const l = await lobby(old);
    const env = repinned(old);
    const s = await req(env, "POST", `/matches/${l.id}/start`, {}, l.a);
    expect(s.status).toBe(409);
    expect(s.json["error"]).toContain("another referee");
    expect(s.json["code"]).toBeUndefined();
    expect(env.chain.locked).toEqual([]);
    expect(env.referee.calls).not.toContain("start");
    expect(env.store.match(l.id)?.phase).toBe("lobby");
    // The VRF caller counts as much as the keys.
    const fresh = await lobby(env, {}, (name) => player(env, `${name}2`));
    (env.chain.matches.get(fresh.id) as { vrf_sender: string | null }).vrf_sender = "someone-else.testnet";
    expect((await req(env, "POST", `/matches/${fresh.id}/start`, {}, fresh.a)).status).toBe(409);
  });

  test("a refresh the referee refuses keeps the old receipt; a refresh needs the account's own key", async () => {
    const old = setup();
    const a = player(old, "ana");
    const before = old.store.device(a.account);
    const env = repinned(old);
    env.referee.refuseEnrolls = 1;
    expect((await refresh(env, a)).status).toBe(502);
    expect(env.store.device(a.account)?.receipt).toEqual(before?.receipt as Uint8Array);
    expect((await req(env, "GET", "/enroll/status", undefined, a)).json["with_referee"]).toBe(false);
    // Unsigned: refused before any challenge is issued.
    expect((await req(env, "POST", "/enroll/refresh/challenge", {})).status).toBe(401);
    // A refresh challenge works only for the account it was issued to.
    const b = player(env, "bo");
    const ch = await req(env, "POST", "/enroll/refresh/challenge", {}, a);
    const stolen = await req(
      env,
      "POST",
      "/enroll/refresh",
      {
        challenge: ch.json["challenge"],
        key_id: Buffer.alloc(32, 3).toString("base64"),
        attestation: Buffer.from("x").toString("base64"),
        player_box_pk: Buffer.alloc(32, 2).toString("base64"),
        rebind_sig: Buffer.alloc(64, 6).toString("base64"),
      },
      b,
    );
    expect(stolen.status).toBe(401);
  });

  test("a refresh needs a 64-byte rebind_sig, checked before the challenge or the referee", async () => {
    const env = setup();
    const a = player(env, "ana");
    const ch = await env.enrolment.refreshChallenge(a.account, "c");
    const base = {
      challenge: new Uint8Array(Buffer.from(ch.challenge, "base64")),
      keyId: new Uint8Array(32),
      attestation: new Uint8Array(1),
      playerBoxPk: new Uint8Array(32),
    };
    for (const rebindSig of [undefined, new Uint8Array(63), new Uint8Array(65)]) {
      const r = env.enrolment.refresh(a.account, { ...base, rebindSig });
      await expect(r).rejects.toMatchObject({ status: 400 });
    }
    expect(env.referee.enrolls.length).toBe(0);
    // The challenge is still there for a well-formed refresh.
    expect(env.store.takeEnrolChallenge(base.challenge)?.account_id).toBe(a.account);
  });

  test("no refresh while the account plays in a match being started or running", async () => {
    const env = setup();
    const l = await lobby(env);
    const dan = player(env, "dan");
    const refused = async (p: Player) => {
      const ch = await req(env, "POST", "/enroll/refresh/challenge", {}, p);
      const r = await req(
        env,
        "POST",
        "/enroll/refresh",
        {
          challenge: Buffer.alloc(32, 1).toString("base64"),
          key_id: Buffer.alloc(32, 3).toString("base64"),
          attestation: Buffer.from("fresh attestation").toString("base64"),
          player_box_pk: Buffer.alloc(32, 2).toString("base64"),
          rebind_sig: Buffer.alloc(64, 6).toString("base64"),
        },
        p,
      );
      return [ch, r].every((x) => x.status === 409 && x.json["code"] === "in_match");
    };
    // Starting: the lobby on chain names the players before the relay stores them.
    expect(env.store.claimPhase(l.id, "lobby", "starting")).toBe(true);
    expect(await refused(l.b)).toBe(true);
    expect(await refused(dan)).toBe(false);
    env.store.setPhase(l.id, "lobby");
    expect(await refused(l.b)).toBe(false);
    expect((await req(env, "POST", `/matches/${l.id}/start`, {}, l.a)).status).toBe(200);
    expect(await refused(l.c)).toBe(true);
    expect(env.referee.enrolls.length).toBe(0);
    await ended(env, l.id);
    expect((await req(env, "POST", "/enroll/refresh/challenge", {}, l.c)).status).toBe(200);
  });

  test("a receipt from before the relay kept its referee counts when its signature is this referee's", async () => {
    const env = setup();
    const a = player(env, "ana");
    const b = player(repinned(env), "bo");
    env.store.db.query("UPDATE devices SET referee_pk = NULL").run();
    expect((await req(env, "GET", "/enroll/status", undefined, a)).json["with_referee"]).toBe(true);
    expect(env.store.device(a.account)?.referee_pk).toEqual(env.referee.pk);
    expect((await req(env, "GET", "/enroll/status", undefined, b)).json["with_referee"]).toBe(false);
    expect(env.store.device(b.account)?.referee_pk).toBeNull();
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
    const env = setup({ allowGhosts: true });
    const l = await twoPhones(env, 4);
    env.chain.join(l.id, player(env, "cy").account);
    const late = `ghost-late.${PARENT}`;
    seedDevice(env.store, late, ed25519.getPublicKey(ed25519.utils.randomSecretKey()), "ghost");
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

  test("after Start each player gets only its own sealed keys, the host included", async () => {
    const env = setup();
    env.referee.overAt = 1_000_000;
    const m = await started(env);
    const accounts = (keys: unknown) => (keys as { account_id: string }[]).map((k) => k.account_id);
    expect(accounts(m.start["keys"])).toEqual([m.a.account]);
    for (const p of [m.a, m.b, m.c]) {
      const view = await req(env, "GET", `/matches/${m.id}/zone`, undefined, p);
      expect(view.status).toBe(200);
      expect(accounts(view.json["keys"])).toEqual([p.account]);
    }
    const host = (await req(env, "GET", `/matches/${m.id}/zone`, undefined, m.a)).json["keys"];
    expect(host).toEqual(m.start["keys"]);
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
    // The host gets its own keys only.
    expect(ok.json["keys"]).toEqual([expect.objectContaining({ account_id: a.account })]);
    expect(appliedSeqs(env)[0]).toBe(1);
  });

  test("start registers a device an older relay left waiting; while it cannot, the lobby stays open", async () => {
    const env = setup();
    const [a, b] = [player(env, "ana"), player(env, "bo")];
    const cy = `cy.${PARENT}`;
    seedDevice(env.store, cy, ed25519.getPublicKey(ed25519.utils.randomSecretKey()), "phone");
    // A row from before synchronous enrolment: no receipt yet, the attestation kept for the referee.
    env.store.db
      .query("UPDATE devices SET attestation = ?, challenge = ? WHERE account_id = ?")
      .run(new Uint8Array([0xa1]), new Uint8Array(32).fill(7), cy);
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
