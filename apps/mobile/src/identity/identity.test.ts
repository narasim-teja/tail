import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { boxPublicKey, enrollClientDataHash } from "@tail/protocol";
import { fromB64 } from "../lib/b64";
import { RelayClient } from "../relay/client";
import { type Attestor, enrol } from "./enrol";
import { loadIdentity, nearSigner, type SecretStore } from "./identity";

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
      enrol("bob", await loadIdentity(s), { relay: new RelayClient("http://r"), attest, secrets: s }),
    ).rejects.toThrow("App Attest");
  });
});
