//! What the referee stores and signs besides verdicts, and the domains it signs them under.
//!
//! Every message the verdict key signs is `SHA256(domain ‖ borsh(body))` with a domain of its
//! own, so a signature over one kind can never be read as another (`tail/verdict/v1` is the
//! protocol's; the ones below belong to this module).

use borsh::{BorshDeserialize, BorshSerialize};
use tail_protocol::digest::sha256;
use tail_protocol::{CallId, Hash, MatchId};

pub mod domain {
    /// Signed statement that `referee_box_pk` is the referee's: `SHA256(this ‖ box_pk)`.
    pub const REFEREE_BOX: &[u8] = b"tail/referee-box/v1";
    /// Enrolment receipt: `SHA256(this ‖ borsh(Device))`.
    pub const ENROLL_RECEIPT: &[u8] = b"tail/enroll-receipt/v1";
    /// AAD of a sealed tick state: `this ‖ match_id`.
    pub const STATE: &[u8] = b"tail/state/v1";
    /// AAD of a latency-benchmark state (never opens as a match's state).
    pub const BENCH_STATE: &[u8] = b"tail/bench-state/v1";
    /// Seal contexts (aad) for what the referee seals to a player's box key.
    pub const SEAL_KEYS: &[u8] = b"tail/keys";
    pub const SEAL_HUD: &[u8] = b"tail/hud";
    /// Seal context of a phone's batch to the referee (`packages/protocol` `Domain.batch`).
    pub const SEAL_BATCH: &[u8] = tail_protocol::domain::BATCH;
}

/// An enrolled phone. Also the body of the enrolment receipt.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Device {
    pub account_id: String,
    /// App Attest public key, SEC1 uncompressed P-256 (0x04 ‖ x ‖ y). The referee checks every
    /// later assertion against this key.
    pub app_attest_pk: [u8; 65],
    /// True when `enroll` verified Apple's attestation of `app_attest_pk` here, bound to this
    /// account and these keys. False only for a ghost (simulated phone) enrolled while the
    /// referee ran with `ALLOW_UNATTESTED=1`: its key could be any software key.
    pub attested: bool,
    pub player_box_pk: [u8; 32],
    pub near_pk: [u8; 32],
    /// The OutLayer call that enrolled it.
    pub call_id: CallId,
}

pub fn device_record_key(account_id: &str) -> String {
    format!("device:{account_id}")
}

pub fn enroll_receipt_digest(d: &Device) -> Hash {
    sha256(&[domain::ENROLL_RECEIPT, &crate::codec::to_borsh(d)])
}

pub fn box_statement_digest(box_pk: &[u8; 32]) -> Hash {
    sha256(&[domain::REFEREE_BOX, box_pk])
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct EndRecord {
    pub seq: u32,
    pub log_size: u64,
    pub root: Hash,
    pub call_id: CallId,
}

/// Kept in storage from `start` on: what `end` must reveal and `declassify` releases.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct MatchRecord {
    pub match_id: MatchId,
    pub start_ms: u64,
    pub end_ms: u64,
    /// Sorted by account id; a player's number is its index here.
    pub players: Vec<Device>,
    /// Account ids in ring order: `ring[k]` hunts `ring[k+1 mod n]`.
    pub ring: Vec<String>,
    pub k_m: [u8; 32],
    pub vrf_alpha: String,
    pub vrf_signature: [u8; 64],
    pub start_call_id: CallId,
    pub end: Option<EndRecord>,
}

pub fn match_record_key(match_id: &MatchId) -> String {
    format!("match:{}", hex::encode(match_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domains_are_distinct_from_the_protocol_ones() {
        let ours = [
            domain::REFEREE_BOX,
            domain::ENROLL_RECEIPT,
            domain::STATE,
            domain::BENCH_STATE,
        ];
        for d in ours {
            assert_ne!(d, tail_protocol::domain::VERDICT);
            assert_ne!(d, tail_protocol::domain::ENROLL);
        }
    }

    #[test]
    fn receipt_digest_covers_every_field() {
        let d = Device {
            account_id: "alice.testnet".into(),
            app_attest_pk: [4; 65],
            attested: true,
            player_box_pk: [1; 32],
            near_pk: [2; 32],
            call_id: [3; 16],
        };
        let base = enroll_receipt_digest(&d);
        let mut e = d.clone();
        e.near_pk[0] ^= 1;
        assert_ne!(base, enroll_receipt_digest(&e));
        let mut e = d.clone();
        e.attested = false;
        assert_ne!(base, enroll_receipt_digest(&e));
        let mut e = d;
        e.call_id[15] ^= 1;
        assert_ne!(base, enroll_receipt_digest(&e));
    }
}
