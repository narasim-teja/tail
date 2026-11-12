//! Sealing between phones and the referee.
//!
//! sealed = eph_pk (32) ‖ ChaCha20-Poly1305(key, nonce = 0, plaintext, aad = context), with
//! key = HKDF-SHA256(ikm = X25519(eph_sk, recipient_pk), salt = eph_pk ‖ recipient_pk,
//! info = "tail/seal/v1"). Every key is used once, so the zero nonce is safe.

use crate::constants::domain;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::ChaCha20Poly1305;
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

const NONCE: [u8; 12] = [0; 12];

#[derive(Debug, PartialEq, Eq)]
pub enum SealError {
    TooShort,
    Decrypt,
}

fn key(shared: &[u8; 32], eph_pk: &[u8; 32], recipient_pk: &[u8; 32]) -> ChaCha20Poly1305 {
    let salt = [eph_pk.as_slice(), recipient_pk.as_slice()].concat();
    let mut k = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&salt), shared)
        .expand(domain::SEAL, &mut k)
        .expect("32 bytes is valid");
    ChaCha20Poly1305::new(&k.into())
}

pub fn public_key(sk: &[u8; 32]) -> [u8; 32] {
    PublicKey::from(&StaticSecret::from(*sk)).to_bytes()
}

/// Seal with a caller-chosen ephemeral secret (fresh randomness in production, fixed in tests).
pub fn seal_with(eph_sk: &[u8; 32], recipient_pk: &[u8; 32], plaintext: &[u8], context: &[u8]) -> Vec<u8> {
    let secret = StaticSecret::from(*eph_sk);
    let ephemeral_pk = PublicKey::from(&secret).to_bytes();
    let shared = secret.diffie_hellman(&PublicKey::from(*recipient_pk)).to_bytes();
    let ct = key(&shared, &ephemeral_pk, recipient_pk)
        .encrypt(
            &NONCE.into(),
            Payload {
                msg: plaintext,
                aad: context,
            },
        )
        .expect("ChaCha20-Poly1305 encryption of an in-memory buffer cannot fail");
    [ephemeral_pk.as_slice(), &ct].concat()
}

pub fn open(recipient_sk: &[u8; 32], sealed: &[u8], context: &[u8]) -> Result<Vec<u8>, SealError> {
    if sealed.len() < 32 + 16 {
        return Err(SealError::TooShort);
    }
    let eph_pk: [u8; 32] = sealed[..32].try_into().expect("32 bytes");
    let me = StaticSecret::from(*recipient_sk);
    let shared = me.diffie_hellman(&PublicKey::from(eph_pk)).to_bytes();
    key(&shared, &eph_pk, &PublicKey::from(&me).to_bytes())
        .decrypt(
            &NONCE.into(),
            Payload {
                msg: &sealed[32..],
                aad: context,
            },
        )
        .map_err(|_| SealError::Decrypt)
}
