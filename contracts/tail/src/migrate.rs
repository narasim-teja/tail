//! In-place upgrade of the contract state. `Tail` is one borsh record under `STATE`; the maps in
//! it are only prefixes, so a migration rewrites that one record and no map entry.

use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId};
use tail_protocol::MatchId;

use crate::{check_vrf_sender, Match, Root, Tail};

/// Ring records live under their own prefix, so no existing key moves.
pub const RINGS_PREFIX: &[u8] = b"r";

/// The state layout before `vrf_sender` and the ring records (deployed until the hardening round).
/// Field order is the borsh order of that deployment and must not change.
#[near(serializers = [borsh])]
#[derive(Debug)]
pub struct TailV1 {
    pub owner: AccountId,
    pub referee_pk: [u8; 32],
    pub vrf_pk: [u8; 32],
    pub allowed_tokens: Vec<AccountId>,
    pub salt: [u8; 32],
    pub payouts: LookupMap<AccountId, AccountId>,
    pub balances: LookupMap<(AccountId, AccountId), u128>,
    pub matches: LookupMap<MatchId, Match>,
    pub checkpoints: LookupMap<MatchId, Vec<Root>>,
    pub match_nonce: u64,
}

/// Reads the v1 record and returns the v2 state; near-sdk writes it back when `migrate` returns.
/// The owner may call it, and so may the contract account itself, so the deploy and the
/// migration can be one transaction and no call ever sees new code over old state.
pub fn from_v1(vrf_sender: AccountId) -> Tail {
    // `state_read` panics if the record is not exactly a v1 one, which also refuses a second run.
    let old: TailV1 = env::state_read().unwrap_or_else(|| env::panic_str("no state to migrate"));
    let caller = env::predecessor_account_id();
    require!(
        caller == old.owner || caller == env::current_account_id(),
        "owner only"
    );
    Tail {
        owner: old.owner,
        referee_pk: old.referee_pk,
        vrf_pk: old.vrf_pk,
        allowed_tokens: old.allowed_tokens,
        salt: old.salt,
        payouts: old.payouts,
        balances: old.balances,
        matches: old.matches,
        checkpoints: old.checkpoints,
        match_nonce: old.match_nonce,
        vrf_sender: check_vrf_sender(vrf_sender),
        rings: LookupMap::new(RINGS_PREFIX),
    }
}
