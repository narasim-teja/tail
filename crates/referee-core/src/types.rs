//! Inputs and outputs of the engine that are not wire formats of `tail-protocol`.

use crate::state::State;
use borsh::{BorshDeserialize, BorshSerialize};
use tail_protocol::{
    BatchEnvelope, CallId, Hash, HintFact, Hud, LogEntry, MatchId, PlayerKeys, VerdictPayload,
};

/// A circle on the map: the play zone or a safehouse.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Circle {
    pub lat_e7: i32,
    pub lon_e7: i32,
    pub radius_m: u32,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct MatchConfig {
    pub match_id: MatchId,
    /// App Attest App ID (`TEAMID.bundle.id`); assertions must carry SHA256(app_id) as rpIdHash.
    pub app_id: String,
    /// Every player's starting head, in the token's smallest unit.
    pub stake: u128,
    pub duration_ms: u64,
    /// The play zone is one circle; its centre also anchors the leak grid and the local plane.
    pub zone: Circle,
    /// Places where no contact counts, so locks cannot fill.
    pub safehouses: Vec<Circle>,
}

/// An enrolled player: account id and the App Attest key the relay verified at enrolment (4.4).
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Device {
    pub account_id: String,
    /// SEC1 uncompressed P-256 public key (65 bytes, `0x04 ‖ x ‖ y`).
    pub key: [u8; 65],
    /// Counter of the last assertion seen at enrolment (0 straight after attestation).
    pub counter: u32,
}

/// A NEAR AI Cloud signature over a Handler line, produced by the `voice` command after the
/// hint was issued and fed back into the next tick so it joins the Merkle log.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct HintReceipt {
    pub hint_id: u32,
    pub chat_id: String,
    pub text_hash: Hash,
    pub signature: Vec<u8>,
    pub signing_address: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TickInput {
    /// Strictly increasing per match.
    pub tick_no: u32,
    /// Referee time of this tick. Never earlier than the previous tick's.
    pub now_ms: u64,
    /// OutLayer call id; every verdict of this tick carries it.
    pub call_id: CallId,
    /// Unsealed batches, any order.
    pub batches: Vec<BatchEnvelope>,
    pub receipts: Vec<HintReceipt>,
}

/// Why a batch was not accepted. From [`Reject::ClockSkew`] on, the batch is authentic, just
/// not usable, and it still advances the player's hash chain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reject {
    UnknownPlayer,
    WrongMatch,
    PlayerOut,
    Seq {
        expected: u32,
        got: u32,
    },
    Prev,
    Assertion(appattest::Step),
    /// Dated more than `CLOCK_SKEW_MS` after the referee clock.
    ClockSkew {
        t_ms: u64,
        now_ms: u64,
    },
    /// Dated before the player's previous accepted batch.
    BatchOrder {
        t_ms: u64,
        last_ms: u64,
    },
    /// Dated before the evidence the referee keeps (`KEEP_EPOCHS`), so nothing in it can count.
    TooOld {
        t_ms: u64,
        oldest_ms: u64,
    },
    FixFlags {
        flags: u8,
    },
    FixOrder,
    /// Implied speed, in cm/s, beyond what both accuracies explain.
    Teleport {
        cmps: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rejection {
    pub player: u16,
    pub seq: u32,
    pub reason: Reject,
}

/// Why a valid batch's action had no effect.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refuse {
    PlayerOut,
    TimeUp,
    /// Only one player is left.
    MatchOver,
    /// Strike: the lock was below `LOCK_EPOCHS`.
    Lock {
        lock: u32,
    },
    /// Strike: no contact in the strike's epoch or the one before. When the target's batches
    /// for those epochs had not arrived, the strike waited one tick before this answer.
    NoContact,
    UnknownHint,
    TextTooLong,
    Cooldown {
        ready_ms: u64,
    },
    InsufficientHead {
        head: u128,
        price: u128,
    },
    /// Hint: the referee has no usable fix for the asker or the target (TREND: also 60 s ago).
    NoFix,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ActionKind {
    Strike,
    Hint(u8),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub player: u16,
    pub nonce: u32,
    pub action: ActionKind,
    pub reason: Refuse,
}

/// A hint that was charged this tick; `voice` turns it into a Handler line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HintIssued {
    pub hint_id: u32,
    pub from: u16,
    pub to: u16,
    pub amount: u128,
    pub fact: HintFact,
    pub nonce: u32,
    /// The asker's optional question (≤ `HINT_TEXT_MAX` chars), for the voice prompt only.
    pub text: Option<String>,
}

#[derive(Debug)]
pub struct Started {
    pub state: State,
    /// `[Start]`, seq 1.
    pub verdicts: Vec<VerdictPayload>,
    pub log: Vec<LogEntry>,
    /// Per-player keys and target, to be sealed to each player's box key.
    pub keys: Vec<(u16, PlayerKeys)>,
}

#[derive(Debug)]
pub struct TickOutput {
    pub state: State,
    /// Unsigned, in seq order; sign each and submit in that order.
    pub verdicts: Vec<VerdictPayload>,
    pub huds: Vec<(u16, Hud)>,
    /// New log entries, in log order (append them to the stored log).
    pub log: Vec<LogEntry>,
    pub rejected: Vec<Rejection>,
    pub refused: Vec<Refusal>,
    pub hints: Vec<HintIssued>,
    /// The match is over (time up or one player left); call `finish` next.
    pub over: bool,
}

#[derive(Debug)]
pub struct Finished {
    pub state: State,
    /// `[End]`.
    pub verdicts: Vec<VerdictPayload>,
    pub log: Vec<LogEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InitError {
    PlayerCount(usize),
    DuplicateAccount(String),
    BadDeviceKey(String),
    ZeroStake,
    /// `stake × players` does not fit a u128.
    StakeOverflow,
    /// Zero, or longer than `MAX_DURATION_MS`.
    Duration(u64),
    EmptyZone,
    TimeOverflow,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TickError {
    NotRunning,
    BeforeStart { now_ms: u64, start_ms: u64 },
    StaleTick { last: u32, got: u32 },
    ClockWentBack { last_ms: u64, now_ms: u64 },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FinishError {
    /// Only a tick at or after `end_ms`, or one that leaves one player, ends the match.
    NotOver,
    AlreadyEnded,
    /// The revealed VRF signature is not the one the ring was built from.
    VrfMismatch,
}
