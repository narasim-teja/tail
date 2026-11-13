import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import {
  boxPublicKey,
  concat,
  enrollClientDataHash,
  rebindDigest,
  requestDigest,
  sha256,
  utf8,
} from "@tail/protocol";
import { credentialKey } from "../../test/appattest";
import { fromB64, toB64 } from "../lib/b64";
import { RelayError } from "../proximity/relay";
import { RelayClient, refreshNeeded } from "../relay/client";
import { attestedPublicKey } from "./attestedKey";
import {
  type Attestor,
  ENROL_RECHECK_MS,
  enrol,
  ensureEnrolled,
  type HuntFacts,
  keyWorks,
  mayReenrol,
  refreshEnrolment,
  startRecheckDue,
  withRefresh,
} from "./enrol";
import {
  attestKeyIds,
  type Identity,
  loadIdentity,
  nearSigner,
  type SecretStore,
  saveAccount,
  savePendingAttestKeyId,
  settleAttestKeyId,
} from "./identity";

function memoryStore(): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => {
      map.set(k, v);
    },
    delete: async (k) => {
      map.delete(k);
    },
  };
}

describe("identity", () => {
  test("the first launch creates the box and NEAR keys, and later launches load the same ones", async () => {
    const s = memoryStore();
    const a = await loadIdentity(s);
    const b = await loadIdentity(s);
    expect(b.boxSk).toEqual(a.boxSk);
    expect(b.nearPk).toEqual(ed25519.getPublicKey(a.nearSk));
    expect(a.boxPk).toEqual(boxPublicKey(a.boxSk));
    expect(a.accountId).toBeNull();
  });

  test("enrolment attests over the protocol's clientDataHash and stores the account", async () => {
    const s = memoryStore();
    const id = await loadIdentity(s);
    const challenge = new Uint8Array(32).fill(3);
    let attestedHash: Uint8Array | undefined;
    let enrolBody: Record<string, string> | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      if (url.endsWith("/enroll/challenge")) {
        return Response.json({
          challenge: Buffer.from(challenge).toString("base64"),
          account_id: "alice.tail.testnet",
          expires_ms: 1,
        });
      }
      enrolBody = JSON.parse(String(init.body));
      return Response.json({
        account_id: "alice.tail.testnet",
        app_attest_pk: "",
        enroll_call_id: "",
        receipt: "",
        receipt_sig: "",
      });
    }) as unknown as typeof fetch;
    const fake = fakeAttestation();
    const attest: Attestor = {
      isSupported: true,
      generateKey: async () => fake.keyId,
      attestKey: async (_k, h) => {
        attestedHash = fromB64(h);
        return fake.attestation;
      },
    };
    const out = await enrol(" Alice ", id, {
      relay: new RelayClient("http://r", { fetch: fetchFn }),
      attest,
      secrets: s,
      parent: "tail.testnet",
    });
    expect(attestedHash).toEqual(enrollClientDataHash(challenge, "alice.tail.testnet", id.boxPk, id.nearPk));
    expect(enrolBody).toMatchObject({
      key_id: fake.keyId,
      attestation: fake.attestation,
      challenge: Buffer.from(challenge).toString("base64"),
    });
    const rebind = rebindDigest("alice.tail.testnet", fake.point, id.boxPk, id.nearPk);
    expect(ed25519.verify(fromB64(enrolBody?.["rebind_sig"] ?? ""), rebind, id.nearPk)).toBe(true);
    expect(out.accountId).toBe("alice.tail.testnet");
    expect((await loadIdentity(s)).attestKeyId).toBe(fake.keyId);
    expect(nearSigner(out).accountId).toBe("alice.tail.testnet");
  });

  test("a retry after a failed enrolment keeps the NEAR key and signs rebind_sig for its own new App Attest key", async () => {
    // The referee may keep the first attempt's key when the relay fails after it (creating the
    // account, a timeout). It takes another key for the account only with rebind_sig from the
    // NEAR key the first attempt sent, so every attempt must carry it, from the same key.
    const s = memoryStore();
    const bodies: Record<string, string>[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      if (url.endsWith("/enroll/challenge"))
        return Response.json({
          challenge: toB64(new Uint8Array(32).fill(bodies.length + 1)),
          account_id: "alice.tail.testnet",
          expires_ms: 1,
        });
      bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) return Response.json({ error: "account creation failed" }, { status: 502 });
      return Response.json({ account_id: "alice.tail.testnet" });
    }) as unknown as typeof fetch;
    const fakes = [fakeAttestation(), fakeAttestation()];
    let made = 0;
    const attest: Attestor = {
      isSupported: true,
      generateKey: async () => (fakes[made++] as { keyId: string }).keyId,
      attestKey: async (k) => (fakes.find((f) => f.keyId === k) as { attestation: string }).attestation,
    };
    const deps = {
      relay: new RelayClient("http://r", { fetch: fetchFn }),
      attest,
      secrets: s,
      parent: "tail.testnet",
    };
    await expect(enrol("alice", await loadIdentity(s), deps)).rejects.toThrow();
    expect((await loadIdentity(s)).accountId).toBeNull();
    expect((await loadIdentity(s)).attestKeyId).toBeNull();
    // The retry runs as after a relaunch: the identity is read again from the Keychain.
    const id = await loadIdentity(s);
    const out = await enrol("alice", id, deps);
    expect(out.accountId).toBe("alice.tail.testnet");
    expect(bodies).toHaveLength(2);
    const [first, second] = bodies as [Record<string, string>, Record<string, string>];
    expect(second["near_pk"]).toBe(first["near_pk"] as string);
    expect(second["key_id"]).not.toBe(first["key_id"] as string);
    for (const [i, body] of bodies.entries()) {
      const point = (fakes[i] as { point: Uint8Array }).point;
      const rebind = rebindDigest("alice.tail.testnet", point, id.boxPk, id.nearPk);
      expect(ed25519.verify(fromB64(body["rebind_sig"] ?? ""), rebind, id.nearPk)).toBe(true);
    }
    expect((await loadIdentity(s)).attestKeyId).toBe(fakes[1]?.keyId ?? "");
  });

  test("enrolment refuses on a phone without App Attest", async () => {
    const s = memoryStore();
    const attest: Attestor = { isSupported: false, generateKey: async () => "", attestKey: async () => "" };
    await expect(
      enrol("bob", await loadIdentity(s), {
        relay: new RelayClient("http://r"),
        attest,
        secrets: s,
        parent: "tail.testnet",
      }),
    ).rejects.toThrow("App Attest");
  });

  test("enrolment attests nothing for an account that is not <handle>.<the build's parent>", async () => {
    const offered = async (accountId: string, parent: string | null) => {
      const s = memoryStore();
      let attested = 0;
      const fetchFn = (async () =>
        Response.json({
          challenge: Buffer.from(new Uint8Array(32)).toString("base64"),
          account_id: accountId,
          expires_ms: 1,
        })) as unknown as typeof fetch;
      const attest: Attestor = {
        isSupported: true,
        generateKey: async () => "a2V5",
        attestKey: async () => {
          attested++;
          return "YXR0";
        },
      };
      const out = enrol("Alice", await loadIdentity(s), {
        relay: new RelayClient("http://r", { fetch: fetchFn }),
        attest,
        secrets: s,
        parent,
      });
      await expect(out).rejects.toThrow();
      expect(attested).toBe(0);
      expect((await loadIdentity(s)).accountId).toBeNull();
      return out.catch((e: Error) => e.message);
    };
    // Someone else's account, a look-alike parent, and a build with no parent pinned.
    expect(await offered("bob.tail.testnet", "tail.testnet")).toBe(
      "The relay offered the account bob.tail.testnet, not alice.tail.testnet. Check the relay address in Settings.",
    );
    expect(await offered("alice.evil.testnet", "tail.testnet")).toContain("not alice.tail.testnet");
    expect(await offered("alice.tail.testnet", null)).toContain("doesn't say which accounts");
  });
});

describe("the App Attest key inside an attestation", () => {
  test("is read out of a real iPhone attestation, the same key as its credential certificate's", () => {
    const vector = JSON.parse(
      readFileSync(
        new URL("../../../../crates/appattest/tests/data/s3-tail-attest.json", import.meta.url),
        "utf8",
      ),
    ) as { keyId: string; attestation: string };
    const att = fromB64(vector.attestation);
    const keyId = fromB64(vector.keyId);
    const pk = attestedPublicKey(att, keyId);
    expect(pk).toHaveLength(65);
    expect(pk).toEqual(credentialKey(att, keyId));
    expect(() => attestedPublicKey(att, sha256(utf8("another key")))).toThrow("App Attest key");
  });
});

/** An attestation-shaped blob that certifies one P-256 key, the way Apple's DER carries it. */
function fakeAttestation(): { keyId: string; attestation: string; point: Uint8Array } {
  const point = p256.getPublicKey(p256.utils.randomSecretKey(), false);
  const attestation = concat(
    utf8("attStmt x5c leaf"),
    Uint8Array.of(0x03, 0x42, 0x00),
    point,
    utf8("authData"),
  );
  return { keyId: toB64(sha256(point)), attestation: toB64(attestation), point };
}

async function enrolled(account = "alice.tail.testnet"): Promise<{ s: SecretStore; id: Identity }> {
  const s = memoryStore();
  await saveAccount(s, account);
  return { s, id: await loadIdentity(s) };
}

describe("refreshing an enrolment for a new referee", () => {
  const CONTRACT = "tail.tail.testnet";
  const challenge = new Uint8Array(32).fill(8);

  test("a new key is attested over the fresh challenge, rebind_sig is signed with the NEAR key, and the account stays", async () => {
    const { s, id } = await enrolled();
    const fake = fakeAttestation();
    let attestedHash: Uint8Array | undefined;
    const calls: { path: string; headers: Record<string, string>; body: string }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push({ path, headers: init.headers as Record<string, string>, body: String(init.body) });
      if (path === "/enroll/refresh/challenge")
        return Response.json({
          challenge: toB64(challenge),
          account_id: "alice.tail.testnet",
          expires_ms: 1,
        });
      return Response.json({ account_id: "alice.tail.testnet" });
    }) as unknown as typeof fetch;
    const attest: Attestor = {
      isSupported: true,
      generateKey: async () => fake.keyId,
      attestKey: async (_k, h) => {
        attestedHash = fromB64(h);
        return fake.attestation;
      },
    };
    const out = await refreshEnrolment(id, {
      relay: new RelayClient("http://r", { fetch: fetchFn, contractId: CONTRACT }),
      attest,
      secrets: s,
    });
    expect(attestedHash).toEqual(enrollClientDataHash(challenge, "alice.tail.testnet", id.boxPk, id.nearPk));
    expect(calls.map((c) => c.path)).toEqual(["/enroll/refresh/challenge", "/enroll/refresh"]);
    // Both requests are signed by the account's NEAR key (request auth v2).
    for (const c of calls) {
      const digest = requestDigest({
        contractId: CONTRACT,
        accountId: "alice.tail.testnet",
        method: "POST",
        path: c.path,
        timeMs: Number(c.headers["x-tail-time"]),
        body: utf8(c.body),
      });
      expect(ed25519.verify(fromB64(c.headers["x-tail-sig"] ?? ""), digest, id.nearPk)).toBe(true);
    }
    const body = JSON.parse(calls[1]?.body ?? "{}") as Record<string, string>;
    expect(body).toMatchObject({
      challenge: toB64(challenge),
      key_id: fake.keyId,
      attestation: fake.attestation,
      player_box_pk: toB64(id.boxPk),
    });
    const rebind = rebindDigest("alice.tail.testnet", fake.point, id.boxPk, id.nearPk);
    expect(ed25519.verify(fromB64(body["rebind_sig"] ?? ""), rebind, id.nearPk)).toBe(true);
    expect(out.accountId).toBe("alice.tail.testnet");
    expect(out.nearPk).toEqual(id.nearPk);
    expect((await loadIdentity(s)).attestKeyId).toBe(fake.keyId);
  });

  test("a refresh challenge for another account attests nothing", async () => {
    const { s, id } = await enrolled();
    let attested = 0;
    const fetchFn = (async () =>
      Response.json({
        challenge: toB64(challenge),
        account_id: "bob.tail.testnet",
        expires_ms: 1,
      })) as unknown as typeof fetch;
    const attest: Attestor = {
      isSupported: true,
      generateKey: async () => "a2V5",
      attestKey: async () => {
        attested++;
        return "";
      },
    };
    await expect(
      refreshEnrolment(id, {
        relay: new RelayClient("http://r", { fetch: fetchFn, contractId: CONTRACT }),
        attest,
        secrets: s,
      }),
    ).rejects.toThrow("different account");
    expect(attested).toBe(0);
  });

  test("a Start refused for this phone's device re-enrols and tries once more; other refusals pass through", async () => {
    const stale = (accounts?: string[]) =>
      new RelayError(409, "the referee does not know these players yet", {
        code: "refresh",
        ...(accounts ? { accounts } : {}),
      });
    expect(refreshNeeded(stale(["alice.tail.testnet"]), "alice.tail.testnet")).toBe(true);
    expect(refreshNeeded(stale(["bob.tail.testnet"]), "alice.tail.testnet")).toBe(false);
    expect(refreshNeeded(stale(), "alice.tail.testnet")).toBe(true);
    expect(refreshNeeded(new RelayError(409, "match is running"), "alice.tail.testnet")).toBe(false);

    let tries = 0;
    let reenrols = 0;
    const ok = await withRefresh(
      "alice.tail.testnet",
      async () => {
        if (++tries === 1) throw stale(["alice.tail.testnet", "bob.tail.testnet"]);
        return "started";
      },
      async () => {
        reenrols++;
      },
    );
    expect([ok, tries, reenrols]).toEqual(["started", 2, 1]);

    tries = 0;
    const other = withRefresh(
      "alice.tail.testnet",
      async () => {
        tries++;
        throw stale(["bob.tail.testnet"]);
      },
      async () => {
        reenrols++;
      },
    );
    await expect(other).rejects.toThrow("does not know");
    expect([tries, reenrols]).toEqual([1, 1]);
  });
});

describe("re-enrolling only when no hunt may be running", () => {
  const none: HuntFacts = { session: false, matchId: null, phase: null };
  const run = async (
    facts: HuntFacts | (() => HuntFacts),
    opts: { withReferee?: boolean; reenrol?: () => Promise<void> } = {},
  ) => {
    let reenrols = 0;
    const out = await ensureEnrolled({
      hunt: typeof facts === "function" ? facts : () => facts,
      keys: async () => ({ current: "a2V5", pending: null }),
      status: async () => ({ withReferee: opts.withReferee ?? false, keyId: null }),
      settle: async () => undefined,
      works: async () => true,
      reenrol: async () => {
        reenrols++;
        await opts.reenrol?.();
      },
    });
    return { out, reenrols };
  };

  test("a referee that doesn't know this phone gets a re-enrolment when no match is open, or in a lobby or after the end", async () => {
    expect(await run(none)).toEqual({ out: "refreshed", reenrols: 1 });
    for (const phase of ["lobby", "ended", "failed"] as const)
      expect(await run({ session: false, matchId: "m", phase })).toEqual({ out: "refreshed", reenrols: 1 });
    expect(await run(none, { withReferee: true })).toEqual({ out: "enrolled", reenrols: 0 });
  });

  test("a live hunt, or a relaunch into one before its session or phase is back, never re-enrols", async () => {
    // A relay answering with_referee:false then would replace the App Attest key the referee
    // checks this phone's batches against, and the Keychain's keyId with it.
    expect(await run({ session: true, matchId: "m", phase: "running" })).toEqual({
      out: "not now",
      reenrols: 0,
    });
    expect(await run({ session: true, matchId: null, phase: null })).toEqual({ out: "not now", reenrols: 0 });
    expect(await run({ session: false, matchId: "m", phase: null })).toEqual({ out: "not now", reenrols: 0 });
    for (const phase of ["starting", "running", "ending"] as const)
      expect(await run({ session: false, matchId: "m", phase })).toEqual({ out: "not now", reenrols: 0 });
    expect(mayReenrol({ session: true, matchId: null, phase: null })).toBe(false);
  });

  test("a hunt that starts while the relay answers stops the re-enrolment", async () => {
    let asked = 0;
    const facts = () => (asked++ === 0 ? none : { session: true, matchId: "m", phase: "running" as const });
    expect(await run(facts)).toEqual({ out: "not now", reenrols: 0 });
  });

  test("the relay's in_match refusal is 'not now'; other refusals and an unreachable relay are not", async () => {
    const inMatch = new RelayError(409, "this account is in a running match", { code: "in_match" });
    expect(await run(none, { reenrol: () => Promise.reject(inMatch) })).toEqual({
      out: "not now",
      reenrols: 1,
    });
    const other = new RelayError(409, "device attestation failed");
    await expect(run(none, { reenrol: () => Promise.reject(other) })).rejects.toThrow("attestation");
    const down = await ensureEnrolled({
      hunt: () => none,
      keys: async () => ({ current: "a2V5", pending: null }),
      status: () => Promise.reject(new Error("offline")),
      settle: async () => undefined,
      works: async () => true,
      reenrol: async () => undefined,
    });
    expect(down).toBe("unknown");
  });
});

describe("the App Attest key the relay holds", () => {
  const none: HuntFacts = { session: false, matchId: null, phase: null };

  /** ensureEnrolled against this Keychain and a relay that holds `relayKey` for the account. */
  const check = async (s: SecretStore, relayKey: string | null, withReferee = true) => {
    let reenrols = 0;
    const out = await ensureEnrolled({
      hunt: () => none,
      keys: () => attestKeyIds(s),
      status: async () => ({ withReferee, keyId: relayKey }),
      settle: (k) => settleAttestKeyId(s, k),
      works: async () => true,
      reenrol: async () => {
        reenrols++;
      },
    });
    return { out, reenrols, keys: await attestKeyIds(s) };
  };

  test("a refresh the relay took but whose answer was lost is kept as pending, then settled by the relay's key id", async () => {
    const { s } = await enrolled();
    await settleAttestKeyId(s, "b2xk");
    const fake = fakeAttestation();
    const fetchFn = (async (url: string) => {
      if (new URL(url).pathname === "/enroll/refresh/challenge")
        return Response.json({
          challenge: toB64(new Uint8Array(32)),
          account_id: "alice.tail.testnet",
          expires_ms: 1,
        });
      // The relay committed the new key, then the answer never arrived.
      throw new TypeError("The network connection was lost.");
    }) as unknown as typeof fetch;
    const attest: Attestor = {
      isSupported: true,
      generateKey: async () => fake.keyId,
      attestKey: async () => fake.attestation,
    };
    await expect(
      refreshEnrolment(await loadIdentity(s), {
        relay: new RelayClient("http://r", { fetch: fetchFn, contractId: "tail.tail.testnet" }),
        attest,
        secrets: s,
      }),
    ).rejects.toThrow();
    expect(await attestKeyIds(s)).toEqual({ current: "b2xk", pending: fake.keyId });
    // The relay says it holds the new key, and its referee has the device: no second refresh.
    expect(await check(s, fake.keyId)).toEqual({
      out: "enrolled",
      reenrols: 0,
      keys: { current: fake.keyId, pending: null },
    });
  });

  test("the relay's status names the key it holds, or nothing when it is too old to say", async () => {
    const status = (answer: object) =>
      new RelayClient("http://r", {
        contractId: "tail.tail.testnet",
        fetch: (async () => Response.json(answer)) as unknown as typeof fetch,
      }).enrolStatus({ accountId: "alice.tail.testnet", sign: () => new Uint8Array(64) });
    const base = { account_id: "alice.tail.testnet", with_referee: true };
    expect(await status({ ...base, app_attest_key_id: "bmV3" })).toMatchObject({ appAttestKeyId: "bmV3" });
    expect(await status(base)).toMatchObject({ withReferee: true, appAttestKeyId: null });
  });

  test("the relay holding the current key drops the pending one; a key the phone doesn't have, or a pending one the relay can't name, refreshes", async () => {
    const pending = async () => {
      const { s } = await enrolled();
      await settleAttestKeyId(s, "b2xk");
      await savePendingAttestKeyId(s, "bmV3");
      return s;
    };
    expect(await check(await pending(), "b2xk")).toEqual({
      out: "enrolled",
      reenrols: 0,
      keys: { current: "b2xk", pending: null },
    });
    expect((await check(await pending(), "b3RoZXI=")).reenrols).toBe(1);
    // An older relay that does not send its key id: only a fresh key settles which one it holds.
    expect((await check(await pending(), null)).reenrols).toBe(1);
    const { s } = await enrolled();
    await settleAttestKeyId(s, "b2xk");
    expect((await check(s, null)).out).toBe("enrolled");
  });
});

describe("a device key iOS threw away", () => {
  test("a trial assertion that finds the key gone replaces it outside a hunt, and is never made during one", async () => {
    const run = async (facts: HuntFacts, works: boolean | null) => {
      const tried: string[] = [];
      let reenrols = 0;
      const out = await ensureEnrolled({
        hunt: () => facts,
        keys: async () => ({ current: "a2V5", pending: null }),
        status: async () => ({ withReferee: true, keyId: "a2V5" }),
        settle: async () => undefined,
        works: async (k) => {
          tried.push(k);
          return works;
        },
        reenrol: async () => {
          reenrols++;
        },
      });
      return { out, reenrols, tried };
    };
    const lobby: HuntFacts = { session: false, matchId: "m", phase: "lobby" };
    // Deleted and installed again: the Keychain still names the key, iOS no longer has it.
    expect(await run(lobby, false)).toEqual({ out: "refreshed", reenrols: 1, tried: ["a2V5"] });
    // App Attest failed for some other reason: nothing known about the key, nothing replaced.
    expect(await run(lobby, null)).toEqual({ out: "enrolled", reenrols: 0, tried: ["a2V5"] });
    const hunting: HuntFacts = { session: true, matchId: "m", phase: "running" };
    expect(await run(hunting, false)).toEqual({ out: "not now", reenrols: 0, tried: [] });
  });

  test("only App Attest's invalid-key error says the key is gone", async () => {
    const failing = (e: unknown) => async () => {
      throw e;
    };
    const gone = Object.assign(new Error("App Attest failed"), { code: "ERR_APP_ATTEST_INVALID_KEY" });
    const busy = Object.assign(new Error("App Attest failed"), { code: "ERR_APP_ATTEST_SYSTEM_FAILURE" });
    expect(await keyWorks(failing(gone), "a2V5")).toBe(false);
    expect(await keyWorks(failing(busy), "a2V5")).toBeNull();
    expect(await keyWorks(async () => "YXNzZXJ0", "a2V5")).toBe(true);
  });
});

describe("re-checking the enrolment while the lobby shows a failed Start", () => {
  test("a new failure is checked at once; the same failure again after a while, so a repeated identical refusal retries", () => {
    expect(startRecheckDue(null, "the referee does not know these players yet", 0)).toBe(true);
    const last = { error: "the referee does not know these players yet", atMs: 1_000 };
    // Every poll sees the failure again; it is not asked about on each one.
    expect(startRecheckDue(last, last.error, 1_000 + 3_000)).toBe(false);
    expect(startRecheckDue(last, last.error, 1_000 + ENROL_RECHECK_MS)).toBe(true);
    expect(startRecheckDue(last, "match is starting", 1_000 + 3_000)).toBe(true);
  });
});
