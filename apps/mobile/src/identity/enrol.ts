// Enrolment (TECHNICAL.md 4.4): challenge → App Attest attestation over
// enrollClientDataHash(challenge, account_id, player_box_pk, near_pk) → the relay checks it,
// creates the NEAR account with only our function-call key, and registers the device key with
// the referee. From then on the enclave checks every batch against that key.

import { enrollClientDataHash } from "@tail/protocol";
import { toB64 } from "../lib/b64";
import type { RelayClient } from "../relay/client";
import { type Identity, type SecretStore, saveAccount, saveAttestKeyId } from "./identity";

export interface Attestor {
  readonly isSupported: boolean;
  generateKey(): Promise<string>;
  attestKey(keyId: string, clientDataHashB64: string): Promise<string>;
}

export async function enrol(
  handle: string,
  id: Identity,
  deps: { relay: RelayClient; attest: Attestor; secrets: SecretStore },
): Promise<Identity> {
  if (!deps.attest.isSupported) throw new Error("App Attest is not available on this device.");
  const ch = await deps.relay.enrollChallenge(handle.trim().toLowerCase());
  // A key is attested once. A fresh one per attempt means a failed enrolment can simply retry.
  const keyId = await deps.attest.generateKey();
  const hash = enrollClientDataHash(ch.challenge, ch.accountId, id.boxPk, id.nearPk);
  const attestation = await deps.attest.attestKey(keyId, toB64(hash));
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
