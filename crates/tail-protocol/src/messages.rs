//! Wire messages. Field order is the borsh order and must match
//! `packages/protocol/src/messages.ts`. Enum variant order is the u8 tag: append, never reorder.

use borsh::{BorshDeserialize, BorshSerialize};

pub type MatchId = [u8; 16];
pub type CallId = [u8; 16];
pub type Token = [u8; 16];
pub type Hash = [u8; 32];

// ── Phone → enclave ─────────────────────────────────────────────────────────────

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Fix {
    pub t_ms: u64,
    pub lat_e7: i32,
    pub lon_e7: i32,
    pub acc_m: u16,
    pub speed_cmps: u16,
    /// `fix_flag` bits; any set bit makes the batch invalid.
    pub flags: u8,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Sighting {
    pub epoch: u32,
    pub token: Token,
    pub rssi_max: i8,
    pub rssi_med: i8,
    pub n: u8,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum Action {
    Hint {
        hint: u8,
        nonce: u32,
        text: Option<String>,
    },
    Strike {
        nonce: u32,
    },
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Batch {
    pub match_id: MatchId,
    pub player: u16,
    pub seq: u32,
    /// `SHA256(borsh(previous batch))`, zeros for seq 0.
    pub prev: Hash,
    pub t_ms: u64,
    pub fixes: Vec<Fix>,
    pub sightings: Vec<Sighting>,
    pub actions: Vec<Action>,
}

/// What a phone seals to the referee: the batch plus its App Attest assertion.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct BatchEnvelope {
    pub batch: Batch,
    pub assertion: Vec<u8>,
}

// ── Enclave → contract ──────────────────────────────────────────────────────────

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    Start {
        players_hash: Hash,
        ring_commit: Hash,
        start_ms: u64,
        end_ms: u64,
    },
    Hint {
        from: u16,
        to: u16,
        amount: u128,
        hint_id: u32,
    },
    Tag {
        hunter: u16,
        target: u16,
    },
    Forfeit {
        player: u16,
        to: u16,
    },
    Checkpoint {
        log_size: u64,
        root: Hash,
    },
    End {
        alpha: String,
        vrf_signature: [u8; 64],
        log_size: u64,
        root: Hash,
    },
}

/// The signed part of a verdict. `call_id` is the OutLayer call that produced it, so the
/// replay can fetch that call's attestation record and check the executed wasm hash.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct VerdictPayload {
    pub match_id: MatchId,
    pub seq: u32,
    pub call_id: CallId,
    pub body: Verdict,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct SignedVerdict {
    pub match_id: MatchId,
    pub seq: u32,
    pub call_id: CallId,
    pub body: Verdict,
    pub sig: [u8; 64],
}

impl SignedVerdict {
    pub fn payload(&self) -> VerdictPayload {
        VerdictPayload {
            match_id: self.match_id,
            seq: self.seq,
            call_id: self.call_id,
            body: self.body.clone(),
        }
    }
}

// ── Match log ───────────────────────────────────────────────────────────────────

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum LogEntry {
    Batch {
        player: u16,
        seq: u32,
        hash: Hash,
    },
    Contact {
        a: u16,
        b: u16,
        epoch: u32,
    },
    Verdict {
        seq: u32,
        digest: Hash,
    },
    HintReceipt {
        hint_id: u32,
        chat_id: String,
        text_hash: Hash,
        signature: Vec<u8>,
        signing_address: String,
    },
}

// ── Enclave → phone (sealed to the player's box key) ─────────────────────────────

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct PlayerKeys {
    pub match_id: MatchId,
    pub player: u16,
    pub start_ms: u64,
    pub end_ms: u64,
    pub k_tag: [u8; 32],
    pub k_player: [u8; 32],
    /// Account id of this player's target.
    pub target: String,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct GridCell {
    pub lat_e7: i32,
    pub lon_e7: i32,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct HintFact {
    pub hint_id: u32,
    pub hint: u8,
    /// NEAR: 0/1. BEARING: 0..7 (N, NE, E, …). TREND: 0 farther, 1 closer, 2 same.
    pub value: u8,
}

/// Per-tick heads-up display for one player: only their own data.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Hud {
    pub tick: u32,
    pub epoch: u32,
    pub lock: u8,
    pub heat: u8,
    pub head: u128,
    pub status: u8,
    pub target: String,
    pub leak: Option<GridCell>,
    pub hint_fact: Option<HintFact>,
}
