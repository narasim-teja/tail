//! Unit tests. Every "is refused" test has a twin nearby that succeeds with one thing changed.

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};
use tail_protocol::hint_kind::{BEARING, NEAR, TREND};
use tail_protocol::merkle::{consistency_proof, leaf, proof, root};
use tail_protocol::{recent_hints, VerdictPayload, PRICE_WINDOW_MS};

const T0: u64 = 1_794_514_000_000;
const STAKE: u128 = 1_000_000;
const DURATION: u64 = 3_600_000;
const CALL_ID: [u8; 16] = [7; 16];
/// What a NEAR or TREND hint costs at `STAKE` (2 %), and a BEARING hint (5 %), with no other hint
/// in the last 5 minutes.
const NEAR_PRICE: u128 = STAKE * 200 / 10_000;
const BEARING_PRICE: u128 = STAKE * 500 / 10_000;

/// What a hint of `kind` costs at `STAKE` after `recent` hints in the window.
fn price(kind: u8, recent: u32) -> u128 {
    hint_price(STAKE, kind, recent).unwrap()
}

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn contract() -> AccountId {
    acc("tail.testnet")
}
fn owner() -> AccountId {
    acc("owner.testnet")
}
fn usdc() -> AccountId {
    acc("usdc.testnet")
}
fn usdt() -> AccountId {
    acc("usdt.testnet")
}
fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}
fn referee() -> SigningKey {
    key(1)
}
fn vrf() -> SigningKey {
    key(3)
}
/// The VRF `sender` the test contract pins; `alpha_for` names it.
fn vrf_sender() -> AccountId {
    acc("relay.testnet")
}
fn pk_hex(k: &SigningKey) -> String {
    hex::encode(k.verifying_key().to_bytes())
}

/// Sets the calling context. Storage carries over between calls, like on chain.
fn ctx(who: &AccountId, now_ms: u64, deposit: NearToken) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(contract())
        .predecessor_account_id(who.clone())
        .signer_account_id(who.clone())
        .block_timestamp(now_ms * 1_000_000)
        .attached_deposit(deposit)
        .build());
}
fn ctx_with_result(now_ms: u64, result: PromiseResult) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(contract())
            .predecessor_account_id(contract())
            .block_timestamp(now_ms * 1_000_000)
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        std::collections::HashMap::default(),
        vec![result],
    );
}

/// A borsh `SignedVerdict` v2 and its digest (the `prev` of the verdict after it).
fn sign(k: &SigningKey, match_id: MatchId, seq: u32, prev: Hash, body: Verdict) -> (Base64VecU8, Hash) {
    let payload = VerdictPayload {
        match_id,
        seq,
        prev,
        call_id: CALL_ID,
        body: body.clone(),
    };
    let digest = verdict_digest(&payload);
    let sv = SignedVerdict {
        match_id,
        seq,
        prev,
        call_id: CALL_ID,
        body,
        sig: k.sign(&digest).to_bytes(),
    };
    (Base64VecU8(borsh::to_vec(&sv).unwrap()), digest)
}

/// Entry `i` of the stand-in match log every test match shares.
fn log_entry(i: u64) -> LogEntry {
    LogEntry::Tick {
        tick_no: i as u32,
        now_ms: T0 + i,
        call_id: CALL_ID,
    }
}
/// The first `n` leaf hashes of that log.
fn log_leaves(n: u64) -> Vec<Hash> {
    (0..n).map(|i| leaf(&log_entry(i))).collect()
}
fn log_root(n: u64) -> Hash {
    root(&log_leaves(n))
}
/// A Checkpoint at `n` entries of the stand-in log.
fn cp(n: u64) -> Verdict {
    Verdict::Checkpoint {
        log_size: n,
        root: log_root(n),
    }
}
/// The consistency proof from `m` to `n` entries of the stand-in log, as the referee sends it.
/// A log cannot shrink, so for `m > n` there is no proof; the path is then empty (and refused).
fn consistency(seq: u32, m: u64, n: u64) -> ConsistencyArg {
    let path = if m <= n {
        consistency_proof(&log_leaves(n), m as usize)
    } else {
        Vec::new()
    };
    ConsistencyArg {
        seq,
        from_size: U64(m),
        path: path.into_iter().map(|h| Base64VecU8(h.to_vec())).collect(),
    }
}
/// In a Hint body: the fixture fills in the price at the match's demand when it signs.
const HONEST_PRICE: u128 = u128::MAX;
/// In a Hint body: the fixture fills in the fixture clock (kept within the match, never before
/// the previous hint) when it signs.
const HONEST_TIME: u64 = u64::MAX;

/// A hint by `from` of `kind`, at its price, now.
fn hint_of(from: u16, kind: u8) -> Verdict {
    Verdict::Hint {
        from,
        amount: HONEST_PRICE,
        hint_id: 1,
        hint: kind,
        t_ms: HONEST_TIME,
    }
}

/// A NEAR hint by `from` in a match whose stake prices it at 0.
fn free_hint(from: u16) -> Verdict {
    Verdict::Hint {
        from,
        amount: 0,
        hint_id: 1,
        hint: NEAR,
        t_ms: HONEST_TIME,
    }
}

/// In a Tag or Forfeit body: the fixture fills in the credit the honest referee would sign (the
/// hints paid onto the loser and not yet credited) when it signs the verdict.
const HONEST_CREDIT: u128 = u128::MAX;
/// In an End body: the fixture fills in the honest hint targets when it signs the verdict.
fn honest_targets() -> Vec<u16> {
    vec![u16::MAX]
}
fn tag(hunter: u16, target: u16) -> Verdict {
    Verdict::Tag {
        hunter,
        target,
        credit: HONEST_CREDIT,
    }
}
fn forfeit(player: u16, to: u16) -> Verdict {
    Verdict::Forfeit {
        player,
        to,
        credit: HONEST_CREDIT,
    }
}

/// The honest referee's view of a match: who hunts whom now, the hints pending on each player,
/// whom each hint so far was about and when it was charged, the stake and the referee clock.
struct Honest {
    targets: Vec<Option<u16>>,
    pending: Vec<u128>,
    about: Vec<u16>,
    times: Vec<u64>,
    stake: u128,
    clock: u64,
}

impl Honest {
    fn new(ring: &[u16], stake: u128, clock: u64) -> Self {
        let mut targets = vec![None; ring.len()];
        for (k, &h) in ring.iter().enumerate() {
            targets[usize::from(h)] = Some(ring[(k + 1) % ring.len()]);
        }
        Self {
            targets,
            pending: vec![0; ring.len()],
            about: Vec::new(),
            times: Vec::new(),
            stake,
            clock,
        }
    }

    /// Fills in the honest price and time, credit or hint targets of `body`, then follows it.
    fn sign(&mut self, mut body: Verdict) -> Verdict {
        match &mut body {
            Verdict::Hint {
                from,
                amount,
                hint,
                t_ms,
                ..
            } => {
                if *t_ms == HONEST_TIME {
                    *t_ms = self.clock.max(self.times.last().copied().unwrap_or(0));
                }
                if *amount == HONEST_PRICE {
                    *amount = hint_price(self.stake, *hint, recent_hints(&self.times, *t_ms)).unwrap_or(0);
                }
                self.times.push(*t_ms);
                // A hint by a player the ring has no target for is refused anyway; 0 stands in.
                let t = self
                    .targets
                    .get(usize::from(*from))
                    .copied()
                    .flatten()
                    .unwrap_or(0);
                self.about.push(t);
                self.pending[usize::from(t)] += *amount;
            }
            Verdict::Tag {
                hunter: w,
                target: l,
                credit,
            }
            | Verdict::Forfeit {
                player: l,
                to: w,
                credit,
            } => {
                let (w, l) = (usize::from(*w), usize::from(*l));
                if l < self.pending.len() && w < self.targets.len() {
                    if *credit == HONEST_CREDIT {
                        *credit = self.pending[l];
                    }
                    self.pending[l] = 0;
                    let next = self.targets[l].take();
                    self.targets[w] = next.filter(|&n| usize::from(n) != w);
                } else if *credit == HONEST_CREDIT {
                    *credit = 0;
                }
            }
            // The referee's clock starts with the match.
            Verdict::Start { start_ms, end_ms, .. } => {
                self.clock = self.clock.clamp(*start_ms, (*end_ms).max(*start_ms));
            }
            Verdict::End { hint_targets, .. } if *hint_targets == honest_targets() => {
                hint_targets.clone_from(&self.about);
            }
            _ => {}
        }
        body
    }
}

fn alpha_for(id: MatchId) -> String {
    format!("vrf:42:relay.testnet:{}", hex::encode(id))
}
fn vrf_sig(alpha: &str) -> [u8; 64] {
    vrf().sign(alpha.as_bytes()).to_bytes()
}

fn deploy() -> Tail {
    deploy_with_seed([0; 32])
}

/// A fresh deployment whose `new` sees `seed` as the block's random seed.
fn deploy_with_seed(seed: [u8; 32]) -> Tail {
    // Empty storage: `testing_env!` carries storage over, which would leak one deployment's
    // state into the next within a test.
    near_sdk::env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
        VMContextBuilder::new()
            .current_account_id(contract())
            .predecessor_account_id(contract())
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        vec![],
        std::collections::HashMap::default(),
        std::collections::HashMap::default(),
        None,
    ));
    testing_env!(VMContextBuilder::new()
        .current_account_id(contract())
        .predecessor_account_id(contract())
        .block_timestamp(T0 * 1_000_000)
        .random_seed(seed)
        .build());
    Tail::new(
        owner(),
        pk_hex(&referee()),
        pk_hex(&vrf()),
        vrf_sender(),
        vec![usdc(), usdt()],
    )
}

fn cfg(token: AccountId, stake: u128) -> MatchConfig {
    MatchConfig {
        token,
        stake: U128(stake),
        duration_ms: DURATION,
        zone_hash: hex::encode([0xab; 32]),
        public_replay: true,
        min_players: 3,
        max_players: 4,
        start_by_ms: T0 + 600_000,
        invites: vec![],
        sponsors: vec![acc("dao.testnet")],
        requires: None,
    }
}

/// End at `n` entries of the stand-in log, revealing the VRF signature over `alpha`, with the
/// honest hint targets.
fn end_at(alpha: &str, n: u64) -> Verdict {
    Verdict::End {
        vrf_signature: vrf_sig(alpha),
        alpha: alpha.to_owned(),
        log_size: n,
        root: log_root(n),
        hint_targets: honest_targets(),
    }
}

/// Player indices in ring order for the VRF output over `alpha`: `ring[k]` hunts `ring[k+1 mod n]`.
fn ring_of(v: &MatchView, alpha: &str) -> Vec<u16> {
    let ids: Vec<&str> = v.players.iter().map(|p| p.account_id.as_str()).collect();
    ring_order(&ids, &vrf_sig(alpha))
}

/// A contract with alice, bob and carol registered and topped up, and one lobby they joined.
/// Sorted, they are players 0, 1 and 2.
///
/// The fixture plays the honest referee: it reads the verdict head and the last anchored log size
/// from the contract, signs each verdict on top of them and proves each Checkpoint and End
/// against the stand-in log (`log_leaves`). It fills in `HONEST_CREDIT` and `honest_targets()`
/// from the events the contract recorded, replayed against the ring of `alpha()`.
struct Fx {
    c: Tail,
    now: u64,
    id: MatchId,
    /// The alpha the match's Start committed to, when it is not `alpha_for(id)`.
    alpha: Option<String>,
}

const PLAYERS: [&str; 3] = ["alice.testnet", "bob.testnet", "carol.testnet"];

impl Fx {
    fn empty() -> Self {
        Self::with(deploy())
    }

    fn with(c: Tail) -> Self {
        Self {
            c,
            now: T0,
            id: [0; 16],
            alpha: None,
        }
    }

    fn lobby() -> Self {
        let mut fx = Self::empty();
        // Joined out of order on purpose: indices come from the sorted ids, not join order.
        for p in ["carol.testnet", "alice.testnet", "bob.testnet"] {
            fx.register(p);
            fx.top_up(p, &usdc(), 2 * STAKE);
        }
        fx.id = fx.create(cfg(usdc(), STAKE));
        for p in ["carol.testnet", "alice.testnet", "bob.testnet"] {
            fx.join(p);
        }
        fx
    }

    /// The lobby, locked by its host so `Start` can land.
    fn locked() -> Self {
        let mut fx = Self::lobby();
        fx.lock();
        fx
    }

    fn running() -> Self {
        let mut fx = Self::locked();
        let body = fx.start_body();
        fx.verdict(body);
        fx
    }

    fn as_(&self, who: &str) {
        ctx(&acc(who), self.now, NearToken::from_yoctonear(0));
    }

    fn registration_deposit(&self) -> NearToken {
        NearToken::from_yoctonear(self.c.get_config().registration_deposit.0)
    }

    /// Self-registration with the payout account being the account itself.
    fn register(&mut self, who: &str) {
        self.register_with_payout(who, who);
    }

    fn register_with_payout(&mut self, who: &str, payout: &str) {
        ctx(&acc(who), self.now, self.registration_deposit());
        self.c.register_for(acc(who), acc(payout));
    }

    fn lock(&mut self) {
        self.as_("host.testnet");
        self.c.lock_lobby(hex::encode(self.id));
    }

    /// `ft_transfer_call` from `token` crediting `who`; returns the refunded amount.
    fn transfer(&mut self, token: &AccountId, sender: &str, amount: u128, msg: &str) -> u128 {
        ctx(token, self.now, NearToken::from_yoctonear(0));
        self.c.ft_on_transfer(acc(sender), U128(amount), msg.to_owned()).0
    }

    fn top_up(&mut self, who: &str, token: &AccountId, amount: u128) {
        let refunded = self.transfer(
            token,
            "minter.testnet",
            amount,
            &format!(r#"{{"credit":"{who}"}}"#),
        );
        assert_eq!(refunded, 0);
    }

    fn create(&mut self, cfg: MatchConfig) -> MatchId {
        ctx(&acc("host.testnet"), self.now, match_storage_deposit());
        parse_hex(&self.c.create_match(cfg), "match_id")
    }

    fn join(&mut self, who: &str) {
        self.as_(who);
        self.c.join_match(hex::encode(self.id));
    }

    fn start_body(&self) -> Verdict {
        let start_ms = self.now + 1_000;
        Verdict::Start {
            players_hash: players_hash(&PLAYERS),
            ring_commit: ring_commit(&vrf_sig(&alpha_for(self.id))),
            start_ms,
            end_ms: start_ms + DURATION,
        }
    }

    fn end_body(&self) -> Verdict {
        end_at(&alpha_for(self.id), 77)
    }

    /// Moves the clock to `end_ms` (if it is not there yet) and applies the committed reveal.
    fn end(&mut self) {
        self.now = self.now.max(self.view().end_ms.unwrap());
        let body = self.end_body();
        self.verdict(body);
    }

    fn alpha(&self) -> String {
        self.alpha.clone().unwrap_or_else(|| alpha_for(self.id))
    }

    fn ring(&self) -> Vec<u16> {
        ring_of(&self.view(), &self.alpha())
    }

    /// The honest referee's view after every event the contract recorded for the match, its
    /// clock the fixture's, kept within the match.
    fn honest(&self) -> Honest {
        let v = self.view();
        let clock = match (v.start_ms, v.end_ms) {
            (Some(s), Some(e)) => self.now.clamp(s, e),
            _ => self.now,
        };
        let mut h = Honest::new(&self.ring(), v.stake.0, clock);
        let events = self
            .c
            .plays
            .get(&self.id)
            .map_or_else(Vec::new, |r| r.events.clone());
        for e in events {
            let body = match e {
                PlayEvent::Hint { from, amount, t_ms } => Verdict::Hint {
                    from,
                    amount,
                    hint_id: 0,
                    hint: 0,
                    t_ms,
                },
                PlayEvent::Tag {
                    hunter,
                    target,
                    credit,
                } => Verdict::Tag {
                    hunter,
                    target,
                    credit,
                },
                PlayEvent::Forfeit { player, to, credit } => Verdict::Forfeit { player, to, credit },
            };
            h.sign(body);
        }
        h
    }

    fn pool(&self) -> u128 {
        self.view().hint_pool.0
    }

    fn paid(&self) -> Vec<u128> {
        self.view().players.iter().map(|p| p.paid.0).collect()
    }

    /// Who hunts player `i` at the start of the match.
    fn hunter_of(&self, i: u16) -> u16 {
        let ring = self.ring();
        let k = ring.iter().position(|&p| p == i).unwrap();
        ring[(k + ring.len() - 1) % ring.len()]
    }

    /// The contract's verdict head for the match: `(seq, digest)`. A match from before the
    /// upgrade has none; the fixture then signs on zeros (and the contract refuses it).
    fn head(&self) -> (u32, Hash) {
        let id = hex::encode(self.id);
        match self.c.get_verdict_head(id.clone()) {
            Some(h) => (h.seq, parse_hex(&h.digest, "digest")),
            None => (self.c.get_match(id).unwrap().seq, [0; 32]),
        }
    }

    /// The log size the match last anchored (0 before its first Checkpoint or End).
    fn anchored(&self) -> u64 {
        self.c
            .get_roots(hex::encode(self.id))
            .and_then(|r| r.checkpoints.last().map(|c| c.log_size))
            .unwrap_or(0)
    }

    /// Signs `bodies` with `k` as the next verdicts of the match, each on top of the one before,
    /// with a consistency proof for each Checkpoint and End.
    fn chain_with(&self, k: &SigningKey, bodies: Vec<Verdict>) -> (Vec<Base64VecU8>, Vec<ConsistencyArg>) {
        let (mut seq, mut prev) = self.head();
        let mut anchored = self.anchored();
        let mut honest = self.honest();
        let (mut verdicts, mut proofs) = (Vec::new(), Vec::new());
        for body in bodies {
            let body = honest.sign(body);
            seq += 1;
            if let Verdict::Checkpoint { log_size, .. } | Verdict::End { log_size, .. } = body {
                proofs.push(consistency(seq, anchored, log_size));
                anchored = log_size;
            }
            let (v, digest) = sign(k, self.id, seq, prev, body);
            verdicts.push(v);
            prev = digest;
        }
        (verdicts, proofs)
    }

    fn chain(&self, bodies: Vec<Verdict>) -> (Vec<Base64VecU8>, Vec<ConsistencyArg>) {
        self.chain_with(&referee(), bodies)
    }

    /// The next verdict signed by `k`, on top of the contract's head.
    fn next_signed_by(&self, k: &SigningKey, body: Verdict) -> Base64VecU8 {
        self.chain_with(k, vec![body]).0.remove(0)
    }

    /// Signs `body` with the referee key as the next verdict and applies it (with its proof).
    fn verdict(&mut self, body: Verdict) {
        self.verdicts(vec![body]);
    }

    fn verdicts(&mut self, bodies: Vec<Verdict>) {
        let (v, p) = self.chain(bodies);
        self.apply_proved(v, p);
    }

    fn apply(&mut self, verdicts: Vec<Base64VecU8>) {
        self.apply_proved(verdicts, Vec::new());
    }

    /// `apply`, passing `None` when there are no proofs, as a relay does for a tick without
    /// Checkpoint or End.
    fn apply_proved(&mut self, verdicts: Vec<Base64VecU8>, proofs: Vec<ConsistencyArg>) {
        self.as_("relay.testnet");
        self.c.apply(verdicts, (!proofs.is_empty()).then_some(proofs));
    }

    fn view(&self) -> MatchView {
        self.c.get_match(hex::encode(self.id)).unwrap()
    }

    fn heads(&self) -> Vec<u128> {
        self.c
            .get_heads(hex::encode(self.id))
            .unwrap()
            .into_iter()
            .map(|h| h.0)
            .collect()
    }

    fn bal(&self, who: &str) -> u128 {
        self.c.get_balance(acc(who), usdc()).0
    }

    fn abort(&mut self) {
        self.as_("anyone.testnet");
        self.c.abort(hex::encode(self.id));
    }
}

// ── Money in ────────────────────────────────────────────────────────────────────────────────

#[test]
fn a_credit_to_a_registered_account_is_accepted() {
    let mut fx = Fx::empty();
    fx.register("alice.testnet");
    assert_eq!(
        fx.transfer(&usdc(), "minter.testnet", 500, r#"{"credit":"alice.testnet"}"#),
        0
    );
    assert_eq!(fx.bal("alice.testnet"), 500);
}

#[test]
fn a_credit_to_an_unregistered_account_is_returned_in_full() {
    let mut fx = Fx::empty();
    assert_eq!(
        fx.transfer(&usdc(), "minter.testnet", 500, r#"{"credit":"alice.testnet"}"#),
        500
    );
    assert_eq!(fx.bal("alice.testnet"), 0);
}

#[test]
fn a_malformed_msg_is_returned_in_full() {
    let mut fx = Fx::empty();
    fx.register("alice.testnet");
    for msg in [
        "",
        "alice.testnet",
        r#"{"credit":"alice.testnet","x":1}"#,
        r#"{"gift":"alice.testnet"}"#,
    ] {
        assert_eq!(
            fx.transfer(&usdc(), "minter.testnet", 500, msg),
            500,
            "msg {msg:?}"
        );
    }
    assert_eq!(fx.bal("alice.testnet"), 0);
}

#[test]
#[should_panic(expected = "token not allowed")]
fn a_transfer_from_a_token_that_is_not_allowed_is_refused() {
    let mut fx = Fx::empty();
    fx.register("alice.testnet");
    fx.transfer(
        &acc("fake.testnet"),
        "minter.testnet",
        500,
        r#"{"credit":"alice.testnet"}"#,
    );
}

#[test]
fn a_second_allowed_token_keeps_its_own_balance() {
    let mut fx = Fx::empty();
    fx.register("alice.testnet");
    fx.top_up("alice.testnet", &usdt(), 300);
    assert_eq!(fx.c.get_balance(acc("alice.testnet"), usdt()).0, 300);
    assert_eq!(fx.bal("alice.testnet"), 0);
}

#[test]
fn sponsoring_a_lobby_adds_to_its_pot() {
    let mut fx = Fx::lobby();
    fx.register("dao.testnet");
    let msg = format!(r#"{{"sponsor":"{}"}}"#, hex::encode(fx.id));
    assert_eq!(fx.transfer(&usdc(), "dao.testnet", 10, &msg), 0);
    assert_eq!(fx.transfer(&usdc(), "dao.testnet", 5, &msg), 0);
    let v = fx.view();
    assert_eq!(v.sponsor_pot, U128(15));
    assert_eq!(
        v.sponsors,
        vec![SponsorView {
            account_id: acc("dao.testnet"),
            amount: U128(15)
        }]
    );
}

#[test]
fn sponsoring_a_running_match_is_returned_in_full() {
    let mut fx = Fx::running();
    fx.register("dao.testnet");
    let msg = format!(r#"{{"sponsor":"{}"}}"#, hex::encode(fx.id));
    assert_eq!(fx.transfer(&usdc(), "dao.testnet", 10, &msg), 10);
    assert_eq!(fx.view().sponsor_pot, U128(0));
}

#[test]
fn sponsoring_by_an_unregistered_sender_or_in_the_wrong_token_is_returned_in_full() {
    let mut fx = Fx::lobby();
    let msg = format!(r#"{{"sponsor":"{}"}}"#, hex::encode(fx.id));
    assert_eq!(fx.transfer(&usdc(), "dao.testnet", 10, &msg), 10);
    fx.register("dao.testnet");
    assert_eq!(fx.transfer(&usdt(), "dao.testnet", 10, &msg), 10);
    assert_eq!(fx.transfer(&usdc(), "dao.testnet", 10, r#"{"sponsor":"00"}"#), 10);
    assert_eq!(fx.view().sponsor_pot, U128(0));
}

/// Review regression: four dust sponsors used to fill the list and lock the real sponsor out.
#[test]
fn a_sponsor_the_host_did_not_name_is_returned_in_full_and_cannot_lock_the_named_one_out() {
    let mut fx = Fx::lobby();
    let id = hex::encode(fx.id);
    for s in ["d1.testnet", "d2.testnet", "d3.testnet", "d4.testnet"] {
        fx.register(s);
        assert_eq!(fx.transfer(&usdc(), s, 1, &format!(r#"{{"sponsor":"{id}"}}"#)), 1);
    }
    fx.register("dao.testnet");
    assert_eq!(
        fx.transfer(
            &usdc(),
            "dao.testnet",
            1_000_000,
            &format!(r#"{{"sponsor":"{id}"}}"#)
        ),
        0
    );
    assert_eq!(fx.view().sponsor_pot, U128(1_000_000));
}

#[test]
#[should_panic(expected = "too many sponsors")]
fn naming_more_than_four_sponsors_is_refused() {
    let mut fx = Fx::empty();
    let sponsors = (0..=MAX_SPONSORS)
        .map(|i| acc(&format!("dao{i}.testnet")))
        .collect();
    fx.create(MatchConfig {
        sponsors,
        ..cfg(usdc(), STAKE)
    });
}

#[test]
fn naming_four_sponsors_lets_each_of_them_sponsor() {
    let mut fx = Fx::empty();
    let sponsors: Vec<AccountId> = (0..MAX_SPONSORS)
        .map(|i| acc(&format!("dao{i}.testnet")))
        .collect();
    fx.id = fx.create(MatchConfig {
        sponsors: sponsors.clone(),
        ..cfg(usdc(), STAKE)
    });
    let msg = format!(r#"{{"sponsor":"{}"}}"#, hex::encode(fx.id));
    for s in &sponsors {
        fx.register(s.as_str());
        assert_eq!(fx.transfer(&usdc(), s.as_str(), 1, &msg), 0);
    }
    assert_eq!(fx.view().sponsor_pot, U128(MAX_SPONSORS as u128));
}

// ── Registration and withdraw ───────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "already registered")]
fn registering_twice_is_refused() {
    let mut fx = Fx::empty();
    fx.register("alice.testnet");
    assert_eq!(fx.c.get_payout(acc("alice.testnet")), Some(acc("alice.testnet")));
    fx.register_with_payout("alice.testnet", "thief.testnet");
}

fn ft_transfer_receipt() -> (AccountId, near_sdk::serde_json::Value, NearToken, Gas) {
    let r = get_created_receipts().into_iter().next().expect("a receipt");
    let MockAction::FunctionCallWeight {
        method_name,
        args,
        attached_deposit,
        prepaid_gas,
        ..
    } = &r.actions[0]
    else {
        panic!("not a function call")
    };
    assert_eq!(method_name, b"ft_transfer");
    (
        r.receiver_id.clone(),
        near_sdk::serde_json::from_slice(args).unwrap(),
        *attached_deposit,
        *prepaid_gas,
    )
}

/// The `ft_transfer` of a withdraw by `who` succeeded: its callback runs, naming `wallet` if the
/// withdraw named one.
fn transfer_succeeded(fx: &mut Fx, who: &str, amount: u128, wallet: Option<&str>) {
    ctx_with_result(fx.now, PromiseResult::Successful(vec![]));
    assert!(fx.c.on_withdraw(acc(who), usdc(), U128(amount), wallet.map(acc)));
}

#[test]
fn withdraw_pays_the_registered_payout_account_with_one_yocto_attached() {
    let mut fx = Fx::empty();
    fx.register_with_payout("alice.testnet", "alice-cold.testnet");
    fx.top_up("alice.testnet", &usdc(), 900);
    fx.as_("alice.testnet");
    let _ = fx.c.withdraw(usdc(), U128(400), None);
    let (receiver, args, deposit, gas) = ft_transfer_receipt();
    assert_eq!(gas, Gas::from_tgas(20));
    assert_eq!(receiver, usdc());
    assert_eq!(args["receiver_id"], "alice-cold.testnet");
    assert_eq!(args["amount"], "400");
    assert_eq!(deposit, NearToken::from_yoctonear(1));
    assert_eq!(fx.bal("alice.testnet"), 500);
}

#[test]
#[should_panic(expected = "balance too small")]
fn a_second_withdraw_beyond_the_balance_is_refused() {
    let mut fx = Fx::empty();
    fx.register("alice.testnet");
    fx.top_up("alice.testnet", &usdc(), 900);
    fx.as_("alice.testnet");
    let _ =
        fx.c.withdraw(usdc(), U128(900), Some(acc("alice-wallet.testnet")));
    assert_eq!(fx.bal("alice.testnet"), 0);
    transfer_succeeded(&mut fx, "alice.testnet", 900, Some("alice-wallet.testnet"));
    fx.as_("alice.testnet");
    let _ = fx.c.withdraw(usdc(), U128(900), None);
}

#[test]
#[should_panic(expected = "account not registered")]
fn a_withdraw_by_an_unregistered_account_is_refused() {
    let mut fx = Fx::empty();
    fx.as_("alice.testnet");
    let _ = fx.c.withdraw(usdc(), U128(1), None);
}

#[test]
fn a_failed_ft_transfer_restores_the_balance() {
    let mut fx = Fx::empty();
    fx.register("alice.testnet");
    fx.top_up("alice.testnet", &usdc(), 900);
    fx.as_("alice.testnet");
    let _ =
        fx.c.withdraw(usdc(), U128(900), Some(acc("alice-wallet.testnet")));
    ctx_with_result(fx.now, PromiseResult::Failed);
    assert!(!fx.c.on_withdraw(
        acc("alice.testnet"),
        usdc(),
        U128(900),
        Some(acc("alice-wallet.testnet"))
    ));
    assert_eq!(fx.bal("alice.testnet"), 900);
    // Review fix: a wallet the transfer never reached does not become the payout, so a typo can
    // be corrected with the next withdraw.
    assert_eq!(fx.c.get_payout(acc("alice.testnet")), Some(acc("alice.testnet")));
    fx.as_("alice.testnet");
    let _ = fx.c.withdraw(usdc(), U128(900), Some(acc("alice-real.testnet")));
    let (_, args, _, _) = ft_transfer_receipt();
    assert_eq!(args["receiver_id"], "alice-real.testnet");
}

#[test]
fn a_successful_ft_transfer_keeps_the_balance_debited() {
    let mut fx = Fx::empty();
    fx.register("alice.testnet");
    fx.top_up("alice.testnet", &usdc(), 900);
    fx.as_("alice.testnet");
    let _ =
        fx.c.withdraw(usdc(), U128(900), Some(acc("alice-wallet.testnet")));
    ctx_with_result(fx.now, PromiseResult::Successful(vec![]));
    assert!(fx.c.on_withdraw(
        acc("alice.testnet"),
        usdc(),
        U128(900),
        Some(acc("alice-wallet.testnet"))
    ));
    assert_eq!(fx.bal("alice.testnet"), 0);
    assert_eq!(
        fx.c.get_payout(acc("alice.testnet")),
        Some(acc("alice-wallet.testnet"))
    );
}

/// Two withdraws in flight each naming a wallet: the first to succeed sets the payout for good.
#[test]
fn the_first_named_wallet_paid_becomes_the_payout_and_a_later_one_does_not_replace_it() {
    let mut fx = Fx::empty();
    fx.register("alice.testnet");
    fx.top_up("alice.testnet", &usdc(), 900);
    for w in ["alice-a.testnet", "alice-b.testnet"] {
        fx.as_("alice.testnet");
        let _ = fx.c.withdraw(usdc(), U128(100), Some(acc(w)));
    }
    for w in ["alice-a.testnet", "alice-b.testnet"] {
        ctx_with_result(fx.now, PromiseResult::Successful(vec![]));
        assert!(fx
            .c
            .on_withdraw(acc("alice.testnet"), usdc(), U128(100), Some(acc(w))));
    }
    assert_eq!(
        fx.c.get_payout(acc("alice.testnet")),
        Some(acc("alice-a.testnet"))
    );
}

#[test]
fn a_token_contract_cannot_be_a_payout() {
    let mut fx = Fx::empty();
    fx.register("alice.testnet");
    fx.top_up("alice.testnet", &usdc(), 900);
    fx.as_("alice.testnet");
    let why = refusal(|| {
        let _ = fx.c.withdraw(usdc(), U128(900), Some(usdc()));
    });
    assert!(why.contains("payout cannot be a token contract"), "{why}");
    let why = refusal(|| fx.register_with_payout("bob.testnet", "usdt.testnet"));
    assert!(why.contains("payout cannot be a token contract"), "{why}");
}

// ── Lobby ───────────────────────────────────────────────────────────────────────────────────

#[test]
fn joining_moves_the_stake_into_a_head_and_players_are_kept_sorted() {
    let fx = Fx::lobby();
    let v = fx.view();
    let ids: Vec<&str> = v.players.iter().map(|p| p.account_id.as_str()).collect();
    assert_eq!(ids, PLAYERS);
    assert_eq!(fx.heads(), vec![STAKE; 3]);
    for p in PLAYERS {
        assert_eq!(fx.bal(p), STAKE);
    }
    assert_eq!(v.phase, Phase::Lobby);
    assert_eq!(v.referee_pk, pk_hex(&referee()));
}

#[test]
#[should_panic(expected = "balance too small")]
fn joining_without_the_stake_is_refused() {
    let mut fx = Fx::lobby();
    fx.register("dave.testnet");
    fx.top_up("dave.testnet", &usdc(), STAKE - 1);
    fx.join("dave.testnet");
}

#[test]
#[should_panic(expected = "already joined")]
fn joining_twice_is_refused() {
    let mut fx = Fx::lobby();
    fx.join("alice.testnet");
}

#[test]
#[should_panic(expected = "account not registered")]
fn joining_unregistered_is_refused() {
    let mut fx = Fx::lobby();
    fx.join("dave.testnet");
}

#[test]
#[should_panic(expected = "match is full")]
fn joining_a_full_lobby_is_refused() {
    let mut fx = Fx::lobby();
    for p in ["dave.testnet", "erin.testnet"] {
        fx.register(p);
        fx.top_up(p, &usdc(), STAKE);
    }
    fx.join("dave.testnet"); // fourth of max 4: fine
    fx.join("erin.testnet");
}

#[test]
#[should_panic(expected = "start deadline passed")]
fn joining_after_the_start_deadline_is_refused() {
    let mut fx = Fx::lobby();
    fx.register("dave.testnet");
    fx.top_up("dave.testnet", &usdc(), STAKE);
    fx.now = T0 + 600_001;
    fx.join("dave.testnet");
}

#[test]
fn leaving_the_lobby_refunds_the_stake() {
    let mut fx = Fx::lobby();
    fx.as_("bob.testnet");
    fx.c.leave_lobby(hex::encode(fx.id));
    assert_eq!(fx.bal("bob.testnet"), 2 * STAKE);
    assert_eq!(fx.view().players.len(), 2);
}

#[test]
#[should_panic(expected = "match already started")]
fn leaving_after_start_is_refused() {
    let mut fx = Fx::running();
    fx.as_("bob.testnet");
    fx.c.leave_lobby(hex::encode(fx.id));
}

#[test]
fn create_match_with_exactly_the_storage_deposit_opens_a_lobby() {
    let mut fx = Fx::empty();
    let id = fx.create(cfg(usdc(), STAKE));
    let v = fx.c.get_match(hex::encode(id)).unwrap();
    assert_eq!(v.host, acc("host.testnet"));
    assert_eq!(v.zone_hash, hex::encode([0xab; 32]));
    assert_eq!(
        fx.c.get_config().match_storage_deposit,
        U128(match_storage_deposit().as_yoctonear())
    );
    // Two matches never share an id.
    assert_ne!(fx.create(cfg(usdc(), STAKE)), id);
}

#[test]
#[should_panic(expected = "attach exactly match_storage_deposit")]
fn create_match_with_a_different_deposit_is_refused() {
    let mut fx = Fx::empty();
    ctx(
        &acc("host.testnet"),
        fx.now,
        match_storage_deposit().saturating_sub(NearToken::from_yoctonear(1)),
    );
    fx.c.create_match(cfg(usdc(), STAKE));
}

#[test]
#[should_panic(expected = "need 3 <= min_players <= max_players <= 12")]
fn create_match_with_too_many_players_is_refused() {
    let mut fx = Fx::empty();
    fx.create(MatchConfig {
        max_players: 13,
        ..cfg(usdc(), STAKE)
    });
}

#[test]
#[should_panic(expected = "token not allowed")]
fn create_match_in_a_token_that_is_not_allowed_is_refused() {
    let mut fx = Fx::empty();
    fx.create(cfg(acc("fake.testnet"), STAKE));
}

// ── Ordering, the verdict chain and signatures ──────────────────────────────────────────────

#[test]
fn verdicts_apply_in_sequence_within_one_call() {
    let mut fx = Fx::locked();
    let body = fx.start_body();
    fx.verdicts(vec![body, hint_of(0, NEAR)]);
    assert_eq!(fx.view().seq, 2);
    assert_eq!(fx.heads(), vec![STAKE - NEAR_PRICE, STAKE, STAKE]);
}

#[test]
#[should_panic(expected = "verdict out of order")]
fn a_verdict_that_skips_a_seq_is_refused() {
    let mut fx = Fx::running();
    let (_, prev) = fx.head();
    let (v, _) = sign(&referee(), fx.id, 3, prev, hint_of(0, NEAR));
    fx.apply(vec![v]);
}

#[test]
#[should_panic(expected = "verdict out of order")]
fn a_replayed_verdict_is_refused() {
    let mut fx = Fx::running();
    let v = fx.next_signed_by(&referee(), hint_of(0, NEAR));
    fx.apply(vec![v.clone()]);
    fx.apply(vec![v]);
}

#[test]
#[should_panic(expected = "bad referee signature")]
fn a_verdict_signed_by_another_key_is_refused() {
    let mut fx = Fx::locked();
    let v = fx.next_signed_by(&key(9), fx.start_body());
    fx.apply(vec![v]);
}

#[test]
#[should_panic(expected = "bad referee signature")]
fn a_verdict_whose_body_was_changed_after_signing_is_refused() {
    let mut fx = Fx::running();
    let mut raw = fx.next_signed_by(&referee(), hint_of(0, NEAR)).0;
    // The amount's low byte sits after match_id(16) seq(4) prev(32) call_id(16) tag(1) from(2)
    // to(2).
    raw[73] ^= 1;
    fx.apply(vec![Base64VecU8(raw)]);
}

#[test]
#[should_panic(expected = "verdict is not a borsh SignedVerdict")]
fn a_verdict_with_trailing_bytes_is_refused() {
    let mut fx = Fx::running();
    let mut raw = fx.next_signed_by(&referee(), hint_of(0, NEAR)).0;
    raw.push(0);
    fx.apply(vec![Base64VecU8(raw)]);
}

#[test]
fn the_verdict_head_starts_at_zeros_and_follows_every_applied_verdict() {
    let mut fx = Fx::locked();
    let head = fx.c.get_verdict_head(hex::encode(fx.id)).unwrap();
    assert_eq!(
        head,
        VerdictHeadView {
            seq: 0,
            digest: hex::encode([0u8; 32])
        }
    );
    let (verdicts, _) = fx.chain(vec![fx.start_body(), hint_of(0, NEAR)]);
    let second = SignedVerdict::try_from_slice(&verdicts[1].0).unwrap();
    fx.apply(verdicts);
    let head = fx.c.get_verdict_head(hex::encode(fx.id)).unwrap();
    assert_eq!(head.seq, 2);
    assert_eq!(head.digest, hex::encode(verdict_digest(&second.payload())));
}

#[test]
#[should_panic(expected = "verdict prev is not the digest of the match's last applied verdict")]
fn a_first_verdict_whose_prev_is_not_zeros_is_refused() {
    let mut fx = Fx::locked();
    let (v, _) = sign(&referee(), fx.id, 1, [1; 32], fx.start_body());
    fx.apply(vec![v]);
}

#[test]
#[should_panic(expected = "verdict prev is not the digest of the match's last applied verdict")]
fn a_verdict_whose_prev_is_not_the_last_applied_digest_is_refused() {
    let mut fx = Fx::running();
    let (seq, mut prev) = fx.head();
    prev[0] ^= 1;
    let (v, _) = sign(&referee(), fx.id, seq + 1, prev, hint_of(0, NEAR));
    fx.apply(vec![v]);
}

/// The panic message of `f`, which must panic.
fn refusal(f: impl FnOnce()) -> String {
    let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("was accepted");
    err.downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| (*s).to_owned()))
        .unwrap_or_default()
}

/// The referee signs two different verdicts for seq 2. Whichever lands first is the chain; the
/// other cannot land, and nothing built on it can either.
#[test]
fn a_forked_verdict_stream_cannot_land() {
    let mut fx = Fx::running();
    let (seq, prev) = fx.head();
    let (a, a_digest) = sign(
        &referee(),
        fx.id,
        seq + 1,
        prev,
        fx.honest().sign(hint_of(0, NEAR)),
    );
    let (b, b_digest) = sign(
        &referee(),
        fx.id,
        seq + 1,
        prev,
        fx.honest().sign(hint_of(1, NEAR)),
    );
    let (b_next, _) = sign(&referee(), fx.id, seq + 2, b_digest, hint_of(2, NEAR));
    fx.apply(vec![a]);
    assert!(refusal(|| fx.apply(vec![b])).contains("verdict out of order"));
    assert!(refusal(|| fx.apply(vec![b_next])).contains("verdict prev is not the digest"));
    // The honest chain continues from the verdict that landed: a second hint in the window.
    let (next, _) = sign(
        &referee(),
        fx.id,
        seq + 2,
        a_digest,
        fx.honest().sign(hint_of(2, NEAR)),
    );
    fx.apply(vec![next]);
    assert_eq!(
        fx.heads(),
        vec![STAKE - NEAR_PRICE, STAKE, STAKE - price(NEAR, 1)]
    );
}

// ── Key rotation ────────────────────────────────────────────────────────────────────────────

fn rotate_to(fx: &mut Fx, k: &SigningKey) {
    ctx(&owner(), fx.now, NearToken::from_yoctonear(1));
    fx.c.set_referee_pk(pk_hex(k));
}

#[test]
fn a_running_match_keeps_the_referee_key_it_was_created_with() {
    let mut fx = Fx::running();
    rotate_to(&mut fx, &key(2));
    assert_eq!(fx.c.get_config().referee_pk, pk_hex(&key(2)));
    fx.verdict(hint_of(0, NEAR));
    assert_eq!(fx.heads()[0], STAKE - NEAR_PRICE);
}

#[test]
#[should_panic(expected = "bad referee signature")]
fn the_rotated_key_is_refused_by_a_match_created_before_rotation() {
    let mut fx = Fx::running();
    rotate_to(&mut fx, &key(2));
    let v = fx.next_signed_by(&key(2), hint_of(0, NEAR));
    fx.apply(vec![v]);
}

#[test]
fn the_rotated_key_is_accepted_by_a_match_created_after_rotation() {
    let mut fx = Fx::lobby();
    rotate_to(&mut fx, &key(2));
    fx.id = fx.create(cfg(usdc(), STAKE));
    for p in PLAYERS {
        fx.join(p);
    }
    fx.lock();
    let v = fx.next_signed_by(&key(2), fx.start_body());
    fx.apply(vec![v]);
    assert_eq!(fx.view().phase, Phase::Running);
    assert_eq!(fx.view().referee_pk, pk_hex(&key(2)));
}

#[test]
#[should_panic(expected = "owner only")]
fn rotation_by_anyone_but_the_owner_is_refused() {
    let mut fx = Fx::empty();
    ctx(&acc("mallory.testnet"), fx.now, NearToken::from_yoctonear(1));
    fx.c.set_referee_pk(pk_hex(&key(2)));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn rotation_without_one_yocto_is_refused() {
    let mut fx = Fx::empty();
    ctx(&owner(), fx.now, NearToken::from_yoctonear(0));
    fx.c.set_referee_pk(pk_hex(&key(2)));
}

// ── Start ───────────────────────────────────────────────────────────────────────────────────

#[test]
fn start_with_the_joined_players_hash_runs_the_match() {
    let fx = Fx::running();
    let v = fx.view();
    assert_eq!(v.phase, Phase::Running);
    assert_eq!(
        v.ring_commit,
        Some(hex::encode(ring_commit(&vrf_sig(&alpha_for(fx.id)))))
    );
    assert_eq!(v.end_ms.unwrap() - v.start_ms.unwrap(), DURATION);
}

#[test]
#[should_panic(expected = "players_hash does not match the joined players")]
fn start_with_a_different_players_hash_is_refused() {
    let mut fx = Fx::locked();
    let Verdict::Start {
        ring_commit,
        start_ms,
        end_ms,
        ..
    } = fx.start_body()
    else {
        unreachable!()
    };
    let ph = players_hash(&["alice.testnet", "bob.testnet", "mallory.testnet"]);
    fx.verdict(Verdict::Start {
        players_hash: ph,
        ring_commit,
        start_ms,
        end_ms,
    });
}

#[test]
#[should_panic(expected = "not enough players to lock")]
fn locking_a_lobby_below_min_players_is_refused() {
    let mut fx = Fx::lobby();
    fx.as_("carol.testnet");
    fx.c.leave_lobby(hex::encode(fx.id));
    fx.lock();
}

#[test]
#[should_panic(expected = "end_ms - start_ms must equal duration_ms")]
fn start_with_a_different_duration_is_refused() {
    let mut fx = Fx::locked();
    let Verdict::Start {
        players_hash,
        ring_commit,
        start_ms,
        ..
    } = fx.start_body()
    else {
        unreachable!()
    };
    fx.verdict(Verdict::Start {
        players_hash,
        ring_commit,
        start_ms,
        end_ms: start_ms + DURATION + 1,
    });
}

#[test]
#[should_panic(expected = "start deadline passed")]
fn start_after_the_deadline_is_refused() {
    let mut fx = Fx::locked();
    fx.now = T0 + 600_001;
    let body = fx.start_body();
    fx.verdict(body);
}

#[test]
#[should_panic(expected = "match already started")]
fn a_second_start_is_refused() {
    let mut fx = Fx::running();
    let body = fx.start_body();
    fx.verdict(body);
}

#[test]
#[should_panic(expected = "match not running")]
fn a_hint_before_start_is_refused() {
    let mut fx = Fx::lobby();
    fx.verdict(hint_of(0, NEAR));
}

// ── Hint, Tag, Forfeit ──────────────────────────────────────────────────────────────────────

#[test]
fn each_hint_kind_moves_its_price_from_the_asker_into_the_pool() {
    let mut fx = Fx::running();
    fx.verdicts(vec![hint_of(0, NEAR), hint_of(0, BEARING), hint_of(1, TREND)]);
    // In one tick, each hint pays for the ones before it: base, 1.25x, 1.5x.
    let (near, bearing, trend) = (price(NEAR, 0), price(BEARING, 1), price(TREND, 2));
    assert_eq!((near, bearing, trend), (20_000, 62_500, 30_000));
    // Nobody's head goes up: whom a hint was about stays secret until End.
    assert_eq!(fx.heads(), vec![STAKE - near - bearing, STAKE - trend, STAKE]);
    assert_eq!(fx.pool(), near + bearing + trend);
}

/// BEARING hints in one tick (5 %, then 25 % dearer each) until the next costs more than player
/// 2's head; returns what they paid.
fn spend_player_2s_head(fx: &mut Fx) -> u128 {
    let mut paid = 0;
    let mut recent = 0;
    while paid + price(BEARING, recent) <= STAKE {
        paid += price(BEARING, recent);
        recent += 1;
    }
    fx.verdicts((0..recent).map(|_| hint_of(2, BEARING)).collect());
    paid
}

#[test]
fn hints_spend_a_head_down_until_the_next_costs_more() {
    let mut fx = Fx::running();
    let paid = spend_player_2s_head(&mut fx);
    assert_eq!(fx.heads(), vec![STAKE, STAKE, STAKE - paid]);
    assert_eq!(fx.pool(), paid);
}

#[test]
fn demand_raises_the_price_up_to_four_times_and_it_falls_back_as_hints_age_out() {
    let mut fx = Fx::running();
    let start = fx.view().start_ms.unwrap();
    // Twelve hints in one tick: the twelfth pays 1 + 11 × 25 % = 3.75x, the thirteenth the cap.
    fx.verdicts((0..13).map(|_| hint_of(0, NEAR)).collect());
    let paid: u128 = (0..13).map(|r| price(NEAR, r)).sum();
    assert_eq!(price(NEAR, 12), 4 * NEAR_PRICE);
    assert_eq!(fx.heads()[0], STAKE - paid);
    // One unit of time before the window closes, all thirteen still count: the cap holds.
    fx.now = start + PRICE_WINDOW_MS - 1;
    fx.verdict(hint_of(1, NEAR));
    assert_eq!(fx.heads()[1], STAKE - 4 * NEAR_PRICE);
    // At exactly 5 minutes the first thirteen age out; only the last one counts.
    fx.now = start + PRICE_WINDOW_MS;
    fx.verdict(hint_of(2, NEAR));
    assert_eq!(fx.heads()[2], STAKE - price(NEAR, 1));
}

/// A Hint with an explicit time.
fn hint_at(from: u16, t_ms: u64) -> Verdict {
    Verdict::Hint {
        from,
        amount: HONEST_PRICE,
        hint_id: 1,
        hint: NEAR,
        t_ms,
    }
}

#[test]
fn hints_in_the_same_tick_share_a_time_and_a_later_one_may_follow() {
    let mut fx = Fx::running();
    let start = fx.view().start_ms.unwrap();
    fx.verdicts(vec![
        hint_at(0, start + 10),
        hint_at(1, start + 10),
        hint_at(2, start + 11),
    ]);
    assert_eq!(fx.pool(), price(NEAR, 0) + price(NEAR, 1) + price(NEAR, 2));
}

#[test]
#[should_panic(expected = "hint t_ms is before the previous hint's")]
fn a_hint_dated_before_the_previous_one_is_refused() {
    let mut fx = Fx::running();
    let start = fx.view().start_ms.unwrap();
    // Backdating would let a referee drop the earlier hint out of the window and charge less.
    fx.verdicts(vec![hint_at(0, start + PRICE_WINDOW_MS), hint_at(1, start)]);
}

#[test]
fn a_hint_dated_outside_the_match_is_refused() {
    for late in [false, true] {
        let mut fx = Fx::running();
        let v = fx.view();
        let t = if late {
            v.end_ms.unwrap() + 1
        } else {
            v.start_ms.unwrap() - 1
        };
        let why = refusal(|| fx.verdict(hint_at(0, t)));
        assert!(why.contains("hint t_ms is outside the match"), "{why}");
    }
}

#[test]
fn hints_at_the_first_and_last_moment_of_the_match_are_accepted() {
    let mut fx = Fx::running();
    let v = fx.view();
    let (start, end) = (v.start_ms.unwrap(), v.end_ms.unwrap());
    fx.now = end;
    fx.verdicts(vec![hint_at(0, start), hint_at(0, end)]);
    assert_eq!(fx.pool(), 2 * NEAR_PRICE);
}

#[test]
#[should_panic(expected = "hint costs more than the payer's head")]
fn a_hint_over_the_payers_head_is_refused() {
    let mut fx = Fx::running();
    spend_player_2s_head(&mut fx);
    fx.verdict(hint_of(2, BEARING));
}

#[test]
#[should_panic(expected = "player is out")]
fn a_hint_by_an_out_player_is_refused() {
    let mut fx = Fx::running();
    let ring = fx.ring();
    fx.verdict(tag(ring[0], ring[1]));
    fx.verdict(hint_of(ring[1], NEAR));
}

/// A running match with `stake`, players alice, bob and carol.
fn running_at_stake(stake: u128) -> Fx {
    let mut fx = Fx::lobby();
    fx.id = fx.create(cfg(usdc(), stake));
    for p in PLAYERS {
        fx.join(p);
    }
    fx.lock();
    let body = fx.start_body();
    fx.verdict(body);
    fx
}

/// The bound that sizes the match's storage deposit holds by rule, not by the referee's grace.
#[test]
fn the_hint_after_max_hints_is_refused() {
    let mut fx = running_at_stake(0);
    let ring = fx.ring();
    for _ in 0..MAX_HINTS / 40 {
        fx.verdicts((0..40).map(|_| free_hint(ring[0])).collect());
    }
    let why = refusal(|| fx.verdict(free_hint(ring[0])));
    assert!(why.contains("MAX_HINTS"), "{why}");
    fx.end();
    assert_eq!(fx.view().settled_as, Some(SettledAs::Payout));
}

fn hint_paying(amount: u128, kind: u8) -> Verdict {
    Verdict::Hint {
        from: 0,
        amount,
        hint_id: 1,
        hint: kind,
        t_ms: HONEST_TIME,
    }
}

/// The referee could charge any amount for a hint; the price is now the contract's rule.
#[test]
#[should_panic(expected = "hint amount is not its price at the match's demand")]
fn a_hint_paying_one_unit_more_than_its_price_is_refused() {
    let mut fx = Fx::running();
    fx.verdict(hint_paying(NEAR_PRICE + 1, NEAR));
}

#[test]
#[should_panic(expected = "hint amount is not its price at the match's demand")]
fn a_hint_paying_one_unit_less_than_its_price_is_refused() {
    let mut fx = Fx::running();
    fx.verdict(hint_paying(BEARING_PRICE - 1, BEARING));
}

#[test]
#[should_panic(expected = "hint amount is not its price at the match's demand")]
fn a_near_hint_at_the_bearing_price_is_refused() {
    let mut fx = Fx::running();
    fx.verdict(hint_paying(BEARING_PRICE, NEAR));
}

#[test]
#[should_panic(expected = "unknown hint kind")]
fn a_hint_of_an_unknown_kind_is_refused() {
    let mut fx = Fx::running();
    fx.verdict(hint_paying(NEAR_PRICE, 3));
}

#[test]
fn a_hint_price_rounds_down() {
    // 2 % of 1 049 is 20.98: the price is 20.
    let mut fx = Fx::lobby();
    fx.id = fx.create(cfg(usdc(), 1_049));
    for p in PLAYERS {
        fx.join(p);
    }
    fx.lock();
    let body = fx.start_body();
    fx.verdicts(vec![body, hint_paying(20, NEAR)]);
    assert_eq!(fx.heads(), vec![1_029, 1_049, 1_049]);
    assert_eq!(fx.pool(), 20);
}

#[test]
fn a_tag_credits_the_target_with_its_hints_then_moves_the_whole_head_to_the_hunter() {
    let mut fx = Fx::running();
    let ring = fx.ring();
    let (h, t, other) = (ring[0], ring[1], ring[2]);
    fx.verdict(hint_of(h, NEAR));
    fx.verdict(tag(h, t));
    let mut want = vec![0; 3];
    want[usize::from(h)] = 2 * STAKE;
    want[usize::from(other)] = STAKE;
    assert_eq!(fx.heads(), want);
    assert_eq!(fx.pool(), 0);
    assert!(fx.view().players[usize::from(t)].out);
}

#[test]
#[should_panic(expected = "credit is more than the hint pool holds")]
fn a_credit_beyond_the_pool_is_refused() {
    let mut fx = Fx::running();
    let ring = fx.ring();
    fx.verdict(hint_of(ring[0], NEAR));
    fx.verdict(Verdict::Tag {
        hunter: ring[0],
        target: ring[1],
        credit: NEAR_PRICE + 1,
    });
}

#[test]
#[should_panic(expected = "player is out")]
fn a_tag_of_an_out_player_is_refused() {
    let mut fx = Fx::running();
    fx.verdict(tag(2, 1));
    fx.verdict(tag(0, 1));
}

#[test]
#[should_panic(expected = "player index out of range")]
fn a_tag_naming_a_player_index_past_the_list_is_refused() {
    let mut fx = Fx::running();
    fx.verdict(tag(0, 3));
}

#[test]
fn a_forfeit_moves_the_head_and_marks_the_player_out() {
    let mut fx = Fx::running();
    fx.verdict(forfeit(0, 2));
    assert_eq!(fx.heads(), vec![0, STAKE, 2 * STAKE]);
    assert!(fx.view().players[0].out);
}

#[test]
#[should_panic(expected = "player is out")]
fn a_forfeit_to_an_out_player_is_refused() {
    let mut fx = Fx::running();
    fx.verdict(forfeit(0, 2));
    fx.verdict(forfeit(1, 0));
}

// ── Checkpoints ─────────────────────────────────────────────────────────────────────────────

/// Puts the clock where the `nth` checkpoint (1-based) is first allowed.
fn at_checkpoint(fx: &mut Fx, nth: u64) {
    fx.now = fx.view().start_ms.unwrap() + nth * CHECKPOINT_SPACING_MS;
}

#[test]
fn every_checkpoint_up_to_the_limit_is_kept_for_the_replay() {
    let mut fx = Fx::running();
    for i in 0..MAX_CHECKPOINTS as u64 {
        at_checkpoint(&mut fx, i + 1);
        fx.verdict(cp(i + 1));
    }
    let roots = fx.c.get_roots(hex::encode(fx.id)).unwrap();
    assert_eq!(roots.checkpoints.len(), MAX_CHECKPOINTS);
    assert_eq!(
        roots.checkpoints[5],
        RootView {
            log_size: 6,
            root: hex::encode(log_root(6))
        }
    );
    assert_eq!(roots.final_root, None);
}

/// The spacing rule is what bounds the list: after the longest match's worth, no amount of
/// waiting past `end_ms` admits one more.
#[test]
#[should_panic(expected = "checkpoint too early")]
fn a_checkpoint_past_the_limit_is_refused_by_the_spacing_rule() {
    let mut fx = Fx::running();
    for i in 0..MAX_CHECKPOINTS as u64 {
        at_checkpoint(&mut fx, i + 1);
        fx.verdict(cp(i + 1));
    }
    fx.now = fx.view().end_ms.unwrap() + VERDICT_GRACE_MS;
    fx.verdict(cp(MAX_CHECKPOINTS as u64 + 1));
}

#[test]
#[should_panic(expected = "checkpoint too early")]
fn a_checkpoint_before_its_spacing_is_refused() {
    let mut fx = Fx::running();
    at_checkpoint(&mut fx, 1);
    fx.now -= 1;
    fx.verdict(cp(1));
}

#[test]
fn checkpoints_at_their_spacing_land_even_in_one_batch() {
    let mut fx = Fx::running();
    at_checkpoint(&mut fx, 3);
    fx.verdicts((1..=3).map(cp).collect());
    assert_eq!(fx.c.get_roots(hex::encode(fx.id)).unwrap().checkpoints.len(), 3);
}

#[test]
#[should_panic(expected = "checkpoint log_size must grow")]
fn a_checkpoint_whose_log_size_does_not_grow_is_refused() {
    let mut fx = Fx::running();
    at_checkpoint(&mut fx, 1);
    fx.verdict(cp(5));
    at_checkpoint(&mut fx, 2);
    fx.verdict(cp(5));
}

#[test]
fn a_checkpoint_whose_log_size_grows_by_one_is_kept() {
    let mut fx = Fx::running();
    at_checkpoint(&mut fx, 1);
    fx.verdict(cp(5));
    at_checkpoint(&mut fx, 2);
    fx.verdict(cp(6));
    assert_eq!(fx.c.get_roots(hex::encode(fx.id)).unwrap().checkpoints.len(), 2);
}

fn end_with_log_size(fx: &mut Fx, log_size: u64) {
    fx.now = fx.view().end_ms.unwrap();
    fx.verdict(end_at(&alpha_for(fx.id), log_size));
}

#[test]
#[should_panic(expected = "End log_size is below the last checkpoint's")]
fn an_end_whose_log_size_is_below_the_last_checkpoint_is_refused() {
    let mut fx = Fx::running();
    at_checkpoint(&mut fx, 1);
    fx.verdict(cp(50));
    end_with_log_size(&mut fx, 49);
}

#[test]
fn an_end_at_the_last_checkpoints_log_size_settles() {
    let mut fx = Fx::running();
    at_checkpoint(&mut fx, 1);
    fx.verdict(cp(50));
    end_with_log_size(&mut fx, 50);
    assert_eq!(fx.view().phase, Phase::Ended);
}

// ── Consistency proofs ──────────────────────────────────────────────────────────────────────

/// A running match whose first checkpoint (at 10 entries) landed, with the clock where a
/// second one may land.
fn with_one_checkpoint() -> Fx {
    let mut fx = Fx::running();
    at_checkpoint(&mut fx, 1);
    fx.verdict(cp(10));
    at_checkpoint(&mut fx, 2);
    fx
}

#[test]
#[should_panic(expected = "no consistency proof for verdict seq 3")]
fn a_checkpoint_without_a_proof_is_refused() {
    let mut fx = with_one_checkpoint();
    let (v, _) = fx.chain(vec![cp(20)]);
    fx.apply(v);
}

#[test]
#[should_panic(expected = "no consistency proof for verdict seq 2")]
fn even_the_first_checkpoint_needs_a_proof() {
    let mut fx = Fx::running();
    at_checkpoint(&mut fx, 1);
    let (v, _) = fx.chain(vec![cp(10)]);
    fx.apply(v);
}

#[test]
#[should_panic(expected = "no consistency proof for verdict seq 3")]
fn an_end_without_a_proof_is_refused() {
    let mut fx = with_one_checkpoint();
    fx.now = fx.view().end_ms.unwrap();
    let (v, _) = fx.chain(vec![fx.end_body()]);
    fx.apply(v);
}

#[test]
#[should_panic(expected = "no consistency proof for verdict seq 3")]
fn a_proof_for_another_seq_is_refused() {
    let mut fx = with_one_checkpoint();
    let (v, _) = fx.chain(vec![cp(20)]);
    fx.apply_proved(v, vec![consistency(4, 10, 20)]);
}

#[test]
#[should_panic(expected = "consistency proof from_size 0 is not the last anchored log size 10")]
fn a_proof_from_the_start_of_the_log_instead_of_the_last_checkpoint_is_refused() {
    let mut fx = with_one_checkpoint();
    let (v, _) = fx.chain(vec![cp(20)]);
    fx.apply_proved(v, vec![consistency(3, 0, 20)]);
}

#[test]
#[should_panic(expected = "consistency proof from_size 9 is not the last anchored log size 10")]
fn a_proof_from_a_size_never_anchored_is_refused() {
    let mut fx = with_one_checkpoint();
    let (v, _) = fx.chain(vec![cp(20)]);
    fx.apply_proved(v, vec![consistency(3, 9, 20)]);
}

#[test]
#[should_panic(expected = "consistency proof does not verify")]
fn a_proof_with_one_hash_changed_is_refused() {
    let mut fx = with_one_checkpoint();
    let (v, mut p) = fx.chain(vec![cp(20)]);
    p[0].path[1].0[0] ^= 1;
    fx.apply_proved(v, p);
}

#[test]
#[should_panic(expected = "consistency proof does not verify")]
fn a_proof_missing_its_last_hash_is_refused() {
    let mut fx = with_one_checkpoint();
    let (v, mut p) = fx.chain(vec![cp(20)]);
    p[0].path.pop();
    fx.apply_proved(v, p);
}

#[test]
#[should_panic(expected = "a consistency proof hash is not 32 bytes")]
fn a_proof_hash_of_the_wrong_length_is_refused() {
    let mut fx = with_one_checkpoint();
    let (v, mut p) = fx.chain(vec![cp(20)]);
    p[0].path[0].0.pop();
    fx.apply_proved(v, p);
}

/// The referee rewrote history: the second checkpoint's log does not start with the 10 entries
/// the first one committed to.
#[test]
#[should_panic(expected = "consistency proof does not verify")]
fn a_checkpoint_over_a_rewritten_log_is_refused() {
    let mut fx = with_one_checkpoint();
    let mut forged = log_leaves(20);
    forged[3] = leaf(&log_entry(1_000));
    let body = Verdict::Checkpoint {
        log_size: 20,
        root: root(&forged),
    };
    let (v, _) = fx.chain(vec![body]);
    let path = consistency_proof(&forged, 10)
        .into_iter()
        .map(|h| Base64VecU8(h.to_vec()))
        .collect();
    fx.apply_proved(
        v,
        vec![ConsistencyArg {
            seq: 3,
            from_size: U64(10),
            path,
        }],
    );
}

#[test]
#[should_panic(expected = "consistency proof does not verify")]
fn an_end_at_the_last_checkpoints_size_with_another_root_is_refused() {
    let mut fx = with_one_checkpoint();
    fx.now = fx.view().end_ms.unwrap();
    let Verdict::End {
        alpha, vrf_signature, ..
    } = end_at(&alpha_for(fx.id), 10)
    else {
        unreachable!()
    };
    fx.verdict(Verdict::End {
        alpha,
        vrf_signature,
        log_size: 10,
        root: log_root(11),
        hint_targets: vec![],
    });
}

#[test]
#[should_panic(expected = "two consistency proofs for one seq")]
fn two_proofs_for_one_seq_are_refused() {
    let mut fx = with_one_checkpoint();
    let (v, p) = fx.chain(vec![cp(20)]);
    fx.apply_proved(v, vec![p[0].clone(), p[0].clone()]);
}

#[test]
#[should_panic(expected = "consistency proof for seq 3 matches no Checkpoint or End in this call")]
fn a_proof_for_a_verdict_that_is_not_an_anchor_is_refused() {
    let mut fx = with_one_checkpoint();
    let (v, _) = fx.chain(vec![hint_of(0, NEAR)]);
    fx.apply_proved(v, vec![consistency(3, 10, 20)]);
}

/// A whole match's worth of checkpoints over a log that grows unevenly (sizes that are and are
/// not powers of two, steps of one and of many), with Hints and Tags between them, proved one
/// by one and in batches, then End.
#[test]
fn valid_proofs_across_a_match_of_many_checkpoints_are_accepted() {
    let mut fx = Fx::running();
    let sizes: Vec<u64> = (1..=60u64).map(|k| k * k / 3 + k).collect();
    let mut nth = 0;
    for chunk in sizes.chunks(7) {
        nth += chunk.len() as u64;
        at_checkpoint(&mut fx, nth);
        let mut bodies = vec![hint_of(0, NEAR)];
        bodies.extend(chunk.iter().map(|&n| cp(n)));
        fx.verdicts(bodies);
    }
    let last = *sizes.last().unwrap();
    end_with_log_size(&mut fx, last + 37);
    let roots = fx.c.get_roots(hex::encode(fx.id)).unwrap();
    assert_eq!(roots.checkpoints.len(), sizes.len());
    for (r, &n) in roots.checkpoints.iter().zip(&sizes) {
        assert_eq!(r.root, hex::encode(log_root(n)));
    }
    assert_eq!(roots.final_root.unwrap().root, hex::encode(log_root(last + 37)));
    assert_eq!(fx.view().phase, Phase::Ended);
}

#[test]
fn an_end_with_no_checkpoint_before_it_is_proved_from_the_empty_log() {
    let mut fx = Fx::running();
    fx.end();
    assert_eq!(
        fx.c.get_roots(hex::encode(fx.id)).unwrap().final_root,
        Some(RootView {
            log_size: 77,
            root: hex::encode(log_root(77))
        })
    );
}

// ── Gas ─────────────────────────────────────────────────────────────────────────────────────

/// Host-function gas of `f` as the mocked VM counts it (SHA-256, ed25519, storage, borsh in and
/// out of the host). The wasm instructions themselves are not metered here; see the README.
fn host_gas(f: impl FnOnce()) -> u64 {
    let before = env::used_gas().as_gas();
    f();
    env::used_gas().as_gas() - before
}

/// A match log near its end is about 15k entries (12 players, an hour of 5 s batches, contacts,
/// ticks). One Checkpoint a minute after the last one, proved against it.
#[test]
fn a_checkpoint_with_a_proof_over_a_fifteen_thousand_entry_log_stays_cheap() {
    let mut fx = Fx::running();
    at_checkpoint(&mut fx, 1);
    fx.verdict(cp(14_750));
    at_checkpoint(&mut fx, 2);
    let leaves = log_leaves(15_013);
    let body = Verdict::Checkpoint {
        log_size: 15_013,
        root: root(&leaves),
    };
    let (v, _) = fx.chain(vec![body]);
    let path: Vec<Base64VecU8> = consistency_proof(&leaves, 14_750)
        .into_iter()
        .map(|h| Base64VecU8(h.to_vec()))
        .collect();
    let hashes = path.len();
    let proof = ConsistencyArg {
        seq: 3,
        from_size: U64(14_750),
        path,
    };
    fx.as_("relay.testnet");
    let with_proof = host_gas(|| fx.c.apply(v, Some(vec![proof])));
    let (hint, _) = fx.chain(vec![hint_of(0, NEAR)]);
    fx.as_("relay.testnet");
    let hint_only = host_gas(|| fx.c.apply(hint, None));
    let entry = Base64VecU8(borsh::to_vec(&log_entry(9_876)).unwrap());
    let audit: Vec<Base64VecU8> = proof_path(&leaves, 9_876);
    let audit_len = audit.len();
    let mut ok = false;
    let inclusion = host_gas(|| {
        ok =
            fx.c.verify_inclusion(hex::encode(fx.id), entry, U64(9_876), U64(15_013), audit);
    });
    assert!(ok);
    let ggas = |g: u64| g / 1_000_000_000;
    println!(
        "host gas: apply(Checkpoint + {hashes}-hash proof) {} Ggas, apply(Hint) {} Ggas, \
         verify_inclusion({audit_len}-hash path) {} Ggas",
        ggas(with_proof),
        ggas(hint_only),
        ggas(inclusion),
    );
    assert!(
        with_proof < 5_000_000_000_000,
        "apply with a proof used {with_proof} gas"
    );
    assert!(
        inclusion < 2_000_000_000_000,
        "verify_inclusion used {inclusion} gas"
    );
}

fn proof_path(leaves: &[Hash], i: usize) -> Vec<Base64VecU8> {
    proof(leaves, i)
        .into_iter()
        .map(|h| Base64VecU8(h.to_vec()))
        .collect()
}

// ── Inclusion proofs (verify_inclusion) ─────────────────────────────────────────────────────

/// Asks the contract whether entry `i` of the stand-in log is at `index` of the root anchored
/// at `size`, with the audit path for entry `i` in a log of `path_size`.
fn included(fx: &Fx, i: u64, index: u64, size: u64, path_size: u64) -> bool {
    let path = proof(&log_leaves(path_size), i as usize)
        .into_iter()
        .map(|h| Base64VecU8(h.to_vec()))
        .collect();
    fx.c.verify_inclusion(
        hex::encode(fx.id),
        Base64VecU8(borsh::to_vec(&log_entry(i)).unwrap()),
        U64(index),
        U64(size),
        path,
    )
}

/// A match with checkpoints at 10 and 21 entries and its final root at 40.
fn ended_with_roots() -> Fx {
    let mut fx = with_one_checkpoint();
    fx.verdict(cp(21));
    end_with_log_size(&mut fx, 40);
    fx
}

#[test]
fn an_entry_proves_in_every_root_anchored_after_it() {
    let fx = ended_with_roots();
    for (i, size) in [(0, 10), (9, 10), (4, 21), (20, 21), (0, 40), (17, 40), (39, 40)] {
        assert!(included(&fx, i, i, size, size), "entry {i} in the root at {size}");
    }
}

#[test]
fn an_entry_does_not_prove_at_another_index() {
    let fx = ended_with_roots();
    assert!(!included(&fx, 5, 6, 21, 21));
}

#[test]
fn an_entry_does_not_prove_in_a_root_anchored_before_it() {
    let fx = ended_with_roots();
    assert!(!included(&fx, 15, 15, 10, 21));
}

#[test]
fn a_size_no_root_was_anchored_at_proves_nothing() {
    let fx = ended_with_roots();
    // 22 entries make a real tree, but the contract holds no root of that size.
    assert!(!included(&fx, 3, 3, 22, 22));
}

#[test]
fn a_path_for_another_tree_size_does_not_prove() {
    let fx = ended_with_roots();
    assert!(!included(&fx, 3, 3, 21, 40));
}

#[test]
fn a_changed_entry_does_not_prove() {
    let fx = ended_with_roots();
    let path: Vec<Base64VecU8> = proof(&log_leaves(21), 4)
        .into_iter()
        .map(|h| Base64VecU8(h.to_vec()))
        .collect();
    let id = hex::encode(fx.id);
    let entry = |e: &LogEntry| Base64VecU8(borsh::to_vec(e).unwrap());
    assert!(fx
        .c
        .verify_inclusion(id.clone(), entry(&log_entry(4)), U64(4), U64(21), path.clone()));
    assert!(!fx
        .c
        .verify_inclusion(id.clone(), entry(&log_entry(5)), U64(4), U64(21), path.clone()));
    // Bytes that are not a LogEntry prove nothing, even with a path that fits their hash.
    let mut junk = borsh::to_vec(&log_entry(4)).unwrap();
    junk.push(0);
    assert!(!fx
        .c
        .verify_inclusion(id.clone(), Base64VecU8(junk), U64(4), U64(21), path.clone()));
    // A path hash of the wrong length.
    let mut short = path;
    short[0].0.pop();
    assert!(!fx
        .c
        .verify_inclusion(id, entry(&log_entry(4)), U64(4), U64(21), short));
}

#[test]
fn an_unknown_match_proves_nothing() {
    let mut fx = ended_with_roots();
    fx.id = [0x55; 16];
    assert!(!included(&fx, 0, 0, 10, 10));
}

// ── End ─────────────────────────────────────────────────────────────────────────────────────

#[test]
fn end_with_the_committed_vrf_reveal_credits_every_survivor_their_head_and_their_hints() {
    let mut fx = Fx::running();
    let ring = fx.ring();
    let (h, t, o) = (ring[0], ring[1], ring[2]);
    at_checkpoint(&mut fx, 1);
    fx.verdict(cp(10));
    // h asks about t, o about h; t's hint money reaches t just before h takes t's head, and h's
    // reaches h at End.
    fx.verdicts(vec![hint_of(h, NEAR), hint_of(o, BEARING), tag(h, t)]);
    let bearing = price(BEARING, 1);
    assert_eq!(fx.pool(), bearing);
    fx.end();
    let v = fx.view();
    assert_eq!(v.phase, Phase::Ended);
    assert_eq!(v.settled_as, Some(SettledAs::Payout));
    assert_eq!(v.violation, None);
    assert_eq!(fx.heads(), vec![0, 0, 0]);
    assert_eq!(fx.pool(), 0);
    let mut want = vec![0; 3];
    want[usize::from(h)] = 2 * STAKE + bearing;
    want[usize::from(o)] = STAKE - bearing;
    assert_eq!(fx.paid(), want);
    for (i, p) in PLAYERS.iter().enumerate() {
        // Each started with 2 stakes and put one in.
        assert_eq!(fx.bal(p), STAKE + want[i]);
    }
    assert_eq!(v.alpha, Some(alpha_for(fx.id)));
    let roots = fx.c.get_roots(hex::encode(fx.id)).unwrap();
    assert_eq!(roots.checkpoints.len(), 1);
    assert_eq!(
        roots.final_root,
        Some(RootView {
            log_size: 77,
            root: hex::encode(log_root(77))
        })
    );
}

#[test]
#[should_panic(expected = "vrf_signature does not match ring_commit")]
fn end_with_a_vrf_signature_other_than_the_committed_one_is_refused() {
    let mut fx = Fx::running();
    let alpha = format!("vrf:43:relay.testnet:{}", hex::encode(fx.id));
    fx.verdict(end_at(&alpha, 1));
}

#[test]
#[should_panic(expected = "bad VRF signature")]
fn end_with_a_committed_signature_that_is_not_from_the_vrf_key_is_refused() {
    let mut fx = Fx::locked();
    let alpha = alpha_for(fx.id);
    let forged = key(9).sign(alpha.as_bytes()).to_bytes();
    let Verdict::Start {
        players_hash,
        start_ms,
        end_ms,
        ..
    } = fx.start_body()
    else {
        unreachable!()
    };
    fx.verdict(Verdict::Start {
        players_hash,
        ring_commit: ring_commit(&forged),
        start_ms,
        end_ms,
    });
    fx.verdict(Verdict::End {
        alpha,
        vrf_signature: forged,
        log_size: 1,
        root: log_root(1),
        hint_targets: vec![],
    });
}

#[test]
#[should_panic(expected = "alpha seed is not this match id")]
fn end_with_a_vrf_drawn_for_another_seed_is_refused() {
    let mut fx = Fx::locked();
    let alpha = "vrf:42:relay.testnet:someotherseed".to_owned();
    let sig = vrf_sig(&alpha);
    let Verdict::Start {
        players_hash,
        start_ms,
        end_ms,
        ..
    } = fx.start_body()
    else {
        unreachable!()
    };
    fx.verdict(Verdict::Start {
        players_hash,
        ring_commit: ring_commit(&sig),
        start_ms,
        end_ms,
    });
    fx.verdict(Verdict::End {
        alpha,
        vrf_signature: sig,
        log_size: 1,
        root: log_root(1),
        hint_targets: vec![],
    });
}

#[test]
#[should_panic(expected = "match not running")]
fn a_verdict_after_end_is_refused() {
    let mut fx = Fx::running();
    fx.end();
    fx.verdict(tag(0, 1));
}

#[test]
fn end_splits_the_sponsor_pot_equally_and_gives_the_remainder_to_the_first_survivors() {
    let mut fx = Fx::locked();
    fx.register("dao.testnet");
    let msg = format!(r#"{{"sponsor":"{}"}}"#, hex::encode(fx.id));
    assert_eq!(fx.transfer(&usdc(), "dao.testnet", 11, &msg), 0);
    let body = fx.start_body();
    fx.verdict(body);
    fx.end();
    // 11 over 3 survivors: 3 each, and the remainder 2 goes to players 0 and 1.
    let paid: Vec<u128> = fx.view().players.iter().map(|p| p.paid.0).collect();
    assert_eq!(paid, vec![STAKE + 4, STAKE + 4, STAKE + 3]);
    assert_eq!(fx.view().sponsor_pot, U128(0));
}

#[test]
fn end_gives_the_pot_only_to_survivors() {
    let mut fx = Fx::locked();
    fx.register("dao.testnet");
    let msg = format!(r#"{{"sponsor":"{}"}}"#, hex::encode(fx.id));
    assert_eq!(fx.transfer(&usdc(), "dao.testnet", 11, &msg), 0);
    let body = fx.start_body();
    fx.verdict(body);
    let hunter = fx.hunter_of(0);
    fx.verdict(tag(hunter, 0));
    fx.end();
    // Survivors are players 1 and 2: 5 each, the remainder 1 to player 1.
    let paid: Vec<u128> = fx.view().players.iter().map(|p| p.paid.0).collect();
    let mut want = vec![0, STAKE + 6, STAKE + 5];
    want[usize::from(hunter)] += STAKE;
    assert_eq!(paid, want);
}

// ── Abort ───────────────────────────────────────────────────────────────────────────────────

/// Nothing that happened during play was checked against the ring, so an abort pays none of it:
/// every stake comes back, hint money with it, and a Tag's transfer does not stand.
#[test]
fn a_running_match_aborted_after_the_referee_timeout_refunds_the_original_stakes() {
    let mut fx = Fx::running();
    fx.verdicts(vec![hint_of(0, BEARING), tag(2, 1)]);
    fx.now += REFEREE_TIMEOUT_MS;
    fx.abort();
    let v = fx.view();
    assert_eq!(v.phase, Phase::Aborted);
    assert_eq!(v.settled_as, Some(SettledAs::RefundedAbort));
    assert_eq!(fx.heads(), vec![0, 0, 0]);
    assert_eq!(fx.pool(), 0);
    assert_eq!(fx.paid(), vec![STAKE; 3]);
    for p in PLAYERS {
        assert_eq!(fx.bal(p), 2 * STAKE);
    }
}

#[test]
#[should_panic(expected = "referee has not timed out")]
fn a_running_match_cannot_be_aborted_before_the_referee_timeout() {
    let mut fx = Fx::running();
    at_checkpoint(&mut fx, 1);
    fx.verdict(cp(1));
    // The clock restarts at every verdict.
    fx.now += REFEREE_TIMEOUT_MS - 1;
    fx.abort();
}

#[test]
fn a_running_match_still_going_past_its_end_by_the_timeout_can_be_aborted() {
    let mut fx = Fx::running();
    let end_ms = fx.view().end_ms.unwrap();
    // The referee keeps checkpointing, so the silence rule never fires.
    while fx.now < end_ms + REFEREE_TIMEOUT_MS {
        fx.now += REFEREE_TIMEOUT_MS / 2;
        let size = fx.anchored() + 1;
        fx.verdict(cp(size));
    }
    fx.abort();
    assert_eq!(fx.view().phase, Phase::Aborted);
    assert_eq!(fx.bal("alice.testnet"), 2 * STAKE);
}

#[test]
#[should_panic(expected = "referee has not timed out")]
fn a_running_match_just_short_of_its_end_plus_the_timeout_cannot_be_aborted() {
    let mut fx = Fx::running();
    let end_ms = fx.view().end_ms.unwrap();
    while fx.now + REFEREE_TIMEOUT_MS / 2 < end_ms + REFEREE_TIMEOUT_MS - 1 {
        fx.now += REFEREE_TIMEOUT_MS / 2;
        let size = fx.anchored() + 1;
        fx.verdict(cp(size));
    }
    fx.now = end_ms + REFEREE_TIMEOUT_MS - 1;
    fx.abort();
}

#[test]
#[should_panic(expected = "payout cannot be this contract")]
fn registering_the_contract_itself_as_payout_is_refused() {
    let mut fx = Fx::empty();
    fx.register_with_payout("alice.testnet", "tail.testnet");
}

#[test]
fn a_running_match_keeps_the_vrf_key_it_was_created_with() {
    let mut fx = Fx::running();
    ctx(&owner(), fx.now, NearToken::from_yoctonear(1));
    fx.c.set_vrf_pk(pk_hex(&key(4)));
    fx.end();
    assert_eq!(fx.view().phase, Phase::Ended);
    assert_eq!(fx.c.get_config().vrf_pk, pk_hex(&key(4)));
}

#[test]
fn a_lobby_aborted_after_its_start_deadline_refunds_stakes_and_sponsors() {
    let mut fx = Fx::lobby();
    fx.register("dao.testnet");
    let msg = format!(r#"{{"sponsor":"{}"}}"#, hex::encode(fx.id));
    assert_eq!(fx.transfer(&usdc(), "dao.testnet", 11, &msg), 0);
    fx.now = T0 + 600_001;
    fx.abort();
    for p in PLAYERS {
        assert_eq!(fx.bal(p), 2 * STAKE);
    }
    assert_eq!(fx.bal("dao.testnet"), 11);
    assert_eq!(fx.view().sponsor_pot, U128(0));
}

#[test]
#[should_panic(expected = "lobby is still open")]
fn a_lobby_cannot_be_aborted_before_its_start_deadline() {
    let mut fx = Fx::lobby();
    fx.now = T0 + 600_000;
    fx.abort();
}

#[test]
#[should_panic(expected = "match already settled")]
fn an_ended_match_cannot_be_aborted() {
    let mut fx = Fx::running();
    fx.end();
    fx.now += REFEREE_TIMEOUT_MS;
    fx.abort();
}

#[test]
#[should_panic(expected = "match already settled")]
fn a_match_cannot_be_aborted_twice() {
    let mut fx = Fx::running();
    fx.now += REFEREE_TIMEOUT_MS;
    fx.abort();
    fx.abort();
}

// ── Golden vectors (packages/protocol/vectors/verdicts.json, written by the TS side) ────────

fn vectors() -> near_sdk::serde_json::Value {
    near_sdk::serde_json::from_str(include_str!("../../../packages/protocol/vectors/verdicts.json")).unwrap()
}
fn vhex<const N: usize>(v: &near_sdk::serde_json::Value) -> [u8; N] {
    parse_hex(v.as_str().unwrap(), "vector")
}
fn vsigned(v: &near_sdk::serde_json::Value, i: usize) -> Base64VecU8 {
    Base64VecU8(hex::decode(v["verdicts"][i]["signed"].as_str().unwrap()).unwrap())
}

/// A running match with the vector's id and referee key, as if its Start (seq 1) had landed.
fn vector_match() -> (Fx, near_sdk::serde_json::Value) {
    let v = vectors();
    let mut fx = Fx::lobby();
    let id: MatchId = vhex(&v["matchId"]);
    let mut m = fx.c.matches.get(&fx.id).unwrap().clone();
    let start = SignedVerdict::try_from_slice(&vsigned(&v, 0).0).unwrap();
    let Verdict::Start {
        ring_commit,
        start_ms,
        end_ms,
        ..
    } = start.body
    else {
        unreachable!()
    };
    m.referee_pk = vhex(&v["refereePk"]);
    m.phase = Phase::Running;
    m.seq = 1;
    m.ring_commit = Some(ring_commit);
    m.start_ms = Some(start_ms);
    m.end_ms = Some(end_ms);
    fx.c.matches.remove(&fx.id);
    fx.c.matches.insert(id, m);
    let ring = fx.c.plays.remove(&fx.id).unwrap();
    fx.c.plays.insert(id, ring);
    fx.c.verdict_heads.remove(&fx.id);
    fx.c.verdict_heads.insert(id, vhex(&v["verdicts"][0]["digest"]));
    fx.id = id;
    // Late enough for the vector's checkpoint (the first) to land.
    fx.now = start_ms + CHECKPOINT_SPACING_MS;
    (fx, v)
}

#[test]
fn the_golden_vector_verdicts_apply_through_the_real_path() {
    let (mut fx, v) = vector_match();
    // seq 2..5: Hint 0→1 20000 (a NEAR hint at 2 % of STAKE), Tag 2 takes 0, Forfeit 1 → 2,
    // Checkpoint. The Checkpoint is the match's first anchor, so its proof from size 0 is empty.
    fx.apply_proved(
        (1..5).map(|i| vsigned(&v, i)).collect(),
        vec![consistency(5, 0, 0)],
    );
    assert_eq!(fx.heads(), vec![0, 0, 3 * STAKE]);
    let head = fx.c.get_verdict_head(hex::encode(fx.id)).unwrap();
    assert_eq!(head.seq, 5);
    assert_eq!(head.digest, v["verdicts"][4]["digest"].as_str().unwrap());
    let roots = fx.c.get_roots(hex::encode(fx.id)).unwrap();
    assert_eq!(roots.checkpoints[0].log_size, 1234);
}

#[test]
#[should_panic(expected = "bad referee signature")]
fn a_golden_vector_verdict_with_one_flipped_signature_bit_is_refused() {
    let (mut fx, v) = vector_match();
    let mut raw = vsigned(&v, 1).0;
    let last = raw.len() - 1;
    raw[last] ^= 0x01;
    fx.apply(vec![Base64VecU8(raw)]);
}

#[test]
#[should_panic(expected = "players_hash does not match the joined players")]
fn the_golden_vector_start_is_refused_for_players_it_does_not_name() {
    let v = vectors();
    let mut fx = Fx::locked();
    let id: MatchId = vhex(&v["matchId"]);
    let mut m = fx.c.matches.get(&fx.id).unwrap().clone();
    m.referee_pk = vhex(&v["refereePk"]);
    fx.c.matches.insert(id, m);
    fx.c.verdict_heads.insert(id, [0; 32]);
    fx.id = id;
    fx.apply(vec![vsigned(&v, 0)]);
}

#[test]
#[should_panic(expected = "alpha seed is not this match id")]
fn the_golden_vector_end_meets_its_ring_commit_but_its_alpha_seed_is_not_the_match_id() {
    // The vector's End reveals the signature its Start committed to (the reveal checks pass); its
    // alpha seed is a placeholder, which the contract refuses.
    let (mut fx, v) = vector_match();
    fx.apply_proved(
        (1..6).map(|i| vsigned(&v, i)).collect(),
        vec![consistency(5, 0, 0)],
    );
}

// ── Storage bound ───────────────────────────────────────────────────────────────────────────

#[test]
fn a_maximal_match_fits_in_the_storage_its_deposit_paid_for() {
    let mut fx = Fx::empty();
    let long = |p: &str| acc(&format!("{p}{}", "x".repeat(64 - p.len())));
    let m = Match {
        host: long("host"),
        token: long("token"),
        stake: u128::MAX,
        duration_ms: MAX_DURATION_MS,
        zone_hash: [1; 32],
        public_replay: true,
        min_players: MIN_PLAYERS,
        max_players: MAX_PLAYERS,
        start_by_ms: u64::MAX,
        created_ms: u64::MAX,
        referee_pk: [2; 32],
        vrf_pk: [3; 32],
        phase: Phase::Ended,
        players: (0..MAX_PLAYERS)
            .map(|i| Player {
                account_id: long(&format!("p{i:02}")),
                head: u128::MAX,
                out: true,
                paid: u128::MAX,
            })
            .collect(),
        sponsors: (0..MAX_SPONSORS)
            .map(|i| Sponsor {
                account_id: long(&format!("s{i}")),
                amount: u128::MAX,
            })
            .collect(),
        invites: (0..MAX_INVITES).map(|i| long(&format!("i{i:02}"))).collect(),
        pot: u128::MAX,
        locked_until_ms: Some(u64::MAX),
        seq: u32::MAX,
        last_verdict_ms: u64::MAX,
        ring_commit: Some([4; 32]),
        start_ms: Some(u64::MAX),
        end_ms: Some(u64::MAX),
        reveal: Some(Reveal {
            alpha: "a".repeat(MAX_ALPHA_LEN),
            vrf_signature: [5; 64],
            final_root: Root {
                log_size: u64::MAX,
                root: [6; 32],
            },
        }),
    };
    let checkpoints = vec![
        Root {
            log_size: u64::MAX,
            root: [7; 32]
        };
        MAX_CHECKPOINTS
    ];
    let hints = (0..MAX_HINTS).map(|_| PlayEvent::Hint {
        from: 0,
        amount: u128::MAX,
        t_ms: u64::MAX,
    });
    let eliminations = (1..MAX_PLAYERS).map(|i| PlayEvent::Tag {
        hunter: 0,
        target: u16::from(i),
        credit: u128::MAX,
    });
    let ring = PlayRecord {
        vrf_sender: long("vrf"),
        events: hints.chain(eliminations).collect(),
        hint_pool: u128::MAX,
        violation: Some(Violation {
            check: tail_protocol::settle::Check::Pool,
            event: Some(u32::MAX),
        }),
        requires: Some(Requires {
            min_matches: u32::MAX,
            min_survived: u32::MAX,
        }),
    };
    let before = env::storage_usage();
    fx.c.matches.insert([9; 16], m);
    fx.c.matches.flush();
    fx.c.checkpoints.insert([9; 16], checkpoints);
    fx.c.checkpoints.flush();
    fx.c.plays.insert([9; 16], ring);
    fx.c.plays.flush();
    fx.c.verdict_heads.insert([9; 16], [8; 32]);
    fx.c.verdict_heads.flush();
    let used = u128::from(env::storage_usage() - before);
    println!("a maximal match stores {used} bytes");
    assert!(used <= MATCH_STORAGE_BYTES, "a maximal match uses {used} bytes");
    // The bound is not wildly loose either: the deposit is for this, not a guess.
    assert!(
        used + 1_000 > MATCH_STORAGE_BYTES,
        "a maximal match uses only {used} bytes"
    );
}

// ── Review regressions: keys, registration storage, lobby lock, invites, deadlines ──────────

fn torsion_encodings() -> Vec<[u8; 32]> {
    curve25519_dalek::constants::EIGHT_TORSION
        .iter()
        .map(|p| p.compress().0)
        .collect()
}

#[test]
fn small_order_mixed_order_and_non_canonical_keys_are_not_strong_keys() {
    for pk in torsion_encodings() {
        assert!(!is_strong_key(&pk), "small-order {}", hex::encode(pk));
    }
    assert!(!is_strong_key(&[0; 32]));
    // y = p + 1, a non-canonical spelling of the identity.
    let mut non_canonical = [0xff; 32];
    non_canonical[0] = 0xee;
    non_canonical[31] = 0x7f;
    assert!(!is_strong_key(&non_canonical));
    let real = CompressedEdwardsY(referee().verifying_key().to_bytes())
        .decompress()
        .unwrap();
    let mixed = (real + curve25519_dalek::constants::EIGHT_TORSION[1])
        .compress()
        .0;
    assert!(!is_strong_key(&mixed), "a real key plus a torsion point");
    assert!(is_strong_key(&referee().verifying_key().to_bytes()));
    assert!(is_strong_key(&key(2).verifying_key().to_bytes()));
}

/// Review regression: with the identity point as referee key, the signature (R = identity,
/// s = 0) verified for every verdict, so anyone could forge a Tag.
#[test]
#[should_panic(expected = "referee_pk is not a valid ed25519 public key")]
fn rotating_to_the_identity_point_as_referee_key_is_refused() {
    let mut fx = Fx::empty();
    let mut identity = [0u8; 32];
    identity[0] = 1;
    ctx(&owner(), fx.now, NearToken::from_yoctonear(1));
    fx.c.set_referee_pk(hex::encode(identity));
}

/// Review regression: the all-zero key also has small order and was forgeable by grinding.
#[test]
#[should_panic(expected = "referee_pk is not a valid ed25519 public key")]
fn rotating_to_the_all_zero_referee_key_is_refused() {
    let mut fx = Fx::empty();
    ctx(&owner(), fx.now, NearToken::from_yoctonear(1));
    fx.c.set_referee_pk(hex::encode([0u8; 32]));
}

#[test]
#[should_panic(expected = "vrf_pk is not a valid ed25519 public key")]
fn deploying_with_a_small_order_vrf_key_is_refused() {
    ctx(&contract(), T0, NearToken::from_yoctonear(0));
    let _ = Tail::new(
        owner(),
        pk_hex(&referee()),
        hex::encode(torsion_encodings()[3]),
        vrf_sender(),
        vec![usdc()],
    );
}

#[test]
fn rotating_the_vrf_key_to_a_real_key_is_accepted() {
    let mut fx = Fx::empty();
    ctx(&owner(), fx.now, NearToken::from_yoctonear(1));
    fx.c.set_vrf_pk(pk_hex(&key(5)));
    assert_eq!(fx.c.get_config().vrf_pk, pk_hex(&key(5)));
}

fn start_at(fx: &Fx, start_ms: u64) -> Verdict {
    let Verdict::Start {
        players_hash,
        ring_commit,
        ..
    } = fx.start_body()
    else {
        unreachable!()
    };
    Verdict::Start {
        players_hash,
        ring_commit,
        start_ms,
        end_ms: start_ms + DURATION,
    }
}

/// Review regression: a Start dated an hour and a quarter in the past was abortable in the
/// block it landed in.
#[test]
#[should_panic(expected = "start_ms is too far from block time")]
fn a_start_dated_long_before_block_time_is_refused() {
    let mut fx = Fx::locked();
    let body = start_at(&fx, fx.now - DURATION - REFEREE_TIMEOUT_MS - 1);
    fx.verdict(body);
}

#[test]
#[should_panic(expected = "start_ms is too far from block time")]
fn a_start_dated_past_the_skew_after_block_time_is_refused() {
    let mut fx = Fx::locked();
    let body = start_at(&fx, fx.now + START_SKEW_MS + 1);
    fx.verdict(body);
}

#[test]
fn a_start_within_the_skew_of_block_time_runs_and_cannot_be_aborted_at_once() {
    let mut fx = Fx::locked();
    let body = start_at(&fx, fx.now - START_SKEW_MS);
    fx.verdict(body);
    assert_eq!(fx.view().phase, Phase::Running);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fx.abort()));
    assert!(r.is_err(), "a fresh match must not be abortable");
}

/// Review regression: a stake-0 lobby took any registered stranger, who could then break the
/// Start the referee had signed.
#[test]
#[should_panic(expected = "not invited")]
fn an_uninvited_account_cannot_join_an_invite_only_lobby() {
    let mut fx = Fx::empty();
    let invites = vec![acc("x1.testnet"), acc("x2.testnet"), acc("x3.testnet")];
    fx.id = fx.create(MatchConfig {
        invites,
        ..cfg(usdc(), 0)
    });
    fx.register("stranger.testnet");
    fx.join("stranger.testnet");
}

#[test]
fn invited_accounts_join_an_invite_only_lobby() {
    let mut fx = Fx::empty();
    let invites = vec![acc("x1.testnet"), acc("x2.testnet"), acc("x3.testnet")];
    fx.id = fx.create(MatchConfig {
        invites,
        ..cfg(usdc(), 0)
    });
    for p in ["x1.testnet", "x2.testnet", "x3.testnet"] {
        fx.register(p);
        fx.join(p);
    }
    assert_eq!(fx.view().players.len(), 3);
}

#[test]
fn the_host_can_reopen_an_invite_only_lobby_to_everyone() {
    let mut fx = Fx::empty();
    fx.id = fx.create(MatchConfig {
        invites: vec![acc("x1.testnet")],
        ..cfg(usdc(), 0)
    });
    fx.as_("host.testnet");
    fx.c.set_invites(hex::encode(fx.id), vec![]);
    fx.register("stranger.testnet");
    fx.join("stranger.testnet");
    assert_eq!(fx.view().invites, Vec::<AccountId>::new());
}

#[test]
#[should_panic(expected = "host only")]
fn only_the_host_can_set_invites() {
    let mut fx = Fx::lobby();
    fx.as_("alice.testnet");
    fx.c.set_invites(hex::encode(fx.id), vec![acc("alice.testnet")]);
}

/// Review regression: a join after the referee signed Start made that Start fail forever.
#[test]
#[should_panic(expected = "lobby is locked")]
fn joining_a_locked_lobby_is_refused() {
    let mut fx = Fx::locked();
    fx.register("dave.testnet");
    fx.top_up("dave.testnet", &usdc(), STAKE);
    fx.join("dave.testnet");
}

/// Review regression: so did a leave.
#[test]
#[should_panic(expected = "lobby is locked")]
fn leaving_a_locked_lobby_is_refused() {
    let mut fx = Fx::locked();
    fx.as_("bob.testnet");
    fx.c.leave_lobby(hex::encode(fx.id));
}

#[test]
fn leaving_after_the_lock_runs_out_refunds_the_stake() {
    let mut fx = Fx::locked();
    fx.now += LOCK_MS;
    fx.as_("bob.testnet");
    fx.c.leave_lobby(hex::encode(fx.id));
    assert_eq!(fx.bal("bob.testnet"), 2 * STAKE);
}

#[test]
fn a_lobby_whose_lock_ran_out_without_a_start_can_be_aborted() {
    let mut fx = Fx::locked();
    fx.now += LOCK_MS;
    fx.abort();
    assert_eq!(fx.view().phase, Phase::Aborted);
    for p in PLAYERS {
        assert_eq!(fx.bal(p), 2 * STAKE);
    }
}

#[test]
#[should_panic(expected = "lobby is still open")]
fn a_locked_lobby_cannot_be_aborted_before_the_lock_runs_out() {
    let mut fx = Fx::locked();
    fx.now += LOCK_MS - 1;
    fx.abort();
}

#[test]
#[should_panic(expected = "lobby is not locked")]
fn start_on_an_unlocked_lobby_is_refused() {
    let mut fx = Fx::lobby();
    let body = fx.start_body();
    fx.verdict(body);
}

#[test]
#[should_panic(expected = "lobby is not locked")]
fn start_after_the_lock_ran_out_is_refused() {
    let mut fx = Fx::locked();
    fx.now += LOCK_MS;
    let body = fx.start_body();
    fx.verdict(body);
}

#[test]
#[should_panic(expected = "host only")]
fn only_the_host_can_lock_the_lobby() {
    let mut fx = Fx::lobby();
    fx.as_("alice.testnet");
    fx.c.lock_lobby(hex::encode(fx.id));
}

#[test]
#[should_panic(expected = "lobby was already locked")]
fn a_lobby_can_be_locked_only_once() {
    let mut fx = Fx::locked();
    fx.now += LOCK_MS;
    fx.lock();
}

#[test]
#[should_panic(expected = "attach exactly registration_deposit")]
fn register_for_without_the_registration_deposit_is_refused() {
    let mut fx = Fx::empty();
    fx.as_("alice.testnet");
    fx.c.register_for(acc("alice.testnet"), acc("alice.testnet"));
}

#[test]
fn a_parent_can_register_its_sub_account() {
    let mut fx = Fx::empty();
    ctx(&acc("relay.testnet"), fx.now, fx.registration_deposit());
    fx.c.register_for(acc("p1.relay.testnet"), acc("p1.relay.testnet"));
    assert_eq!(
        fx.c.get_payout(acc("p1.relay.testnet")),
        Some(acc("p1.relay.testnet"))
    );
    assert_eq!(fx.c.get_balance(acc("p1.relay.testnet"), usdt()), U128(0));
}

#[test]
#[should_panic(expected = "only the account or its parent can register it")]
fn a_stranger_cannot_register_someone_else_with_its_own_payout() {
    let mut fx = Fx::empty();
    ctx(&acc("mallory.testnet"), fx.now, fx.registration_deposit());
    fx.c.register_for(acc("alice.testnet"), acc("mallory.testnet"));
}

#[test]
#[should_panic(expected = "only the account or its parent can register it")]
fn a_grandparent_cannot_register_a_sub_sub_account() {
    let mut fx = Fx::empty();
    ctx(&acc("relay.testnet"), fx.now, fx.registration_deposit());
    fx.c.register_for(acc("a.b.relay.testnet"), acc("a.b.relay.testnet"));
}

#[test]
fn a_maximal_registration_fits_in_what_its_deposit_paid_for() {
    let mut fx = Fx::empty();
    let long = |p: &str| acc(&format!("{p}{}", "x".repeat(64 - p.len())));
    ctx(&long("a"), fx.now, fx.registration_deposit());
    let before = env::storage_usage();
    fx.c.register_for(long("a"), long("b"));
    fx.c.payouts.flush();
    fx.c.balances.flush();
    // The token ids here are short; a 64-character token id adds 52 bytes per balance record.
    let used = u128::from(env::storage_usage() - before) + 2 * (64 - 12);
    let paid = PAYOUT_RECORD_BYTES + 2 * BALANCE_RECORD_BYTES;
    assert!(
        used <= paid,
        "a maximal registration uses {used} bytes, paid {paid}"
    );
    assert!(
        used + 60 > paid,
        "a maximal registration uses only {used} bytes, paid {paid}"
    );
}

/// Review regression: a credit used to create a balance record nobody paid for, and an emptied
/// balance was removed, so a failed-withdraw refund had to allocate storage again (and could
/// fail once the contract's own NEAR ran out, orphaning the tokens).
/// Storage the call `f` adds, measured inside the current context (each `testing_env!`
/// restarts the account's usage counter).
fn storage_delta(c: &mut Tail, f: impl FnOnce(&mut Tail)) -> i64 {
    let before = env::storage_usage();
    f(c);
    c.payouts.flush();
    c.balances.flush();
    c.matches.flush();
    env::storage_usage().cast_signed() - before.cast_signed()
}

#[test]
fn credits_withdraws_and_failed_withdraw_refunds_never_grow_storage() {
    let mut fx = Fx::empty();
    // A payout other than the account itself, so the withdraw does not also set one (that
    // rewrite stays within the 64-character record registration paid for).
    fx.register_with_payout("alice.testnet", "alice-cold.testnet");
    fx.c.payouts.flush();
    fx.c.balances.flush();
    let credit = |amount: u128| {
        let msg = r#"{"credit":"alice.testnet"}"#.to_owned();
        move |c: &mut Tail| assert_eq!(c.ft_on_transfer(acc("minter.testnet"), U128(amount), msg).0, 0)
    };
    ctx(&usdc(), fx.now, NearToken::from_yoctonear(0));
    assert_eq!(storage_delta(&mut fx.c, credit(900)), 0, "credit");
    ctx(&usdt(), fx.now, NearToken::from_yoctonear(0));
    assert_eq!(
        storage_delta(&mut fx.c, credit(1)),
        0,
        "credit in the second token"
    );
    fx.as_("alice.testnet");
    let withdraw = |c: &mut Tail| {
        let _ = c.withdraw(usdc(), U128(900), None);
    };
    assert_eq!(
        storage_delta(&mut fx.c, withdraw),
        0,
        "withdraw that empties the balance"
    );
    ctx_with_result(fx.now, PromiseResult::Failed);
    let refund = |c: &mut Tail| assert!(!c.on_withdraw(acc("alice.testnet"), usdc(), U128(900), None));
    assert_eq!(
        storage_delta(&mut fx.c, refund),
        0,
        "refund of the failed withdraw"
    );
    assert_eq!(fx.bal("alice.testnet"), 900);
}

fn as_with_one_yocto(fx: &Fx, who: &str) {
    ctx(&acc(who), fx.now, NearToken::from_yoctonear(1));
}

#[test]
fn the_payout_account_can_repoint_the_payout_with_one_yocto() {
    let mut fx = Fx::empty();
    fx.register_with_payout("alice.testnet", "alice-cold.testnet");
    as_with_one_yocto(&fx, "alice-cold.testnet");
    fx.c.set_payout(acc("alice.testnet"), acc("alice-new.testnet"));
    assert_eq!(
        fx.c.get_payout(acc("alice.testnet")),
        Some(acc("alice-new.testnet"))
    );
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn the_payout_account_cannot_repoint_the_payout_without_one_yocto() {
    let mut fx = Fx::empty();
    fx.register_with_payout("alice.testnet", "alice-cold.testnet");
    fx.as_("alice-cold.testnet");
    fx.c.set_payout(acc("alice.testnet"), acc("alice-new.testnet"));
}

/// Re-review regression: a parent registered its child with a payout the parent controlled, and
/// the child could never take it back.
#[test]
fn the_account_itself_can_override_a_payout_its_parent_set() {
    let mut fx = Fx::empty();
    ctx(&acc("relay.testnet"), fx.now, fx.registration_deposit());
    fx.c.register_for(acc("victim.relay.testnet"), acc("thief.testnet"));
    as_with_one_yocto(&fx, "victim.relay.testnet");
    fx.c.set_payout(acc("victim.relay.testnet"), acc("victim-wallet.testnet"));
    fx.top_up("victim.relay.testnet", &usdc(), 5);
    fx.as_("victim.relay.testnet");
    let _ = fx.c.withdraw(usdc(), U128(5), None);
    let (_, args, _, _) = ft_transfer_receipt();
    assert_eq!(args["receiver_id"], "victim-wallet.testnet");
}

/// A function-call key cannot attach the 1 yocto, so a stolen player key cannot redirect winnings.
#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn a_player_function_call_key_cannot_repoint_its_payout() {
    let mut fx = Fx::empty();
    fx.register_with_payout("alice.testnet", "alice-cold.testnet");
    fx.as_("alice.testnet");
    fx.c.set_payout(acc("alice.testnet"), acc("thief.testnet"));
}

#[test]
#[should_panic(expected = "only the account or its current payout account can change it")]
fn a_stranger_cannot_repoint_a_payout_even_with_one_yocto() {
    let mut fx = Fx::empty();
    fx.register_with_payout("alice.testnet", "alice-cold.testnet");
    as_with_one_yocto(&fx, "mallory.testnet");
    fx.c.set_payout(acc("alice.testnet"), acc("mallory.testnet"));
}

#[test]
#[should_panic(expected = "account not registered")]
fn repointing_the_payout_of_an_unregistered_account_is_refused() {
    let mut fx = Fx::empty();
    as_with_one_yocto(&fx, "alice.testnet");
    fx.c.set_payout(acc("alice.testnet"), acc("alice-cold.testnet"));
}

#[test]
#[should_panic(expected = "payout cannot be this contract")]
fn repointing_the_payout_to_this_contract_is_refused() {
    let mut fx = Fx::empty();
    fx.register("alice.testnet");
    as_with_one_yocto(&fx, "alice.testnet");
    fx.c.set_payout(acc("alice.testnet"), contract());
}

fn invites(n: usize) -> Vec<AccountId> {
    (0..n).map(|i| acc(&format!("i{i:02}.testnet"))).collect()
}

/// Re-review: the invite cap bounds what `create_match` charged for, so it must hold.
#[test]
#[should_panic(expected = "too many invites")]
fn create_match_with_more_invites_than_seats_is_refused() {
    let mut fx = Fx::empty();
    fx.create(MatchConfig {
        invites: invites(MAX_INVITES + 1),
        ..cfg(usdc(), 0)
    });
}

#[test]
fn create_match_with_one_invite_per_seat_is_accepted() {
    let mut fx = Fx::empty();
    fx.id = fx.create(MatchConfig {
        invites: invites(MAX_INVITES),
        ..cfg(usdc(), 0)
    });
    assert_eq!(fx.view().invites.len(), MAX_INVITES);
}

#[test]
#[should_panic(expected = "too many invites")]
fn set_invites_with_more_invites_than_seats_is_refused() {
    let mut fx = Fx::empty();
    fx.id = fx.create(cfg(usdc(), 0));
    fx.as_("host.testnet");
    fx.c.set_invites(hex::encode(fx.id), invites(MAX_INVITES + 1));
}

#[test]
fn set_invites_with_one_invite_per_seat_is_accepted() {
    let mut fx = Fx::empty();
    fx.id = fx.create(cfg(usdc(), 0));
    fx.as_("host.testnet");
    fx.c.set_invites(hex::encode(fx.id), invites(MAX_INVITES));
    assert_eq!(fx.view().invites.len(), MAX_INVITES);
}

/// A running match whose Start committed to the VRF signature over `alpha`.
fn running_with_alpha(alpha: &str) -> Fx {
    let mut fx = Fx::locked();
    let Verdict::Start {
        players_hash,
        start_ms,
        end_ms,
        ..
    } = fx.start_body()
    else {
        unreachable!()
    };
    fx.verdict(Verdict::Start {
        players_hash,
        ring_commit: ring_commit(&vrf_sig(alpha)),
        start_ms,
        end_ms,
    });
    fx
}

/// A well-formed alpha for `id` padded to `len` bytes with a long request id.
fn long_alpha(id: MatchId, len: usize) -> String {
    let rest = format!(":{}:{}", vrf_sender(), hex::encode(id));
    let alpha = format!("vrf:{}{rest}", "9".repeat(len - 4 - rest.len()));
    assert_eq!(alpha.len(), len);
    alpha
}

/// Re-review: the alpha cap bounds the stored reveal, so it must hold.
#[test]
#[should_panic(expected = "alpha too long")]
fn end_with_an_alpha_one_byte_over_the_limit_is_refused() {
    let id = Fx::locked().id;
    let alpha = long_alpha(id, MAX_ALPHA_LEN + 1);
    let mut fx = running_with_alpha(&alpha);
    fx.verdict(end_at(&alpha, 1));
}

#[test]
fn end_with_an_alpha_exactly_at_the_limit_settles() {
    let id = Fx::locked().id;
    let alpha = long_alpha(id, MAX_ALPHA_LEN);
    let mut fx = running_with_alpha(&alpha);
    fx.now = fx.view().end_ms.unwrap();
    fx.verdict(end_at(&alpha, 1));
    assert_eq!(fx.view().phase, Phase::Ended);
}

/// `y = 3` is on the curve with large order. `p + 3` spells the same point a second way; only
/// the canonical spelling is a key. (No torsion-free point has `y < 19`, so the torsion check
/// would also catch this one; this test pins the canonical check on its own.)
#[test]
fn a_non_canonical_encoding_of_a_large_order_point_is_refused() {
    let mut canonical = [0u8; 32];
    canonical[0] = 3;
    let mut non_canonical = [0xff; 32];
    non_canonical[0] = 0xed + 3; // p = 2^255 - 19 is ed ff … ff 7f in little endian
    non_canonical[31] = 0x7f;
    let point = CompressedEdwardsY(canonical).decompress().unwrap();
    assert!(!point.is_small_order());
    assert_eq!(
        CompressedEdwardsY(non_canonical).decompress(),
        Some(point),
        "same point"
    );
    assert_eq!(canonical_point(&non_canonical), None);
    assert!(!is_strong_key(&non_canonical));
}

#[test]
fn the_canonical_encoding_of_a_large_order_point_decodes() {
    let mut canonical = [0u8; 32];
    canonical[0] = 3;
    assert!(canonical_point(&canonical).is_some_and(|p| !p.is_small_order()));
}

#[test]
#[should_panic(expected = "attach exactly registration_deposit")]
fn register_for_with_one_yocto_more_than_the_registration_deposit_is_refused() {
    let mut fx = Fx::empty();
    let more = fx
        .registration_deposit()
        .saturating_add(NearToken::from_yoctonear(1));
    ctx(&acc("alice.testnet"), fx.now, more);
    fx.c.register_for(acc("alice.testnet"), acc("alice.testnet"));
}

#[test]
fn register_for_with_exactly_the_registration_deposit_is_accepted() {
    let mut fx = Fx::empty();
    ctx(&acc("alice.testnet"), fx.now, fx.registration_deposit());
    fx.c.register_for(acc("alice.testnet"), acc("alice.testnet"));
    assert_eq!(fx.c.get_payout(acc("alice.testnet")), Some(acc("alice.testnet")));
}

fn as_with_gas(fx: &Fx, who: &str, gas: Gas) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(contract())
        .predecessor_account_id(acc(who))
        .signer_account_id(acc(who))
        .block_timestamp(fx.now * 1_000_000)
        .prepaid_gas(gas)
        .build());
}

#[test]
#[should_panic(expected = "withdraw needs at least 50 Tgas")]
fn a_withdraw_with_less_than_fifty_tgas_is_refused() {
    let mut fx = Fx::empty();
    fx.register("alice.testnet");
    fx.top_up("alice.testnet", &usdc(), 900);
    as_with_gas(&fx, "alice.testnet", Gas::from_tgas(49));
    let _ =
        fx.c.withdraw(usdc(), U128(900), Some(acc("alice-wallet.testnet")));
}

#[test]
fn a_withdraw_with_fifty_tgas_gives_the_refund_callback_ten() {
    let mut fx = Fx::empty();
    fx.register("alice.testnet");
    fx.top_up("alice.testnet", &usdc(), 900);
    as_with_gas(&fx, "alice.testnet", WITHDRAW_MIN_GAS);
    let _ =
        fx.c.withdraw(usdc(), U128(900), Some(acc("alice-wallet.testnet")));
    let callback = get_created_receipts()
        .into_iter()
        .nth(1)
        .expect("the callback receipt");
    let MockAction::FunctionCallWeight {
        method_name,
        prepaid_gas,
        ..
    } = &callback.actions[0]
    else {
        panic!("not a function call")
    };
    assert_eq!(method_name, b"on_withdraw");
    assert_eq!(*prepaid_gas, Gas::from_tgas(10));
}

/// Every stored byte outside the contract's own state record, as NEAR counts it.
fn stored_bytes() -> u128 {
    let s = near_sdk::mock::with_mocked_blockchain(near_sdk::MockedBlockchain::take_storage);
    let n = s
        .iter()
        .filter(|(k, _)| k.as_slice() != b"STATE")
        .map(|(k, v)| (k.len() + v.len() + 40) as u128)
        .sum();
    near_sdk::env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
        VMContextBuilder::new().current_account_id(contract()).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        vec![],
        s,
        std::collections::HashMap::default(),
        None,
    ));
    n
}

/// Start, `MAX_HINTS` hints and 11 tags (the first hunter in the ring asks about and takes everyone
/// else: the longest play record), 120 checkpoints and End with a maximal alpha.
fn play_a_maximal_match(fx: &mut Fx, players: &[AccountId]) {
    let alpha = long_alpha(fx.id, MAX_ALPHA_LEN);
    fx.alpha = Some(alpha.clone());
    let ids: Vec<&str> = players.iter().map(|a| a.as_str()).collect();
    let start_ms = fx.now;
    fx.verdict(Verdict::Start {
        players_hash: players_hash(&ids),
        ring_commit: ring_commit(&vrf_sig(&alpha)),
        start_ms,
        end_ms: start_ms + DURATION,
    });
    let order = ring_order(&ids, &vrf_sig(&alpha));
    for _ in 0..MAX_HINTS / 40 {
        fx.verdicts((0..40).map(|_| free_hint(order[0])).collect());
    }
    for &target in &order[1..] {
        fx.verdict(tag(order[0], target));
    }
    for i in 0..MAX_CHECKPOINTS as u64 {
        fx.now = start_ms + (i + 1) * CHECKPOINT_SPACING_MS;
        fx.verdict(cp(i + 1));
    }
    let (end, proofs) = fx.chain(vec![end_at(&alpha, MAX_CHECKPOINTS as u64 + 1)]);
    fx.as_("relay.testnet");
    let gas = host_gas(|| fx.c.apply(end, Some(proofs)));
    // The replay of 240 hints and 11 tags, the ring rebuilt (`ring_order` hashes in wasm, which
    // the mock does not meter), the payout and the 12 dossier entries. The mock counts host
    // functions only (not wasm instructions, not the map writes at the end of the call), so this
    // is a floor; the e2e prints the real receipt gas of End.
    println!(
        "host gas: apply(End of a maximal match) {} Ggas",
        gas / 1_000_000_000
    );
    assert!(gas < 30_000_000_000_000, "End of a maximal match used {gas} gas");
}

/// Re-review port: through the real methods with every id at 64 characters (one token too),
/// registrations with repointed payouts, one full match (invites, sponsors, 11 tags, 120
/// checkpoints, a maximal alpha, End) and one aborted, and withdraws refunded: storage stays within what the
/// deposits paid for.
#[test]
fn storage_never_exceeds_the_deposits_with_maximal_ids() {
    let long = |p: &str| acc(&format!("{p}{}", "x".repeat(64 - p.len())));
    let tok = acc(&"f".repeat(64));
    let _ = deploy();
    ctx(&contract(), T0, NearToken::from_yoctonear(0));
    let c = Tail::new(
        owner(),
        pk_hex(&referee()),
        pk_hex(&vrf()),
        vrf_sender(),
        vec![usdc(), tok.clone()],
    );
    let mut fx = Fx::with(c);
    let mut paid: u128 = 0;
    let players: Vec<AccountId> = (0..MAX_PLAYERS).map(|i| long(&format!("p{i:02}"))).collect();
    let sponsors: Vec<AccountId> = (0..MAX_SPONSORS).map(|i| long(&format!("s{i}"))).collect();
    for a in players.iter().chain(sponsors.iter()) {
        ctx(a, fx.now, fx.registration_deposit());
        fx.c.register_for(a.clone(), long("payout"));
        paid += PAYOUT_RECORD_BYTES + 2 * BALANCE_RECORD_BYTES + DOSSIER_RECORD_BYTES;
        ctx(&long("payout"), fx.now, NearToken::from_yoctonear(1));
        fx.c.set_payout(a.clone(), long("payout2"));
    }
    for round in 0..2 {
        ctx(&long("host"), fx.now, match_storage_deposit());
        let id_hex = fx.c.create_match(MatchConfig {
            max_players: MAX_PLAYERS,
            invites: players.clone(),
            sponsors: sponsors.clone(),
            start_by_ms: fx.now + 3_600_000,
            ..cfg(tok.clone(), 1)
        });
        paid += MATCH_STORAGE_BYTES;
        fx.id = parse_hex(&id_hex, "match_id");
        for p in &players {
            ctx(&tok, fx.now, NearToken::from_yoctonear(0));
            let msg = format!(r#"{{"credit":"{p}"}}"#);
            assert_eq!(fx.c.ft_on_transfer(long("m"), U128(u128::MAX / 64), msg).0, 0);
            ctx(p, fx.now, NearToken::from_yoctonear(0));
            fx.c.join_match(id_hex.clone());
        }
        for s in &sponsors {
            ctx(&tok, fx.now, NearToken::from_yoctonear(0));
            let msg = format!(r#"{{"sponsor":"{id_hex}"}}"#);
            assert_eq!(fx.c.ft_on_transfer(s.clone(), U128(u128::MAX / 64), msg).0, 0);
        }
        ctx(&long("host"), fx.now, NearToken::from_yoctonear(0));
        fx.c.lock_lobby(id_hex.clone());
        if round == 1 {
            fx.now += LOCK_MS;
            fx.abort();
        } else {
            play_a_maximal_match(&mut fx, &players);
            assert_eq!(fx.view().phase, Phase::Ended);
        }
        for p in &players {
            ctx(p, fx.now, NearToken::from_yoctonear(0));
            let b = fx.c.get_balance(p.clone(), tok.clone()).0;
            let _ = fx.c.withdraw(tok.clone(), U128(b), None);
            ctx_with_result(fx.now, PromiseResult::Failed);
            fx.c.on_withdraw(p.clone(), tok.clone(), U128(b), None);
        }
        fx.c.payouts.flush();
        fx.c.balances.flush();
        fx.c.matches.flush();
        fx.c.checkpoints.flush();
        fx.c.plays.flush();
        fx.c.verdict_heads.flush();
        fx.c.dossiers.flush();
        fx.c.dossier_ids.flush();
        let used = stored_bytes();
        assert!(
            used <= paid,
            "round {round}: stored {used} bytes, paid for {paid}"
        );
    }
}

/// Review regression: a lobby with `start_by_ms = u64::MAX` held a sponsor's money forever.
#[test]
#[should_panic(expected = "start_by_ms is more than 7 days out")]
fn a_start_deadline_more_than_seven_days_out_is_refused() {
    let mut fx = Fx::empty();
    fx.create(MatchConfig {
        start_by_ms: u64::MAX,
        ..cfg(usdc(), 0)
    });
}

#[test]
fn a_start_deadline_seven_days_out_is_accepted_and_the_sponsor_can_get_out_after_it() {
    let mut fx = Fx::empty();
    fx.id = fx.create(MatchConfig {
        start_by_ms: T0 + MAX_START_WINDOW_MS,
        ..cfg(usdc(), 0)
    });
    fx.register("dao.testnet");
    let msg = format!(r#"{{"sponsor":"{}"}}"#, hex::encode(fx.id));
    assert_eq!(fx.transfer(&usdc(), "dao.testnet", 5, &msg), 0);
    fx.now = T0 + MAX_START_WINDOW_MS + 1;
    fx.abort();
    assert_eq!(fx.bal("dao.testnet"), 5);
}

fn first_match_id(seed: [u8; 32]) -> MatchId {
    let mut fx = Fx::with(deploy_with_seed(seed));
    fx.create(cfg(usdc(), STAKE))
}

#[test]
fn a_contract_recreated_on_the_same_account_gets_new_match_ids() {
    assert_ne!(first_match_id([1; 32]), first_match_id([2; 32]));
}

#[test]
fn the_match_id_depends_only_on_the_salt_account_and_nonce() {
    assert_eq!(first_match_id([1; 32]), first_match_id([1; 32]));
}

// ── Conservation property over random operation sequences ──────────────────────────────────

/// xorshift64*: deterministic, so a failing seed can be replayed.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn pick<'a, T>(&mut self, v: &'a [T]) -> Option<&'a T> {
        if v.is_empty() {
            None
        } else {
            Some(&v[self.below(v.len() as u64) as usize])
        }
    }
}

struct Model {
    fx: Fx,
    accounts: Vec<String>,
    tokens: Vec<AccountId>,
    matches: Vec<MatchId>,
    /// `sum(heads) + pot` recorded at Start, per match.
    at_start: std::collections::HashMap<MatchId, u128>,
    /// Net tokens held per token: accepted by ft_on_transfer minus paid out by withdraw.
    held: std::collections::HashMap<AccountId, u128>,
    /// Each running match as the honest referee sees it (targets from the committed ring, pending
    /// hints, hint targets), so the model signs the credits and hint targets the replay accepts.
    honest: std::collections::HashMap<MatchId, Honest>,
    /// Matches that got one off-ring Tag: they take only Checkpoints and End from then on, and
    /// End must refund them.
    cheated: std::collections::HashSet<MatchId>,
}

impl Model {
    fn view(&self, id: MatchId) -> MatchView {
        self.fx.c.get_match(hex::encode(id)).unwrap()
    }

    fn check(&self) {
        for (i, token) in self.tokens.iter().enumerate() {
            let balances: u128 = self
                .accounts
                .iter()
                .map(|a| self.fx.c.get_balance(acc(a), token.clone()).0)
                .sum();
            let mut in_matches = 0;
            for id in &self.matches {
                let v = self.view(*id);
                if &v.token != token {
                    continue;
                }
                let live = v.players.iter().map(|p| p.head.0).sum::<u128>() + v.sponsor_pot.0 + v.hint_pool.0;
                in_matches += live;
                match v.phase {
                    Phase::Running => assert_eq!(live, self.at_start[id], "match total moved while running"),
                    Phase::Ended | Phase::Aborted => assert_eq!(live, 0, "settled match still holds money"),
                    Phase::Lobby => {}
                }
                let paid: u128 = v.players.iter().map(|p| p.paid.0).sum();
                let refunded = v.players.iter().all(|p| p.paid == v.stake);
                match v.settled_as {
                    Some(SettledAs::Payout) => {
                        assert!(
                            !self.cheated.contains(id),
                            "a match with an off-ring Tag paid out"
                        );
                        assert_eq!(paid, self.at_start[id], "End paid out a different total");
                    }
                    Some(SettledAs::RefundedRuleViolation) => {
                        assert!(self.cheated.contains(id), "an honest match was refunded");
                        assert!(refunded, "a refund paid something other than the stakes");
                    }
                    Some(SettledAs::RefundedAbort) => {
                        assert!(refunded, "abort paid something other than the stakes");
                    }
                    Some(SettledAs::PayoutUnreplayed) => panic!("every match here has a play record"),
                    None => {}
                }
            }
            let held = self.held.get(token).copied().unwrap_or(0);
            assert_eq!(
                balances + in_matches,
                held,
                "token {i}: balances + matches != received - withdrawn"
            );
        }
    }

    fn as_(&self, who: &str) {
        self.fx.as_(who);
    }

    /// Matches not yet settled, so random operations mostly hit something they can change.
    fn unsettled(&self) -> Vec<MatchId> {
        self.matches
            .iter()
            .copied()
            .filter(|id| matches!(self.view(*id).phase, Phase::Lobby | Phase::Running))
            .collect()
    }

    #[allow(clippy::too_many_lines)] // one arm per operation reads better than a dispatch table
    fn step(&mut self, rng: &mut Rng) {
        self.fx.now += rng.below(5_000);
        let token = rng.pick(&self.tokens).unwrap().clone();
        let who = rng.pick(&self.accounts).unwrap().clone();
        // Weights: verdicts most often, abort rarely (its clock jump expires other lobbies).
        match rng.below(24) {
            0..=3 => {
                let amount = 1 + u128::from(rng.below(3_000_000));
                // A third of transfers carry a bad message and must come back in full.
                let msg = if rng.below(3) == 0 {
                    "nope".to_owned()
                } else {
                    format!(r#"{{"credit":"{who}"}}"#)
                };
                let refunded = self.fx.transfer(&token, "minter.testnet", amount, &msg);
                *self.held.entry(token).or_default() += amount - refunded;
            }
            4 | 5 => {
                let bal = self.fx.c.get_balance(acc(&who), token.clone()).0;
                if bal == 0 {
                    return;
                }
                let amount = 1 + u128::from(rng.next()) % bal;
                // A payout that is the account itself must be given a wallet on the first withdraw.
                let to =
                    (self.fx.c.get_payout(acc(&who)) == Some(acc(&who))).then(|| acc(&format!("w-{who}")));
                self.as_(&who);
                let _ = self.fx.c.withdraw(token.clone(), U128(amount), to.clone());
                *self.held.get_mut(&token).unwrap() -= amount;
                self.check(); // in flight: debited, not yet resolved
                let failed = rng.below(2) == 0;
                ctx_with_result(
                    self.fx.now,
                    if failed {
                        PromiseResult::Failed
                    } else {
                        PromiseResult::Successful(vec![])
                    },
                );
                self.fx.c.on_withdraw(acc(&who), token.clone(), U128(amount), to);
                if failed {
                    *self.held.get_mut(&token).unwrap() += amount;
                }
            }
            6 => {
                let stake = u128::from(rng.below(500_000));
                let max = 3 + rng.below(4) as u8;
                // Short matches too, so some end by the clock and not only by elimination.
                let id = self.fx.create(MatchConfig {
                    max_players: max,
                    duration_ms: 60_000 * (1 + rng.below(30)),
                    start_by_ms: self.fx.now + 1_800_000,
                    ..cfg(token, stake)
                });
                self.matches.push(id);
            }
            7..=11 => {
                let Some(&id) = rng.pick(&self.unsettled()) else {
                    return;
                };
                let v = self.view(id);
                let can_join: Vec<&String> = self
                    .accounts
                    .iter()
                    .filter(|a| {
                        !v.players.iter().any(|p| p.account_id.as_str() == a.as_str())
                            && self.fx.c.get_balance(acc(a), v.token.clone()).0 >= v.stake.0
                    })
                    .collect();
                let Some(who) = rng.pick(&can_join) else { return };
                if v.phase != Phase::Lobby
                    || v.locked_until_ms.is_some()
                    || self.fx.now > v.start_by_ms
                    || v.players.len() >= usize::from(v.max_players)
                {
                    return;
                }
                self.as_(who);
                self.fx.c.join_match(hex::encode(id));
            }
            12 => {
                let Some(&id) = rng.pick(&self.unsettled()) else {
                    return;
                };
                let v = self.view(id);
                let Some(p) = rng.pick(&v.players) else { return };
                if v.phase != Phase::Lobby || v.locked_until_ms.is_some_and(|t| self.fx.now < t) {
                    return;
                }
                self.as_(p.account_id.as_str());
                self.fx.c.leave_lobby(hex::encode(id));
            }
            13 | 14 => {
                let Some(&id) = rng.pick(&self.unsettled()) else {
                    return;
                };
                let v = self.view(id);
                if v.phase != Phase::Lobby {
                    return;
                }
                let amount = 1 + u128::from(rng.below(1_000));
                let msg = format!(r#"{{"sponsor":"{}"}}"#, hex::encode(id));
                // Sometimes the wrong token: it must come back in full.
                let t = if rng.below(4) == 0 { token } else { v.token.clone() };
                // Mostly the named sponsor; anyone else must come back in full.
                let sponsor = if rng.below(4) == 0 {
                    who.as_str()
                } else {
                    "dao.testnet"
                };
                let refunded = self.fx.transfer(&t, sponsor, amount, &msg);
                *self.held.entry(t).or_default() += amount - refunded;
            }
            15..=22 => self.verdict(rng),
            _ => {
                // Half the time only: an abort jumps the clock, which also ends other lobbies.
                if rng.below(2) == 0 {
                    return;
                }
                let Some(&id) = rng.pick(&self.unsettled()) else {
                    return;
                };
                let v = self.view(id);
                match v.phase {
                    Phase::Lobby => {
                        let open_until = v.locked_until_ms.unwrap_or(v.start_by_ms + 1);
                        self.fx.now = self.fx.now.max(open_until);
                    }
                    Phase::Running => self.fx.now = self.fx.now.max(v.last_verdict_ms + REFEREE_TIMEOUT_MS),
                    _ => return,
                }
                self.fx.as_("anyone.testnet");
                self.fx.c.abort(hex::encode(id));
            }
        }
    }

    fn verdict(&mut self, rng: &mut Rng) {
        let Some(&id) = rng.pick(&self.unsettled()) else {
            return;
        };
        let v = self.view(id);
        let live: Vec<u16> = (0..v.players.len() as u16)
            .filter(|&i| !v.players[usize::from(i)].out)
            .collect();
        let body = match v.phase {
            Phase::Lobby => {
                if v.players.len() < usize::from(v.min_players) || self.fx.now > v.start_by_ms {
                    return;
                }
                match v.locked_until_ms {
                    None => {
                        self.fx.as_("host.testnet");
                        self.fx.c.lock_lobby(hex::encode(id));
                        return;
                    }
                    Some(t) if self.fx.now >= t => return,
                    Some(_) => {}
                }
                let ids: Vec<&str> = v.players.iter().map(|p| p.account_id.as_str()).collect();
                let start_ms = self.fx.now;
                Verdict::Start {
                    players_hash: players_hash(&ids),
                    ring_commit: ring_commit(&vrf_sig(&alpha_for(id))),
                    start_ms,
                    end_ms: start_ms + v.duration_ms,
                }
            }
            Phase::Running => {
                let (start_ms, end_ms) = (v.start_ms.unwrap(), v.end_ms.unwrap());
                let now = self.fx.now;
                let in_play = now < end_ms + VERDICT_GRACE_MS;
                let targets = &self.honest[&id].targets;
                let a = *rng.pick(&live).unwrap();
                let others: Vec<u16> = live.iter().copied().filter(|&b| b != a).collect();
                let honest = in_play && !others.is_empty() && !self.cheated.contains(&id);
                match rng.below(10) {
                    0..=3 if honest => {
                        let kind = rng.below(3) as u8;
                        self.fx.id = id;
                        let body = self.fx.honest().sign(Verdict::Hint {
                            from: a,
                            amount: HONEST_PRICE,
                            hint_id: 0,
                            hint: kind,
                            t_ms: HONEST_TIME,
                        });
                        let Verdict::Hint { amount, .. } = body else {
                            unreachable!()
                        };
                        if amount > v.players[usize::from(a)].head.0 {
                            return;
                        }
                        body
                    }
                    4 | 5 if honest => {
                        let target = targets[usize::from(a)].unwrap();
                        // One Tag in five takes someone other than the target: End must refund.
                        let wrong = others.iter().copied().find(|&b| b != target);
                        match wrong {
                            Some(b) if rng.below(5) == 0 => {
                                self.cheated.insert(id);
                                tag(a, b)
                            }
                            _ => tag(a, target),
                        }
                    }
                    6 if honest => forfeit(a, targets.iter().position(|&t| t == Some(a)).unwrap() as u16),
                    7 | 8 => {
                        let kept = self.fx.c.get_roots(hex::encode(id)).unwrap().checkpoints.len() as u64;
                        if (kept + 1) * CHECKPOINT_SPACING_MS > now.min(end_ms).saturating_sub(start_ms) {
                            return;
                        }
                        cp(u64::from(v.seq) + 1)
                    }
                    _ if now >= end_ms || live.len() == 1 => end_at(&alpha_for(id), u64::from(v.seq) + 1),
                    _ => return,
                }
            }
            Phase::Ended | Phase::Aborted => return,
        };
        self.fx.id = id;
        let signed = self
            .honest
            .get_mut(&id)
            .map_or(body.clone(), |h| h.sign(body.clone()));
        self.fx.verdict(body);
        self.track(id, &signed);
    }

    /// Follows an applied verdict in the model: the match total at Start and the honest referee's
    /// view (`Honest::sign` already followed every other verdict).
    fn track(&mut self, id: MatchId, body: &Verdict) {
        if let Verdict::Start { .. } = body {
            let v = self.view(id);
            let total = v.players.iter().map(|p| p.head.0).sum::<u128>() + v.sponsor_pot.0;
            self.at_start.insert(id, total);
            // Bodies reach this model with their price and time already filled in.
            self.honest
                .insert(id, Honest::new(&ring_of(&v, &alpha_for(id)), v.stake.0, 0));
        }
    }
}

#[test]
fn money_is_conserved_over_random_operation_sequences() {
    let accounts: Vec<String> = (0..7)
        .map(|i| format!("p{i}.testnet"))
        .chain(["dao.testnet".to_owned()])
        .collect();
    let mut refunded = 0;
    for seed in 1..=6u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let mut model = Model {
            fx: Fx::empty(),
            accounts: accounts.clone(),
            tokens: vec![usdc(), usdt()],
            matches: Vec::new(),
            at_start: std::collections::HashMap::new(),
            held: std::collections::HashMap::new(),
            honest: std::collections::HashMap::new(),
            cheated: std::collections::HashSet::new(),
        };
        for a in &accounts {
            model.fx.register(a);
        }
        for _ in 0..800 {
            model.step(&mut rng);
            model.check();
        }
        let ended = model
            .matches
            .iter()
            .filter(|id| model.view(**id).phase == Phase::Ended)
            .count();
        let aborted = model
            .matches
            .iter()
            .filter(|id| model.view(**id).phase == Phase::Aborted)
            .count();
        assert!(
            ended > 0 && aborted > 0,
            "seed {seed}: the run never ended ({ended}) or aborted ({aborted}) a match"
        );
        refunded += model
            .matches
            .iter()
            .filter(|id| model.view(**id).settled_as == Some(SettledAs::RefundedRuleViolation))
            .count();
    }
    assert!(refunded > 0, "no run refunded a match for an off-ring Tag");
}

// ── Hardening: payout through withdraw, config, VRF alpha, timing, End replay, migration ─────

/// Audit D2: the relay registers a player with itself as payout, and the player account holds only
/// a function-call key, so tokens paid there were stranded.
#[test]
#[should_panic(expected = "the payout account is this account itself; pass `to`")]
fn a_withdraw_to_a_self_payout_without_to_is_refused() {
    let mut fx = Fx::empty();
    fx.register("alice.testnet");
    fx.top_up("alice.testnet", &usdc(), 900);
    fx.as_("alice.testnet");
    let _ = fx.c.withdraw(usdc(), U128(900), None);
}

#[test]
fn a_withdraw_with_to_names_the_payout_for_good_and_pays_it() {
    let mut fx = Fx::empty();
    fx.register("alice.testnet");
    fx.top_up("alice.testnet", &usdc(), 900);
    fx.as_("alice.testnet");
    let _ =
        fx.c.withdraw(usdc(), U128(400), Some(acc("alice-wallet.testnet")));
    let (_, args, _, _) = ft_transfer_receipt();
    assert_eq!(args["receiver_id"], "alice-wallet.testnet");
    // Saved once the transfer to it went through.
    assert_eq!(fx.c.get_payout(acc("alice.testnet")), Some(acc("alice.testnet")));
    transfer_succeeded(&mut fx, "alice.testnet", 400, Some("alice-wallet.testnet"));
    assert_eq!(
        fx.c.get_payout(acc("alice.testnet")),
        Some(acc("alice-wallet.testnet"))
    );
    // From now on `to` may be left out and the wallet is paid.
    fx.as_("alice.testnet");
    let _ = fx.c.withdraw(usdc(), U128(500), None);
    let (_, args, _, _) = ft_transfer_receipt();
    assert_eq!(args["receiver_id"], "alice-wallet.testnet");
    assert_eq!(fx.bal("alice.testnet"), 0);
}

#[test]
#[should_panic(expected = "`to` must be absent or the payout account")]
fn a_withdraw_cannot_name_a_second_wallet_once_the_payout_is_set() {
    let mut fx = Fx::empty();
    fx.register("alice.testnet");
    fx.top_up("alice.testnet", &usdc(), 900);
    fx.as_("alice.testnet");
    let _ =
        fx.c.withdraw(usdc(), U128(400), Some(acc("alice-wallet.testnet")));
    transfer_succeeded(&mut fx, "alice.testnet", 400, Some("alice-wallet.testnet"));
    fx.as_("alice.testnet");
    let _ = fx.c.withdraw(usdc(), U128(1), Some(acc("thief.testnet")));
}

#[test]
fn a_withdraw_naming_the_payout_it_already_has_is_accepted() {
    let mut fx = Fx::empty();
    fx.register_with_payout("alice.testnet", "alice-cold.testnet");
    fx.top_up("alice.testnet", &usdc(), 900);
    fx.as_("alice.testnet");
    let _ = fx.c.withdraw(usdc(), U128(900), Some(acc("alice-cold.testnet")));
    let (_, args, _, _) = ft_transfer_receipt();
    assert_eq!(args["receiver_id"], "alice-cold.testnet");
}

#[test]
#[should_panic(expected = "`to` must be absent or the payout account")]
fn a_withdraw_naming_another_account_than_a_set_payout_is_refused() {
    let mut fx = Fx::empty();
    fx.register_with_payout("alice.testnet", "alice-cold.testnet");
    fx.top_up("alice.testnet", &usdc(), 900);
    fx.as_("alice.testnet");
    let _ = fx.c.withdraw(usdc(), U128(900), Some(acc("thief.testnet")));
}

#[test]
#[should_panic(expected = "`to` must be another account")]
fn a_withdraw_naming_the_caller_itself_as_to_is_refused() {
    let mut fx = Fx::empty();
    fx.register("alice.testnet");
    fx.top_up("alice.testnet", &usdc(), 900);
    fx.as_("alice.testnet");
    let _ = fx.c.withdraw(usdc(), U128(900), Some(acc("alice.testnet")));
}

#[test]
#[should_panic(expected = "payout cannot be this contract")]
fn a_withdraw_naming_this_contract_as_to_is_refused() {
    let mut fx = Fx::empty();
    fx.register("alice.testnet");
    fx.top_up("alice.testnet", &usdc(), 900);
    fx.as_("alice.testnet");
    let _ = fx.c.withdraw(usdc(), U128(900), Some(contract()));
}

#[test]
fn the_wallet_a_withdraw_named_can_repoint_the_payout() {
    let mut fx = Fx::empty();
    fx.register("alice.testnet");
    fx.top_up("alice.testnet", &usdc(), 900);
    fx.as_("alice.testnet");
    let _ =
        fx.c.withdraw(usdc(), U128(900), Some(acc("alice-wallet.testnet")));
    transfer_succeeded(&mut fx, "alice.testnet", 900, Some("alice-wallet.testnet"));
    as_with_one_yocto(&fx, "alice-wallet.testnet");
    fx.c.set_payout(acc("alice.testnet"), acc("alice-new.testnet"));
    assert_eq!(
        fx.c.get_payout(acc("alice.testnet")),
        Some(acc("alice-new.testnet"))
    );
}

/// The payout a withdraw names overwrites the record registration paid for at 64 characters.
#[test]
fn naming_a_maximal_payout_through_withdraw_stays_within_the_registration() {
    let mut fx = Fx::empty();
    let long = |p: &str| acc(&format!("{p}{}", "x".repeat(64 - p.len())));
    ctx(&long("a"), fx.now, fx.registration_deposit());
    let before = env::storage_usage();
    fx.c.register_for(long("a"), long("a"));
    fx.top_up(long("a").as_str(), &usdc(), 5);
    ctx(&long("a"), fx.now, NearToken::from_yoctonear(0));
    let _ = fx.c.withdraw(usdc(), U128(5), Some(long("b")));
    ctx_with_result(fx.now, PromiseResult::Successful(vec![]));
    assert!(fx.c.on_withdraw(long("a"), usdc(), U128(5), Some(long("b"))));
    assert_eq!(fx.c.get_payout(long("a")), Some(long("b")));
    fx.c.payouts.flush();
    fx.c.balances.flush();
    let used = u128::from(env::storage_usage() - before) + 2 * (64 - 12);
    assert!(
        used <= PAYOUT_RECORD_BYTES + 2 * BALANCE_RECORD_BYTES,
        "uses {used} bytes"
    );
}

/// Audit D1: clients hard-coded the withdraw gas.
#[test]
fn get_config_reports_the_withdraw_gas_the_vrf_sender_and_the_timing_rules() {
    let fx = Fx::empty();
    let c = fx.c.get_config();
    assert_eq!(c.withdraw_min_gas, 50);
    assert_eq!(Gas::from_tgas(c.withdraw_min_gas), WITHDRAW_MIN_GAS);
    assert_eq!(c.vrf_sender, vrf_sender());
    assert_eq!(c.verdict_grace_ms, VERDICT_GRACE_MS);
    assert_eq!(c.checkpoint_spacing_ms, CHECKPOINT_MS / 2);
    assert_eq!(c.max_checkpoints, 120);
}

/// A running match whose Start committed to the VRF signature over `alpha`, at its end.
fn ending_with_alpha(alpha: &str) -> Fx {
    let mut fx = running_with_alpha(alpha);
    fx.now = fx.view().end_ms.unwrap();
    fx
}

fn end_with_alpha(fx: &mut Fx, alpha: &str) {
    fx.verdict(end_at(alpha, 1));
}

/// Audit D4: only the last ':' field of the alpha was checked.
#[test]
#[should_panic(expected = "alpha sender is not the pinned vrf_sender")]
fn end_with_a_vrf_drawn_by_another_sender_is_refused() {
    let id = Fx::locked().id;
    let alpha = format!("vrf:42:mallory.testnet:{}", hex::encode(id));
    let mut fx = ending_with_alpha(&alpha);
    end_with_alpha(&mut fx, &alpha);
}

#[test]
#[should_panic(expected = "alpha must start with vrf:")]
fn end_with_an_alpha_without_the_vrf_prefix_is_refused() {
    let id = Fx::locked().id;
    let alpha = format!("rng:42:relay.testnet:{}", hex::encode(id));
    let mut fx = ending_with_alpha(&alpha);
    end_with_alpha(&mut fx, &alpha);
}

#[test]
#[should_panic(expected = "alpha must be vrf:{request_id}:{sender}:{seed}")]
fn end_with_an_alpha_of_three_fields_is_refused() {
    let id = Fx::locked().id;
    let alpha = format!("vrf:relay.testnet:{}", hex::encode(id));
    let mut fx = ending_with_alpha(&alpha);
    end_with_alpha(&mut fx, &alpha);
}

#[test]
#[should_panic(expected = "alpha must be vrf:{request_id}:{sender}:{seed}")]
fn end_with_an_alpha_of_five_fields_is_refused() {
    let id = Fx::locked().id;
    let alpha = format!("vrf:42:x:relay.testnet:{}", hex::encode(id));
    let mut fx = ending_with_alpha(&alpha);
    end_with_alpha(&mut fx, &alpha);
}

#[test]
#[should_panic(expected = "alpha has no request id")]
fn end_with_an_alpha_without_a_request_id_is_refused() {
    let id = Fx::locked().id;
    let alpha = format!("vrf::relay.testnet:{}", hex::encode(id));
    let mut fx = ending_with_alpha(&alpha);
    end_with_alpha(&mut fx, &alpha);
}

#[test]
#[should_panic(expected = "alpha seed is not this match id")]
fn end_with_an_uppercase_seed_is_refused() {
    let id = Fx::locked().id;
    let alpha = format!("vrf:42:relay.testnet:{}", hex::encode_upper(id));
    let mut fx = ending_with_alpha(&alpha);
    end_with_alpha(&mut fx, &alpha);
}

#[test]
fn end_with_a_uuid_request_id_from_the_pinned_sender_settles() {
    let id = Fx::locked().id;
    let alpha = format!(
        "vrf:0a1b2c3d-0000-4000-8000-000000000001:relay.testnet:{}",
        hex::encode(id)
    );
    let mut fx = ending_with_alpha(&alpha);
    end_with_alpha(&mut fx, &alpha);
    assert_eq!(fx.view().phase, Phase::Ended);
}

#[test]
fn a_match_keeps_the_vrf_sender_it_was_created_with() {
    let mut fx = Fx::running();
    ctx(&owner(), fx.now, NearToken::from_yoctonear(1));
    fx.c.set_vrf_sender(acc("new-referee.testnet"));
    assert_eq!(fx.c.get_config().vrf_sender, acc("new-referee.testnet"));
    assert_eq!(fx.view().vrf_sender, Some(vrf_sender()));
    fx.end();
    assert_eq!(fx.view().phase, Phase::Ended);
}

#[test]
#[should_panic(expected = "alpha sender is not the pinned vrf_sender")]
fn a_match_created_after_a_vrf_sender_rotation_needs_the_new_sender() {
    let mut fx = Fx::lobby();
    ctx(&owner(), fx.now, NearToken::from_yoctonear(1));
    fx.c.set_vrf_sender(acc("new-referee.testnet"));
    fx.id = fx.create(cfg(usdc(), 0));
    for p in PLAYERS {
        fx.join(p);
    }
    fx.lock();
    let body = fx.start_body();
    fx.verdict(body);
    fx.end();
}

#[test]
#[should_panic(expected = "owner only")]
fn rotating_the_vrf_sender_by_anyone_but_the_owner_is_refused() {
    let mut fx = Fx::empty();
    ctx(&acc("mallory.testnet"), fx.now, NearToken::from_yoctonear(1));
    fx.c.set_vrf_sender(acc("mallory.testnet"));
}

// Timing.

fn hint() -> Verdict {
    hint_of(0, NEAR)
}

#[test]
fn a_hint_tag_and_forfeit_land_up_to_the_grace_after_end() {
    let mut fx = Fx::running();
    fx.now = fx.view().end_ms.unwrap() + VERDICT_GRACE_MS - 1;
    fx.verdict(hint());
    let ring = fx.ring();
    fx.verdict(tag(ring[0], ring[1]));
    fx.verdict(forfeit(ring[2], ring[0]));
    assert_eq!(fx.view().players.iter().filter(|p| !p.out).count(), 1);
}

#[test]
#[should_panic(expected = "the match is overdue: no heads move once it can be aborted")]
fn a_hint_after_the_grace_is_refused() {
    let mut fx = Fx::running();
    fx.now = fx.view().end_ms.unwrap() + VERDICT_GRACE_MS;
    fx.verdict(hint());
}

#[test]
#[should_panic(expected = "the match is overdue: no heads move once it can be aborted")]
fn a_tag_after_the_grace_is_refused() {
    let mut fx = Fx::running();
    fx.now = fx.view().end_ms.unwrap() + VERDICT_GRACE_MS;
    let ring = fx.ring();
    fx.verdict(tag(ring[0], ring[1]));
}

#[test]
#[should_panic(expected = "the match is overdue: no heads move once it can be aborted")]
fn a_forfeit_after_the_grace_is_refused() {
    let mut fx = Fx::running();
    fx.now = fx.view().end_ms.unwrap() + VERDICT_GRACE_MS;
    let ring = fx.ring();
    fx.verdict(forfeit(ring[1], ring[0]));
}

#[test]
#[should_panic(expected = "End before end_ms needs exactly one survivor")]
fn an_early_end_with_two_survivors_is_refused() {
    let mut fx = Fx::running();
    let ring = fx.ring();
    fx.verdict(tag(ring[0], ring[1]));
    fx.now = fx.view().end_ms.unwrap() - 1;
    let body = fx.end_body();
    fx.verdict(body);
}

#[test]
fn an_early_end_with_one_survivor_settles_and_pays_it_everything() {
    let mut fx = Fx::running();
    let ring = fx.ring();
    // The winner of the first tag inherits the loser's target and takes it too.
    fx.verdict(tag(ring[0], ring[1]));
    fx.verdict(tag(ring[0], ring[2]));
    let body = fx.end_body();
    fx.verdict(body);
    let v = fx.view();
    assert_eq!(v.phase, Phase::Ended);
    assert_eq!(v.players[usize::from(ring[0])].paid, U128(3 * STAKE));
}

// The replay at End, and the refund when it fails.

/// A match refunded because its End replay failed at `violation`: phase Ended, every stake and the
/// sponsor back, nothing left in the match.
fn assert_refunded(fx: &Fx, violation: &str) {
    let v = fx.view();
    assert_eq!(v.phase, Phase::Ended);
    assert_eq!(v.settled_as, Some(SettledAs::RefundedRuleViolation));
    assert_eq!(v.violation.as_deref(), Some(violation));
    assert_eq!(fx.heads(), vec![0; v.players.len()]);
    assert_eq!(fx.pool(), 0);
    assert_eq!(v.sponsor_pot, U128(0));
    assert_eq!(fx.paid(), vec![STAKE; v.players.len()]);
    for p in &v.players {
        // Each started with 2 stakes and put one in.
        assert_eq!(fx.bal(p.account_id.as_str()), 2 * STAKE);
    }
}

/// End with these hint targets instead of the honest ones.
fn end_naming(fx: &mut Fx, hint_targets: Vec<u16>) {
    fx.now = fx.now.max(fx.view().end_ms.unwrap());
    let Verdict::End {
        alpha,
        vrf_signature,
        log_size,
        root,
        ..
    } = fx.end_body()
    else {
        unreachable!()
    };
    fx.verdict(Verdict::End {
        alpha,
        vrf_signature,
        log_size,
        root,
        hint_targets,
    });
}

/// The referee could tag anyone: the contract only checked that both players were in. The Tag
/// applies during play (the ring is secret then); End's replay catches it and nobody keeps it.
#[test]
fn a_match_whose_tag_does_not_follow_the_ring_is_refunded_at_end() {
    let mut fx = Fx::locked();
    fx.register("dao.testnet");
    let msg = format!(r#"{{"sponsor":"{}"}}"#, hex::encode(fx.id));
    assert_eq!(fx.transfer(&usdc(), "dao.testnet", 11, &msg), 0);
    let body = fx.start_body();
    fx.verdict(body);
    let ring = fx.ring();
    // ring[0] hunts ring[1], not ring[2].
    fx.verdict(tag(ring[0], ring[2]));
    fx.end();
    assert_refunded(&fx, "event 0: a Tag did not follow the ring");
    assert_eq!(fx.bal("dao.testnet"), 11);
    let logs = near_sdk::test_utils::get_logs();
    let event = logs
        .iter()
        .find(|l| l.starts_with(r#"EVENT_JSON:{"standard":"tail""#))
        .expect("a refund event");
    assert!(event.contains(r#""event":"match_refunded""#), "{event}");
    assert!(
        event.contains(r#""settled_as":"refunded_rule_violation""#),
        "{event}"
    );
    // Settled for good: no abort, no further verdict.
    fx.now += REFEREE_TIMEOUT_MS;
    let why = refusal(|| fx.abort());
    assert!(why.contains("match already settled"), "{why}");
}

/// Without End there is no replay, so the off-ring transfer cannot stand through abort either.
#[test]
fn an_off_ring_tag_whose_end_never_comes_is_refunded_by_abort() {
    let mut fx = Fx::running();
    let ring = fx.ring();
    fx.verdict(tag(ring[0], ring[2]));
    fx.now = fx.view().end_ms.unwrap() + REFEREE_TIMEOUT_MS;
    fx.abort();
    assert_eq!(fx.view().phase, Phase::Aborted);
    for p in PLAYERS {
        assert_eq!(fx.bal(p), 2 * STAKE);
    }
}

/// The hint target the referee reveals at End must be the asker's target when the hint was paid.
#[test]
fn a_hint_whose_revealed_target_is_not_the_askers_target_is_refunded_at_end() {
    let mut fx = Fx::running();
    let ring = fx.ring();
    fx.verdict(hint_of(ring[0], NEAR));
    end_naming(&mut fx, vec![ring[2]]);
    assert_refunded(&fx, "event 0: a hint was not about its asker's target");
}

#[test]
fn an_end_naming_fewer_hint_targets_than_hints_is_refunded() {
    let mut fx = Fx::running();
    let ring = fx.ring();
    fx.verdicts(vec![hint_of(ring[0], NEAR), hint_of(ring[1], NEAR)]);
    end_naming(&mut fx, vec![ring[1]]);
    assert_refunded(
        &fx,
        "End names a different number of hint targets than there were hints",
    );
}

/// A credit below what the target's hints paid in fits the pool, so it applies during play; the
/// replay finds it short.
#[test]
fn a_tag_whose_credit_is_not_the_targets_pending_hints_is_refunded_at_end() {
    let mut fx = Fx::running();
    let ring = fx.ring();
    fx.verdict(hint_of(ring[0], NEAR));
    fx.verdict(Verdict::Tag {
        hunter: ring[0],
        target: ring[1],
        credit: NEAR_PRICE - 1,
    });
    fx.end();
    assert_refunded(&fx, "event 1: a credit is not the hints paid onto its target");
}

/// The contract's own pool follows the same credits the replay checks, so it cannot drift; this
/// pins that the End check is wired, by corrupting the stored pool.
#[test]
fn a_pool_that_does_not_end_at_zero_is_refunded() {
    let mut fx = Fx::running();
    let ring = fx.ring();
    fx.verdict(hint_of(ring[0], NEAR));
    fx.c.plays.get_mut(&fx.id).unwrap().hint_pool += 1;
    fx.end();
    assert_refunded(&fx, "the hint pool does not end at 0");
}

/// A running four-player match (alice, bob, carol, dave).
fn running_with_four() -> Fx {
    let mut fx = Fx::lobby();
    fx.register("dave.testnet");
    fx.top_up("dave.testnet", &usdc(), 2 * STAKE);
    fx.join("dave.testnet");
    fx.lock();
    let ids: Vec<String> = fx
        .view()
        .players
        .iter()
        .map(|p| p.account_id.to_string())
        .collect();
    let Verdict::Start {
        ring_commit,
        start_ms,
        end_ms,
        ..
    } = fx.start_body()
    else {
        unreachable!()
    };
    fx.verdict(Verdict::Start {
        players_hash: players_hash(&ids),
        ring_commit,
        start_ms,
        end_ms,
    });
    fx
}

#[test]
fn each_winner_hunts_the_losers_target_next_and_the_last_one_standing_settles() {
    let mut fx = running_with_four();
    let ring = fx.ring();
    for (hunter, target) in [(0, 1), (0, 2), (3, 0)] {
        fx.verdict(tag(ring[hunter], ring[target]));
    }
    let body = fx.end_body();
    fx.verdict(body);
    let v = fx.view();
    assert_eq!(v.phase, Phase::Ended);
    assert_eq!(v.players[usize::from(ring[3])].paid, U128(4 * STAKE));
}

#[test]
fn a_tag_of_someone_elses_inherited_target_is_refunded_at_end() {
    let mut fx = running_with_four();
    let ring = fx.ring();
    // ring[0] takes ring[1] and with it ring[2]; ring[3] still hunts ring[0], not ring[2].
    fx.verdict(tag(ring[0], ring[1]));
    fx.verdict(tag(ring[3], ring[2]));
    fx.end();
    assert_refunded(&fx, "event 1: a Tag did not follow the ring");
}

#[test]
fn a_match_whose_forfeit_paid_someone_other_than_the_hunter_is_refunded_at_end() {
    let mut fx = Fx::running();
    let ring = fx.ring();
    // ring[0] hunts ring[1]; a forfeit by ring[1] must go to ring[0].
    fx.verdict(forfeit(ring[1], ring[2]));
    fx.end();
    assert_refunded(&fx, "event 0: a Forfeit did not pay the forfeiter's hunter");
}

/// After a Forfeit the winner inherits the forfeiter's target, and hints by the winner are about
/// that player from then on.
#[test]
fn hints_follow_the_target_a_forfeit_handed_on() {
    let mut fx = Fx::running();
    let ring = fx.ring();
    fx.verdicts(vec![
        hint_of(ring[1], NEAR),
        forfeit(ring[1], ring[0]),
        hint_of(ring[0], BEARING),
    ]);
    fx.end();
    assert_eq!(fx.view().settled_as, Some(SettledAs::Payout));
    let mut want = vec![0; 3];
    // ring[1]'s hint was about ring[2], who survives with it; ring[0]'s too.
    let bearing = price(BEARING, 1);
    want[usize::from(ring[0])] = 2 * STAKE - NEAR_PRICE - bearing;
    want[usize::from(ring[2])] = STAKE + NEAR_PRICE + bearing;
    assert_eq!(fx.paid(), want);
}

#[test]
fn a_forfeit_to_the_hunter_then_a_tag_of_the_inherited_target_settles() {
    let mut fx = Fx::running();
    let ring = fx.ring();
    fx.verdict(forfeit(ring[1], ring[0]));
    // ring[0] now hunts ring[1]'s target, ring[2].
    fx.verdict(tag(ring[0], ring[2]));
    let body = fx.end_body();
    fx.verdict(body);
    assert_eq!(fx.view().phase, Phase::Ended);
}

// Migration.

/// Turns `fx`'s contract into the first state layout, as the live deployment has it: no ring
/// record or verdict head for the match, no `vrf_sender`, the old `STATE` record.
fn downgrade_to_v1(fx: &mut Fx) {
    fx.c.payouts.flush();
    fx.c.balances.flush();
    fx.c.matches.flush();
    fx.c.checkpoints.flush();
    fx.c.plays.remove(&fx.id);
    fx.c.plays.flush();
    fx.c.verdict_heads.remove(&fx.id);
    fx.c.verdict_heads.flush();
    // v1 registrations paid for no dossier, so v1 accounts have none.
    let ids: Vec<AccountId> = fx.c.dossier_ids.iter().cloned().collect();
    for id in &ids {
        fx.c.dossiers.remove(id);
    }
    fx.c.dossiers.flush();
    fx.c.dossier_ids.clear();
    fx.c.dossier_ids.flush();
    let v1 = migrate::TailV1 {
        owner: fx.c.owner.clone(),
        referee_pk: fx.c.referee_pk,
        vrf_pk: fx.c.vrf_pk,
        allowed_tokens: fx.c.allowed_tokens.clone(),
        salt: fx.c.salt,
        payouts: LookupMap::new(b"p"),
        balances: LookupMap::new(b"b"),
        matches: LookupMap::new(b"m"),
        checkpoints: LookupMap::new(b"c"),
        match_nonce: fx.c.match_nonce,
    };
    env::state_write(&v1);
}

fn migrated(mut fx: Fx) -> Fx {
    downgrade_to_v1(&mut fx);
    ctx(&owner(), fx.now, NearToken::from_yoctonear(0));
    fx.c = Tail::migrate(acc("referee-caller.testnet"));
    fx
}

fn migrated_lobby() -> Fx {
    migrated(Fx::lobby())
}

#[test]
fn migrate_keeps_balances_payouts_and_matches_and_pins_the_vrf_sender() {
    let mut fx = migrated_lobby();
    let c = fx.c.get_config();
    assert_eq!(c.vrf_sender, acc("referee-caller.testnet"));
    assert_eq!(c.owner, owner());
    assert_eq!(c.referee_pk, pk_hex(&referee()));
    for p in PLAYERS {
        assert_eq!(fx.bal(p), STAKE);
        assert_eq!(fx.c.get_payout(acc(p)), Some(acc(p)));
    }
    let old = fx.view();
    assert_eq!(old.players.len(), 3);
    assert_eq!(old.vrf_sender, None);
    assert_eq!(fx.c.get_verdict_head(hex::encode(fx.id)), None);
    // The nonce carried over: the next match gets a new id, a play record and a verdict head.
    let old_id = fx.id;
    fx.id = fx.create(cfg(usdc(), 0));
    assert_ne!(fx.id, old_id);
    assert_eq!(fx.view().vrf_sender, Some(acc("referee-caller.testnet")));
    assert_eq!(
        fx.c.get_verdict_head(hex::encode(fx.id)),
        Some(VerdictHeadView {
            seq: 0,
            digest: hex::encode([0u8; 32])
        })
    );
}

#[test]
fn a_match_created_after_migrate_runs_to_end_with_the_ring_checked() {
    let mut fx = migrated_lobby();
    ctx(&owner(), fx.now, NearToken::from_yoctonear(1));
    fx.c.set_vrf_sender(vrf_sender());
    fx.id = fx.create(cfg(usdc(), STAKE));
    for p in PLAYERS {
        fx.join(p);
    }
    fx.lock();
    let body = fx.start_body();
    fx.verdict(body);
    let ring = fx.ring();
    fx.verdict(tag(ring[2], ring[0]));
    fx.end();
    assert_eq!(fx.view().phase, Phase::Ended);
}

/// A match from before the upgrade has no verdict head, pinned sender or elimination record, so
/// no verdict for it can be checked against the chain or the ring; the refund path still works.
#[test]
#[should_panic(expected = "match was created before the upgrade")]
fn a_start_in_a_lobby_from_before_migrate_is_refused() {
    let mut fx = migrated_lobby();
    fx.lock();
    let body = fx.start_body();
    fx.verdict(body);
}

#[test]
fn a_lobby_from_before_migrate_takes_no_join_sponsor_or_lock_and_aborts_with_a_refund() {
    let mut fx = migrated_lobby();
    // Review fix: such a lobby can never start, so it takes nothing more in.
    let why = refusal(|| fx.lock());
    assert!(why.contains("created before the upgrade"), "{why}");
    fx.register("dave.testnet");
    fx.top_up("dave.testnet", &usdc(), STAKE);
    let why = refusal(|| fx.join("dave.testnet"));
    assert!(why.contains("created before the upgrade"), "{why}");
    fx.register("dao.testnet");
    let msg = format!(r#"{{"sponsor":"{}"}}"#, hex::encode(fx.id));
    assert_eq!(fx.transfer(&usdc(), "dao.testnet", 7, &msg), 7);
    fx.now = fx.view().start_by_ms + 1;
    fx.abort();
    for p in PLAYERS {
        assert_eq!(fx.bal(p), 2 * STAKE);
    }
}

#[test]
fn a_running_match_from_before_migrate_takes_no_verdict_and_aborts_with_its_stakes_refunded() {
    let mut fx = Fx::running();
    fx.verdict(hint());
    let mut fx = migrated(fx);
    for body in [hint(), tag(0, 1), cp(1)] {
        let why = refusal(|| fx.verdict(body));
        assert!(why.contains("match was created before the upgrade"), "{why}");
    }
    let why = refusal(|| fx.end());
    assert!(why.contains("match was created before the upgrade"), "{why}");
    fx.now += REFEREE_TIMEOUT_MS;
    fx.abort();
    // Every stake back, whatever the old code moved between heads.
    for p in PLAYERS {
        assert_eq!(fx.bal(p), 2 * STAKE);
    }
}

#[test]
fn the_contract_account_itself_can_migrate_in_its_deploy_transaction() {
    let mut fx = Fx::lobby();
    downgrade_to_v1(&mut fx);
    ctx(&contract(), fx.now, NearToken::from_yoctonear(0));
    fx.c = Tail::migrate(vrf_sender());
    assert_eq!(fx.c.get_config().vrf_sender, vrf_sender());
}

#[test]
#[should_panic(expected = "owner only")]
fn migrate_by_a_stranger_is_refused() {
    let mut fx = Fx::lobby();
    downgrade_to_v1(&mut fx);
    ctx(&acc("mallory.testnet"), fx.now, NearToken::from_yoctonear(0));
    let _ = Tail::migrate(acc("mallory.testnet"));
}

#[test]
#[should_panic(expected = "Cannot deserialize the contract state")]
fn migrate_on_the_new_layout_is_refused() {
    let fx = migrated_lobby();
    env::state_write(&fx.c);
    ctx(&owner(), fx.now, NearToken::from_yoctonear(0));
    let _ = Tail::migrate(vrf_sender());
}

// ── Dossier (NEP-171) ───────────────────────────────────────────────────────────────────────

fn dossier(fx: &Fx, who: &str) -> DossierView {
    fx.c.get_dossier(acc(who)).unwrap()
}

/// The NEP-171 events the last call logged, as near-sdk writes them (keys in insertion order).
fn nep171_logs() -> Vec<String> {
    near_sdk::test_utils::get_logs()
        .into_iter()
        .filter(|l| l.starts_with(r#"EVENT_JSON:{"standard":"nep171""#))
        .collect()
}

/// NEP-171 1.2.0's `nft_metadata_update` naming `ids`, written out by hand so a change of name,
/// version or shape shows up.
fn metadata_update(ids: &[&str]) -> String {
    let ids: Vec<String> = ids.iter().map(|i| format!(r#""{i}""#)).collect();
    format!(
        r#"EVENT_JSON:{{"standard":"nep171","version":"1.2.0","event":"nft_metadata_update","data":[{{"token_ids":[{}]}}]}}"#,
        ids.join(",")
    )
}

#[test]
fn registering_logs_nft_mint_at_the_same_version_as_the_metadata_update() {
    let mut fx = Fx::empty();
    fx.register("alice.testnet");
    assert_eq!(
        near_sdk::test_utils::get_logs(),
        [
            r#"EVENT_JSON:{"standard":"nep171","version":"1.2.0","event":"nft_mint","data":[{"owner_id":"alice.testnet","token_ids":["alice.testnet"]}]}"#
        ]
    );
}

/// The card is the same bytes the TypeScript builder draws (`packages/brand`, golden vectors).
#[test]
fn the_dossier_card_matches_the_golden_vectors_byte_for_byte() {
    let cases: Vec<near_sdk::serde_json::Value> =
        near_sdk::serde_json::from_str(include_str!("../../../packages/brand/vectors/dossier.json")).unwrap();
    assert!(cases.len() >= 4);
    for c in cases {
        let view: DossierView = near_sdk::serde_json::from_value(c["view"].clone()).unwrap();
        let want = c["svg"].as_str().unwrap();
        assert_eq!(art::dossier_svg(&view), want, "{}", c["name"]);
        assert!(want.len() <= 4096, "{}: {} bytes", c["name"], want.len());
        assert_eq!(view.seed, hex::encode(env::sha256(view.account_id.as_bytes())));
    }
}

#[test]
fn registering_mints_a_dossier_whose_owner_and_token_id_are_the_account() {
    let fx = Fx::lobby();
    let t = fx.c.nft_token("alice.testnet".to_owned()).unwrap();
    let json = near_sdk::serde_json::to_value(&t).unwrap();
    assert_eq!(json["token_id"], "alice.testnet");
    assert_eq!(json["owner_id"], "alice.testnet");
    assert!(json.get("approved_account_ids").is_none());
    let md = &json["metadata"];
    for key in [
        "title",
        "description",
        "media",
        "media_hash",
        "copies",
        "issued_at",
        "expires_at",
        "starts_at",
        "updated_at",
        "extra",
        "reference",
        "reference_hash",
    ] {
        assert!(md.get(key).is_some(), "NEP-177 metadata lacks {key}");
    }
    assert_eq!(md["title"], "alice's dossier");
    assert_eq!(md["copies"], 1);
    assert_eq!(md["issued_at"], T0.to_string());
    assert!(md["reference"].is_null());
    let extra: near_sdk::serde_json::Value =
        near_sdk::serde_json::from_str(md["extra"].as_str().unwrap()).unwrap();
    assert_eq!(extra["matches"], 0);
    assert_eq!(extra["page"], "/dossier/alice.testnet");
    // The media is the card itself, and media_hash its SHA-256.
    let media = md["media"].as_str().unwrap();
    let svg = near_sdk::base64::Engine::decode(
        &near_sdk::base64::engine::general_purpose::STANDARD,
        media.strip_prefix("data:image/svg+xml;base64,").unwrap(),
    )
    .unwrap();
    assert_eq!(svg, art::dossier_svg(&dossier(&fx, "alice.testnet")).into_bytes());
    assert_eq!(t.metadata.media_hash.unwrap().0, env::sha256(&svg));
    assert!(fx.c.nft_token("mallory.testnet".to_owned()).is_none());
    assert!(fx.c.get_dossier(acc("mallory.testnet")).is_none());
}

#[test]
fn the_collection_follows_nep_177_and_nep_181() {
    let fx = Fx::lobby();
    let md = near_sdk::serde_json::to_value(fx.c.nft_metadata()).unwrap();
    assert_eq!(md["spec"], "nft-2.1.0");
    assert_eq!(md["symbol"], "DOSSIER");
    assert!(md["icon"]
        .as_str()
        .unwrap()
        .starts_with("data:image/svg+xml;base64,"));
    assert!(md["base_uri"].is_null());
    assert_eq!(fx.c.nft_total_supply(), U128(3));
    // Mint order: the lobby registers carol, alice, bob.
    let ids: Vec<String> =
        fx.c.nft_tokens(None, None)
            .into_iter()
            .map(|t| t.token_id)
            .collect();
    assert_eq!(ids, ["carol.testnet", "alice.testnet", "bob.testnet"]);
    let page: Vec<String> =
        fx.c.nft_tokens(Some(U128(1)), Some(1))
            .into_iter()
            .map(|t| t.token_id)
            .collect();
    assert_eq!(page, ["alice.testnet"]);
    assert_eq!(fx.c.nft_tokens(Some(U128(3)), None).len(), 0);
    assert_eq!(fx.c.nft_supply_for_owner(acc("bob.testnet")), U128(1));
    assert_eq!(fx.c.nft_supply_for_owner(acc("mallory.testnet")), U128(0));
    assert_eq!(fx.c.nft_tokens_for_owner(acc("bob.testnet"), None, None).len(), 1);
    let bob_from_1 = fx.c.nft_tokens_for_owner(acc("bob.testnet"), Some(U128(1)), None);
    assert_eq!(bob_from_1.len(), 0);
    assert_eq!(
        fx.c.nft_tokens_for_owner(acc("mallory.testnet"), None, None)
            .len(),
        0
    );
}

#[test]
#[should_panic(expected = "a dossier is bound to the player who earned it")]
fn a_dossier_transfer_by_its_owner_is_refused() {
    let fx = Fx::lobby();
    ctx(&acc("alice.testnet"), fx.now, NearToken::from_yoctonear(1));
    let mut c = fx.c;
    c.nft_transfer(acc("bob.testnet"), "alice.testnet".to_owned(), None, None);
}

#[test]
#[should_panic(expected = "a dossier is bound to the player who earned it")]
fn a_dossier_transfer_call_by_its_owner_is_refused() {
    let fx = Fx::lobby();
    ctx(&acc("alice.testnet"), fx.now, NearToken::from_yoctonear(1));
    let mut c = fx.c;
    let _ = c.nft_transfer_call(
        acc("market.testnet"),
        "alice.testnet".to_owned(),
        None,
        None,
        String::new(),
    );
}

/// h hints and tags t, then End: h survives with a tag, t was tagged, o survives.
fn ended_with_a_tag() -> (Fx, u16, u16, u16) {
    let mut fx = Fx::running();
    let ring = fx.ring();
    let (h, t, o) = (ring[0], ring[1], ring[2]);
    at_checkpoint(&mut fx, 1);
    fx.verdict(cp(10));
    fx.verdicts(vec![hint_of(h, NEAR), tag(h, t)]);
    fx.end();
    (fx, h, t, o)
}

#[test]
fn a_paid_out_match_adds_an_entry_to_every_players_dossier() {
    let (fx, h, t, o) = ended_with_a_tag();
    // The End payout logs nothing else.
    assert_eq!(near_sdk::test_utils::get_logs(), [metadata_update(&PLAYERS)]);
    let view = fx.view();
    let name = |i: u16| view.players[usize::from(i)].account_id.to_string();
    let final_root = fx.c.get_roots(hex::encode(fx.id)).unwrap().final_root.unwrap();
    for (i, result, tags) in [
        (h, MatchResult::Survived, 1),
        (t, MatchResult::Tagged, 0),
        (o, MatchResult::Survived, 0),
    ] {
        let dos = dossier(&fx, &name(i));
        assert_eq!((dos.matches, dos.refunded), (1, 0));
        assert_eq!(dos.survived, u32::from(result == MatchResult::Survived));
        assert_eq!(dos.tags, tags);
        assert_eq!(dos.won, view.players[usize::from(i)].paid);
        assert_eq!(dos.entries.len(), 1);
        let entry = &dos.entries[0];
        assert_eq!(entry.match_id, hex::encode(fx.id));
        assert_eq!((entry.result, entry.tags), (result, tags));
        assert_eq!(entry.payout, view.players[usize::from(i)].paid);
        // The entry names the root End anchored, so its log can be checked with verify_inclusion.
        assert_eq!(
            (entry.log_size.0, entry.root.clone()),
            (final_root.log_size, final_root.root.clone())
        );
    }
    let t_name = name(t);
    let extra = fx.c.nft_token(t_name).unwrap().metadata.extra.unwrap();
    assert!(extra.contains(r#""matches":1"#), "{extra}");
}

#[test]
fn a_forfeit_is_recorded_as_one() {
    let mut fx = Fx::running();
    let ring = fx.ring();
    fx.verdict(forfeit(ring[1], ring[0]));
    fx.end();
    let loser = fx.view().players[usize::from(ring[1])].account_id.to_string();
    let d = dossier(&fx, &loser);
    assert_eq!((d.matches, d.forfeits, d.survived), (1, 1, 0));
    assert_eq!(d.entries[0].result, MatchResult::Forfeit);
}

#[test]
fn a_match_refunded_for_a_broken_rule_counts_only_as_a_refund() {
    let mut fx = Fx::running();
    let ring = fx.ring();
    // An off-ring Tag: End's replay refunds the match.
    fx.verdict(tag(ring[0], ring[2]));
    fx.end();
    assert_eq!(nep171_logs(), [metadata_update(&PLAYERS)]);
    assert_eq!(near_sdk::test_utils::get_logs().len(), 2, "and match_refunded");
    assert_eq!(fx.view().settled_as, Some(SettledAs::RefundedRuleViolation));
    for p in PLAYERS {
        let d = dossier(&fx, p);
        assert_eq!((d.matches, d.survived, d.tags, d.refunded), (0, 0, 0, 1));
        assert_eq!(d.won, U128(0));
        let e = &d.entries[0];
        assert_eq!(
            (e.result, e.tags, e.payout),
            (MatchResult::Refunded, 0, U128(STAKE))
        );
        assert_eq!(e.log_size, U64(77));
    }
}

#[test]
fn an_aborted_running_match_is_recorded_as_a_refund_at_its_last_checkpoint() {
    let mut fx = Fx::running();
    at_checkpoint(&mut fx, 1);
    fx.verdict(cp(10));
    fx.now += REFEREE_TIMEOUT_MS;
    fx.abort();
    assert_eq!(nep171_logs(), [metadata_update(&PLAYERS)]);
    assert_eq!(near_sdk::test_utils::get_logs().len(), 2, "and match_refunded");
    for p in PLAYERS {
        let d = dossier(&fx, p);
        assert_eq!((d.matches, d.refunded), (0, 1));
        let e = &d.entries[0];
        assert_eq!(e.result, MatchResult::Refunded);
        assert_eq!((e.log_size, e.root.clone()), (U64(10), hex::encode(log_root(10))));
    }
}

#[test]
fn a_lobby_that_never_started_adds_nothing() {
    let mut fx = Fx::locked();
    fx.now += LOCK_MS;
    fx.abort();
    assert_eq!(near_sdk::test_utils::get_logs(), Vec::<String>::new());
    for p in PLAYERS {
        assert_eq!(dossier(&fx, p).entries.len(), 0);
    }
}

/// Only dossiers that changed are named: an account from before dossiers has none until it mints
/// one, and its settlement changes nothing for it.
#[test]
fn the_metadata_update_names_only_the_players_who_hold_a_dossier() {
    let mut fx = migrated(Fx::running());
    let deposit = dossier_deposit_attached(&fx);
    ctx(&acc("bob.testnet"), fx.now, deposit);
    fx.c.mint_dossier(acc("bob.testnet"));
    assert_eq!(
        near_sdk::test_utils::get_logs(),
        [
            r#"EVENT_JSON:{"standard":"nep171","version":"1.2.0","event":"nft_mint","data":[{"owner_id":"bob.testnet","token_ids":["bob.testnet"]}]}"#
        ]
    );
    fx.now += REFEREE_TIMEOUT_MS;
    fx.abort();
    assert_eq!(nep171_logs(), [metadata_update(&["bob.testnet"])]);
}

/// The most an End logs: 12 players with 64-character ids, refunded for a broken rule, so it logs
/// both `nft_metadata_update` and `match_refunded`, the latter counted with the longest violation
/// text any rule and event index could give. NEAR allows a receipt 100 logs and 16,384 bytes of
/// them in all.
#[test]
fn the_largest_settlement_logs_stay_far_below_the_receipt_log_limits() {
    use tail_protocol::settle::{Check, Violation};
    // At most 240 hints and 11 eliminations, so the last event index is 250.
    let last_event = u32::try_from(MAX_HINTS).unwrap() + u32::from(MAX_PLAYERS) - 2;
    let longest = [
        Check::HintCount,
        Check::HintTarget,
        Check::TagRing,
        Check::ForfeitRing,
        Check::Credit,
        Check::Pool,
    ]
    .into_iter()
    .flat_map(|check| [None, Some(last_event)].map(|event| Violation { check, event }.describe().len()))
    .max()
    .unwrap();
    let long = |p: &str| format!("{p}{}", "x".repeat(64 - p.len()));
    let ids: Vec<String> = (0..MAX_PLAYERS).map(|i| long(&format!("p{i:02}"))).collect();
    let mut fx = Fx::empty();
    for p in &ids {
        fx.register(p);
        fx.top_up(p, &usdc(), STAKE);
    }
    fx.id = fx.create(MatchConfig {
        max_players: MAX_PLAYERS,
        ..cfg(usdc(), STAKE)
    });
    for p in &ids {
        fx.join(p);
    }
    fx.lock();
    let Verdict::Start {
        ring_commit,
        start_ms,
        end_ms,
        ..
    } = fx.start_body()
    else {
        unreachable!()
    };
    fx.verdict(Verdict::Start {
        players_hash: players_hash(&ids),
        ring_commit,
        start_ms,
        end_ms,
    });
    // One hint target for a match without hints.
    end_naming(&mut fx, vec![0]);
    let violation = fx.view().violation.unwrap();
    let ids: Vec<&str> = ids.iter().map(String::as_str).collect();
    assert_eq!(nep171_logs(), [metadata_update(&ids)]);
    let logs = near_sdk::test_utils::get_logs();
    assert_eq!(logs.len(), 2);
    let total = logs.iter().map(String::len).sum::<usize>() - violation.len() + longest;
    println!(
        "largest settlement: {} logs, at most {total} bytes ({} of them nft_metadata_update)",
        logs.len(),
        logs[0].len()
    );
    // Under a tenth of the byte limit: even ten such Ends batched into one `apply` would fit.
    assert!(total <= 16_384 / 10, "{total} bytes");
}

#[test]
fn a_dossier_keeps_the_newest_entries_and_every_total() {
    let mut d = Dossier::new(T0);
    for k in 0..DOSSIER_ENTRIES as u8 + 3 {
        d.matches += 1;
        d.push(
            dossier::DossierEntry {
                match_id: [k; 16],
                result: MatchResult::Survived,
                tags: 0,
                payout: 0,
                anchor: Root {
                    log_size: 1,
                    root: [0; 32],
                },
            },
            T0 + u64::from(k),
        );
    }
    assert_eq!(d.entries.len(), DOSSIER_ENTRIES);
    assert_eq!(d.entries[0].match_id, [3; 16]);
    assert_eq!(d.matches, 15);
    let v = DossierView::of(&acc("alice.testnet"), &d);
    // Newest first.
    assert_eq!(v.entries[0].match_id, hex::encode([14u8; 16]));
}

/// A maximal dossier (64-character id, every entry and total at its largest) and its place in
/// the token list stay within what registration charges for it.
#[test]
fn a_maximal_dossier_fits_the_storage_registration_paid_for() {
    let mut fx = Fx::empty();
    let who = acc(&format!("{}.testnet", "d".repeat(56)));
    fx.c.dossiers.flush();
    fx.c.dossier_ids.flush();
    let before = env::storage_usage();
    ctx(&who, fx.now, fx.registration_deposit());
    fx.c.register_for(who.clone(), who.clone());
    fx.c.payouts.remove(&who);
    fx.c.payouts.flush();
    for t in [usdc(), usdt()] {
        fx.c.balances.remove(&(who.clone(), t));
    }
    fx.c.balances.flush();
    let d = fx.c.dossiers.get_mut(&who).unwrap();
    for k in 0..DOSSIER_ENTRIES as u8 {
        d.push(
            dossier::DossierEntry {
                match_id: [k; 16],
                result: MatchResult::Survived,
                tags: u8::MAX,
                payout: u128::MAX,
                anchor: Root {
                    log_size: u64::MAX,
                    root: [9; 32],
                },
            },
            u64::MAX,
        );
    }
    (d.matches, d.survived, d.tags, d.forfeits, d.refunded, d.won) =
        (u32::MAX, u32::MAX, u32::MAX, 0, 0, u128::MAX);
    fx.c.dossiers.flush();
    fx.c.dossier_ids.flush();
    let used = u128::from(env::storage_usage() - before);
    println!("a maximal dossier stores {used} bytes");
    assert!(
        used <= DOSSIER_RECORD_BYTES,
        "a maximal dossier uses {used} bytes"
    );
    assert!(
        used + 100 > DOSSIER_RECORD_BYTES,
        "a maximal dossier uses only {used} bytes"
    );
    assert_eq!(
        fx.c.get_config().registration_deposit.0,
        env::storage_byte_cost().as_yoctonear()
            * (PAYOUT_RECORD_BYTES + 2 * BALANCE_RECORD_BYTES + DOSSIER_RECORD_BYTES)
    );
}

/// A lobby open for ten minutes from `now`, with `requires`.
fn requiring(now: u64, min_matches: u32, min_survived: u32) -> MatchConfig {
    MatchConfig {
        requires: Some(Requires {
            min_matches,
            min_survived,
        }),
        start_by_ms: now + 600_000,
        ..cfg(usdc(), STAKE)
    }
}

#[test]
fn a_player_whose_dossier_is_below_requires_cannot_join() {
    let mut fx = Fx::empty();
    fx.register("alice.testnet");
    fx.top_up("alice.testnet", &usdc(), STAKE);
    fx.id = fx.create(requiring(fx.now, 1, 0));
    assert_eq!(
        fx.view().requires,
        Some(Requires {
            min_matches: 1,
            min_survived: 0
        })
    );
    let why = refusal(|| fx.join("alice.testnet"));
    assert!(
        why.contains("your dossier is below this match's requires: 1 settled matches and 0 survived"),
        "{why}"
    );
    assert_eq!(fx.bal("alice.testnet"), STAKE);
}

#[test]
fn a_player_whose_dossier_meets_requires_joins_and_a_refund_does_not_count() {
    let (mut fx, h, t, _) = ended_with_a_tag();
    let v = fx.view();
    let (survivor, tagged) = (
        v.players[usize::from(h)].account_id.to_string(),
        v.players[usize::from(t)].account_id.to_string(),
    );
    fx.id = fx.create(requiring(fx.now, 1, 1));
    fx.join(&survivor);
    // One match played but not survived.
    let why = refusal(|| fx.join(&tagged));
    assert!(why.contains("below this match's requires"), "{why}");
    // A refunded match is no settled match: after one, the bar of one match still holds.
    let mut fx = Fx::running();
    let ring = fx.ring();
    fx.verdict(tag(ring[0], ring[2]));
    fx.end();
    fx.id = fx.create(requiring(fx.now, 1, 0));
    let why = refusal(|| fx.join("alice.testnet"));
    assert!(why.contains("below this match's requires"), "{why}");
}

#[test]
fn a_match_without_requires_admits_a_new_player() {
    let mut fx = Fx::empty();
    fx.register("alice.testnet");
    fx.top_up("alice.testnet", &usdc(), STAKE);
    fx.id = fx.create(requiring(fx.now, 0, 0));
    fx.join("alice.testnet");
    assert_eq!(fx.view().players.len(), 1);
}

#[test]
fn an_account_from_before_migrate_has_no_dossier_until_it_mints_one() {
    let mut fx = migrated(Fx::running());
    assert!(fx.c.get_dossier(acc("alice.testnet")).is_none());
    assert_eq!(fx.c.nft_total_supply(), U128(0));
    // Its old match settles by abort, which records nothing for an account without a dossier,
    // so no token changed and none is announced.
    fx.now += REFEREE_TIMEOUT_MS;
    fx.abort();
    assert_eq!(nep171_logs(), Vec::<String>::new());
    let deposit = NearToken::from_yoctonear(fx.c.get_config().dossier_deposit.0);
    let why = refusal(|| {
        ctx(&acc("mallory.testnet"), fx.now, deposit);
        fx.c.mint_dossier(acc("alice.testnet"));
    });
    assert!(why.contains("only the account, its parent or the owner"), "{why}");
    ctx(&acc("alice.testnet"), fx.now, deposit);
    fx.c.mint_dossier(acc("alice.testnet"));
    assert_eq!(dossier(&fx, "alice.testnet").matches, 0);
    assert_eq!(fx.c.nft_total_supply(), U128(1));
    let why = refusal(|| {
        ctx(&acc("alice.testnet"), fx.now, deposit);
        fx.c.mint_dossier(acc("alice.testnet"));
    });
    assert!(why.contains("already has a dossier"), "{why}");
    let why = refusal(|| {
        ctx(&acc("zed.testnet"), fx.now, deposit);
        fx.c.mint_dossier(acc("zed.testnet"));
    });
    assert!(why.contains("account not registered"), "{why}");
}

// ── Review fixes (money review of 2d30754) ──────────────────────────────────────────────────

/// OutLayer down at the end: a Tag signed in time lands ten minutes after `end_ms`, past the old
/// five-minute grace, and the End behind it still pays out the winners.
#[test]
fn a_late_tag_before_the_overdue_abort_lands_and_end_still_pays_out() {
    let mut fx = Fx::running();
    let ring = fx.ring();
    fx.now = fx.view().end_ms.unwrap() + 600_000;
    fx.verdict(tag(ring[0], ring[1]));
    fx.end();
    assert_eq!(fx.view().settled_as, Some(SettledAs::Payout));
    let mut want = vec![STAKE; 3];
    want[usize::from(ring[0])] = 2 * STAKE;
    want[usize::from(ring[1])] = 0;
    // The sponsor named in `cfg` put nothing in, so the payout is the heads.
    assert_eq!(fx.paid(), want);
}

#[test]
#[should_panic(expected = "checkpoint log_size must grow (and an empty log is no checkpoint)")]
fn a_checkpoint_of_an_empty_log_is_refused() {
    let mut fx = Fx::running();
    at_checkpoint(&mut fx, 1);
    fx.verdict(Verdict::Checkpoint {
        log_size: 0,
        root: [7; 32],
    });
}

#[test]
fn an_end_of_an_empty_log_must_anchor_the_empty_root() {
    let mut fx = Fx::running();
    fx.now = fx.view().end_ms.unwrap();
    let mut junk = end_at(&alpha_for(fx.id), 0);
    if let Verdict::End { root, .. } = &mut junk {
        *root = [7; 32];
    }
    let why = refusal(|| fx.verdict(junk));
    assert!(why.contains("the root of an empty log must be SHA256"), "{why}");
    // The empty root itself is fine.
    fx.verdict(end_at(&alpha_for(fx.id), 0));
    assert_eq!(fx.view().settled_as, Some(SettledAs::Payout));
}

/// The code before the upgrade paid heads at End with no replay; `get_match` says so.
#[test]
fn a_match_ended_before_the_upgrade_reads_as_paid_out_without_a_replay() {
    let mut fx = Fx::running();
    fx.end();
    let fx = migrated(fx);
    assert_eq!(fx.view().settled_as, Some(SettledAs::PayoutUnreplayed));
    let json = near_sdk::serde_json::to_value(fx.view()).unwrap();
    assert_eq!(json["settled_as"], "payout_unreplayed");
}

// ── Review fixes (money review of b1736f1) ──────────────────────────────────────────────────

/// A player the relay created (`zoe.relay.testnet`) and registered before dossiers existed, next
/// to the lobby's three.
fn migrated_with_a_relay_player() -> Fx {
    let mut fx = Fx::lobby();
    ctx(&acc("relay.testnet"), fx.now, fx.registration_deposit());
    fx.c.register_for(acc("zoe.relay.testnet"), acc("zoe-wallet.testnet"));
    migrated(fx)
}

fn dossier_deposit_attached(fx: &Fx) -> NearToken {
    NearToken::from_yoctonear(fx.c.get_config().dossier_deposit.0)
}

/// A relay player's function-call key cannot attach `mint_dossier`'s deposit, so its parent, the
/// relay, backfills it and pays. Nobody else in the account tree may.
#[test]
fn the_relay_backfills_its_players_dossier_and_a_stranger_cannot() {
    let mut fx = migrated_with_a_relay_player();
    let zoe = acc("zoe.relay.testnet");
    assert!(fx.c.get_dossier(zoe.clone()).is_none());
    let deposit = dossier_deposit_attached(&fx);
    // The grandparent, a sibling's parent and a stranger are not its parent.
    for who in ["testnet", "relay2.testnet", "mallory.testnet", "elay.testnet"] {
        let why = refusal(|| {
            ctx(&acc(who), fx.now, deposit);
            fx.c.mint_dossier(zoe.clone());
        });
        assert!(
            why.contains("only the account, its parent or the owner can mint its dossier"),
            "{who}: {why}"
        );
    }
    let why = refusal(|| {
        ctx(&acc("relay.testnet"), fx.now, NearToken::from_yoctonear(0));
        fx.c.mint_dossier(zoe.clone());
    });
    assert!(why.contains("attach exactly dossier_deposit"), "{why}");
    ctx(&acc("relay.testnet"), fx.now, deposit);
    fx.c.mint_dossier(zoe.clone());
    assert_eq!(fx.c.get_dossier(zoe.clone()).unwrap().matches, 0);
    assert_eq!(fx.c.nft_supply_for_owner(zoe.clone()), U128(1));
    assert!(fx.c.nft_token(zoe.to_string()).is_some());
    let why = refusal(|| {
        ctx(&acc("relay.testnet"), fx.now, deposit);
        fx.c.mint_dossier(zoe.clone());
    });
    assert!(why.contains("already has a dossier"), "{why}");
}

#[test]
fn the_owner_can_backfill_a_dossier() {
    let mut fx = migrated(Fx::lobby());
    let deposit = dossier_deposit_attached(&fx);
    ctx(&owner(), fx.now, deposit);
    fx.c.mint_dossier(acc("alice.testnet"));
    assert_eq!(dossier(&fx, "alice.testnet").matches, 0);
    assert_eq!(fx.c.nft_total_supply(), U128(1));
}

/// Review fix: a registered player without a dossier reads as an empty record, so `requires`
/// of `{0, 0}` lets them in and any higher bar keeps them out.
#[test]
fn a_player_without_a_dossier_clears_an_empty_requires_and_nothing_above_it() {
    let mut fx = migrated(Fx::lobby());
    assert!(fx.c.get_dossier(acc("alice.testnet")).is_none());
    fx.id = fx.create(requiring(fx.now, 0, 0));
    fx.join("alice.testnet");
    assert_eq!(fx.view().players.len(), 1);
    for (m, s) in [(1, 0), (0, 1)] {
        fx.id = fx.create(requiring(fx.now, m, s));
        let why = refusal(|| fx.join("bob.testnet"));
        assert!(why.contains("below this match's requires"), "{why}");
    }
}

/// Review fix: totals at their largest saturate, so recording a settlement can never make End or
/// abort panic.
#[test]
fn dossier_totals_saturate_so_end_and_abort_cannot_panic() {
    let max_out = |fx: &mut Fx| {
        for p in PLAYERS {
            let d = fx.c.dossiers.get_mut(&acc(p)).unwrap();
            (d.matches, d.survived, d.tags, d.forfeits, d.refunded, d.won) =
                (u32::MAX, u32::MAX, u32::MAX, u32::MAX, u32::MAX, u128::MAX);
        }
    };
    let mut fx = Fx::running();
    max_out(&mut fx);
    let ring = fx.ring();
    fx.verdict(tag(ring[0], ring[1]));
    fx.verdict(forfeit(ring[2], ring[0]));
    fx.end();
    assert_eq!(fx.view().settled_as, Some(SettledAs::Payout));
    for p in PLAYERS {
        let d = dossier(&fx, p);
        assert_eq!(
            (d.matches, d.survived, d.tags, d.forfeits),
            (u32::MAX, u32::MAX, u32::MAX, u32::MAX)
        );
        assert_eq!(d.won, U128(u128::MAX));
        assert_eq!(d.entries.len(), 1);
    }
    let mut fx = Fx::running();
    max_out(&mut fx);
    fx.now += REFEREE_TIMEOUT_MS;
    fx.abort();
    for p in PLAYERS {
        let d = dossier(&fx, p);
        assert_eq!(d.refunded, u32::MAX);
        assert_eq!(d.entries[0].result, MatchResult::Refunded);
    }
}

/// Fills `MAX_TOKENS_PER_PAGE + 3` dossiers at their largest (64-character ids, 12 entries, every
/// tick drawn) for the page-size measurement.
fn maximal_dossiers(fx: &mut Fx, n: u64) {
    for i in 0..n {
        let who = acc(&format!("p{i:03}{}.testnet", "d".repeat(52)));
        ctx(&who, fx.now, fx.registration_deposit());
        fx.c.register_for(who.clone(), who.clone());
        let d = fx.c.dossiers.get_mut(&who).unwrap();
        for k in 0..DOSSIER_ENTRIES as u8 {
            let result =
                [MatchResult::Survived, MatchResult::Tagged, MatchResult::Forfeit][usize::from(k % 3)];
            d.push(
                dossier::DossierEntry {
                    match_id: [k; 16],
                    result,
                    tags: 11,
                    payout: u128::MAX,
                    anchor: Root {
                        log_size: u64::MAX,
                        root: [9; 32],
                    },
                },
                u64::MAX,
            );
        }
        (d.matches, d.survived, d.tags, d.forfeits, d.refunded, d.won) =
            (u32::MAX, u32::MAX, u32::MAX, u32::MAX, u32::MAX, u128::MAX);
    }
    fx.c.dossiers.flush();
    fx.c.dossier_ids.flush();
}

/// Review fix: `nft_tokens` builds one card per token in wasm, which the unit-test VM does not
/// meter, so the page is kept small enough that the unmetered part is bounded by the bytes it
/// writes. Measured here per maximal token: the host gas (storage reads, two SHA-256) and the
/// bytes of SVG, base64 and JSON. See `MAX_TOKENS_PER_PAGE` for the bound.
#[test]
fn nft_tokens_pages_are_capped_at_ten_maximal_cards() {
    use dossier::MAX_TOKENS_PER_PAGE;
    assert_eq!(MAX_TOKENS_PER_PAGE, 10);
    let mut fx = Fx::empty();
    maximal_dossiers(&mut fx, MAX_TOKENS_PER_PAGE + 3);
    fx.as_("anyone.testnet");
    let mut page = Vec::new();
    let gas = host_gas(|| page = fx.c.nft_tokens(None, Some(u64::MAX)));
    assert_eq!(page.len() as u64, MAX_TOKENS_PER_PAGE);
    assert_eq!(fx.c.nft_tokens(Some(U128(10)), None).len(), 3);
    let json = near_sdk::serde_json::to_vec(&page).unwrap().len();
    let svg: usize = page
        .iter()
        .map(|t| art::dossier_svg(&fx.c.get_dossier(t.owner_id.clone()).unwrap()).len())
        .sum();
    println!(
        "nft_tokens of {} maximal cards: host gas {} Ggas, {} bytes of SVG, {} bytes of JSON",
        page.len(),
        gas / 1_000_000_000,
        svg,
        json
    );
    // The two numbers `MAX_TOKENS_PER_PAGE`'s bound rests on, with margin: host gas per card under
    // 0.2 Tgas, and the bytes the wasm side writes per card (the SVG, then the JSON that holds
    // its base64) under 10.6 KB.
    assert!(gas < MAX_TOKENS_PER_PAGE * 200_000_000_000, "{gas} gas");
    let per_card = (svg + json) as u64 / MAX_TOKENS_PER_PAGE;
    assert!(per_card < 10_600, "{per_card} bytes per card");
}

/// Review fix (NEP-171): `token_id` is a string, and one that is not an account id names no
/// token instead of failing the view.
#[test]
fn nft_token_takes_any_string_and_a_malformed_id_names_no_token() {
    let fx = Fx::lobby();
    assert!(fx.c.nft_token("alice.testnet".to_owned()).is_some());
    for bad in [
        String::new(),
        "Alice!".to_owned(),
        "a..testnet".to_owned(),
        "x".repeat(65),
    ] {
        assert!(fx.c.nft_token(bad.clone()).is_none(), "{bad}");
    }
    let json = near_sdk::serde_json::to_value(fx.c.nft_token("not an id".to_owned())).unwrap();
    assert!(json.is_null());
}

/// NEP-171: `nft_resolve_transfer` returns whether the token was transferred; none ever is.
#[test]
fn nft_resolve_transfer_says_nothing_was_transferred() {
    let mut fx = Fx::lobby();
    ctx(&contract(), fx.now, NearToken::from_yoctonear(0));
    let moved = fx.c.nft_resolve_transfer(
        acc("alice.testnet"),
        acc("market.testnet"),
        "alice.testnet".to_owned(),
        None,
    );
    assert!(!moved);
    assert_eq!(
        fx.c.nft_token("alice.testnet".to_owned()).unwrap().owner_id,
        acc("alice.testnet")
    );
}

/// Review fix: a lobby from before the upgrade can never start, so anyone may abort it at once
/// instead of waiting for its deadline. A lobby from after it still waits.
#[test]
fn a_lobby_from_before_migrate_aborts_at_once_and_a_new_one_still_waits() {
    let mut fx = migrated_lobby();
    assert!(fx.now < fx.view().start_by_ms);
    fx.abort();
    assert_eq!(fx.view().phase, Phase::Aborted);
    assert_eq!(fx.view().settled_as, Some(SettledAs::RefundedAbort));
    for p in PLAYERS {
        assert_eq!(fx.bal(p), 2 * STAKE);
    }
    fx.id = fx.create(cfg(usdc(), STAKE));
    let why = refusal(|| fx.abort());
    assert!(why.contains("lobby is still open"), "{why}");
}

/// Review fix: `create_match` caps the stake so `hint_price` (stake × base bps × demand bps) can
/// never overflow, whatever the demand.
#[test]
fn a_stake_above_max_stake_is_refused_and_max_stake_prices_every_hint() {
    for kind in [NEAR, TREND, BEARING] {
        for recent in [0, 1, 12, u32::MAX] {
            let price = hint_price(MAX_STAKE, kind, recent).unwrap();
            assert!(price <= MAX_STAKE / 5, "{kind} at {recent}: {price}");
        }
    }
    let mut fx = Fx::empty();
    fx.id = fx.create(cfg(usdc(), MAX_STAKE));
    assert_eq!(fx.view().stake, U128(MAX_STAKE));
    let why = refusal(|| {
        fx.create(cfg(usdc(), MAX_STAKE + 1));
    });
    assert!(why.contains("stake is above MAX_STAKE"), "{why}");
}
