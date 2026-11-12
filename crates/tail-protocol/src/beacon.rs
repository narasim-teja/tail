//! Match keys and the rotating beacon (4.1, 4.2).

use crate::constants::{domain, EPOCH_MS};
use crate::messages::Token;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;

fn derive(k_m: &[u8; 32], info: &[&[u8]]) -> [u8; 32] {
    let info: Vec<u8> = info.concat();
    let mut out = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&[]), k_m)
        .expand(&info, &mut out)
        .expect("32 bytes is a valid HKDF length");
    out
}

/// Shared by every player in the match: recognises "a beacon from my match".
pub fn derive_tag_key(k_m: &[u8; 32]) -> [u8; 32] {
    derive(k_m, &[domain::TAG])
}

/// Player i's beacon key. Only the enclave and player i hold it.
pub fn derive_player_key(k_m: &[u8; 32], player: u16) -> [u8; 32] {
    derive(k_m, &[domain::BEACON, &player.to_le_bytes()])
}

fn hmac(key: &[u8; 32], parts: &[&[u8]]) -> [u8; 32] {
    let mut m = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes any key length");
    for p in parts {
        m.update(p);
    }
    m.finalize().into_bytes().into()
}

pub fn epoch_at(now_ms: u64, start_ms: u64) -> Option<u32> {
    now_ms
        .checked_sub(start_ms)
        .and_then(|d| u32::try_from(d / EPOCH_MS).ok())
}

pub fn beacon_tag(k_tag: &[u8; 32], epoch: u32) -> [u8; 4] {
    hmac(k_tag, &[domain::TAG_MAC, &epoch.to_le_bytes()])[..4]
        .try_into()
        .expect("4 bytes")
}

/// 16-byte token = tag(e) ‖ mac_i(e).
pub fn beacon_token(k_tag: &[u8; 32], k_player: &[u8; 32], epoch: u32) -> Token {
    let mut t = [0u8; 16];
    t[..4].copy_from_slice(&beacon_tag(k_tag, epoch));
    t[4..].copy_from_slice(&hmac(k_player, &[domain::TOKEN_MAC, &epoch.to_le_bytes()])[..12]);
    t
}

/// Phone-side filter: is this token from my match, for epochs e−1, e or e+1?
pub fn tag_matches(k_tag: &[u8; 32], token: &Token, epoch: u32) -> bool {
    [epoch.checked_sub(1), Some(epoch), epoch.checked_add(1)]
        .into_iter()
        .flatten()
        .any(|e| token[..4] == beacon_tag(k_tag, e))
}

/// Enclave-side: which player sent this token in epoch e?
pub fn resolve_token(k_players: &[[u8; 32]], k_tag: &[u8; 32], token: &Token, epoch: u32) -> Option<u16> {
    k_players
        .iter()
        .position(|k| &beacon_token(k_tag, k, epoch) == token)
        .and_then(|i| u16::try_from(i).ok())
}
