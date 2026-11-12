//! TAIL wire formats and crypto. Byte-identical to `packages/protocol` (TypeScript); the
//! golden vectors in `packages/protocol/vectors/` pin both sides.
//!
//! Features: none by default (messages, verdict digest, Merkle log, ring — SHA-256 only, so the
//! NEAR contract can depend on it); `beacon` adds HMAC/HKDF token maths; `seal` adds
//! X25519 + ChaCha20-Poly1305 sealing.

pub mod constants;
pub mod digest;
pub mod merkle;
pub mod messages;
pub mod ring;

#[cfg(feature = "beacon")]
pub mod beacon;
#[cfg(feature = "seal")]
pub mod seal;

pub use constants::*;
pub use messages::*;
