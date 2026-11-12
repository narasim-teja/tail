// App Attest assertions for tests, byte for byte as crates/appattest builds and checks them:
//
//   assertion         = CBOR {signature: DER ECDSA, authenticatorData}
//   authenticatorData = SHA256(app_id) ‖ flags (1) ‖ u32be(counter)
//   nonce             = SHA256(authenticatorData ‖ clientDataHash)
//   signature         = ECDSA P-256 over SHA256(nonce)  (the Secure Enclave hashes its input)
//
// verifyAssertion runs the referee's five checks (crates/appattest/src/lib.rs).

import { p256 } from "@noble/curves/nist.js";
import { concat, equal, sha256, utf8 } from "@tail/protocol";
import { type Cbor, decode, encode } from "./cbor";

export function signAssertion(
  sk: Uint8Array,
  clientDataHash: Uint8Array,
  appId: string,
  counter: number,
): Uint8Array {
  const auth = concat(
    sha256(utf8(appId)),
    Uint8Array.of(0),
    Uint8Array.of(counter >>> 24, (counter >> 16) & 255, (counter >> 8) & 255, counter & 255),
  );
  const nonce = sha256(concat(auth, clientDataHash));
  const sig = p256.sign(nonce, sk, { format: "der" });
  return encode(
    new Map<string, Cbor>([
      ["signature", sig],
      ["authenticatorData", auth],
    ]),
  );
}

export class AssertionError extends Error {
  constructor(readonly step: "Decode" | "Signature" | "RpId" | "Counter") {
    super(step);
  }
}

/** Returns the new counter, or throws naming the failed step. */
export function verifyAssertion(
  publicKey: Uint8Array,
  assertion: Uint8Array,
  clientDataHash: Uint8Array,
  appId: string,
  prevCounter: number,
): number {
  let m: Cbor;
  try {
    m = decode(assertion);
  } catch {
    throw new AssertionError("Decode");
  }
  if (!(m instanceof Map)) throw new AssertionError("Decode");
  const sig = m.get("signature");
  const auth = m.get("authenticatorData");
  if (!(sig instanceof Uint8Array) || !(auth instanceof Uint8Array) || auth.length < 37)
    throw new AssertionError("Decode");
  const nonce = sha256(concat(auth, clientDataHash));
  // Apple's signatures are not normalised to low S.
  if (!p256.verify(sig, nonce, publicKey, { format: "der", lowS: false }))
    throw new AssertionError("Signature");
  if (!equal(auth.slice(0, 32), sha256(utf8(appId)))) throw new AssertionError("RpId");
  const counter = new DataView(auth.buffer, auth.byteOffset).getUint32(33, false);
  if (counter <= prevCounter) throw new AssertionError("Counter");
  return counter;
}

// DER prefix of a P-256 SubjectPublicKeyInfo: SEQUENCE { id-ecPublicKey, prime256v1 } BIT STRING.
const SPKI_P256 = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48,
  0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);

/** The attested key from a real attestation object: x5c[0]'s public key, checked against keyId. */
export function credentialKey(attestation: Uint8Array, keyId: Uint8Array): Uint8Array {
  const m = decode(attestation) as Map<string, Cbor>;
  const stmt = m.get("attStmt") as Map<string, Cbor>;
  const leaf = (stmt.get("x5c") as Cbor[])[0] as Uint8Array;
  for (let i = 0; i + SPKI_P256.length + 65 <= leaf.length; i++) {
    if (equal(leaf.slice(i, i + SPKI_P256.length), SPKI_P256)) {
      const point = leaf.slice(i + SPKI_P256.length, i + SPKI_P256.length + 65);
      if (!equal(sha256(point), keyId)) throw new Error("SHA256(credential key) is not the keyId");
      return point;
    }
  }
  throw new Error("no P-256 key in the credential certificate");
}
