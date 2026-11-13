// The phone's three keys (TECHNICAL.md 4.1, 4.4): the App Attest key (in the Secure Enclave; only
// its keyId is stored), the X25519 player_box key (the enclave seals HUDs and keys to it) and the
// NEAR ed25519 function-call key (signs join_match, leave_lobby, withdraw and relay requests).
// Secrets live only in the Keychain (keychain.ts), never in files or AsyncStorage.

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { boxPublicKey } from "@tail/protocol";
import { fromB64, toB64 } from "../lib/b64";
import type { Signer } from "../proximity/auth";

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
  pendingAttestKeyId: "tail.appAttest.pendingKeyId",
  account: "tail.account",
} as const;

export interface Identity {
  boxSk: Uint8Array;
  boxPk: Uint8Array;
  nearSk: Uint8Array;
  nearPk: Uint8Array;
  /**
   * App Attest keyId (base64) the relay holds for this phone, once enrolled. A new key sent for
   * enrolment or refresh is kept apart as pending until the relay answers (attestKeyIds).
   */
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

/** The settled and the pending App Attest keyIds, as the Keychain has them now. */
export const attestKeyIds = async (s: SecretStore) => ({
  current: await s.get(K.attestKeyId),
  pending: await s.get(K.pendingAttestKeyId),
});

/** Kept before the key is sent, so an answer lost on the way back does not lose the key. */
export const savePendingAttestKeyId = (s: SecretStore, keyId: string) => s.set(K.pendingAttestKeyId, keyId);

/**
 * The relay holds `keyId` for this phone: it is the key from now on, and nothing is pending. Set
 * before the pending one is cleared, so a crash between the two leaves both naming the same key.
 */
export async function settleAttestKeyId(s: SecretStore, keyId: string): Promise<void> {
  await s.set(K.attestKeyId, keyId);
  await s.delete(K.pendingAttestKeyId);
}
export const saveAccount = (s: SecretStore, accountId: string) => s.set(K.account, accountId);
/**
 * Forgets which account this phone plays as, keeping every key: the old account still answers to
 * the same NEAR key. For test relays, where an account can end up tied to a contract the relay
 * no longer plays on.
 */
export const forgetAccount = (s: SecretStore) => s.delete(K.account);

/** Signs relay requests and HUD challenges with the NEAR key. */
export function nearSigner(id: Identity): Signer {
  if (!id.accountId) throw new Error("not enrolled");
  const accountId = id.accountId;
  return { accountId, sign: (digest) => ed25519.sign(digest, id.nearSk) };
}
