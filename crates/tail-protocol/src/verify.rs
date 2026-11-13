//! ed25519 checks of what the referee signs, for off-chain Rust verifiers. The contract does not
//! use this (it has `env::ed25519_verify`), and the referee only signs.
//!
//! Strict RFC 8032 verification: small-order keys and non-canonical encodings are refused, as in
//! the TypeScript side (`zip215: false`).

use crate::digest::{hud_sig_digest, keys_sig_digest, verdict_digest, voice_sig_digest};
use crate::messages::{Hash, SignedHud, SignedPlayerKeys, SignedVerdict, SignedVoiceLine};
use ed25519_dalek::{Signature, VerifyingKey};

/// Does `sig` sign `digest` under the ed25519 key `pk`?
pub fn ed25519(pk: &[u8; 32], digest: &Hash, sig: &[u8; 64]) -> bool {
    VerifyingKey::from_bytes(pk).is_ok_and(|k| k.verify_strict(digest, &Signature::from_bytes(sig)).is_ok())
}

pub fn signed_verdict(v: &SignedVerdict, referee_pk: &[u8; 32]) -> bool {
    ed25519(referee_pk, &verdict_digest(&v.payload()), &v.sig)
}

pub fn signed_hud(h: &SignedHud, referee_pk: &[u8; 32]) -> bool {
    ed25519(referee_pk, &hud_sig_digest(&h.hud), &h.sig)
}

pub fn signed_keys(k: &SignedPlayerKeys, referee_pk: &[u8; 32]) -> bool {
    ed25519(referee_pk, &keys_sig_digest(&k.keys), &k.sig)
}

pub fn signed_voice(v: &SignedVoiceLine, referee_pk: &[u8; 32]) -> bool {
    ed25519(referee_pk, &voice_sig_digest(&v.line), &v.sig)
}
