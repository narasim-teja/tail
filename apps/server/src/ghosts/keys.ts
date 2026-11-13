// The three keys a phone holds, made in-process for a ghost: an ed25519 NEAR function-call key,
// an X25519 box key (HUDs and PlayerKeys are sealed to it) and a P-256 key in the place of the
// App Attest key (the referee checks every batch's assertion against it).

import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { boxPublicKey } from "@tail/protocol";

export interface GhostKeys {
  /** 32-byte ed25519 seed of the NEAR key. */
  nearSeed: Uint8Array;
  nearPk: Uint8Array;
  boxSk: Uint8Array;
  boxPk: Uint8Array;
  attestSk: Uint8Array;
  /** Uncompressed SEC1 (65 bytes), the form an App Attest public key takes. */
  attestPk: Uint8Array;
}

export function newGhostKeys(): GhostKeys {
  const nearSeed = ed25519.utils.randomSecretKey();
  const boxSk = crypto.getRandomValues(new Uint8Array(32));
  const attestSk = p256.utils.randomSecretKey();
  return {
    nearSeed,
    nearPk: ed25519.getPublicKey(nearSeed),
    boxSk,
    boxPk: boxPublicKey(boxSk),
    attestSk,
    attestPk: p256.getPublicKey(attestSk, false),
  };
}
