// Enrolment (TECHNICAL.md 4.4): challenge → App Attest attestation over
// enrollClientDataHash(challenge, account_id, player_box_pk, near_pk) → the relay checks it,
// creates the NEAR account with only our function-call key, and registers the device key with
// the referee. From then on the enclave checks every batch against that key.
//
// The relay names the account in its challenge, and the attestation binds this phone's keys to
// whatever account it names. So the phone checks the name first: `<handle>.<parent>`, with the
// parent pinned in the build (app.config.ts), never taken from the relay. A relay that named
// someone else's account would otherwise get an Apple-attested binding of this phone to it.
//
// Refresh: when the contract pins another referee, that referee knows no device yet, and an old
// attestation cannot be replayed to it. The phone then attests a new App Attest key over a fresh
// challenge for the same account and signs `rebind_sig` with the account's NEAR key, which only
// this phone holds; the referee replaces its record for the account only with that signature.

import { ed25519 } from "@noble/curves/ed25519.js";
import { enrollClientDataHash, rebindDigest } from "@tail/protocol";
import { fromB64, toB64 } from "../lib/b64";
import { type RelayClient, refreshNeeded } from "../relay/client";
import { attestedPublicKey } from "./attestedKey";
import { type Identity, nearSigner, type SecretStore, saveAccount, saveAttestKeyId } from "./identity";

export interface Attestor {
  readonly isSupported: boolean;
  generateKey(): Promise<string>;
  attestKey(keyId: string, clientDataHashB64: string): Promise<string>;
}

/** The handle as the relay takes it: trimmed, lower case. */
export const normalHandle = (handle: string) => handle.trim().toLowerCase();

/** Why `accountId` is not the account this build enrols `handle` as, or null when it is. */
export function accountProblem(handle: string, accountId: string, parent: string | null): string | null {
  if (!parent)
    return "This build doesn't say which accounts it plays on. Rebuild it with NEAR_RELAY_ACCOUNT set.";
  const want = `${normalHandle(handle)}.${parent}`;
  return accountId === want
    ? null
    : `The relay offered the account ${accountId}, not ${want}. Check the relay address in Settings.`;
}

export async function enrol(
  handle: string,
  id: Identity,
  deps: {
    relay: RelayClient;
    attest: Attestor;
    secrets: SecretStore;
    /** The parent account this build plays on (app.config.ts); null when the build has none. */
    parent: string | null;
    /** The step now running, for the button label: the relay's half can take a minute. */
    onStep?: (label: string) => void;
  },
): Promise<Identity> {
  if (!deps.attest.isSupported) throw new Error("App Attest is not available on this device.");
  const ch = await deps.relay.enrollChallenge(normalHandle(handle));
  const problem = accountProblem(handle, ch.accountId, deps.parent);
  if (problem) throw new Error(problem);
  // A key is attested once. A fresh one per attempt means a failed enrolment can simply retry.
  const keyId = await deps.attest.generateKey();
  const hash = enrollClientDataHash(ch.challenge, ch.accountId, id.boxPk, id.nearPk);
  const attestation = await deps.attest.attestKey(keyId, toB64(hash));
  deps.onStep?.("Making your account");
  const r = await deps.relay.enroll({
    challenge: ch.challenge,
    keyId,
    attestation,
    playerBoxPk: id.boxPk,
    nearPk: id.nearPk,
  });
  if (r.accountId !== ch.accountId) throw new Error("The relay enrolled a different account.");
  await saveAttestKeyId(deps.secrets, keyId);
  await saveAccount(deps.secrets, r.accountId);
  return { ...id, attestKeyId: keyId, accountId: r.accountId };
}

/** What the phone tells the player after a refresh, in one line. */
export const REFRESHED = "This phone re-enrolled with the match referee. Same account, same balance.";

/**
 * Re-enrols this phone's account with the referee the relay runs with now: a new App Attest key
 * attested over a fresh challenge, and `rebind_sig` from the NEAR key in the Keychain. The
 * account, the box key and the NEAR key stay; only the App Attest key is new.
 */
export async function refreshEnrolment(
  id: Identity,
  deps: { relay: RelayClient; attest: Attestor; secrets: SecretStore },
): Promise<Identity> {
  if (!deps.attest.isSupported) throw new Error("App Attest is not available on this device.");
  const signer = nearSigner(id);
  const accountId = signer.accountId;
  const ch = await deps.relay.refreshChallenge(signer);
  if (ch.accountId !== accountId) throw new Error("The relay offered to refresh a different account.");
  const keyId = await deps.attest.generateKey();
  const hash = enrollClientDataHash(ch.challenge, accountId, id.boxPk, id.nearPk);
  const attestation = await deps.attest.attestKey(keyId, toB64(hash));
  const appAttestPk = attestedPublicKey(fromB64(attestation), fromB64(keyId));
  const rebindSig = ed25519.sign(rebindDigest(accountId, appAttestPk, id.boxPk, id.nearPk), id.nearSk);
  const r = await deps.relay.refreshEnrolment(signer, {
    challenge: ch.challenge,
    keyId,
    attestation,
    playerBoxPk: id.boxPk,
    rebindSig,
  });
  if (r.accountId !== accountId) throw new Error("The relay refreshed a different account.");
  await saveAttestKeyId(deps.secrets, keyId);
  return { ...id, attestKeyId: keyId };
}

/**
 * Runs a relay call; if the relay refuses it because its referee doesn't know this phone yet,
 * re-enrols and runs it once more. Any other refusal, or a second one, is the caller's.
 */
export async function withRefresh<T>(
  accountId: string,
  call: () => Promise<T>,
  reenrol: () => Promise<void>,
): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (!refreshNeeded(e, accountId)) throw e;
  }
  await reenrol();
  return call();
}
