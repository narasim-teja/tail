//! The Dossier: one soulbound NEP-171 token per registered player, whose metadata is the
//! player's record of settled matches, computed on every read.
//!
//! `token_id` is the player's account id and `owner_id` is that account, for good: `nft_transfer`
//! and `nft_transfer_call` always refuse, and there are no approvals (NEP-178), so no marketplace
//! can move one. The token is minted by `register_for` (whose deposit pays for the largest record),
//! and each settlement adds one entry per player (`record_settlement`): End's payout, End's refund
//! for a broken rule, and the abort of a running match, logging one NEP-171 `nft_metadata_update`
//! for the tokens it changed. A lobby that never started adds nothing and logs nothing.
//! The record keeps the last `DOSSIER_ENTRIES` entries and running totals, so it never grows past
//! what registration paid for. `create_match`'s `requires` reads it: `join_match` refuses a player
//! whose dossier is below the match's bar.
//!
//! `metadata.media` is the card (`art.rs`) as a `data:image/svg+xml;base64,` URI, rebuilt on each
//! read, so the picture changes as the record grows and needs no hosting.

use near_sdk::base64::{engine::general_purpose::STANDARD, Engine};
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId};
use tail_protocol::settle::PlayEvent;
use tail_protocol::MatchId;

use crate::{art, Match, PlayRecord, Root, Tail, TailExt};

/// Entries a dossier keeps (the newest); the card draws one segment per entry.
pub const DOSSIER_ENTRIES: usize = 12;
/// The largest dossier record with a 64-character account id, plus its place in the token list,
/// including NEAR's 40-byte per-record overhead. `register_for` charges it; a unit test measures it.
pub const DOSSIER_RECORD_BYTES: u128 = 1_200;
/// `nft_tokens` returns at most this many tokens per call: each one builds its card. Measured in
/// the unit-test VM for ten maximal cards (`nft_tokens_pages_are_capped_at_ten_maximal_cards`):
/// 1.47 Tgas of host functions (storage reads, two SHA-256 per card) and about 10.5 KB written
/// per card (a 4 KB SVG, then 6.4 KB of JSON holding its base64). That VM does not meter wasm
/// instructions; at NEAR's 822,756 gas per instruction and a generous 200 instructions per byte
/// written, a card costs at most about 1.7 Tgas, so a page stays under about 20 Tgas, a fifteenth
/// of the 300 Tgas an RPC node gives a view call.
pub const MAX_TOKENS_PER_PAGE: u64 = 10;
/// The error both transfer methods give.
pub const BOUND: &str = "a dossier is bound to the player who earned it";

/// How a match ended for one player.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MatchResult {
    /// Still in when the match paid out.
    Survived,
    /// Tagged out by their hunter.
    Tagged,
    /// Forfeited (went dark or left the zone) to their hunter.
    Forfeit,
    /// The match settled as a refund (a broken rule at End, or an abort): nothing in it counts.
    Refunded,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DossierEntry {
    pub match_id: MatchId,
    pub result: MatchResult,
    /// Tags the player landed in the match (0 when refunded).
    pub tags: u8,
    /// What settlement credited the player.
    pub payout: u128,
    /// The last log root the match anchored (End's, or the last checkpoint's on an abort).
    pub anchor: Root,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dossier {
    pub issued_ms: u64,
    pub updated_ms: u64,
    /// Totals over every settled (paid-out) match, not only the kept entries.
    pub matches: u32,
    pub survived: u32,
    pub tags: u32,
    pub forfeits: u32,
    pub refunded: u32,
    pub won: u128,
    /// Oldest first, at most `DOSSIER_ENTRIES`.
    pub entries: Vec<DossierEntry>,
}

impl Dossier {
    pub fn new(now: u64) -> Self {
        Self {
            issued_ms: now,
            updated_ms: now,
            matches: 0,
            survived: 0,
            tags: 0,
            forfeits: 0,
            refunded: 0,
            won: 0,
            entries: Vec::new(),
        }
    }

    pub(crate) fn push(&mut self, e: DossierEntry, now: u64) {
        if self.entries.len() == DOSSIER_ENTRIES {
            self.entries.remove(0);
        }
        self.entries.push(e);
        self.updated_ms = now;
    }

    /// Whether the record clears a match's `requires`.
    pub fn meets(&self, r: &Requires) -> bool {
        self.matches >= r.min_matches && self.survived >= r.min_survived
    }
}

/// `create_match`'s access rule: who may join, by their dossier.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Requires {
    /// Settled (paid-out) matches played; refunded ones do not count.
    #[serde(default)]
    pub min_matches: u32,
    /// Settled matches survived.
    #[serde(default)]
    pub min_survived: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DossierEntryView {
    pub match_id: String,
    pub result: MatchResult,
    pub tags: u32,
    pub payout: U128,
    /// `verify_inclusion(match_id, entry, index, size = log_size, path)` checks a log entry
    /// against this root; `get_roots(match_id)` lists it.
    pub log_size: U64,
    pub root: String,
}

/// `get_dossier`: totals over settled matches, entries newest first.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DossierView {
    pub account_id: AccountId,
    /// SHA-256 of the account id, hex: the only randomness the card draws from.
    pub seed: String,
    pub matches: u32,
    pub survived: u32,
    pub tags: u32,
    pub forfeits: u32,
    pub refunded: u32,
    /// Total payouts of the settled matches, in the match tokens' smallest units.
    pub won: U128,
    pub entries: Vec<DossierEntryView>,
}

impl DossierView {
    pub fn of(account_id: &AccountId, d: &Dossier) -> Self {
        Self {
            account_id: account_id.clone(),
            seed: hex::encode(env::sha256_array(account_id.as_bytes())),
            matches: d.matches,
            survived: d.survived,
            tags: d.tags,
            forfeits: d.forfeits,
            refunded: d.refunded,
            won: U128(d.won),
            entries: d
                .entries
                .iter()
                .rev()
                .map(|e| DossierEntryView {
                    match_id: hex::encode(e.match_id),
                    result: e.result,
                    tags: u32::from(e.tags),
                    payout: U128(e.payout),
                    log_size: U64(e.anchor.log_size),
                    root: hex::encode(e.anchor.root),
                })
                .collect(),
        }
    }
}

/// NEP-177 token metadata. Every field is present, `null` when unused.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    /// Base64 SHA-256 of the SVG `media` holds.
    pub media_hash: Option<Base64VecU8>,
    pub copies: Option<u64>,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    pub starts_at: Option<String>,
    pub updated_at: Option<String>,
    pub extra: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<Base64VecU8>,
}

/// NEP-171 token. No `approved_account_ids`: dossiers have no approvals.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Token {
    pub token_id: String,
    pub owner_id: AccountId,
    pub metadata: TokenMetadata,
}

/// NEP-177 contract metadata.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NftContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<Base64VecU8>,
}

/// The Trail mark, the collection icon.
const ICON_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1C2430"/><path d="M33.8 11.8 Q14 30 7 57 Q30 46 52.2 30.2 Z" fill="#EE6A3F" fill-opacity=".38"/><circle cx="43" cy="21" r="13" fill="#EE6A3F"/></svg>"##;

fn svg_uri(svg: &str) -> String {
    format!("data:image/svg+xml;base64,{}", STANDARD.encode(svg))
}

fn token(account_id: &AccountId, d: &Dossier) -> Token {
    let view = DossierView::of(account_id, d);
    let svg = art::dossier_svg(&view);
    let handle = account_id.as_str().split('.').next().unwrap_or_default();
    let extra = json!({
        "matches": d.matches,
        "survived": d.survived,
        "tags": d.tags,
        "forfeits": d.forfeits,
        "refunded": d.refunded,
        "won": U128(d.won),
        "page": format!("/dossier/{account_id}"),
    });
    Token {
        token_id: account_id.to_string(),
        owner_id: account_id.clone(),
        metadata: TokenMetadata {
            title: Some(format!("{handle}'s dossier")),
            description: Some(format!(
                "{account_id} in TAIL: {} settled matches, {} survived, {} tags. Bound to this account: it cannot be transferred.",
                d.matches, d.survived, d.tags
            )),
            media_hash: Some(Base64VecU8(env::sha256(svg.as_bytes()))),
            media: Some(svg_uri(&svg)),
            copies: Some(1),
            issued_at: Some(d.issued_ms.to_string()),
            expires_at: None,
            starts_at: None,
            updated_at: Some(d.updated_ms.to_string()),
            extra: Some(extra.to_string()),
            reference: None,
            reference_hash: None,
        },
    }
}

/// NEP-171 1.2.0 is the version that added `nft_metadata_update` (which `record_settlement`
/// emits), and it says every NFT event, `nft_mint` included, carries version "1.2.0".
const NEP171_EVENT_VERSION: &str = "1.2.0";

/// A NEP-297 log of a NEP-171 event.
fn emit_nep171(event: &str, data: &near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "nep171", "version": NEP171_EVENT_VERSION, "event": event, "data": data })
    ));
}

/// NEP-171 `nft_mint`.
pub fn emit_mint(owner: &AccountId) {
    emit_nep171("nft_mint", &json!([{ "owner_id": owner, "token_ids": [owner] }]));
}

/// The dossier entries a settled match adds: one per player, for players who hold a dossier (an
/// account registered before dossiers existed has none until `mint_dossier`, and no storage
/// was paid for one). `refunded` settlements count only as refunds; a payout counts the result,
/// the tags landed and what was paid.
///
/// Each changed dossier is a token whose metadata (computed on read) is now different, so this
/// logs one NEP-171 `nft_metadata_update` naming them in player order; an indexer that cached
/// the card at mint refetches it. No dossier changed, no event: nothing is stale.
pub fn record_settlement(
    dossiers: &mut LookupMap<AccountId, Dossier>,
    id: &MatchId,
    m: &Match,
    play: Option<&PlayRecord>,
    anchor: Root,
    refunded: bool,
) {
    let now = env::block_timestamp_ms();
    let events: &[PlayEvent] = play.map_or(&[], |p| p.events.as_slice());
    let mut changed: Vec<&AccountId> = Vec::with_capacity(m.players.len());
    for (i, p) in m.players.iter().enumerate() {
        let Some(d) = dossiers.get_mut(&p.account_id) else {
            continue;
        };
        changed.push(&p.account_id);
        let i = i as u16;
        let (result, tags) = if refunded {
            d.refunded = d.refunded.saturating_add(1);
            (MatchResult::Refunded, 0)
        } else {
            let tags = events
                .iter()
                .filter(|e| matches!(e, PlayEvent::Tag { hunter, .. } if *hunter == i))
                .count();
            let tags = u8::try_from(tags).unwrap_or(u8::MAX);
            let result = if !p.out {
                MatchResult::Survived
            } else if events
                .iter()
                .any(|e| matches!(e, PlayEvent::Forfeit { player, .. } if *player == i))
            {
                MatchResult::Forfeit
            } else {
                MatchResult::Tagged
            };
            // Saturating: the record is bookkeeping, and nothing in it may make End or abort panic.
            d.matches = d.matches.saturating_add(1);
            d.survived = d
                .survived
                .saturating_add(u32::from(result == MatchResult::Survived));
            d.forfeits = d
                .forfeits
                .saturating_add(u32::from(result == MatchResult::Forfeit));
            d.tags = d.tags.saturating_add(u32::from(tags));
            d.won = d.won.saturating_add(p.paid);
            (result, tags)
        };
        d.push(
            DossierEntry {
                match_id: *id,
                result,
                tags,
                payout: p.paid,
                anchor,
            },
            now,
        );
    }
    if !changed.is_empty() {
        emit_nep171("nft_metadata_update", &json!([{ "token_ids": changed }]));
    }
}

// near-sdk deserialises every JSON argument into an owned value, so methods take them by value.
#[allow(clippy::needless_pass_by_value)]
#[near]
impl Tail {
    /// The player's record: totals over settled matches and the last `DOSSIER_ENTRIES` entries,
    /// newest first. `None` for an account with no dossier.
    pub fn get_dossier(&self, account_id: AccountId) -> Option<DossierView> {
        self.dossiers
            .get(&account_id)
            .map(|d| DossierView::of(&account_id, d))
    }

    /// Mints the dossier of an account registered before dossiers existed, with exactly
    /// `get_config().dossier_deposit` attached. The relay (each player's parent) backfills its
    /// players this way, since a player's own function-call key cannot attach a deposit; the
    /// owner may too, and so may the account itself. Whoever calls pays the storage.
    #[payable]
    pub fn mint_dossier(&mut self, account_id: AccountId) {
        require!(
            env::attached_deposit() == crate::dossier_deposit(),
            "attach exactly dossier_deposit (see get_config)"
        );
        let caller = env::predecessor_account_id();
        require!(
            caller == self.owner || crate::is_self_or_parent(&account_id, &caller),
            "only the account, its parent or the owner can mint its dossier"
        );
        require!(self.payouts.contains_key(&account_id), "account not registered");
        require!(
            !self.dossiers.contains_key(&account_id),
            "this account already has a dossier"
        );
        self.mint(&account_id);
    }

    // ── NEP-171 core ─────────────────────────────────────────────────────────────────────────

    /// Always refused: a dossier is a credential (`requires`), so it stays with the player.
    #[payable]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        let _ = (receiver_id, token_id, approval_id, memo);
        env::panic_str(BOUND)
    }

    /// Always refused, like `nft_transfer`.
    #[payable]
    pub fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> bool {
        let _ = (receiver_id, token_id, approval_id, memo, msg);
        env::panic_str(BOUND)
    }

    /// NEP-171's callback after `nft_transfer_call`. No transfer ever starts, so nothing schedules
    /// it. NEP-171's `true` means the token was transferred; it never is, so this says `false`.
    #[private]
    pub fn nft_resolve_transfer(
        &mut self,
        owner_id: AccountId,
        receiver_id: AccountId,
        token_id: String,
        approved_account_ids: Option<std::collections::HashMap<AccountId, u64>>,
    ) -> bool {
        let _ = (owner_id, receiver_id, token_id, approved_account_ids);
        false
    }

    /// NEP-171 `token_id` is a string; one that is not an account id names no dossier.
    pub fn nft_token(&self, token_id: String) -> Option<Token> {
        let account_id: AccountId = token_id.parse().ok()?;
        self.dossiers.get(&account_id).map(|d| token(&account_id, d))
    }

    // ── NEP-177 metadata ─────────────────────────────────────────────────────────────────────

    pub fn nft_metadata(&self) -> NftContractMetadata {
        NftContractMetadata {
            spec: "nft-2.1.0".to_owned(),
            name: "TAIL dossiers".to_owned(),
            symbol: "DOSSIER".to_owned(),
            icon: Some(svg_uri(ICON_SVG)),
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }

    // ── NEP-181 enumeration ──────────────────────────────────────────────────────────────────

    pub fn nft_total_supply(&self) -> U128 {
        U128(u128::from(self.dossier_ids.len()))
    }

    /// Tokens in mint order, at most `MAX_TOKENS_PER_PAGE` per call.
    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        let from = u32::try_from(from_index.map_or(0, |i| i.0)).unwrap_or(u32::MAX);
        let limit = limit.unwrap_or(MAX_TOKENS_PER_PAGE).min(MAX_TOKENS_PER_PAGE) as u32;
        (from..self.dossier_ids.len().min(from.saturating_add(limit)))
            .filter_map(|i| {
                let id = self.dossier_ids.get(i)?;
                self.dossiers.get(id).map(|d| token(id, d))
            })
            .collect()
    }

    /// 1 when the account holds its dossier, else 0: each player owns exactly their own.
    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        U128(u128::from(self.dossiers.contains_key(&account_id)))
    }

    pub fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        let skip = from_index.map_or(0, |i| i.0);
        if skip > 0 || limit == Some(0) {
            return Vec::new();
        }
        self.dossiers
            .get(&account_id)
            .map(|d| token(&account_id, d))
            .into_iter()
            .collect()
    }
}

impl Tail {
    /// Writes an empty dossier for `account_id` and lists it; the caller has taken the deposit.
    pub(crate) fn mint(&mut self, account_id: &AccountId) {
        self.dossiers
            .insert(account_id.clone(), Dossier::new(env::block_timestamp_ms()));
        self.dossier_ids.push(account_id.clone());
        emit_mint(account_id);
    }
}
