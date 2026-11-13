//! JSON shapes the relay, the app and the replay read and send. Every fixed-size byte array
//! (match id, hashes, public keys, signatures) is a lowercase hex string in JSON; amounts are
//! decimal strings (`U128`); times are unix milliseconds as JSON numbers.

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::{near, AccountId};

use crate::{Phase, Requires};

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
    /// Who may join, by their dossier: at least this many settled matches played and survived.
    /// Absent (the default) means anyone the other rules let in.
    #[serde(default)]
    pub requires: Option<Requires>,
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

/// One RFC 9162 consistency proof for `apply`: from the match's last anchored log size
/// (`from_size`, 0 for the first anchor) to the log size of the Checkpoint or End with `seq`.
/// `path` is the list of 32-byte hashes, base64 each; empty when `from_size` is 0.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsistencyArg {
    pub seq: u32,
    pub from_size: U64,
    pub path: Vec<Base64VecU8>,
}

/// The head of a match's verdict chain.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerdictHeadView {
    /// Last applied verdict seq (0 before `Start`).
    pub seq: u32,
    /// Its `verdict_digest`, hex; zeros before `Start`. The next verdict's `prev` must equal it.
    pub digest: String,
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
    /// The `sender` this match's VRF alpha must name, pinned at creation. `None` for a match
    /// created before the upgrade that added it (such a match settles by `abort`).
    pub vrf_sender: Option<AccountId>,
    /// Hint money paid in and not yet credited to anyone (0 once settled).
    pub hint_pool: U128,
    /// How the match settled; `None` while it is a lobby or running.
    pub settled_as: Option<SettledAs>,
    /// The first rule the `End` replay found broken, when `settled_as` is
    /// `refunded_rule_violation`.
    pub violation: Option<String>,
    /// The dossier a player needs to join (`create_match`'s `requires`); `None` for none.
    pub requires: Option<Requires>,
}

/// How a match's money left it. Only `payout` follows the play: the other two refund every
/// original stake and every sponsor.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettledAs {
    /// `End` landed and its replay of the whole match held.
    Payout,
    /// `End` landed but its replay found a broken rule (see `violation`).
    RefundedRuleViolation,
    /// `abort`: the lobby never started, or the referee went silent.
    RefundedAbort,
    /// `End` landed under the code before the upgrade that added the replay: the heads were paid
    /// as the verdicts moved them, with nothing checked against the ring.
    PayoutUnreplayed,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigView {
    pub owner: AccountId,
    /// The key new matches pin; running matches keep the key they were created with.
    pub referee_pk: String,
    pub vrf_pk: String,
    /// The `sender` field new matches require in the VRF alpha (the referee's OutLayer caller).
    pub vrf_sender: AccountId,
    /// Least prepaid gas `withdraw` accepts, in Tgas.
    pub withdraw_min_gas: u64,
    /// Tag, Hint and Forfeit are refused once block time passes `end_ms` by more than this.
    pub verdict_grace_ms: u64,
    /// The k-th checkpoint needs k times this much match time since `start_ms`.
    pub checkpoint_spacing_ms: u64,
    pub allowed_tokens: Vec<AccountId>,
    /// Exact yoctoNEAR deposit `create_match` needs.
    pub match_storage_deposit: U128,
    /// Exact yoctoNEAR deposit `register_for` needs (it includes the dossier).
    pub registration_deposit: U128,
    /// Exact yoctoNEAR deposit `mint_dossier` needs.
    pub dossier_deposit: U128,
    /// How many entries a dossier keeps (the newest).
    pub dossier_entries: u32,
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
