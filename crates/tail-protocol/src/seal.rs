//! Sealing between phones and the referee.
//!
//! sealed = eph_pk (32) ‖ ChaCha20-Poly1305(key, nonce = 0, plaintext, aad = context), with
//! key = HKDF-SHA256(ikm = X25519(eph_sk, recipient_pk), salt = eph_pk ‖ recipient_pk,
//! info = "tail/seal/v1"). Every key is used once, so the zero nonce is safe.
//!
//! Low-order public keys are refused on both sides. With one, the X25519 output is all zeros
//! whatever the secret, so the "sealed" message would be readable by anyone.

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
    /// A low-order public key, or a shared secret of all zeros.
    LowOrderKey,
}

/// The u-coordinates of order dividing 8 on Curve25519 and its twist (0, 1, p−1 and the two
/// order-8 points), plus the non-canonical encodings p and p+1 of 0 and 1. Compared after
/// clearing bit 255, which X25519 ignores. Same list as libsodium.
const LOW_ORDER: [[u8; 32]; 7] = [
    [0; 32],
    {
        let mut u = [0; 32];
        u[0] = 1;
        u
    },
    hex32(b"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
    hex32(b"e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800"),
    hex32(b"5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157"),
    hex32(b"edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
    hex32(b"eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
];

const fn hex32(s: &[u8; 64]) -> [u8; 32] {
    const fn nibble(c: u8) -> u8 {
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            _ => panic!("not lowercase hex"),
        }
    }
    let mut out = [0; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = (nibble(s[2 * i]) << 4) | nibble(s[2 * i + 1]);
        i += 1;
    }
    out
}

/// True for an X25519 public key whose shared secret with any private key is all zeros.
pub fn is_low_order(pk: &[u8; 32]) -> bool {
    let mut u = *pk;
    u[31] &= 0x7f;
    LOW_ORDER.contains(&u)
}

fn shared(sk: &StaticSecret, pk: &[u8; 32]) -> Result<[u8; 32], SealError> {
    if is_low_order(pk) {
        return Err(SealError::LowOrderKey);
    }
    let s = sk.diffie_hellman(&PublicKey::from(*pk));
    // Unreachable once low-order keys are refused; kept so a gap in the list cannot leak.
    if !s.was_contributory() {
        return Err(SealError::LowOrderKey);
    }
    Ok(s.to_bytes())
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
pub fn seal_with(
    eph_sk: &[u8; 32],
    recipient_pk: &[u8; 32],
    plaintext: &[u8],
    context: &[u8],
) -> Result<Vec<u8>, SealError> {
    let secret = StaticSecret::from(*eph_sk);
    let ephemeral_pk = PublicKey::from(&secret).to_bytes();
    let shared = shared(&secret, recipient_pk)?;
    let ct = key(&shared, &ephemeral_pk, recipient_pk)
        .encrypt(
            &NONCE.into(),
            Payload {
                msg: plaintext,
                aad: context,
            },
        )
        .expect("ChaCha20-Poly1305 encryption of an in-memory buffer cannot fail");
    Ok([ephemeral_pk.as_slice(), &ct].concat())
}

pub fn open(recipient_sk: &[u8; 32], sealed: &[u8], context: &[u8]) -> Result<Vec<u8>, SealError> {
    if sealed.len() < 32 + 16 {
        return Err(SealError::TooShort);
    }
    let eph_pk: [u8; 32] = sealed[..32].try_into().expect("32 bytes");
    let me = StaticSecret::from(*recipient_sk);
    let shared = shared(&me, &eph_pk)?;
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
