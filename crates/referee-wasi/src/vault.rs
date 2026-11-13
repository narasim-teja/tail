//! Blobs only this referee can make or open: the log entries and hint facts it hands the relay
//! during play, opaque to the relay and unforgeable by it.
//!
//! `blob = nonce (24 B) ‖ XChaCha20-Poly1305(key, nonce, plaintext, aad = bind)` with
//! `key = HKDF-SHA256(ikm = referee box secret, info = "tail/referee-vault/v1" ‖ purpose ‖ match_id)`.
//! Sealing to the referee's box *public* key would hide the content too, but anyone can seal to
//! a public key, the relay included; a key derived from the box *secret* means a blob that opens
//! was made here. Pure computation inside the module, so a tick pays no extra host call for it.
//! `bind` ties a blob to its place (a log blob to the log index of its first entry), so blobs
//! cannot be reordered or swapped between purposes and matches.

use crate::host;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use sha2::Sha256;
use tail_protocol::MatchId;

const INFO: &[u8] = b"tail/referee-vault/v1";
const NONCE_LEN: usize = 24;

/// What a blob holds; each has its own key.
#[derive(Clone, Copy, Debug)]
pub enum Purpose {
    /// borsh `Vec<LogEntry>` of one call's new entries; bound to the index of the first.
    Log,
    /// borsh `HintBlob`: a hint for `voice` to put into words.
    Hint,
    /// borsh `referee_core::HintReceipt` from `voice`, for the next tick to log.
    Receipt,
}

impl Purpose {
    fn label(self) -> &'static str {
        match self {
            Purpose::Log => "log",
            Purpose::Hint => "hint",
            Purpose::Receipt => "receipt",
        }
    }
}

fn cipher(box_sk: &[u8; 32], purpose: Purpose, match_id: &MatchId) -> XChaCha20Poly1305 {
    let info = [INFO, purpose.label().as_bytes(), match_id.as_slice()].concat();
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(None, box_sk)
        .expand(&info, &mut key)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    XChaCha20Poly1305::new(&key.into())
}

pub fn seal(
    box_sk: &[u8; 32],
    purpose: Purpose,
    match_id: &MatchId,
    bind: &[u8],
    plaintext: &[u8],
) -> Vec<u8> {
    // A random 192-bit nonce cannot repeat in practice, so no counter has to survive calls.
    let nonce: [u8; NONCE_LEN] = host::random();
    let ct = cipher(box_sk, purpose, match_id)
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: bind,
            },
        )
        .expect("XChaCha20-Poly1305 encryption of an in-memory buffer cannot fail");
    [nonce.as_slice(), &ct].concat()
}

pub fn open(
    box_sk: &[u8; 32],
    purpose: Purpose,
    match_id: &MatchId,
    bind: &[u8],
    blob: &[u8],
) -> Result<Vec<u8>, String> {
    let refused = || {
        format!(
            "{} blob was not made by this referee for this match and place",
            purpose.label()
        )
    };
    if blob.len() < NONCE_LEN {
        return Err(refused());
    }
    let (nonce, ct) = blob.split_at(NONCE_LEN);
    cipher(box_sk, purpose, match_id)
        .decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad: bind })
        .map_err(|_| refused())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blob_opens_only_for_its_purpose_match_place_and_key() {
        let sk = [3; 32];
        let blob = seal(&sk, Purpose::Log, &[1; 16], &5u64.to_le_bytes(), b"entries");
        assert_eq!(
            open(&sk, Purpose::Log, &[1; 16], &5u64.to_le_bytes(), &blob).unwrap(),
            b"entries"
        );
        assert!(open(&sk, Purpose::Hint, &[1; 16], &5u64.to_le_bytes(), &blob).is_err());
        assert!(open(&sk, Purpose::Log, &[2; 16], &5u64.to_le_bytes(), &blob).is_err());
        assert!(open(&sk, Purpose::Log, &[1; 16], &6u64.to_le_bytes(), &blob).is_err());
        assert!(open(&[4; 32], Purpose::Log, &[1; 16], &5u64.to_le_bytes(), &blob).is_err());
        let mut flipped = blob.clone();
        flipped[30] ^= 1;
        assert!(open(&sk, Purpose::Log, &[1; 16], &5u64.to_le_bytes(), &flipped).is_err());
        assert!(open(&sk, Purpose::Log, &[1; 16], &5u64.to_le_bytes(), &blob[..10]).is_err());
    }
}
