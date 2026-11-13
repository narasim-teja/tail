//! The sealed match state. Everything the next tick needs and nothing more: per-epoch evidence
//! is kept only for the trailing `KEEP_EPOCHS`, the log only as a Merkle frontier.

use crate::geo::Plane;
use crate::log::Log;
use crate::types::MatchConfig;
use borsh::{BorshDeserialize, BorshSerialize};
use std::fmt;
use tail_protocol::{Hash, MatchId};

/// Keys and the VRF signature. Debug never prints them: the state is sealed because of these.
#[derive(BorshSerialize, BorshDeserialize, Clone, PartialEq, Eq)]
pub(crate) struct Secrets {
    pub k_tag: [u8; 32],
    pub k_players: Vec<[u8; 32]>,
    pub vrf_signature: [u8; 64],
}

impl fmt::Debug for Secrets {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secrets(redacted)")
    }
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct StoredFix {
    pub t_ms: u64,
    pub lat_e7: i32,
    pub lon_e7: i32,
    pub acc_m: u16,
}

/// What one player's phone heard of another player's token for one token epoch, summed over
/// every batch that reported it. Weak sightings never get here.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Heard {
    pub player: u16,
    /// Samples from sightings at or above `RSSI_MIN_DBM`; weak sightings never get here.
    pub n: u8,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct EpochData {
    pub epoch: u32,
    /// The usable fix nearest this epoch's midpoint, within `FIX_WINDOW_MS` of it.
    pub fix: Option<StoredFix>,
    pub heard: Vec<Heard>,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Contact {
    pub epoch: u32,
    pub a: u16,
    pub b: u16,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct Player {
    pub account: String,
    pub key: [u8; 65],
    pub counter: u32,
    pub next_seq: u32,
    pub prev: Hash,
    /// Who took this player's head (hunter on a Tag, receiver on a Forfeit); `None` while
    /// they are in. One field rather than an `alive` flag beside it, so a player can never be
    /// out without the HUD being able to say who got them.
    pub taken_by: Option<u16>,
    pub target: Option<u16>,
    /// First contact epoch that counts toward the lock on the current target. Set when the
    /// target is assigned (start, or inheriting one), so contact a hunter had with a player
    /// before hunting them cannot fill the lock the moment they inherit them.
    pub lock_from: u32,
    pub head: u128,
    /// Latest accepted fix with `acc ≤ MAX_ACC_M`.
    pub last_fix: Option<StoredFix>,
    /// Time of the latest accepted fix of any accuracy (fixes must move forward).
    pub last_fix_t: Option<u64>,
    /// Device time of the latest accepted batch (batch times must not go back).
    pub last_batch_t: Option<u64>,
    /// Referee time of the latest fresh valid batch whose last fix with
    /// `acc ≤ PRESENCE_ACC_M` was inside the zone.
    pub present_ms: u64,
    /// Cumulative dark time, and the referee time it has been counted up to.
    pub dark_ms: u64,
    pub dark_counted_ms: u64,
    /// Device time of the first fix of the current run above `MAX_SPEED_MPS`.
    pub fast_since: Option<u64>,
    /// Vehicle freezes, device-time intervals `[from, until)`.
    pub freezes: Vec<(u64, u64)>,
    /// Referee time of the last hint charged (the cooldown runs on the referee clock).
    pub last_hint_ms: Option<u64>,
    /// Ascending by epoch, trailing window only.
    pub epochs: Vec<EpochData>,
}

impl Player {
    pub(crate) fn alive(&self) -> bool {
        self.taken_by.is_none()
    }
}

/// A strike that lacked contact only because the target's batches for its epoch had not
/// arrived yet. It is decided once more at the start of the next tick, before that tick's
/// actions, so it keeps its place ahead of later strikes.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DeferredStrike {
    pub player: u16,
    pub t_ms: u64,
    pub nonce: u32,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Running,
    /// Time is up or one player is left; only `finish` remains.
    Over,
    Ended,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, PartialEq)]
pub struct State {
    pub(crate) cfg: MatchConfig,
    pub(crate) start_ms: u64,
    pub(crate) end_ms: u64,
    pub(crate) plane: Plane,
    pub(crate) secrets: Secrets,
    pub(crate) ring_commit: Hash,
    pub(crate) players: Vec<Player>,
    /// Established contacts in the trailing window, ascending.
    pub(crate) contacts: Vec<Contact>,
    pub(crate) next_verdict_seq: u32,
    pub(crate) log: Log,
    pub(crate) next_checkpoint_ms: u64,
    pub(crate) next_hint_id: u32,
    /// Hints still waiting for a voice receipt: `(hint_id, referee time issued)`.
    pub(crate) pending_receipts: Vec<(u32, u64)>,
    /// Strikes from the previous tick waiting for the target's data, in their action order.
    pub(crate) deferred: Vec<DeferredStrike>,
    pub(crate) last_tick: Option<(u32, u64)>,
    pub(crate) phase: Phase,
}

impl fmt::Debug for State {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("State")
            .field("match_id", &self.cfg.match_id)
            .field("phase", &self.phase)
            .field("players", &self.players.len())
            .field("alive", &self.players.iter().filter(|p| p.alive()).count())
            .field("log_size", &self.log.size())
            .field("next_verdict_seq", &self.next_verdict_seq)
            .finish_non_exhaustive()
    }
}

/// Read-only facts about one player, for the relay, the simulator and tests.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlayerView {
    pub index: u16,
    pub account: String,
    pub alive: bool,
    pub head: u128,
    pub target: Option<u16>,
    pub dark_ms: u64,
}

impl State {
    pub fn match_id(&self) -> MatchId {
        self.cfg.match_id
    }
    pub fn config(&self) -> &MatchConfig {
        &self.cfg
    }
    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn start_ms(&self) -> u64 {
        self.start_ms
    }
    pub fn end_ms(&self) -> u64 {
        self.end_ms
    }
    pub fn log_size(&self) -> u64 {
        self.log.size()
    }
    pub fn log_root(&self) -> Hash {
        self.log.root()
    }
    /// Seq the next verdict will carry.
    pub fn next_verdict_seq(&self) -> u32 {
        self.next_verdict_seq
    }
    pub fn players(&self) -> Vec<PlayerView> {
        self.players
            .iter()
            .enumerate()
            .map(|(i, p)| PlayerView {
                index: i as u16,
                account: p.account.clone(),
                alive: p.alive(),
                head: p.head,
                target: p.target,
                dark_ms: p.dark_ms,
            })
            .collect()
    }
    /// Sum of all heads. Constant from `Start` to `End`: hints and tags only move money.
    pub fn total_heads(&self) -> u128 {
        self.players.iter().map(|p| p.head).sum()
    }
}
