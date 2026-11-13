//! TAIL wire formats and crypto. Byte-identical to `packages/protocol` (TypeScript); the
//! golden vectors in `packages/protocol/vectors/` pin both sides.
//!
//! Features: none by default (messages, signature digests, Merkle log with inclusion and
//! consistency proofs, presence proofs, ring, the settlement replay — SHA-256 only, so the
//! NEAR contract can depend on it); `beacon` adds HMAC/HKDF token maths; `seal` adds X25519 + ChaCha20-Poly1305 sealing;
//! `verify` adds ed25519 checks of referee signatures for off-chain verifiers.

pub mod constants;
pub mod digest;
pub mod merkle;
pub mod messages;
pub mod presence;
pub mod ring;
pub mod settle;

#[cfg(feature = "beacon")]
pub mod beacon;
#[cfg(feature = "seal")]
pub mod seal;
#[cfg(feature = "verify")]
pub mod verify;

pub use constants::*;
pub use messages::*;
