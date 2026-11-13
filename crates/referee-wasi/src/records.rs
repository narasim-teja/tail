//! What the referee stores and signs besides verdicts, and the domains it signs them under.
//!
//! Every message the verdict key signs is `SHA256(domain ‖ borsh(body))` with a domain of its
//! own, so a signature over one kind can never be read as another. Verdicts, HUDs, player keys
//! and Handler lines are signed and sealed under the protocol's domains
//! (`tail_protocol::domain`); the ones below belong to this module.

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
}

/// A hint `tick` issued, as `voice` needs it: sealed to the referee (`vault::Purpose::Hint`)
/// so the relay that carries it learns neither the fact nor the question.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct HintBlob {
    pub match_id: MatchId,
    pub hint_id: u32,
    /// The asker, who gets the Handler's line.
    pub player: u16,
    /// `hint_kind`.
    pub hint: u8,
    /// `HintFact.value`.
    pub value: u8,
    /// Hints bought in the price window before this one (`HintIssued.recent`), so the Handler
    /// can say why it cost what it did.
    pub recent: u32,
    pub question: Option<String>,
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

/// What `enroll` stores under `device_record_key`: the device and when Apple certified its App
/// Attest key.
///
/// Stored as `borsh(Device) ‖ DEVICE_RECORD_V2 ‖ u64le(credential_not_before)`. A version 1
/// record is `borsh(Device)` alone (a referee from before the time was kept) and reads as
/// `credential_not_before: 0`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceRecord {
    pub device: Device,
    /// The notBefore of the credential certificate in the attestation that enrolled
    /// `device.app_attest_pk`, Unix seconds. A rebind signature carries no time of its own, so
    /// this is what orders the account's attestations: a move must bring a later one, and an
    /// attestation the relay kept from an earlier move cannot put an older key back. 0 for a
    /// ghost and for a version 1 record: nothing to order against.
    pub credential_not_before: u64,
}

pub const DEVICE_RECORD_V2: u8 = 2;

impl DeviceRecord {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = crate::codec::to_borsh(&self.device);
        out.push(DEVICE_RECORD_V2);
        out.extend_from_slice(&self.credential_not_before.to_le_bytes());
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<DeviceRecord, String> {
        let mut rest = bytes;
        let device = Device::deserialize(&mut rest).map_err(|e| e.to_string())?;
        let credential_not_before =
            match rest {
                [] => 0,
                [DEVICE_RECORD_V2, t @ ..] => u64::from_le_bytes(t.try_into().map_err(|_| {
                    format!("version {DEVICE_RECORD_V2} record has {} trailing bytes", t.len())
                })?),
                [v, ..] => return Err(format!("device record version {v}")),
            };
        Ok(DeviceRecord {
            device,
            credential_not_before,
        })
    }
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
        use tail_protocol::domain as p;
        let ours = [
            domain::REFEREE_BOX,
            domain::ENROLL_RECEIPT,
            domain::STATE,
            domain::BENCH_STATE,
        ];
        for d in ours {
            for theirs in [
                p::VERDICT,
                p::ENROLL,
                p::HUD,
                p::KEYS,
                p::VOICE,
                p::BATCH,
                p::SEAL,
            ] {
                assert_ne!(d, theirs);
            }
        }
    }

    fn alice() -> Device {
        Device {
            account_id: "alice.testnet".into(),
            app_attest_pk: [4; 65],
            attested: true,
            player_box_pk: [1; 32],
            near_pk: [2; 32],
            call_id: [3; 16],
        }
    }

    #[test]
    fn device_records_round_trip_and_read_version_1() {
        let r = DeviceRecord {
            device: alice(),
            credential_not_before: 1_794_427_669,
        };
        assert_eq!(DeviceRecord::decode(&r.encode()), Ok(r.clone()));
        // Version 1: the receipt body alone.
        let v1 = crate::codec::to_borsh(&alice());
        assert_eq!(
            DeviceRecord::decode(&v1),
            Ok(DeviceRecord {
                device: alice(),
                credential_not_before: 0
            })
        );
        let mut bad = r.encode();
        bad.pop();
        assert!(DeviceRecord::decode(&bad).is_err());
        let mut bad = v1.clone();
        bad.extend_from_slice(&[3; 9]);
        assert!(DeviceRecord::decode(&bad).is_err());
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
