//! TAIL contract: custody and settlement.
//!
//! Money enters only through NEP-141 `ft_transfer_call` (into an internal balance or a match's
//! sponsor pot) and leaves only through `withdraw` to the account's payout account. Inside a match,
//! heads move only when `apply` accepts a verdict signed by the referee key the match pinned at
//! creation. `abort` is the refund path when the referee goes silent.
//!
//! Storage is always paid for up front: `register_for` pays for an account's payout record and one
//! balance per allowed token, and `create_match` pays for the largest a match can grow. Nothing
//! later allocates new storage, so a refund can never fail for lack of it.

use curve25519_dalek::edwards::{CompressedEdwardsY, EdwardsPoint};
use near_sdk::borsh::BorshDeserialize;
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
};
use tail_protocol::digest::verdict_digest;
use tail_protocol::ring::{players_hash, ring_commit};
use tail_protocol::{Hash, MatchId, SignedVerdict, Verdict, CHECKPOINT_MS, REFEREE_TIMEOUT_MS};

mod views;
pub use views::*;

#[cfg(test)]
mod tests;

pub const MIN_PLAYERS: u8 = 3;
pub const MAX_PLAYERS: u8 = 12;
/// Matches are 30 to 60 minutes (IDEA.md); the cap bounds the checkpoint list.
pub const MAX_DURATION_MS: u64 = 3_600_000;
/// Twice the referee's cadence (one per `CHECKPOINT_MS`) over the longest match. A checkpoint past
/// this is refused, which stalls the match into `abort`: storage stays bounded and paid for.
pub const MAX_CHECKPOINTS: usize = 2 * (MAX_DURATION_MS / CHECKPOINT_MS) as usize;
/// Sponsors are named by the host at creation (a DAO in Commons mode), so strangers cannot fill
/// the list with dust and lock the real sponsor out.
pub const MAX_SPONSORS: usize = 4;
/// An invite list is for a friends lobby: at most one name per seat.
pub const MAX_INVITES: usize = MAX_PLAYERS as usize;
/// OutLayer alphas are `vrf:{request_id}:{sender_id}:{seed}`, well under this.
pub const MAX_ALPHA_LEN: usize = 192;
/// How far ahead a lobby may set its start deadline. Sponsors and players can always get their
/// money back by then at the latest.
pub const MAX_START_WINDOW_MS: u64 = 7 * 24 * 3_600_000;
/// How long `lock_lobby` freezes joins and leaves while the referee signs `Start`. If `Start`
/// has not landed when it runs out, the lobby can only be left or aborted.
pub const LOCK_MS: u64 = 600_000;
/// `Start.start_ms` must be this close to the block time it lands in, so `end_ms` (and with it
/// the overdue abort) means real time.
pub const START_SKEW_MS: u64 = 300_000;
/// Upper bound on what one match ever stores (the match record at its largest plus a full checkpoint
/// list, with NEAR's 40-byte per-record overhead). `create_match` charges it up front. A unit test
/// checks the bound against a maximal match.
pub const MATCH_STORAGE_BYTES: u128 = 8_000;
/// One payout record with 64-character account ids, including the 40-byte record overhead.
pub const PAYOUT_RECORD_BYTES: u128 = 180;
/// One (account, token) balance record with 64-character ids, including the record overhead.
pub const BALANCE_RECORD_BYTES: u128 = 200;

/// Circle's USDC is untested here; 20 Tgas is the usual NEP-141 transfer budget.
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(20);
/// The refund path writes one balance and logs; it burns well under this (see the e2e), with margin.
const ON_WITHDRAW_GAS: Gas = Gas::from_tgas(10);
/// What `withdraw` must be called with: its own execution, the 20 + 10 Tgas it attaches, and the
/// receipt costs. Less could leave the callback without the gas to restore a failed transfer.
pub const WITHDRAW_MIN_GAS: Gas = Gas::from_tgas(50);

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Lobby,
    Running,
    Ended,
    Aborted,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Player {
    pub account_id: AccountId,
    pub head: u128,
    pub out: bool,
    pub paid: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sponsor {
    pub account_id: AccountId,
    pub amount: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Root {
    pub log_size: u64,
    pub root: Hash,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reveal {
    pub alpha: String,
    pub vrf_signature: [u8; 64],
    pub final_root: Root,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Match {
    pub host: AccountId,
    pub token: AccountId,
    pub stake: u128,
    pub duration_ms: u64,
    pub zone_hash: Hash,
    pub public_replay: bool,
    pub min_players: u8,
    pub max_players: u8,
    pub start_by_ms: u64,
    pub created_ms: u64,
    pub referee_pk: [u8; 32],
    pub vrf_pk: [u8; 32],
    pub phase: Phase,
    /// Kept sorted by account id, the order `players_hash` and the ring use, so a verdict's
    /// player index is simply the position here.
    pub players: Vec<Player>,
    /// Who may join; empty means anyone registered.
    pub invites: Vec<AccountId>,
    /// The sponsors the host named, each with what they have put in so far.
    pub sponsors: Vec<Sponsor>,
    /// Sponsor money the match still holds: the sum of `sponsors` until settlement, then 0.
    pub pot: u128,
    /// Set once by `lock_lobby`: joins are closed from then on, leaves until this time.
    pub locked_until_ms: Option<u64>,
    pub seq: u32,
    pub last_verdict_ms: u64,
    pub ring_commit: Option<Hash>,
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
    pub reveal: Option<Reveal>,
}

impl Match {
    fn is_locked(&self, now: u64) -> bool {
        self.locked_until_ms.is_some_and(|t| now < t)
    }
}

/// `ft_transfer_call` message: `{"credit":"<account>"}` or `{"sponsor":"<match id hex>"}`.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Debug)]
enum TransferMsg {
    Credit(AccountId),
    Sponsor(String),
}

#[near(contract_state)]
#[derive(PanicOnDefault, Debug)]
pub struct Tail {
    owner: AccountId,
    referee_pk: [u8; 32],
    vrf_pk: [u8; 32],
    /// Fixed at `new`, so registration can pre-size one balance per token.
    allowed_tokens: Vec<AccountId>,
    /// Random at `new`: a contract recreated on the same account never repeats a match id.
    salt: [u8; 32],
    /// Registered accounts → where `withdraw` pays them.
    payouts: LookupMap<AccountId, AccountId>,
    /// (account, token) → internal balance. Created for every allowed token at registration and
    /// never removed, so credits and refunds never allocate storage.
    balances: LookupMap<(AccountId, AccountId), u128>,
    matches: LookupMap<MatchId, Match>,
    /// Kept apart from `matches` so Hint and Tag verdicts do not rewrite the checkpoint list.
    checkpoints: LookupMap<MatchId, Vec<Root>>,
    match_nonce: u64,
}

// near-sdk deserialises every JSON argument into an owned value, so methods take them by value.
#[allow(clippy::needless_pass_by_value)]
#[near]
impl Tail {
    /// Not `#[private]`: the parent account creates, deploys and calls `new` in one transaction
    /// (so nobody can initialise it in between), and there the predecessor is the parent.
    /// `#[init]` refuses a second call once state exists.
    #[init]
    pub fn new(owner: AccountId, referee_pk: String, vrf_pk: String, allowed_tokens: Vec<AccountId>) -> Self {
        require!(!allowed_tokens.is_empty(), "allowed_tokens is empty");
        Self {
            owner,
            referee_pk: parse_key(&referee_pk, "referee_pk"),
            vrf_pk: parse_key(&vrf_pk, "vrf_pk"),
            allowed_tokens,
            salt: env::random_seed_array(),
            payouts: LookupMap::new(b"p"),
            balances: LookupMap::new(b"b"),
            matches: LookupMap::new(b"m"),
            checkpoints: LookupMap::new(b"c"),
            match_nonce: 0,
        }
    }

    // ── Owner ────────────────────────────────────────────────────────────────────────────────

    /// Rotates the referee key for matches created from now on. Running matches keep theirs.
    #[payable]
    pub fn set_referee_pk(&mut self, referee_pk: String) {
        self.assert_owner();
        self.referee_pk = parse_key(&referee_pk, "referee_pk");
    }

    /// Rotates the OutLayer VRF key for matches created from now on.
    #[payable]
    pub fn set_vrf_pk(&mut self, vrf_pk: String) {
        self.assert_owner();
        self.vrf_pk = parse_key(&vrf_pk, "vrf_pk");
    }

    // ── Accounts ─────────────────────────────────────────────────────────────────────────────

    /// Registers `account_id` with its payout account. The caller is the account itself or its
    /// parent (the relay creates `<handle>.<relay>` and registers it in the same breath), so
    /// nobody can register someone else with a payout they control. Attach exactly
    /// `get_config().registration_deposit`: it pays for the payout record and a balance for each
    /// allowed token.
    #[payable]
    pub fn register_for(&mut self, account_id: AccountId, payout_account: AccountId) {
        require!(
            env::attached_deposit() == self.registration_deposit(),
            "attach exactly registration_deposit (see get_config)"
        );
        let caller = env::predecessor_account_id();
        let is_parent = account_id
            .as_str()
            .strip_suffix(caller.as_str())
            .and_then(|rest| rest.strip_suffix('.'))
            .is_some_and(|handle| !handle.is_empty() && !handle.contains('.'));
        require!(
            caller == account_id || is_parent,
            "only the account or its parent can register it"
        );
        require!(!self.payouts.contains_key(&account_id), "already registered");
        check_payout(&payout_account);
        for token in &self.allowed_tokens {
            self.balances.insert((account_id.clone(), token.clone()), 0);
        }
        self.payouts.insert(account_id, payout_account);
    }

    /// Repoints `account_id`'s payout. Either the account itself or its current payout account
    /// may, with exactly 1 yocto attached. Function-call keys cannot attach a deposit, so a stolen
    /// player key cannot redirect winnings, while the account's owner (full-access key) can always
    /// undo a payout its parent set at registration.
    #[payable]
    pub fn set_payout(&mut self, account_id: AccountId, payout_account: AccountId) {
        assert_one_yocto();
        let current = self
            .payouts
            .get(&account_id)
            .unwrap_or_else(|| env::panic_str("account not registered"));
        let caller = env::predecessor_account_id();
        require!(
            caller == account_id || caller == *current,
            "only the account or its current payout account can change it"
        );
        check_payout(&payout_account);
        self.payouts.insert(account_id, payout_account);
    }

    // ── Money in and out ─────────────────────────────────────────────────────────────────────

    /// NEP-141 receiver. Returns the amount to refund: 0 when accepted, all of it when the
    /// message is not one we can honour (the token then sends it back to `sender_id`).
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let token = env::predecessor_account_id();
        require!(self.allowed_tokens.contains(&token), "token not allowed");
        match self.accept_transfer(&token, &sender_id, amount.0, &msg) {
            Ok(()) => U128(0),
            Err(reason) => {
                env::log_str(&format!("refunded: {reason}"));
                amount
            }
        }
    }

    /// Pays `amount` of `token` from the caller's internal balance to their payout account. The
    /// balance is debited first and restored by `on_withdraw` if the transfer fails. The contract
    /// attaches the 1 yocto `ft_transfer` needs, because function-call keys cannot (F18). Call it
    /// with at least 50 Tgas: 20 go to `ft_transfer` and 10 to the callback.
    pub fn withdraw(&mut self, token: AccountId, amount: U128) -> Promise {
        require!(
            env::prepaid_gas() >= WITHDRAW_MIN_GAS,
            "withdraw needs at least 50 Tgas"
        );
        let who = env::predecessor_account_id();
        let payout = self
            .payouts
            .get(&who)
            .cloned()
            .unwrap_or_else(|| env::panic_str("account not registered"));
        require!(amount.0 > 0, "amount must be positive");
        debit(&mut self.balances, &who, &token, amount.0);
        Promise::new(token.clone())
            .function_call(
                "ft_transfer",
                json!({ "receiver_id": payout, "amount": amount })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(1),
                FT_TRANSFER_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_WITHDRAW_GAS)
                    .on_withdraw(who, token, amount),
            )
    }

    /// Returns true when the tokens were paid, false when the transfer failed and the balance
    /// was restored (into the record `debit` left in place, so this never needs new storage).
    #[private]
    pub fn on_withdraw(&mut self, account_id: AccountId, token: AccountId, amount: U128) -> bool {
        // ft_transfer returns no value, so any data (even an unexpected one) means it ran.
        if matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed)) {
            credit(&mut self.balances, &account_id, &token, amount.0);
            env::log_str(&format!("withdraw of {} failed; balance restored", amount.0));
            false
        } else {
            true
        }
    }

    // ── Lobby ────────────────────────────────────────────────────────────────────────────────

    /// Opens a lobby hosted by the caller. Attach exactly `get_config().match_storage_deposit`.
    /// Returns the 16-byte match id as hex.
    #[payable]
    pub fn create_match(&mut self, cfg: MatchConfig) -> String {
        require!(
            env::attached_deposit() == match_storage_deposit(),
            "attach exactly match_storage_deposit (see get_config)"
        );
        require!(self.allowed_tokens.contains(&cfg.token), "token not allowed");
        require!(
            MIN_PLAYERS <= cfg.min_players
                && cfg.min_players <= cfg.max_players
                && cfg.max_players <= MAX_PLAYERS,
            "need 3 <= min_players <= max_players <= 12"
        );
        require!(
            cfg.duration_ms > 0 && cfg.duration_ms <= MAX_DURATION_MS,
            "duration out of range"
        );
        let now = env::block_timestamp_ms();
        require!(cfg.start_by_ms > now, "start_by_ms is in the past");
        require!(
            cfg.start_by_ms <= now + MAX_START_WINDOW_MS,
            "start_by_ms is more than 7 days out"
        );
        require!(cfg.invites.len() <= MAX_INVITES, "too many invites");
        require!(cfg.sponsors.len() <= MAX_SPONSORS, "too many sponsors");
        for (i, s) in cfg.sponsors.iter().enumerate() {
            require!(!cfg.sponsors[..i].contains(s), "sponsor named twice");
        }

        self.match_nonce += 1;
        let id = self.next_match_id();
        let m = Match {
            host: env::predecessor_account_id(),
            token: cfg.token.clone(),
            stake: cfg.stake.0,
            duration_ms: cfg.duration_ms,
            zone_hash: parse_hex(&cfg.zone_hash, "zone_hash"),
            public_replay: cfg.public_replay,
            min_players: cfg.min_players,
            max_players: cfg.max_players,
            start_by_ms: cfg.start_by_ms,
            created_ms: now,
            referee_pk: self.referee_pk,
            vrf_pk: self.vrf_pk,
            phase: Phase::Lobby,
            players: Vec::new(),
            invites: cfg.invites,
            sponsors: cfg
                .sponsors
                .into_iter()
                .map(|account_id| Sponsor {
                    account_id,
                    amount: 0,
                })
                .collect(),
            pot: 0,
            locked_until_ms: None,
            seq: 0,
            last_verdict_ms: now,
            ring_commit: None,
            start_ms: None,
            end_ms: None,
            reveal: None,
        };
        self.matches.insert(id, m);
        hex::encode(id)
    }

    /// Replaces the invite list (empty = open to any registered account). Host only, before the
    /// lobby is locked. Players already in stay in.
    pub fn set_invites(&mut self, match_id: String, invites: Vec<AccountId>) {
        let m = self
            .matches
            .get_mut(&parse_hex(&match_id, "match_id"))
            .unwrap_or_else(no_match);
        require!(env::predecessor_account_id() == m.host, "host only");
        require!(
            m.phase == Phase::Lobby && m.locked_until_ms.is_none(),
            "lobby is locked or started"
        );
        require!(invites.len() <= MAX_INVITES, "too many invites");
        m.invites = invites;
    }

    /// Freezes the player list for `LOCK_MS` so the referee's `Start` (which commits to it) can
    /// land: no joins from now on, no leaves until the lock runs out. Host only, once per match.
    /// If `Start` has not landed when the lock runs out, players may leave and anyone may abort.
    pub fn lock_lobby(&mut self, match_id: String) {
        let m = self
            .matches
            .get_mut(&parse_hex(&match_id, "match_id"))
            .unwrap_or_else(no_match);
        require!(env::predecessor_account_id() == m.host, "host only");
        require!(m.phase == Phase::Lobby, "match already started");
        require!(m.locked_until_ms.is_none(), "lobby was already locked");
        let now = env::block_timestamp_ms();
        require!(now <= m.start_by_ms, "start deadline passed");
        require!(
            m.players.len() >= usize::from(m.min_players),
            "not enough players to lock"
        );
        m.locked_until_ms = Some(now + LOCK_MS);
    }

    /// Moves the stake from the caller's internal balance into their head in this lobby.
    pub fn join_match(&mut self, match_id: String) {
        let who = env::predecessor_account_id();
        require!(self.payouts.contains_key(&who), "account not registered");
        let m = self
            .matches
            .get_mut(&parse_hex(&match_id, "match_id"))
            .unwrap_or_else(no_match);
        require!(m.phase == Phase::Lobby, "match already started");
        require!(m.locked_until_ms.is_none(), "lobby is locked");
        require!(
            env::block_timestamp_ms() <= m.start_by_ms,
            "start deadline passed"
        );
        require!(m.invites.is_empty() || m.invites.contains(&who), "not invited");
        require!(m.players.len() < usize::from(m.max_players), "match is full");
        let Err(pos) = m.players.binary_search_by(|p| p.account_id.cmp(&who)) else {
            env::panic_str("already joined");
        };
        debit(&mut self.balances, &who, &m.token, m.stake);
        m.players.insert(
            pos,
            Player {
                account_id: who,
                head: m.stake,
                out: false,
                paid: 0,
            },
        );
    }

    /// Gives the caller's head back to their internal balance; only before `Start`, and not while
    /// the lobby is locked.
    pub fn leave_lobby(&mut self, match_id: String) {
        let who = env::predecessor_account_id();
        let m = self
            .matches
            .get_mut(&parse_hex(&match_id, "match_id"))
            .unwrap_or_else(no_match);
        require!(m.phase == Phase::Lobby, "match already started");
        require!(!m.is_locked(env::block_timestamp_ms()), "lobby is locked");
        let Ok(pos) = m.players.binary_search_by(|p| p.account_id.cmp(&who)) else {
            env::panic_str("not in this match");
        };
        let p = m.players.remove(pos);
        credit(&mut self.balances, &p.account_id, &m.token, p.head);
    }

    // ── Verdicts ─────────────────────────────────────────────────────────────────────────────

    /// The only way heads move. Each item is a borsh `SignedVerdict`; they apply in order and
    /// the whole call fails if any one is refused. Anyone may submit; only the referee signs.
    pub fn apply(&mut self, verdicts: Vec<Base64VecU8>) {
        require!(!verdicts.is_empty(), "no verdicts");
        let now = env::block_timestamp_ms();
        for raw in &verdicts {
            let sv = SignedVerdict::try_from_slice(&raw.0)
                .unwrap_or_else(|_| env::panic_str("verdict is not a borsh SignedVerdict"));
            self.apply_one(sv, now);
        }
    }

    /// Refunds a match the referee abandoned. Anyone may call it once:
    /// - a lobby passed `start_by_ms`, or its lock ran out, without a `Start`;
    /// - a running match saw no verdict for `REFEREE_TIMEOUT_MS`;
    /// - a running match is still running `REFEREE_TIMEOUT_MS` after its `end_ms` (a referee
    ///   that keeps talking but never sends `End` must not hold the money either).
    ///
    /// Every head goes to its player and every sponsor gets their contribution back, all as
    /// internal balances.
    pub fn abort(&mut self, match_id: String) {
        let m = self
            .matches
            .get_mut(&parse_hex(&match_id, "match_id"))
            .unwrap_or_else(no_match);
        let now = env::block_timestamp_ms();
        match m.phase {
            Phase::Lobby => {
                let lock_ran_out = m.locked_until_ms.is_some_and(|t| now >= t);
                require!(now > m.start_by_ms || lock_ran_out, "lobby is still open");
            }
            Phase::Running => {
                let silent = now >= m.last_verdict_ms + REFEREE_TIMEOUT_MS;
                let overdue = m
                    .end_ms
                    .is_some_and(|end| now >= end.saturating_add(REFEREE_TIMEOUT_MS));
                require!(silent || overdue, "referee has not timed out");
            }
            Phase::Ended | Phase::Aborted => env::panic_str("match already settled"),
        }
        for p in &mut m.players {
            credit(&mut self.balances, &p.account_id, &m.token, p.head);
            p.paid = p.head;
            p.head = 0;
        }
        for s in &m.sponsors {
            credit(&mut self.balances, &s.account_id, &m.token, s.amount);
        }
        m.pot = 0;
        m.phase = Phase::Aborted;
    }

    // ── Views ────────────────────────────────────────────────────────────────────────────────

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            referee_pk: hex::encode(self.referee_pk),
            vrf_pk: hex::encode(self.vrf_pk),
            allowed_tokens: self.allowed_tokens.clone(),
            match_storage_deposit: U128(match_storage_deposit().as_yoctonear()),
            registration_deposit: U128(self.registration_deposit().as_yoctonear()),
            referee_timeout_ms: REFEREE_TIMEOUT_MS,
            lock_ms: LOCK_MS,
            start_skew_ms: START_SKEW_MS,
            max_start_window_ms: MAX_START_WINDOW_MS,
            min_players: MIN_PLAYERS,
            max_players: MAX_PLAYERS,
            max_duration_ms: MAX_DURATION_MS,
            max_checkpoints: MAX_CHECKPOINTS as u32,
            max_sponsors: MAX_SPONSORS as u32,
            max_invites: MAX_INVITES as u32,
        }
    }

    pub fn get_match(&self, match_id: String) -> Option<MatchView> {
        let id = parse_hex(&match_id, "match_id");
        self.matches.get(&id).map(|m| match_view(&id, m))
    }

    /// Heads in player-index order.
    pub fn get_heads(&self, match_id: String) -> Option<Vec<U128>> {
        let m = self.matches.get(&parse_hex(&match_id, "match_id"))?;
        Some(m.players.iter().map(|p| U128(p.head)).collect())
    }

    pub fn get_balance(&self, account_id: AccountId, token: AccountId) -> U128 {
        U128(self.balances.get(&(account_id, token)).copied().unwrap_or(0))
    }

    pub fn get_payout(&self, account_id: AccountId) -> Option<AccountId> {
        self.payouts.get(&account_id).cloned()
    }

    pub fn get_roots(&self, match_id: String) -> Option<RootsView> {
        let id = parse_hex(&match_id, "match_id");
        let m = self.matches.get(&id)?;
        let checkpoints = self
            .checkpoints
            .get(&id)
            .map_or_else(Vec::new, |cs| cs.iter().map(root_view).collect());
        Some(RootsView {
            checkpoints,
            final_root: m.reveal.as_ref().map(|r| root_view(&r.final_root)),
        })
    }
}

impl Tail {
    fn assert_owner(&self) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn registration_deposit(&self) -> NearToken {
        let bytes = PAYOUT_RECORD_BYTES + BALANCE_RECORD_BYTES * self.allowed_tokens.len() as u128;
        env::storage_byte_cost().saturating_mul(bytes)
    }

    /// 16 bytes of SHA256("tail/match" ‖ salt ‖ contract account ‖ u64le(nonce)): unique across
    /// contracts and across redeployments of one account, so a verdict signed for one deployment
    /// can never name a match in another.
    fn next_match_id(&self) -> MatchId {
        let mut pre = b"tail/match".to_vec();
        pre.extend_from_slice(&self.salt);
        pre.extend_from_slice(env::current_account_id().as_bytes());
        pre.extend_from_slice(&self.match_nonce.to_le_bytes());
        let h = env::sha256_array(&pre);
        let mut id = [0u8; 16];
        id.copy_from_slice(&h[..16]);
        id
    }

    fn accept_transfer(
        &mut self,
        token: &AccountId,
        sender: &AccountId,
        amount: u128,
        msg: &str,
    ) -> Result<(), &'static str> {
        let msg: TransferMsg = near_sdk::serde_json::from_str(msg)
            .map_err(|_| r#"msg must be {"credit":…} or {"sponsor":…}"#)?;
        match msg {
            TransferMsg::Credit(account) => {
                if !self.payouts.contains_key(&account) {
                    return Err("account not registered");
                }
                credit(&mut self.balances, &account, token, amount);
            }
            TransferMsg::Sponsor(match_id) => {
                let mut id = [0u8; 16];
                hex::decode_to_slice(&match_id, &mut id).map_err(|_| "match_id must be 32 hex chars")?;
                // Sponsors are refunded to their internal balance on abort, so they need a payout.
                if !self.payouts.contains_key(sender) {
                    return Err("sponsor not registered");
                }
                let m = self.matches.get_mut(&id).ok_or("no such match")?;
                // The pot is fixed at Start so `sum(heads) + pot` stays constant while running.
                if m.phase != Phase::Lobby {
                    return Err("match already started");
                }
                if &m.token != token {
                    return Err("wrong token for this match");
                }
                let s = m
                    .sponsors
                    .iter_mut()
                    .find(|s| &s.account_id == sender)
                    .ok_or("not a named sponsor")?;
                s.amount += amount;
                m.pot += amount;
            }
        }
        Ok(())
    }

    fn apply_one(&mut self, sv: SignedVerdict, now: u64) {
        let m = self.matches.get_mut(&sv.match_id).unwrap_or_else(no_match);
        require!(sv.seq == m.seq + 1, "verdict out of order");
        require!(
            env::ed25519_verify(&sv.sig, verdict_digest(&sv.payload()), &m.referee_pk),
            "bad referee signature"
        );
        if !matches!(sv.body, Verdict::Start { .. }) {
            require!(m.phase == Phase::Running, "match not running");
        }
        match sv.body {
            Verdict::Start {
                players_hash: ph,
                ring_commit: rc,
                start_ms,
                end_ms,
            } => {
                require!(m.phase == Phase::Lobby, "match already started");
                require!(now <= m.start_by_ms, "start deadline passed");
                // The lock is what keeps the player list equal to the one the referee signed.
                require!(m.is_locked(now), "lobby is not locked");
                let n = m.players.len();
                require!(
                    usize::from(m.min_players) <= n && n <= usize::from(m.max_players),
                    "player count out of range"
                );
                let ids: Vec<&str> = m.players.iter().map(|p| p.account_id.as_str()).collect();
                require!(
                    ph == players_hash(&ids),
                    "players_hash does not match the joined players"
                );
                require!(
                    now.abs_diff(start_ms) <= START_SKEW_MS,
                    "start_ms is too far from block time"
                );
                require!(
                    end_ms > start_ms && end_ms - start_ms == m.duration_ms,
                    "end_ms - start_ms must equal duration_ms"
                );
                m.phase = Phase::Running;
                m.ring_commit = Some(rc);
                m.start_ms = Some(start_ms);
                m.end_ms = Some(end_ms);
            }
            Verdict::Hint { from, to, amount, .. } => {
                let (f, t) = live_pair(m, from, to);
                require!(
                    m.players[f].head >= amount,
                    "hint costs more than the payer's head"
                );
                m.players[f].head -= amount;
                m.players[t].head += amount;
            }
            Verdict::Tag {
                hunter: winner,
                target: loser,
            }
            | Verdict::Forfeit {
                player: loser,
                to: winner,
            } => {
                let (l, w) = live_pair(m, loser, winner);
                let head = std::mem::take(&mut m.players[l].head);
                m.players[l].out = true;
                m.players[w].head += head;
            }
            Verdict::Checkpoint { log_size, root } => {
                let list = self.checkpoints.entry(sv.match_id).or_default();
                require!(list.len() < MAX_CHECKPOINTS, "checkpoint limit reached");
                list.push(Root { log_size, root });
            }
            Verdict::End {
                alpha,
                vrf_signature,
                log_size,
                root,
            } => {
                require!(
                    m.ring_commit == Some(ring_commit(&vrf_signature)),
                    "vrf_signature does not match ring_commit"
                );
                require!(alpha.len() <= MAX_ALPHA_LEN, "alpha too long");
                // The ring seed is this match's id (TECHNICAL 4.8), so a VRF output drawn for
                // anything else cannot be passed off as this match's shuffle.
                require!(
                    alpha.rsplit_once(':').map(|(_, seed)| seed) == Some(hex::encode(sv.match_id).as_str()),
                    "alpha seed is not this match id"
                );
                require!(
                    env::ed25519_verify(&vrf_signature, alpha.as_bytes(), &m.vrf_pk),
                    "bad VRF signature"
                );
                settle_end(m, &mut self.balances);
                m.reveal = Some(Reveal {
                    alpha,
                    vrf_signature,
                    final_root: Root { log_size, root },
                });
            }
        }
        m.seq = sv.seq;
        m.last_verdict_ms = now;
    }
}

/// End: every player's head goes to their balance (an out player's head is already 0), and the
/// sponsor pot is split equally among survivors in index order, the first `pot % survivors`
/// survivors getting one extra unit so nothing is left behind.
fn settle_end(m: &mut Match, balances: &mut LookupMap<(AccountId, AccountId), u128>) {
    let survivors = m.players.iter().filter(|p| !p.out).count() as u128;
    // Tag and Forfeit always leave the winner in, so a started match never runs out of survivors.
    require!(survivors > 0, "no survivors");
    let (share, mut extra) = (m.pot / survivors, m.pot % survivors);
    for p in &mut m.players {
        let mut paid = p.head;
        if !p.out {
            paid += share;
            if extra > 0 {
                paid += 1;
                extra -= 1;
            }
        }
        credit(balances, &p.account_id, &m.token, paid);
        p.paid = paid;
        p.head = 0;
    }
    m.pot = 0;
    m.phase = Phase::Ended;
}

/// Two distinct players who are both still in, as indices.
fn live_pair(m: &Match, a: u16, b: u16) -> (usize, usize) {
    let (a, b) = (usize::from(a), usize::from(b));
    require!(
        a < m.players.len() && b < m.players.len(),
        "player index out of range"
    );
    require!(a != b, "players must differ");
    require!(!m.players[a].out && !m.players[b].out, "player is out");
    (a, b)
}

/// Every account that can be credited (registered players and sponsors) got a balance record for
/// every allowed token at registration, so this only ever updates an existing record. The
/// `or_insert` is the fallback that keeps money safe if that ever stopped holding.
fn credit(
    balances: &mut LookupMap<(AccountId, AccountId), u128>,
    account: &AccountId,
    token: &AccountId,
    amount: u128,
) {
    if amount == 0 {
        return;
    }
    *balances.entry((account.clone(), token.clone())).or_insert(0) += amount;
}

/// Panics unless the balance covers `amount`. The record stays even at 0, so a later credit or a
/// failed-withdraw refund never needs storage nobody paid for.
fn debit(
    balances: &mut LookupMap<(AccountId, AccountId), u128>,
    account: &AccountId,
    token: &AccountId,
    amount: u128,
) {
    if amount == 0 {
        return;
    }
    let bal = balances
        .get_mut(&(account.clone(), token.clone()))
        .unwrap_or_else(|| env::panic_str("balance too small"));
    require!(*bal >= amount, "balance too small");
    *bal -= amount;
}

fn check_payout(payout: &AccountId) {
    // A plain ft_transfer to this contract would land outside every internal balance.
    require!(
        *payout != env::current_account_id(),
        "payout cannot be this contract"
    );
}

pub fn match_storage_deposit() -> NearToken {
    env::storage_byte_cost().saturating_mul(MATCH_STORAGE_BYTES)
}

fn no_match<T>() -> T {
    env::panic_str("no such match")
}

fn parse_hex<const N: usize>(s: &str, what: &str) -> [u8; N] {
    let mut out = [0u8; N];
    if hex::decode_to_slice(s, &mut out).is_err() {
        env::panic_str(&format!("{what} must be {} hex chars", 2 * N));
    }
    out
}

/// An ed25519 public key that can only have come from a real secret: canonical, on the curve,
/// not of small order and free of torsion. A small-order key (the identity, the all-zero bytes,
/// …) lets anyone forge signatures that `ed25519_verify` accepts.
fn parse_key(s: &str, what: &str) -> [u8; 32] {
    let pk: [u8; 32] = parse_hex(s, what);
    require!(
        is_strong_key(&pk),
        &format!("{what} is not a valid ed25519 public key")
    );
    pk
}

pub fn is_strong_key(pk: &[u8; 32]) -> bool {
    canonical_point(pk).is_some_and(|p| !p.is_small_order() && p.is_torsion_free())
}

/// The curve point `pk` encodes, only if `pk` is its one canonical encoding (`y < p`). Decompression
/// alone also accepts `y + p`, a second spelling of the same key.
pub fn canonical_point(pk: &[u8; 32]) -> Option<EdwardsPoint> {
    CompressedEdwardsY(*pk)
        .decompress()
        .filter(|p| p.compress().0 == *pk)
}

fn root_view(r: &Root) -> RootView {
    RootView {
        log_size: r.log_size,
        root: hex::encode(r.root),
    }
}

fn match_view(id: &MatchId, m: &Match) -> MatchView {
    MatchView {
        match_id: hex::encode(id),
        host: m.host.clone(),
        token: m.token.clone(),
        stake: U128(m.stake),
        duration_ms: m.duration_ms,
        zone_hash: hex::encode(m.zone_hash),
        public_replay: m.public_replay,
        min_players: m.min_players,
        max_players: m.max_players,
        start_by_ms: m.start_by_ms,
        created_ms: m.created_ms,
        phase: m.phase,
        players: m
            .players
            .iter()
            .map(|p| PlayerView {
                account_id: p.account_id.clone(),
                head: U128(p.head),
                out: p.out,
                paid: U128(p.paid),
            })
            .collect(),
        invites: m.invites.clone(),
        sponsors: m
            .sponsors
            .iter()
            .map(|s| SponsorView {
                account_id: s.account_id.clone(),
                amount: U128(s.amount),
            })
            .collect(),
        sponsor_pot: U128(m.pot),
        locked_until_ms: m.locked_until_ms,
        seq: m.seq,
        last_verdict_ms: m.last_verdict_ms,
        referee_pk: hex::encode(m.referee_pk),
        vrf_pk: hex::encode(m.vrf_pk),
        ring_commit: m.ring_commit.map(hex::encode),
        start_ms: m.start_ms,
        end_ms: m.end_ms,
        alpha: m.reveal.as_ref().map(|r| r.alpha.clone()),
        vrf_signature: m.reveal.as_ref().map(|r| hex::encode(r.vrf_signature)),
    }
}
