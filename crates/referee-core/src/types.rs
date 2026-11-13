//! Inputs and outputs of the engine that are not wire formats of `tail-protocol`.

use crate::state::State;
use borsh::{BorshDeserialize, BorshSerialize};
use tail_protocol::{
    refuse_code, reject_code, Batch, BatchEnvelope, CallId, Hash, HintFact, Hud, LogEntry, MatchId,
    PlayerKeys, VerdictPayload,
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

/// An enrolled player: account id and the App Attest key the referee checked at enrolment (4.4).
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Device {
    pub account_id: String,
    /// SEC1 uncompressed P-256 public key (65 bytes, `0x04 ‖ x ‖ y`).
    pub key: [u8; 65],
    /// Counter of the last assertion seen at enrolment (0 straight after attestation).
    pub counter: u32,
    /// Whether Apple's attestation of `key` was verified at enrolment. False only for a ghost
    /// (a simulated phone) enrolled on testnet; the `Enrolled` log entry says which.
    pub attested: bool,
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

/// A player's App Attest key as a replay knows it: the key, or only the `key_hash` of its
/// `Enrolled` log entry when the key itself was not released. Without the key no assertion can
/// be checked, so the replay must use [`ReplayBatch::Unasserted`] for that player.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReleasedKey {
    Key([u8; 65]),
    Hash(Hash),
}

/// [`Device`] for [`crate::init_released`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleasedDevice {
    pub account_id: String,
    pub key: ReleasedKey,
    pub counter: u32,
    pub attested: bool,
}

/// One batch of a replayed tick, as far as the released match data shows it
/// ([`crate::replay_tick`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReplayBatch {
    /// The batch and its App Attest assertion: checked exactly as [`crate::tick`] checks one.
    Asserted(BatchEnvelope),
    /// The batch without its assertion. Every other check runs; the App Attest outcome is the
    /// log's (`assertion_ok` false for a batch logged as refused with `ASSERTION`) and the
    /// assertion counter is not tracked.
    Unasserted { batch: Batch, assertion_ok: bool },
    /// A refused batch that was not released, with its logged `Rejected` fields. An
    /// authenticity refusal is logged as given. A validity refusal still has to pass the checks
    /// the fields allow (player, still in, next seq) and then moves the chain to `hash`, as the
    /// batch did; its content and the reason are taken as given.
    Withheld {
        player: u16,
        seq: u32,
        hash: Hash,
        code: u8,
    },
}

/// [`TickInput`] for [`crate::replay_tick`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayTickInput {
    pub tick_no: u32,
    pub now_ms: u64,
    pub call_id: CallId,
    pub batches: Vec<ReplayBatch>,
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
    /// Replay only ([`ReplayBatch::Withheld`]): a refused batch that was not released, so its
    /// logged `reject_code` is all there is.
    Withheld {
        code: u8,
    },
}

impl Reject {
    /// Whether a `reject_code` comes from the authenticity checks (match, player, seq, prev, App
    /// Attest). Those run for every batch of a tick first, are logged before any accepted batch,
    /// and leave the player's chain where it was; the other codes are validity refusals of a batch
    /// that did advance it.
    pub fn is_authenticity_code(code: u8) -> bool {
        matches!(
            code,
            reject_code::UNKNOWN_PLAYER
                | reject_code::WRONG_MATCH
                | reject_code::PLAYER_OUT
                | reject_code::SEQ
                | reject_code::PREV
                | reject_code::ASSERTION
        )
    }

    /// The protocol's `reject_code` for this reason: what `LogEntry::Rejected` and the HUD carry.
    pub fn code(&self) -> u8 {
        match self {
            Reject::UnknownPlayer => reject_code::UNKNOWN_PLAYER,
            Reject::WrongMatch => reject_code::WRONG_MATCH,
            Reject::PlayerOut => reject_code::PLAYER_OUT,
            Reject::Seq { .. } => reject_code::SEQ,
            Reject::Prev => reject_code::PREV,
            Reject::Assertion(_) => reject_code::ASSERTION,
            Reject::ClockSkew { .. } => reject_code::CLOCK_SKEW,
            Reject::TooOld { .. } => reject_code::TOO_OLD,
            Reject::BatchOrder { .. } => reject_code::TIME_ORDER,
            Reject::FixFlags { .. } => reject_code::FIX_FLAGS,
            Reject::FixOrder => reject_code::FIX_ORDER,
            Reject::Teleport { .. } => reject_code::TELEPORT,
            Reject::Withheld { code } => *code,
        }
    }
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
    /// Hint: the match already charged `MAX_HINTS`, all the contract keeps records for.
    HintLimit,
}

impl Refuse {
    /// The protocol's `refuse_code` for this reason: what a tick's `refused` list carries. The
    /// amounts some reasons hold stay inside the referee.
    pub fn code(&self) -> u8 {
        match self {
            Refuse::PlayerOut => refuse_code::PLAYER_OUT,
            Refuse::TimeUp => refuse_code::TIME_UP,
            Refuse::MatchOver => refuse_code::MATCH_OVER,
            Refuse::Lock { .. } => refuse_code::LOCK,
            Refuse::NoContact => refuse_code::NO_CONTACT,
            Refuse::UnknownHint => refuse_code::UNKNOWN_HINT,
            Refuse::TextTooLong => refuse_code::TEXT_TOO_LONG,
            Refuse::Cooldown { .. } => refuse_code::COOLDOWN,
            Refuse::InsufficientHead { .. } => refuse_code::FUNDS,
            Refuse::NoFix => refuse_code::NO_FIX,
            Refuse::HintLimit => refuse_code::HINT_LIMIT,
        }
    }
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

/// A hint that was charged this tick; `voice` turns it into a Handler line. `to` stays with the
/// referee (the Hint verdict does not name it) until End reveals every hint's target.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HintIssued {
    pub hint_id: u32,
    pub from: u16,
    pub to: u16,
    pub amount: u128,
    /// Hints charged in the `PRICE_WINDOW_MS` before this one: the demand that set `amount`,
    /// for the Handler's line.
    pub recent: u32,
    pub fact: HintFact,
    pub nonce: u32,
    /// The asker's optional question (≤ `HINT_TEXT_MAX` chars), for the voice prompt only.
    pub text: Option<String>,
}

/// RFC 9162 consistency proof from the log size the previous Checkpoint anchored (0 before the
/// first) to the `log_size` of verdict `seq`, a Checkpoint or End. The contract checks it against
/// the roots it holds before it anchors the new one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsistencyProof {
    pub seq: u32,
    pub from_size: u64,
    pub path: Vec<Hash>,
}

#[derive(Debug)]
pub struct Started {
    pub state: State,
    /// `[Start]`, seq 1.
    pub verdicts: Vec<VerdictPayload>,
    /// One `Enrolled` per player, then the Start verdict's entry.
    pub log: Vec<LogEntry>,
    /// Per-player keys and target, to be sealed to each player's box key.
    pub keys: Vec<(u16, PlayerKeys)>,
}

#[derive(Debug)]
pub struct TickOutput {
    pub state: State,
    /// Unsigned, in seq order; sign each and submit in that order.
    pub verdicts: Vec<VerdictPayload>,
    /// One per Checkpoint in `verdicts`.
    pub proofs: Vec<ConsistencyProof>,
    /// Unsigned; the wrapper signs each with `hud_sig_digest`.
    pub huds: Vec<(u16, Hud)>,
    /// New log entries, in log order, starting with this tick's `Tick`.
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
    /// The End verdict's.
    pub proofs: Vec<ConsistencyProof>,
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
