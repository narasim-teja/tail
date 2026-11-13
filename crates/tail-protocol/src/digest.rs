//! Hashes that cross a trust boundary: verdict, HUD, keys and voice signature digests, batch
//! hash, App Attest client data.

use crate::constants::domain;
use crate::messages::{Batch, Hash, Hud, PlayerKeys, VerdictPayload, VoiceLine};
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

/// The 32 bytes the referee signs (ed25519) and the contract checks with `ed25519_verify`:
/// `SHA256("tail/verdict/v2" ‖ borsh(match_id, seq, prev, call_id, body))`. The next verdict's
/// `prev` is this value.
pub fn verdict_digest(p: &VerdictPayload) -> Hash {
    sha256(&[domain::VERDICT, &borsh(p)])
}

/// `SHA256("tail/hud/v2" ‖ borsh(hud))`, signed by the referee key.
pub fn hud_sig_digest(hud: &Hud) -> Hash {
    sha256(&[domain::HUD, &borsh(hud)])
}

/// `SHA256("tail/keys/v2" ‖ borsh(keys))`, signed by the referee key.
pub fn keys_sig_digest(keys: &PlayerKeys) -> Hash {
    sha256(&[domain::KEYS, &borsh(keys)])
}

/// `SHA256("tail/voice/v1" ‖ borsh(line))`, signed by the referee key.
pub fn voice_sig_digest(line: &VoiceLine) -> Hash {
    sha256(&[domain::VOICE, &borsh(line)])
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
