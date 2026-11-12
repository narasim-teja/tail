// The real vector is the S3 spike's `tail-attest` run: an iPhone 17 Pro attested a key over a raw
// 32-byte clientDataHash, exactly as enrolment does. Each refusal breaks one of Apple's checks
// on that real object and sits next to a twin that shows the unbroken input passes.

import { describe, expect, test } from "bun:test";
import { decode, Encoder } from "cbor-x";
import {
  APPLE_ROOT_SHA256,
  AttestationError,
  type AttestationInput,
  loadRoot,
  verifyAttestation,
} from "../src/index.ts";

const vector = (await Bun.file(new URL("./data/s3-tail-attest.json", import.meta.url)).json()) as {
  capturedAt: string;
  appId: string;
  environment: "development" | "production";
  keyId: string;
  attestation: string;
  clientData: string;
  clientDataHash: string;
};
const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const rootPem = await Bun.file(new URL("../apple-app-attest-root-ca.pem", import.meta.url)).text();

const real = (): AttestationInput => ({
  attestation: b64(vector.attestation),
  keyId: b64(vector.keyId),
  clientDataHash: b64(vector.clientDataHash),
  appId: vector.appId,
  environment: vector.environment,
  now: new Date(vector.capturedAt),
});

async function refusal(input: AttestationInput): Promise<AttestationError> {
  try {
    await verifyAttestation(input);
  } catch (e) {
    if (e instanceof AttestationError) return e;
    throw e;
  }
  throw new Error("attestation was accepted");
}

describe("verifyAttestation", () => {
  test("the real iPhone attestation verifies and yields the key whose hash is the keyId", async () => {
    const pk = await verifyAttestation(real());
    expect(pk.length).toBe(65);
    expect(pk[0]).toBe(4);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(pk)));
    expect(Buffer.from(digest).toString("base64")).toBe(vector.keyId);
  });

  test("the vector's clientDataHash is SHA-256 of its clientData", async () => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", b64(vector.clientData)));
    expect(Buffer.from(digest).toString("base64")).toBe(vector.clientDataHash);
  });

  test("an attestation for another app id is refused at step 6", async () => {
    expect((await refusal({ ...real(), appId: "LKABS9RZAC.com.example.other" })).step).toBe("step 6");
  });

  test("an attestation over another clientDataHash is refused at step 4", async () => {
    const other = new Uint8Array(32).fill(7);
    expect((await refusal({ ...real(), clientDataHash: other })).step).toBe("step 4");
  });

  test("a credential certificate with a tampered signature is refused at step 1", async () => {
    const obj = decode(b64(vector.attestation)) as { attStmt: { x5c: Uint8Array[] } };
    const leaf = new Uint8Array(obj.attStmt.x5c[0] as Uint8Array);
    leaf[leaf.length - 1] = (leaf[leaf.length - 1] as number) ^ 1;
    obj.attStmt.x5c[0] = leaf;
    const tampered = new Encoder({ useRecords: false, tagUint8Array: false }).encode(obj);
    expect((await refusal({ ...real(), attestation: tampered })).step).toBe("step 1");
  });

  test("the same object re-encoded without tampering still verifies", async () => {
    const obj = decode(b64(vector.attestation));
    const again = new Encoder({ useRecords: false, tagUint8Array: false }).encode(obj);
    expect((await verifyAttestation({ ...real(), attestation: again })).length).toBe(65);
  });

  test("a credential certificate past its validity window is refused at step 1", async () => {
    expect((await refusal({ ...real(), now: new Date("2026-11-15T00:00:00Z") })).step).toBe("step 1");
  });

  test("another key identifier is refused at step 5", async () => {
    expect((await refusal({ ...real(), keyId: new Uint8Array(32) })).step).toBe("step 5");
  });

  test("a development attestation checked as production is refused at step 8", async () => {
    expect((await refusal({ ...real(), environment: "production" })).step).toBe("step 8");
  });

  test("bytes that are not CBOR are refused while decoding", async () => {
    expect((await refusal({ ...real(), attestation: Uint8Array.of(0xff, 0x00) })).step).toBe("decode");
  });
});

describe("loadRoot", () => {
  test("Apple's root loads when its DER matches the pinned SHA-256", async () => {
    expect((await loadRoot(rootPem, APPLE_ROOT_SHA256)).subject).toContain("Apple App Attestation Root CA");
  });

  test("a root whose DER does not match the pin is refused", async () => {
    const e = await loadRoot(rootPem, "00".repeat(32)).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(AttestationError);
    expect((e as AttestationError).step).toBe("root");
  });
});
