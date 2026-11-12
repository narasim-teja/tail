//! Players hash, ring commitment and the deterministic ring from the VRF signature (4.8).

use crate::constants::domain;
use crate::digest::sha256;
use crate::messages::Hash;

/// Account ids sorted by their UTF-8 bytes (Rust's `str` ordering).
pub fn sort_accounts<S: AsRef<str>>(ids: &[S]) -> Vec<String> {
    let mut v: Vec<String> = ids.iter().map(|s| s.as_ref().to_owned()).collect();
    v.sort();
    v
}

pub fn players_hash<S: AsRef<str>>(ids: &[S]) -> Hash {
    let sorted = sort_accounts(ids);
    sha256(&[
        domain::PLAYERS,
        &borsh::to_vec(&sorted).expect("borsh into a Vec cannot fail"),
    ])
}

pub fn ring_commit(vrf_signature: &[u8; 64]) -> Hash {
    sha256(&[domain::RING, vrf_signature])
}

/// Fisher–Yates over the sorted ids. r_k = u64 LE of SHA256(seed ‖ u32le(k))[0..8],
/// seed = SHA256(vrf_signature), j = r_k mod (i + 1). `ring[k]` hunts `ring[k+1 mod n]`.
pub fn build_ring<S: AsRef<str>>(ids: &[S], vrf_signature: &[u8; 64]) -> Vec<String> {
    let mut ring = sort_accounts(ids);
    let seed = sha256(&[vrf_signature]);
    for (k, i) in (1..ring.len()).rev().enumerate() {
        let k = u32::try_from(k).expect("fewer than 2^32 players");
        let h = sha256(&[&seed, &k.to_le_bytes()]);
        let r = u64::from_le_bytes(h[..8].try_into().expect("8 bytes"));
        let j = (r % (i as u64 + 1)) as usize;
        ring.swap(i, j);
    }
    ring
}
