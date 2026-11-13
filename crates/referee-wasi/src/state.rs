//! The tick state, sealed with the enclave's `state` encryption key and held by the relay
//! between calls, so a tick never touches OutLayer storage (S2: about 1 s per storage call).
//!
//! The blob opens only in a run of this project for the same signer (the relay's account) and
//! only under `aad = domain ‖ match_id`, so it cannot be moved to another match. What sealing
//! cannot stop is the relay handing back an *older* blob of the same match. The engine's verdict
//! counter is the defence: the caller reports the last verdict seq it holds (the contract's
//! last seq), and the blob must be the one that was sealed together with that verdict.

use crate::host;
use borsh::{BorshDeserialize, BorshSerialize};
use tail_protocol::MatchId;

/// Bumped when the layout changes; an old blob is refused rather than misread.
pub const VERSION: u8 = 4;

#[derive(BorshSerialize, BorshDeserialize, Clone, PartialEq)]
pub struct MatchState {
    pub version: u8,
    pub match_id: MatchId,
    /// Last tick number given to the engine (0 before the first tick).
    pub tick_no: u32,
    /// The referee's box secret, so a tick can open sealed batches without a storage read.
    /// It is inside the same enclave-sealed blob as the engine's match keys.
    pub box_sk: [u8; 32],
    /// Each player's box key, by player number, for sealing HUDs.
    pub box_pks: Vec<[u8; 32]>,
    /// The rules engine's state. It owns players, heads, App Attest counters, the log frontier
    /// and the verdict seq; this wrapper keeps no copy of any of them.
    pub core: referee_core::State,
}

impl MatchState {
    /// Seq of the last verdict signed for this match (Start = 1).
    pub fn last_seq(&self) -> u32 {
        self.core.next_verdict_seq() - 1
    }
}

// Hand-written so the box secret never reaches a log; the engine's own Debug hides its keys.
impl std::fmt::Debug for MatchState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MatchState")
            .field("match_id", &self.match_id)
            .field("tick_no", &self.tick_no)
            .field("core", &self.core)
            .finish_non_exhaustive()
    }
}

fn aad(domain: &[u8], match_id: &MatchId) -> Vec<u8> {
    [domain, match_id.as_slice()].concat()
}

/// Seals any versioned blob of this crate (tick state, latency-benchmark state).
pub fn seal<T: BorshSerialize>(value: &T, domain: &[u8], match_id: &MatchId) -> Result<Vec<u8>, String> {
    host::encrypt_state(&crate::codec::to_borsh(value), &aad(domain, match_id))
}

pub fn open_raw(blob: &[u8], domain: &[u8], match_id: &MatchId) -> Result<Vec<u8>, String> {
    host::decrypt_state(blob, &aad(domain, match_id))
}

pub fn open(blob: &[u8], domain: &[u8], match_id: &MatchId) -> Result<MatchState, String> {
    decode(&open_raw(blob, domain, match_id)?, match_id)
}

fn decode(plain: &[u8], match_id: &MatchId) -> Result<MatchState, String> {
    // The version byte comes first, so an old layout is named instead of failing to parse.
    match plain.first() {
        Some(&VERSION) => {}
        Some(v) => return Err(format!("state blob version {v} (this referee reads {VERSION})")),
        None => return Err("state blob is empty".into()),
    }
    let s: MatchState = borsh::from_slice(plain).map_err(|e| format!("state blob does not decode: {e}"))?;
    // The aad already binds the match; this catches a layout bug, not an attacker.
    if &s.match_id != match_id || s.core.match_id() != *match_id {
        return Err("state blob belongs to another match".into());
    }
    Ok(s)
}

/// Rollback check. `reported` is the last verdict seq the caller holds; the blob must be the
/// one produced together with that verdict.
pub fn check_seq(blob_seq: u32, reported: u32) -> Result<(), String> {
    match blob_seq.cmp(&reported) {
        std::cmp::Ordering::Equal => Ok(()),
        std::cmp::Ordering::Less => Err(format!(
            "stale state: the blob was sealed at verdict seq {blob_seq} but the last verdict is {reported} (rollback refused)"
        )),
        std::cmp::Ordering::Greater => Err(format!(
            "state is ahead of the caller: the blob is at verdict seq {blob_seq}, the caller reports {reported}; \
             apply the verdicts returned with this blob first"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use referee_core::{Circle, Device, MatchConfig};

    fn sample() -> MatchState {
        // The P-256 generator point is a valid device key for the engine's check.
        let key: [u8; 65] = hex::decode(
            "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296\
             4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
        )
        .unwrap()
        .try_into()
        .unwrap();
        let cfg = MatchConfig {
            match_id: [7; 16],
            app_id: "T.app".into(),
            stake: 100,
            duration_ms: 60_000,
            zone: Circle {
                lat_e7: 0,
                lon_e7: 0,
                radius_m: 100,
            },
            safehouses: Vec::new(),
        };
        let devices = ["a.testnet", "b.testnet"]
            .map(|a| Device {
                account_id: a.into(),
                key,
                counter: 0,
                attested: true,
            })
            .to_vec();
        let started = referee_core::init(cfg, devices, &[1; 32], &[2; 64], 1_000, [3; 16]).unwrap();
        MatchState {
            version: VERSION,
            match_id: [7; 16],
            tick_no: 0,
            box_sk: [2; 32],
            box_pks: vec![[5; 32]; 2],
            core: started.state,
        }
    }

    #[test]
    fn decode_round_trip_and_match_binding() {
        let s = sample();
        assert_eq!(s.last_seq(), 1);
        let bytes = crate::codec::to_borsh(&s);
        assert!(decode(&bytes, &[7; 16]).unwrap() == s);
        assert!(decode(&bytes, &[8; 16]).unwrap_err().contains("another match"));
    }

    #[test]
    fn decode_refuses_other_versions() {
        let mut bytes = crate::codec::to_borsh(&sample());
        bytes[0] = 1;
        assert!(decode(&bytes, &[7; 16]).unwrap_err().contains("version 1"));
    }

    #[test]
    fn debug_hides_the_box_secret() {
        let s = format!("{:?}", sample());
        assert!(!s.contains("box_sk") && !s.contains("2, 2, 2"));
    }

    #[test]
    fn rollback_check() {
        assert!(check_seq(5, 5).is_ok());
        assert!(check_seq(4, 5).unwrap_err().contains("rollback"));
        assert!(check_seq(6, 5).unwrap_err().contains("ahead"));
    }

    #[test]
    fn aad_binds_domain_and_match() {
        use crate::records::domain::{BENCH_STATE, STATE};
        assert_ne!(aad(STATE, &[1; 16]), aad(BENCH_STATE, &[1; 16]));
        assert_ne!(aad(STATE, &[1; 16]), aad(STATE, &[2; 16]));
    }
}
