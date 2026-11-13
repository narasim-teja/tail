//! In-place upgrade of the contract state. `Tail` is one borsh record under `STATE`; the maps in
//! it are only prefixes, so a migration rewrites that one record and no map entry.

use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, require, AccountId};
use tail_protocol::MatchId;

use crate::{check_vrf_sender, Match, Root, Tail};

/// Play records and verdict heads live under their own prefixes, so no existing key moves.
pub const PLAYS_PREFIX: &[u8] = b"r";
pub const VERDICT_HEADS_PREFIX: &[u8] = b"h";
/// Dossiers and their token list, likewise.
pub const DOSSIERS_PREFIX: &[u8] = b"d";
pub const DOSSIER_IDS_PREFIX: &[u8] = b"n";

/// The state layout before `vrf_sender`, the play records and the verdict heads (deployed until
/// the hardening round). It is the only layout ever deployed, so this is the one migration path.
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

/// Reads the v1 record and returns the current state; near-sdk writes it back when `migrate`
/// returns. Matches from v1 get neither a play record nor a verdict head, so they take no further
/// verdicts and settle by `abort`. Accounts from v1 have no dossier (their registration did not pay
/// for one): they mint it with `mint_dossier`, and until then settlements add nothing for them.
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
        plays: LookupMap::new(PLAYS_PREFIX),
        verdict_heads: LookupMap::new(VERDICT_HEADS_PREFIX),
        dossiers: LookupMap::new(DOSSIERS_PREFIX),
        dossier_ids: Vector::new(DOSSIER_IDS_PREFIX),
    }
}
