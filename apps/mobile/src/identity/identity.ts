// The phone's three keys (TECHNICAL.md 4.1, 4.4): the App Attest key (in the Secure Enclave; only
// its keyId is stored), the X25519 player_box key (the enclave seals HUDs and keys to it) and the
// NEAR ed25519 function-call key (signs join_match, leave_lobby, withdraw and relay requests).
// Secrets live only in the Keychain (keychain.ts), never in files or AsyncStorage.

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { boxPublicKey } from "@tail/protocol";
import { fromB64, toB64 } from "../lib/b64";
import type { Signer } from "../relay/auth";

/** A small key-value secret store. keychain.ts is the device one; tests use a Map. */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const K = {
  boxSk: "tail.playerBox.sk",
  nearSk: "tail.near.sk",
  attestKeyId: "tail.appAttest.keyId",
  account: "tail.account",
} as const;

export interface Identity {
  boxSk: Uint8Array;
  boxPk: Uint8Array;
  nearSk: Uint8Array;
  nearPk: Uint8Array;
  /** App Attest keyId (base64), once generated. */
  attestKeyId: string | null;
  /** Set after enrolment. */
  accountId: string | null;
}

/** Loads the identity, creating the box and NEAR keys on first launch. */
export async function loadIdentity(s: SecretStore): Promise<Identity> {
  let box = await s.get(K.boxSk);
  if (!box) {
    box = toB64(x25519.utils.randomSecretKey());
    await s.set(K.boxSk, box);
  }
  let near = await s.get(K.nearSk);
  if (!near) {
    near = toB64(ed25519.utils.randomSecretKey());
    await s.set(K.nearSk, near);
  }
  const boxSk = fromB64(box);
  const nearSk = fromB64(near);
  return {
    boxSk,
    boxPk: boxPublicKey(boxSk),
    nearSk,
    nearPk: ed25519.getPublicKey(nearSk),
    attestKeyId: await s.get(K.attestKeyId),
    accountId: await s.get(K.account),
  };
}

export const saveAttestKeyId = (s: SecretStore, keyId: string | null) =>
  keyId === null ? s.delete(K.attestKeyId) : s.set(K.attestKeyId, keyId);
export const saveAccount = (s: SecretStore, accountId: string) => s.set(K.account, accountId);

/** Signs relay requests and HUD challenges with the NEAR key. */
export function nearSigner(id: Identity): Signer {
  if (!id.accountId) throw new Error("not enrolled");
  const accountId = id.accountId;
  return { accountId, sign: (digest) => ed25519.sign(digest, id.nearSk) };
}
