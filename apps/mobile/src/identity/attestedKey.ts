// The App Attest public key, read back out of the phone's own attestation. A refresh signs
// `rebind_sig` over it (packages/protocol rebindDigest), and iOS gives the key only inside the
// attestation: in the credential certificate's SubjectPublicKeyInfo, a P-256 point that ends
// `03 42 00 04 ‖ x(32) ‖ y(32)` in DER.
//
// Apple's keyId is SHA256 of that 65-byte point, so the phone needs no certificate parser: it
// takes the one point in the attestation that hashes to its own keyId. Nothing else can match
// it, and the relay checks the same equality (packages/appattest, step 5).

import { equal, sha256 } from "@tail/protocol";

/** DER for a 66-byte BIT STRING with no unused bits, holding an uncompressed point. */
const POINT_PREFIX = [0x03, 0x42, 0x00, 0x04] as const;

/** The 65-byte uncompressed P-256 key the attestation certifies for `keyId`; throws if none. */
export function attestedPublicKey(attestation: Uint8Array, keyId: Uint8Array): Uint8Array {
  for (let i = 0; i + 3 + 65 <= attestation.length; i++) {
    if (POINT_PREFIX.some((b, k) => attestation[i + k] !== b)) continue;
    const point = attestation.subarray(i + 3, i + 3 + 65);
    if (equal(sha256(point), keyId)) return point.slice();
  }
  throw new Error("The attestation doesn't hold this phone's App Attest key.");
}
