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
import { type Attestor, enrol, refreshEnrolment, withRefresh } from "./enrol";
import { type Identity, loadIdentity, nearSigner, type SecretStore, saveAccount } from "./identity";

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
    const attest: Attestor = {
      isSupported: true,
      generateKey: async () => "a2V5",
      attestKey: async (_k, h) => {
        attestedHash = fromB64(h);
        return "YXR0";
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
      key_id: "a2V5",
      attestation: "YXR0",
      challenge: Buffer.from(challenge).toString("base64"),
    });
    expect(out.accountId).toBe("alice.tail.testnet");
    expect((await loadIdentity(s)).attestKeyId).toBe("a2V5");
    expect(nearSigner(out).accountId).toBe("alice.tail.testnet");
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
