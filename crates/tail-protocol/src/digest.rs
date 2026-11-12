//! Hashes that cross a trust boundary: verdict digest, batch hash, App Attest client data.

use crate::constants::domain;
use crate::messages::{Batch, Hash, VerdictPayload};
use borsh::BorshSerialize;
use sha2::{Digest, Sha256};

pub fn sha256(parts: &[&[u8]]) -> Hash {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn borsh<T: BorshSerialize>(v: &T) -> Vec<u8> {
    borsh::to_vec(v).expect("borsh serialization into a Vec cannot fail")
}

/// The 32 bytes the referee signs (ed25519) and the contract checks with `ed25519_verify`.
pub fn verdict_digest(p: &VerdictPayload) -> Hash {
    sha256(&[domain::VERDICT, &borsh(p)])
}

/// Hash-chain link and Merkle log id of a batch.
pub fn batch_hash(b: &Batch) -> Hash {
    sha256(&[&borsh(b)])
}

/// The clientDataHash an App Attest assertion over this batch signs.
pub fn batch_client_data_hash(b: &Batch) -> Hash {
    sha256(&[domain::BATCH, &borsh(b)])
}

/// The clientDataHash the enrolment attestation signs: binds the device key to the account.
pub fn enroll_client_data_hash(
    challenge: &[u8; 32],
    account_id: &str,
    player_box_pk: &[u8; 32],
    near_pk: &[u8; 32],
) -> Hash {
    sha256(&[
        domain::ENROLL,
        challenge,
        &borsh(&account_id.to_owned()),
        player_box_pk,
        near_pk,
    ])
}
