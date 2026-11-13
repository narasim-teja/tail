# tail contract

near-sdk 5.30.1 contract for TAIL's custody and settlement. Money enters only through NEP-141
`ft_transfer_call` and leaves only through `withdraw`. Inside a match, heads move only when `apply`
accepts a verdict signed by the referee key the match pinned at creation. Each verdict names the
digest of the one before it, so a match has one verdict chain and a forked stream cannot land.
Each Checkpoint and End carries an RFC 9162 consistency proof from the last anchored log root, so
the anchored roots form one append-only log, and `verify_inclusion` checks a log entry against
them on-chain.

Money only becomes withdrawable after the contract has replayed and checked the whole match.
During play heads move inside the match: a Hint pays into the match's hint pool (it does not say
whom it was about), a Tag or Forfeit credits the loser from the pool and moves the loser's head.
At `End` the contract rebuilds the ring from the revealed VRF output and replays every Hint, Tag
and Forfeit against it and the revealed hint targets. Only then does it pay out. If any step
fails, it refunds every original stake and records the first broken rule. `abort` refunds every
original stake of a match whose referee went quiet.

Testnet: `tail.tail-dev-a38d13.testnet`, deployed by `e2e/deploy.ts`. It was upgraded in place to
this code on 2026-11-13 (`deploy.ts --upgrade --migrate`; matches settled before that read
`settled_as: "payout_unreplayed"`). Since OutLayer testnet stopped running calls on 2026-11-12 it
pins the local test referee's keys, not the enclave's: `get_config` shows `referee_pk`
`d35338a9…6594` and `vrf_pk` `ad82f28f…defcb`. While those are pinned, the referee is whoever runs
that machine. The enclave's verdict key is `e1c64271…7d6c56` and OutLayer's testnet VRF key
`c0c5aeae…f8cfa8`; re-pinning them is a `set_referee_pk` / `set_vrf_pk` away.

## Encoding

- Fixed-size bytes in JSON (match id, hashes, public keys, signatures) are lowercase hex.
  Amounts are decimal strings (`U128`). Times are unix ms as JSON numbers.
- A verdict is borsh `SignedVerdict { match_id: [u8;16], seq: u32, prev: [u8;32], call_id: [u8;16], body: Verdict, sig: [u8;64] }`
  (protocol v2) from `crates/tail-protocol`, base64 in JSON. `sig` is ed25519 over the verdict
  digest `SHA256("tail/verdict/v2" ‖ borsh(VerdictPayload { match_id, seq, prev, call_id, body }))`.
  `prev` is the digest of the match's previous verdict, zeros for the first (seq 1).
- A consistency proof for `apply` is `{seq, from_size, path}`: the seq of the Checkpoint or End it
  proves, the log size it starts from as a decimal string (`U64`), and the RFC 9162 path as base64
  32-byte hashes. Log entries for `verify_inclusion` are borsh `LogEntry`, base64; `index` and
  `size` are decimal strings.
- **Player index** in a verdict = position in the match's player list, which is kept sorted by
  account id (UTF-8 byte order), the same order `players_hash` and the ring use. `get_match().players[i]`
  is index `i`.

## Methods

| Method                                                                                                                                                                                        | Who                                                                                                                            | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new(owner, referee_pk, vrf_pk, vrf_sender, allowed_tokens)`                                                                                                                                  | deploy tx                                                                                                                      | Keys are 32-byte ed25519 hex. Small-order, mixed-order and non-canonical keys are refused. `vrf_sender` is the account OutLayer names as `sender` in the VRF alpha (the referee's OutLayer caller). Call it in the same transaction as the deploy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `migrate(vrf_sender)`                                                                                                                                                                         | owner, or the contract account itself                                                                                          | Upgrades the first state layout (the one deployed) in place: keeps every balance, payout, match and checkpoint, pins `vrf_sender`, and adds the play records and verdict heads. Deploy and migrate in one transaction (`deploy.ts --upgrade --migrate`). A second call fails. Matches created before it have no play record or verdict head: they take no more verdicts and settle by `abort`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `set_referee_pk(referee_pk)`, `set_vrf_pk(vrf_pk)`, `set_vrf_sender(vrf_sender)`                                                                                                              | owner, 1 yocto                                                                                                                 | Same key check. Only matches created afterwards use the new value. A match keeps the keys and VRF sender it was created with.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `register_for(account_id, payout_account)`                                                                                                                                                    | the account itself or its direct parent, attach exactly `get_config().registration_deposit`                                    | Registers the account, sets where `withdraw` pays it and mints its Dossier (below). The deposit pays for the payout record, one balance record per allowed token and the largest dossier. Required before credit, join or sponsor. The payout cannot be this contract or an allowed token contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `set_payout(account_id, payout_account)`                                                                                                                                                      | the account itself or its current payout account, 1 yocto                                                                      | Repoints the payout. The 1 yocto keeps it off function-call keys, so a stolen player key cannot redirect winnings. Relay-created player accounts hold only a function-call key and cannot call it; they name a wallet once through `withdraw`'s `to`, and that wallet can repoint it from then on. The payout cannot be this contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ft_on_transfer(sender_id, amount, msg)`                                                                                                                                                      | allowed token                                                                                                                  | `{"credit":"<account>"}` adds to that account's balance. `{"sponsor":"<match id>"}` adds to a lobby's sponsor pot (the sender must be a sponsor the host named). Returns `"0"` when accepted, the full amount when refused (unregistered account or sponsor, unnamed sponsor, unknown or started match, wrong token, bad msg). Other tokens panic.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `withdraw(token, amount, to?) -> bool`                                                                                                                                                        | registered, at least `get_config().withdraw_min_gas` (50) Tgas                                                                 | Refused below 50 Tgas. If the payout is the caller itself (a player account with only a function-call key would strand the tokens), `to` is required and this withdraw goes there; `to` becomes the payout for good only when that transfer succeeds (a mistyped or unregistered wallet leaves the payout unset, so the player can name another), and only if no other withdraw named one first. `to` cannot be this contract or an allowed token contract. Otherwise `to` must be absent or equal the payout. Debits the balance, then `ft_transfer`s to the payout account with 1 yocto the contract attaches itself (20 Tgas). A `#[private]` callback `on_withdraw` (10 Tgas; the refund path burned 1.69 Tgas on testnet) restores the balance if the transfer fails. The final result is `true` when paid and `false` when refunded. The payout account must be `storage_deposit`ed on the token. |
| `create_match(cfg) -> "<match id hex>"`                                                                                                                                                       | anyone (host), attach exactly `get_config().match_storage_deposit`                                                             | `cfg = {token, stake, duration_ms, zone_hash, public_replay, min_players, max_players, start_by_ms, invites?, sponsors?, requires?}`. Limits: 3 ≤ min ≤ max ≤ 12, 0 < duration ≤ 1 h, `now < start_by_ms ≤ now + 7 days`, up to 12 invites, up to 4 sponsors (no duplicates). `invites` empty means any registered account may join. `sponsors` empty means there is no pot. `requires = {min_matches, min_survived}` (both default 0) is the access rule: who may join, by their dossier. Stake 0 is allowed, and at most `MAX_STAKE` (`u128::MAX / 40,000`), so a hint price can never overflow.                                                                                                                                                                                                                                                                                                      |
| `set_invites(match_id, invites)`                                                                                                                                                              | host                                                                                                                           | Lobby only, before the lock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `join_match(match_id)`                                                                                                                                                                        | registered player                                                                                                              | Lobby only: not after the lock, not after `start_by_ms`, invited if there is a list, and a dossier with at least `requires.min_matches` settled matches and `requires.min_survived` survived (refused: "your dossier is below this match's requires: …"; an account without a dossier, one registered before dossiers existed, reads as an empty record, so it clears `{0, 0}` and nothing higher). Refused for a lobby created before the upgrade (it can never start). Moves `stake` from balance to head.                                                                                                                                                                                                                                                                                                                                                                                            |
| `lock_lobby(match_id)`                                                                                                                                                                        | host, once                                                                                                                     | Needs at least `min_players`. Closes joins for good and leaves for `LOCK_MS` (10 min). `Start` only lands while the lock holds. Refused for a lobby created before the upgrade; such a lobby takes no sponsor money either, and settles by `abort`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `leave_lobby(match_id)`                                                                                                                                                                       | player                                                                                                                         | Lobby only, not while locked. Head back to balance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `apply(verdicts: [base64 SignedVerdict], proofs?: [{seq, from_size, path}])`                                                                                                                  | anyone                                                                                                                         | Applies the verdicts in order. If one is refused, the whole call is refused. `proofs` has exactly one consistency proof per Checkpoint and End in the call, matched by seq; a missing, duplicate or unused proof refuses the call. Checkpoints and Ends of two matches in one call cannot share a seq.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `abort(match_id)`                                                                                                                                                                             | anyone                                                                                                                         | See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `get_config()`, `get_match(match_id)`, `get_heads(match_id)`, `get_balance(account_id, token)`, `get_payout(account_id)`, `get_roots(match_id)`                                               | view                                                                                                                           | `get_config` includes `vrf_sender`, `withdraw_min_gas` (Tgas), `verdict_grace_ms`, `checkpoint_spacing_ms`, `dossier_deposit` and `dossier_entries`. `get_match` includes the match's pinned `vrf_sender` (`null` for a match from before `migrate`), `hint_pool`, `requires`, `settled_as` (`payout`, `refunded_rule_violation`, `refunded_abort`, `payout_unreplayed` for a match the code before the upgrade ended without a replay, or `null` while unsettled) and `violation` (the first rule End's replay found broken, else `null`). `get_roots` returns `{checkpoints: [{log_size, root}], final_root}`.                                                                                                                                                                                                                                                                                        |
| `get_verdict_head(match_id) -> {seq, digest} \| null`                                                                                                                                         | view                                                                                                                           | The last applied seq and its verdict digest (hex; seq 0 and zeros before `Start`). A client holding the same digest at that seq has seen the same verdict history. `null` for an unknown match or one from before `migrate`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `verify_inclusion(match_id, entry, index, size, path) -> bool`                                                                                                                                | view                                                                                                                           | Hashes `entry` (borsh `LogEntry`) as the RFC 9162 leaf `SHA256(0x00 ‖ entry)` on-chain, takes the root the match anchored at exactly `size` entries (a checkpoint's or the final one) and checks the audit `path` (base64 32-byte hashes) for leaf `index`. `false` if no root has that size, the bytes are not a `LogEntry`, or the path does not verify.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `get_dossier(account_id) -> DossierView \| null`                                                                                                                                              | view                                                                                                                           | The player's record: `{account_id, seed, matches, survived, tags, forfeits, refunded, won, entries}`. Counts cover settled (paid-out) matches only, `refunded` counts the rest; `won` is everything those matches paid the player, their own stake coming back included, in the match tokens' smallest units. `entries` are the newest `DOSSIER_ENTRIES` (12), newest first: `{match_id, result: survived\|tagged\|forfeit\|refunded, tags, payout, log_size, root}`, the root being the last one the match anchored (End's, or the last checkpoint's on an abort). `seed` is `SHA256(account_id)`, the card's only randomness.                                                                                                                                                                                                                                                                         |
| `mint_dossier(account_id)`                                                                                                                                                                    | the account itself, its direct parent (the relay, for its players) or the owner; attach exactly `get_config().dossier_deposit` | For an account registered before dossiers existed: mints its dossier, the caller paying its storage. A relay player's function-call key cannot attach a deposit, so the relay backfills it. Refused for an unregistered account or one that has a dossier.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `nft_token(token_id)`, `nft_metadata()`, `nft_total_supply()`, `nft_tokens(from_index?, limit?)`, `nft_supply_for_owner(account_id)`, `nft_tokens_for_owner(account_id, from_index?, limit?)` | view                                                                                                                           | NEP-171 core, NEP-177 metadata and NEP-181 enumeration for the dossiers (below). `nft_token` takes any string and returns `null` for one that is not an account id. `nft_tokens` returns at most 10 per call (`MAX_TOKENS_PER_PAGE`, see Storage and gas), in mint order.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `nft_transfer(…)`, `nft_transfer_call(…)`                                                                                                                                                     | anyone                                                                                                                         | Always refused: "a dossier is bound to the player who earned it". `nft_resolve_transfer` exists for NEP-171 but nothing schedules it; it returns `false` (not transferred).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Player function-call keys need these methods: `join_match`, `leave_lobby`, `withdraw`.

## Lobby flow

1. The host (the relay account) calls `create_match`. For a friends lobby it passes `invites`. For
   a Commons pot it passes `sponsors`.
2. Players join. The relay sends the locked player list to the referee.
3. The host calls `lock_lobby`. From then on the player list cannot change.
4. The referee signs `Start` over that list, and someone calls `apply` within the 10-minute lock.
5. If the lock runs out without a `Start`, players may leave and anyone may abort the lobby. The
   host makes a new match.

## Verdict rules

Every verdict needs `seq == last + 1`, `prev` equal to the digest of the match's last applied
verdict (zeros for seq 1) and a valid signature from the match's pinned referee key. So once a
verdict lands at some seq, no other verdict for that seq, and nothing signed on top of one, can
land. Anything other than `Start` needs the match to be running. Hint, Tag and Forfeit land until
block time reaches `end_ms + VERDICT_GRACE_MS` (15 min, the moment the overdue abort opens). A late
verdict (OutLayer slow or down at the end, relay retries) must still land before then, since verdicts
are ordered and the End behind it would otherwise be stuck; after it nothing that moves a head is
needed, because an abort refunds the original stakes whatever the heads are.

| Verdict                                                         | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Start`                                                         | All of: the match is in the lobby and not past `start_by_ms`; the lock is still active; min ≤ players ≤ max; `players_hash == players_hash(joined)`; `start_ms` is within 5 min of the block time; `end_ms - start_ms == duration_ms`. Stores `ring_commit`, `start_ms`, `end_ms`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Hint {from, amount, hint_id, hint, t_ms}`                      | `from` is in, `hint` is a known kind, `start_ms ≤ t_ms ≤ end_ms` and `t_ms` ≥ the previous hint's (hints of one tick share a time), `amount == hint_price(stake, hint, recent_hints(earlier hints' t_ms, t_ms))` from `tail_protocol::pricing`: the base price (NEAR and TREND 2 %, BEARING 5 % of the stake) plus 25 % for each hint anyone in the match bought in the 5 minutes of match time up to `t_ms`, at most 4x, each division rounded down. `from`'s head ≥ amount, and the match has charged fewer than `MAX_HINTS` (240). Moves `amount` from `from`'s head into the hint pool and records `(from, amount, t_ms)`. The verdict does not name whom the hint was about. So the referee cannot charge more than the pricing rule allows for the times it states (at most 4x); tail-verify's re-execution checks the times.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Tag {hunter, target, credit}` / `Forfeit {player, to, credit}` | Both players are in and different, and `credit` ≤ the hint pool. `credit` moves from the pool onto the loser's head, then the loser's whole head goes to the winner, and the loser is marked out. The event is recorded for the replay at `End` (at most 11 per match).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `Checkpoint {log_size, root}`                                   | The k-th checkpoint needs `k × CHECKPOINT_SPACING_MS` (30 s, half the referee's cadence) of match time since `start_ms`, counted no further than `end_ms`, so a match never holds more than `MAX_CHECKPOINTS` (120). `log_size` must be larger than the previous checkpoint's (and than 0: an empty log is no checkpoint). Its proof must start at the last anchored size (the previous checkpoint's, or 0 with the empty root `SHA256("")` for the first) and verify (`verify_consistency_with` on the `env::sha256` host function) from that root to this one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `End {alpha, vrf_signature, log_size, root, hint_targets}`      | Refused unless: `ring_commit == SHA256("tail/ring" ‖ vrf_signature)`; `alpha` is exactly `vrf:{request_id}:{sender}:{seed}` with a non-empty request id, `seed` = the match id in lowercase hex (TECHNICAL 4.8) and `sender` = the match's pinned `vrf_sender`; `ed25519_verify(vrf_signature, alpha, match.vrf_pk)`; before `end_ms` only with exactly one survivor; `log_size` ≥ the last checkpoint's, with a consistency proof from the last checkpoint (or size 0) to the final root, as for a Checkpoint (at the same size the roots must be equal; an End of an empty log must name `SHA256("")`). Then the replay (`tail_protocol::settle::replay`): the ring is rebuilt from `vrf_signature` and every recorded Hint, Tag and Forfeit is replayed in order. Each Tag winner must be hunting the loser, each Forfeit must pay the forfeiter's hunter (the winner then hunts the loser's target), each hint's target (`hint_targets[k]` for the k-th hint) must be its asker's target then, each credit must equal the hints paid onto the loser and not yet credited, and what the survivors are owed must equal the pool. If it holds: each survivor gets what they are owed, every head goes to its balance, and the pot is split equally among survivors (the first `pot % survivors` in index order get 1 more unit each); `settled_as: "payout"`. If it fails: the End still lands, every player is credited their original stake and every sponsor their contribution, `settled_as: "refunded_rule_violation"` with `violation`, and a `match_refunded` event is logged. Either way the reveal and the final root are stored. A refused End leaves the match to `abort`; an End refused only for being early can be resubmitted once block time reaches `end_ms`. |

## Abort (the refund path)

Anyone can abort:

- a lobby after `start_by_ms`, or once its lock ran out without a `Start`;
- a lobby created before the upgrade, at any time: it has no play record, so it can never start;
- a running match with no verdict for `REFEREE_TIMEOUT_MS` (15 min);
- a running match at or after `end_ms + REFEREE_TIMEOUT_MS`. `end_ms` is close to real time,
  because `Start` must land within 5 min of its `start_ms`.

Abort credits every player their original stake (not the current heads: nothing that happened
during play was checked against the ring) and every sponsor contribution back to its sponsor.
Hint money in the pool goes back with the stakes. All credits go to internal balances, and
`get_match` shows `settled_as: "refunded_abort"`. A running match's abort also logs a
`match_refunded` event and adds a `refunded` entry to each player's dossier (logging an
`nft_metadata_update`, below); a lobby that never started adds and logs nothing.

## Dossier (NEP-171, soulbound)

Every registered player holds one NFT, minted by `register_for`: `token_id` is the player's
account id and `owner_id` is that account. NEAR player accounts are already sub-accounts the relay
creates (`<handle>.<relay>`), so the token is the account's own credential, not something it holds
for a while. Its metadata (NEP-177) is computed on every read from what the contract settled:

- `title` "`<handle>`'s dossier"; `description` the counts in words; `copies` 1; `issued_at` the
  registration time and `updated_at` the last settlement (ms, as strings);
- `extra`: JSON `{matches, survived, tags, forfeits, refunded, won, page}`, where `page` is
  `/dossier/<account>` on the replay site (`apps/web`), a path relative to wherever that is hosted;
- `media`: the card as `data:image/svg+xml;base64,…`, built by `src/art.rs` on every read, so it
  changes as the record grows and needs no hosting; `media_hash` is the SHA-256 of the SVG. The
  card is the player's trail: a winding route seeded from `SHA256(account_id)`, one segment per
  kept entry (a persimmon dot for a survival, a ring for a tag-out, a slashed ring for a forfeit,
  a tick for each tag landed, a dashed grey segment for a refund) and the Trail mark at its head.
  It is at most 4 KB, uses no external fonts or images, and is byte-identical to `dossierSvg` in
  `packages/brand/src/dossier.ts`: `packages/brand/vectors/dossier.json` pins both builders, and
  both test suites check it.

Each settlement adds one entry per player who holds a dossier: End's payout (survived, tagged or
forfeit, with the tags landed and what was paid), End's refund for a broken rule, and the abort of
a running match (both `refunded`). The counts (`matches`, `survived`, `tags`, `forfeits`, `won`)
cover paid-out matches only; a refunded match is on the record and counts for nothing. The record
keeps the newest `DOSSIER_ENTRIES` (12) entries and running totals, so it never grows past what
registration paid for. The totals saturate at their largest value instead of overflowing, so
recording a settlement can never make End or abort fail.

**Events.** Minting (`register_for` or `mint_dossier`) logs NEP-171's `nft_mint`. Since the
metadata is computed on read, a settlement changes it without any transfer, so each settlement
that changed at least one dossier logs one NEP-171 `nft_metadata_update` naming those tokens in
player order, and an indexer or wallet that cached a card knows to fetch it again. Both use
version 1.2.0, the NEP-171 version that defines `nft_metadata_update`:
`EVENT_JSON:{"standard":"nep171","version":"1.2.0","event":"nft_metadata_update","data":[{"token_ids":["alice.testnet","bob.testnet","carol.testnet"]}]}`.

**Access rights.** `create_match` takes `requires: {min_matches, min_survived}`, and `join_match`
refuses a player whose dossier is below it. A host can open a match to players with a record
(say three settled matches, one survived) without a list of names.

**Soulbound.** `nft_transfer` and `nft_transfer_call` always panic with "a dossier is bound to the
player who earned it", whoever calls and whatever is attached, and there are no approvals
(NEP-178), so no marketplace can move one. Threat model: a dossier is an access credential, so if
it could move, a record could be bought or rented to get into a gated match, and the gate would
measure money rather than play; binding it to the account that played makes the count mean "this
account played these matches". It does not stop the account itself from changing hands: whoever
holds a player account's keys plays as it and carries its record (the relay's player accounts
hold only a function-call key kept on one phone, and App Attest ties each match's enrolment to a
real iPhone running the app, which makes lending an account a matter of lending the phone). Nor
does it stop farming: a group can play many small matches among themselves to build records. Each
counted match had to be started, played and ended by the pinned referee and pass the End replay,
so a farmed record still costs real matches on real phones; with the local test referee pinned,
it costs only that machine's cooperation. Refunded matches never count. Accounts registered
before dossiers existed have none (their registration did not pay for one) until the relay (their
parent), the owner or the account itself calls `mint_dossier` and pays for it; settlements add
nothing for them until then, and `requires` reads them as an empty record.

## Invariant

For each match, `sum(heads) + hint_pool + sponsor_pot` is constant from `Start` until `End` or
`abort`, and all three are 0 after settlement. A payout pays out exactly that total; a refund pays
every stake and every sponsor. For each token, all internal balances plus all heads and pots equal
the tokens accepted by `ft_on_transfer` minus the tokens paid by `withdraw`. A withdraw in flight
counts as paid until its callback refunds it. A unit test checks both after every step of 4,800
random operations: credits, bad messages, withdraws that succeed or fail, lobbies, locks, joins,
leaves, named and unnamed sponsors, every verdict kind, off-ring Tags (whose End must refund the
match), and aborts.

## Storage and gas

Every byte is paid for up front, and nothing allocates storage later:

- `register_for` charges `PAYOUT_RECORD_BYTES + BALANCE_RECORD_BYTES × allowed tokens +
  DOSSIER_RECORD_BYTES` (180 + 2 × 200 + 1,200 = 1,780 bytes, 0.0178 NEAR). The dossier bound is
  the largest record (a 64-character id, 12 entries at 74 bytes, the totals) plus its place in the
  token list; a unit test builds it and measures 1,166 bytes. `mint_dossier` charges
  `DOSSIER_RECORD_BYTES` alone. It writes a zero balance for every allowed token right away. Debits
  leave the record at 0 instead of removing it. A credit, an End payout or a failed-withdraw
  refund therefore only ever overwrites an existing record. The allowed tokens are fixed at `new`,
  so registration covers them all. A maximal registration (64-character ids) measures 563 bytes.
- `create_match` charges `MATCH_STORAGE_BYTES` (15,200 bytes, 0.152 NEAR). That is the most a
  match can ever store: 12 players, 12 invites and 4 sponsors with 64-character ids, a 192-byte
  alpha, 120 checkpoints, a play record (64-character VRF sender, `MAX_HINTS` = 240 hints at 27
  bytes with their times, 11 eliminations at 21 bytes, the pool, a violation and `requires`) and
  the verdict head (written at creation). A unit test builds that maximal match and measures
  14,920 bytes. Matches are kept after settlement for the replay.
- Gas on testnet (e2e, before the End replay, alpha parsing and timing rules), one verdict per
  `apply`: the contract receipt burned 2.0 to 2.7 Tgas (Start 2.00, Hint 1.96, Tag 1.96,
  Checkpoint 2.14, End 2.65). The current code has not been measured on testnet yet; End now also
  rebuilds the ring (up to 12 SHA-256) and replays up to 251 events, and Checkpoint and End verify
  a proof. Each Hint, Tag and Forfeit rewrites the play record (up to about 4.9 KB with 240
  hints). Batches were not measured.
- Proofs, host-function gas only (the unit-test VM does not meter wasm instructions), over a
  15,013-entry log: `apply` of one Checkpoint with its 13-hash proof from 14,750 entries 0.57 Tgas
  (a Hint alone 0.22 Tgas); `verify_inclusion` with a 14-hash path 0.26 Tgas; `End` of a maximal
  match (240 hints, 11 tags, a 1-hash proof, 12 players with 64-character ids) 0.85 Tgas: 0.56
  as before the replay (the replay itself is wasm the unit-test VM does not meter) and 0.29 for
  logging its 909-byte `nft_metadata_update`. The e2e prints the real receipt gas of `End` with
  its proof.
- Wasm: 392 KB, so about 3.9 NEAR of storage for the code (it was 318 KB before demand pricing,
  the dossiers and their card builder). The curve check for keys adds 24 KB; the proof checks and
  `LogEntry` decoding about 22 KB.
- End and a running match's abort also rewrite each player's dossier (up to 12 records of about
  1 KB). Their logs stay small: with 12 players of 64-character ids, `nft_metadata_update` is
  909 bytes, and with a refund's `match_refunded` (at its longest violation text) a settlement
  logs 2 lines and at most 1,170 bytes, against NEAR's 100 logs and 16 KiB per receipt (a unit
  test measures it).
- A view of `nft_token` builds the card (an SVG of at most 4 KB, base64 and SHA-256 on the
  host). `nft_tokens` builds one card per token, so a page is at most 10. A unit test measures ten
  maximal cards: 1.47 Tgas of host functions and about 10.5 KB written per card (the SVG, then
  6.4 KB of JSON holding its base64). The unit-test VM does not meter wasm instructions; at NEAR's
  822,756 gas per instruction and an assumed 200 instructions per byte written, a page comes to
  about 20 Tgas, well under the 300 Tgas an RPC node allows a view. Not measured on chain.

## Trust notes

- The contract account has a full-access key (in `.keys/`, used for redeploys). Whoever holds it
  can replace the code. Delete that key to lock the code.
- The owner can rotate the referee and VRF keys only for matches created afterwards.
- Match ids mix in a salt taken from the block's random seed at `new`. A contract recreated on
  the same account never repeats an id, so an old signed verdict cannot apply to a new match.
- The contract checks that the VRF output is OutLayer's for this match's seed and was requested
  by the pinned `vrf_sender`, that the `Start` commitment matches it, and that every Tag,
  Forfeit and hint followed the ring it yields before any of the match's money is paid out. It cannot stop the referee (the pinned sender) from
  requesting several VRF outputs for the same seed and picking one (OutLayer request ids differ).
- The End replay proves who hunted whom and whom each hint was about, not that a Tag's proximity
  evidence was real: that part is still the referee's word. A referee that breaks a rule cannot
  move money with it, but it can force a refund.
- The consistency proofs show that every anchored root extends the one before, so the referee
  cannot drop or rewrite an entry once a root covering it is on-chain. They say nothing about
  whether the entries are true.

## Run

```sh
cd contracts/tail
cargo test                                   # 256 unit tests: golden vectors (wire and dossier card), review regressions, proofs, property test
cargo clippy --all-targets -- -D warnings && cargo fmt --check
cargo near build non-reproducible-wasm       # target/near/tail_contract.wasm
cd e2e && bun install
bun run e2e.ts                               # testnet, on a throwaway contract; reads the repo-root .env.local
bun run deploy.ts --upgrade                  # new code on the live contract, state kept (layout must not change)
bun run deploy.ts --upgrade --migrate        # new code and migrate(vrf_sender) in one transaction (layout changed)
bun run deploy.ts --fresh                    # recreates the live contract pinned to the real referee keys (wipes it)
```

`e2e.ts` creates `tail-e2e-<run>.<NEAR_RELAY_ACCOUNT>` and pins a local test referee key and a
stand-in VRF key on it (`.keys/tail-e2e-*.json`, never printed), with the parent as VRF sender. It
then:

1. creates three player accounts with function-call keys and registers them through the parent;
2. tops them up and opens an invite-only lobby with the parent as named sponsor (11 units);
3. has the players join, then locks the lobby;
4. applies Start (dated 4.5 min back, so the 4-min match is past `end_ms` when End lands), Hint
   (into the pool at its base price, dated one minute into the match), a Tag by the ring's hunter of player 1 with its credit, Checkpoint and End
   naming the hint's target, each chained to the one before, the
   Checkpoint and End with consistency proofs over a stand-in log of 99 entries (built with
   `@tail/protocol`'s `consistencyProof`), then checks `get_verdict_head` and `verify_inclusion`;
5. checks heads and balances, and each player's dossier (one entry from this match: survived,
   tagged, survived), `nft_token`'s on-chain card, and that `nft_transfer` is refused;
6. withdraws: a player whose payout is itself names a wallet once (paid there), and one is
   refunded because the payout account is not registered on the token.

The demand-priced Hint, the dossier checks and the `nft_metadata_update` event were added after
the last testnet run of `e2e.ts` and have only run in the unit tests so far (`e2e.ts` does not
check the NEP-171 events).

It also checks that each of these is refused: an unregistered join, an uninvited join, a leave
from a locked lobby, a forged verdict, a replayed verdict, a verdict with the wrong `prev`, a hint
at the wrong price, a Checkpoint without a proof, an End proved from the wrong size, and an
over-balance withdraw. At the
end it deletes the throwaway account, and its NEAR goes back to the parent. A run costs the parent
about 0.4 NEAR (three player accounts plus the deposits). It never touches the live contract.

`deploy.ts` takes the referee key from the referee's `pubkeys` command and checks the VRF key
against OutLayer's `/vrf/pubkey`.

- `--upgrade` deploys new code in place with the account's full-access key, keeps all state, then
  checks the on-chain code hash and that the real keys are still pinned.
- `--fresh` deletes and recreates `tail.<NEAR_RELAY_ACCOUNT>`, which wipes its state, then
  registers the contract on both allowed tokens.
