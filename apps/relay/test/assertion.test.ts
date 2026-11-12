// Ghost assertions must pass the referee's App Attest check (crates/appattest verify_assertion).
// `verify` below follows those Rust steps one for one. It accepts the two real Secure Enclave
// assertions from the S3 spike, which shows it reads Apple's format, and then it is run on the
// ghost's assertions.

import { describe, expect, test } from "bun:test";
import { p256 } from "@noble/curves/nist.js";
import { concat, equal, sha256, utf8 } from "@tail/protocol";
import { decode } from "cbor-x";
import { authenticatorData, signAssertion } from "../src/ghosts/assertion.ts";

const vector = (await Bun.file(new URL("./data/s3-assertions.json", import.meta.url)).json()) as {
  appId: string;
  publicKey: string;
  assertions: { clientDataHash: string; object: string }[];
};
const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/** crates/appattest verify_assertion, steps 2–5. Returns the counter or throws naming the step. */
function verify(
  pk: Uint8Array,
  assertion: Uint8Array,
  clientDataHash: Uint8Array,
  appId: string,
  prev: number,
) {
  const m = decode(assertion) as { signature?: unknown; authenticatorData?: unknown };
  if (!(m.signature instanceof Uint8Array) || !(m.authenticatorData instanceof Uint8Array))
    throw new Error("decode");
  const auth = new Uint8Array(m.authenticatorData);
  if (auth.length < 37) throw new Error("decode");
  const nonce = sha256(concat(auth, clientDataHash));
  const ok = p256.verify(new Uint8Array(m.signature), nonce, pk, {
    prehash: true,
    format: "der",
    lowS: false,
  });
  if (!ok) throw new Error("signature");
  if (!equal(auth.slice(0, 32), sha256(utf8(appId)))) throw new Error("rp id");
  const counter = new DataView(auth.buffer, auth.byteOffset).getUint32(33, false);
  if (counter <= prev) throw new Error("counter");
  return counter;
}

describe("the assertion check the referee runs", () => {
  test("accepts the two real iPhone assertions with increasing counters", () => {
    const pk = Uint8Array.from(Buffer.from(vector.publicKey, "hex"));
    let prev = 0;
    for (const a of vector.assertions)
      prev = verify(pk, b64(a.object), b64(a.clientDataHash), vector.appId, prev);
    expect(prev).toBe(2);
  });
});

describe("ghost assertions", () => {
  const sk = p256.utils.randomSecretKey();
  const pk = p256.getPublicKey(sk, false);
  const cdh = sha256(utf8("a batch"));

  test("a ghost's assertion verifies exactly as a device's does", () => {
    expect(verify(pk, signAssertion(sk, cdh, vector.appId, 1), cdh, vector.appId, 0)).toBe(1);
  });

  test("a ghost's assertion over other client data is refused at the signature", () => {
    expect(() =>
      verify(pk, signAssertion(sk, cdh, vector.appId, 1), sha256(utf8("other")), vector.appId, 0),
    ).toThrow("signature");
  });

  test("a ghost's assertion for another app id is refused at the rp id", () => {
    expect(() => verify(pk, signAssertion(sk, cdh, "OTHER.app", 1), cdh, vector.appId, 0)).toThrow("rp id");
  });

  test("a replayed counter is refused; the next one is accepted", () => {
    expect(() => verify(pk, signAssertion(sk, cdh, vector.appId, 3), cdh, vector.appId, 3)).toThrow(
      "counter",
    );
    expect(verify(pk, signAssertion(sk, cdh, vector.appId, 4), cdh, vector.appId, 3)).toBe(4);
  });

  test("the assertion is a plain two-entry CBOR map with untagged byte strings", () => {
    const a = signAssertion(sk, cdh, vector.appId, 1);
    // a2 = map(2); 69 "signature"; 58 n = bytes(n), no tag; 71 "authenticatorData"; 58 25 = bytes(37).
    expect([a[0], a[1], a[11]]).toEqual([0xa2, 0x69, 0x58]);
    const sigLen = a[12] as number;
    const at = 13 + sigLen;
    expect([a[at], a[at + 18], a[at + 19]]).toEqual([0x71, 0x58, 37]);
    expect(a.length).toBe(at + 20 + 37);
    const m = decode(a) as Record<string, Uint8Array>;
    expect(Object.keys(m).sort()).toEqual(["authenticatorData", "signature"]);
    expect(
      equal(new Uint8Array(m["authenticatorData"] as Uint8Array), authenticatorData(vector.appId, 1)),
    ).toBe(true);
  });
});
