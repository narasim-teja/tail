// An App Attest assertion built the way the Secure Enclave builds one, byte for byte what
// crates/appattest `verify_assertion` checks (and its `sign_assertion` test signer produces):
//
//   authenticatorData = SHA256(app_id) ‖ flags (0x00) ‖ u32be(counter)
//   signature         = DER ECDSA-P256 over SHA256(authenticatorData ‖ clientDataHash), with
//                       ECDSA's own SHA-256 prehash on top (the Rust side verifies the nonce as
//                       the message, so the curve sees SHA256(nonce))
//   assertion         = CBOR map {"signature": bytes, "authenticatorData": bytes}
//
// Only ghosts use this. A real phone's key never leaves its Secure Enclave.

import { p256 } from "@noble/curves/nist.js";
import { concat, sha256, utf8 } from "@tail/protocol";
import { Encoder } from "cbor-x";

// Plain CBOR as the Secure Enclave writes it: a minimal-length map header (a2), text keys,
// byte strings without typed-array tags.
const cbor = new Encoder({
  useRecords: false,
  tagUint8Array: false,
  mapsAsObjects: true,
  variableMapSize: true,
});

export function authenticatorData(appId: string, counter: number): Uint8Array {
  const ctr = new Uint8Array(4);
  new DataView(ctr.buffer).setUint32(0, counter, false);
  return concat(sha256(utf8(appId)), Uint8Array.of(0), ctr);
}

export function signAssertion(
  secretKey: Uint8Array,
  clientDataHash: Uint8Array,
  appId: string,
  counter: number,
): Uint8Array {
  const auth = authenticatorData(appId, counter);
  const nonce = sha256(concat(auth, clientDataHash));
  const signature = p256.sign(nonce, secretKey, { prehash: true, format: "der" });
  return new Uint8Array(cbor.encode({ signature, authenticatorData: auth }));
}
