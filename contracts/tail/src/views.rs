//! JSON shapes the relay, the app and the replay read and send. Every fixed-size byte array
//! (match id, hashes, public keys, signatures) is a lowercase hex string in JSON; amounts are
//! decimal strings (`U128`); times are unix milliseconds as JSON numbers.

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

use crate::Phase;

/// What a host sends to `create_match`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatchConfig {
    /// One of the contract's allowed NEP-141 tokens; every stake, hint and payout is in it.
    pub token: AccountId,
    /// Each player's buy-in, which becomes their head. Zero is allowed (a sponsored match).
    pub stake: U128,
    /// Must equal `end_ms - start_ms` of the `Start` verdict.
    pub duration_ms: u64,
    /// SHA-256 of the zone description, hex.
    pub zone_hash: String,
    pub public_replay: bool,
    pub min_players: u8,
    pub max_players: u8,
    /// `Start` must land by this time (at most 7 days out); after it anyone may `abort` the lobby.
    pub start_by_ms: u64,
    /// Accounts allowed to join; empty (the default) means any registered account.
    #[serde(default)]
    pub invites: Vec<AccountId>,
    /// Accounts allowed to sponsor (at most 4); empty (the default) means no sponsor pot.
    #[serde(default)]
    pub sponsors: Vec<AccountId>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlayerView {
    pub account_id: AccountId,
    pub head: U128,
    pub out: bool,
    /// What settlement credited to this player's internal balance (0 until End or abort).
    pub paid: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SponsorView {
    pub account_id: AccountId,
    pub amount: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RootView {
    pub log_size: u64,
    pub root: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RootsView {
    pub checkpoints: Vec<RootView>,
    /// The root the `End` verdict anchored; `None` until the match ends.
    pub final_root: Option<RootView>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatchView {
    pub match_id: String,
    pub host: AccountId,
    pub token: AccountId,
    pub stake: U128,
    pub duration_ms: u64,
    pub zone_hash: String,
    pub public_replay: bool,
    pub min_players: u8,
    pub max_players: u8,
    pub start_by_ms: u64,
    pub created_ms: u64,
    pub phase: Phase,
    /// Sorted by account id. A verdict's player index is the position in this list.
    pub players: Vec<PlayerView>,
    /// Who may join; empty means any registered account.
    pub invites: Vec<AccountId>,
    /// The named sponsors and what each put in, kept after settlement as the record.
    pub sponsors: Vec<SponsorView>,
    /// Sponsor money still held by the match (0 after End or abort).
    pub sponsor_pot: U128,
    /// Set by `lock_lobby`: no joins from then on, no leaves until this time.
    pub locked_until_ms: Option<u64>,
    /// Last applied verdict seq; the next verdict must carry `seq + 1`.
    pub seq: u32,
    pub last_verdict_ms: u64,
    /// Keys copied at `create_match`; a later rotation does not change them.
    pub referee_pk: String,
    pub vrf_pk: String,
    pub ring_commit: Option<String>,
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
    /// The VRF reveal from `End`, so anyone can rebuild the ring.
    pub alpha: Option<String>,
    pub vrf_signature: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigView {
    pub owner: AccountId,
    /// The key new matches pin; running matches keep the key they were created with.
    pub referee_pk: String,
    pub vrf_pk: String,
    pub allowed_tokens: Vec<AccountId>,
    /// Exact yoctoNEAR deposit `create_match` needs.
    pub match_storage_deposit: U128,
    /// Exact yoctoNEAR deposit `register_for` needs.
    pub registration_deposit: U128,
    pub referee_timeout_ms: u64,
    pub lock_ms: u64,
    pub start_skew_ms: u64,
    pub max_start_window_ms: u64,
    pub min_players: u8,
    pub max_players: u8,
    pub max_duration_ms: u64,
    pub max_checkpoints: u32,
    pub max_sponsors: u32,
    pub max_invites: u32,
}
