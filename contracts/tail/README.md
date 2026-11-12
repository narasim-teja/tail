# tail contract

near-sdk 5.30.1 contract for TAIL's custody and settlement. Money enters only through NEP-141
`ft_transfer_call` and leaves only through `withdraw`. Inside a match, heads move only when `apply`
accepts a verdict signed by the referee key the match pinned at creation. `abort` refunds a match
whose referee went quiet.

Testnet: `tail.tail-dev-a38d13.testnet`, deployed by `e2e/deploy.ts`. It pins the referee
enclave's verdict key `e1c64271…7d6c56` and OutLayer's testnet VRF key `c0c5aeae…f8cfa8`.

## Encoding

- Fixed-size bytes in JSON (match id, hashes, public keys, signatures) are lowercase hex.
  Amounts are decimal strings (`U128`). Times are unix ms as JSON numbers.
- A verdict is borsh `SignedVerdict { match_id: [u8;16], seq: u32, call_id: [u8;16], body: Verdict, sig: [u8;64] }`
  from `crates/tail-protocol`, base64 in JSON. `sig` is ed25519 over
  `SHA256("tail/verdict/v1" ‖ borsh(VerdictPayload { match_id, seq, call_id, body }))`.
- **Player index** in a verdict = position in the match's player list, which is kept sorted by
  account id (UTF-8 byte order), the same order `players_hash` and the ring use. `get_match().players[i]`
  is index `i`.

## Methods

| Method                                                                                                                                          | Who                                                                                         | Does                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new(owner, referee_pk, vrf_pk, allowed_tokens)`                                                                                                | deploy tx                                                                                   | Keys are 32-byte ed25519 hex. Small-order, mixed-order and non-canonical keys are refused. Call it in the same transaction as the deploy.                                                                                                                                                                                                                                             |
| `set_referee_pk(referee_pk)`, `set_vrf_pk(vrf_pk)`                                                                                              | owner, 1 yocto                                                                              | Same key check. Only matches created afterwards use the new key. A match keeps the keys it was created with.                                                                                                                                                                                                                                                                          |
| `register_for(account_id, payout_account)`                                                                                                      | the account itself or its direct parent, attach exactly `get_config().registration_deposit` | Registers the account and sets where `withdraw` pays it. The deposit pays for the payout record and one balance record per allowed token. Required before credit, join or sponsor. The payout cannot be this contract.                                                                                                                                                                |
| `set_payout(account_id, payout_account)`                                                                                                        | the current payout account                                                                  | Repoints the payout. Do not put this method on a player's function-call key when the player is its own payout account.                                                                                                                                                                                                                                                                |
| `ft_on_transfer(sender_id, amount, msg)`                                                                                                        | allowed token                                                                               | `{"credit":"<account>"}` adds to that account's balance. `{"sponsor":"<match id>"}` adds to a lobby's sponsor pot (the sender must be a sponsor the host named). Returns `"0"` when accepted, the full amount when refused (unregistered account or sponsor, unnamed sponsor, unknown or started match, wrong token, bad msg). Other tokens panic.                                    |
| `withdraw(token, amount) -> bool`                                                                                                               | registered                                                                                  | Debits the balance, then `ft_transfer`s to the payout account with 1 yocto the contract attaches itself (20 Tgas). A `#[private]` callback `on_withdraw` (5 Tgas) restores the balance if the transfer fails. The final result is `true` when paid and `false` when refunded. Call it with 50 Tgas. The payout account must be `storage_deposit`ed on the token.                      |
| `create_match(cfg) -> "<match id hex>"`                                                                                                         | anyone (host), attach exactly `get_config().match_storage_deposit`                          | `cfg = {token, stake, duration_ms, zone_hash, public_replay, min_players, max_players, start_by_ms, invites?, sponsors?}`. Limits: 3 ≤ min ≤ max ≤ 12, 0 < duration ≤ 1 h, `now < start_by_ms ≤ now + 7 days`, up to 12 invites, up to 4 sponsors (no duplicates). `invites` empty means any registered account may join. `sponsors` empty means there is no pot. Stake 0 is allowed. |
| `set_invites(match_id, invites)`                                                                                                                | host                                                                                        | Lobby only, before the lock.                                                                                                                                                                                                                                                                                                                                                          |
| `join_match(match_id)`                                                                                                                          | registered player                                                                           | Lobby only: not after the lock, not after `start_by_ms`, invited if there is a list. Moves `stake` from balance to head.                                                                                                                                                                                                                                                              |
| `lock_lobby(match_id)`                                                                                                                          | host, once                                                                                  | Needs at least `min_players`. Closes joins for good and leaves for `LOCK_MS` (10 min). `Start` only lands while the lock holds.                                                                                                                                                                                                                                                       |
| `leave_lobby(match_id)`                                                                                                                         | player                                                                                      | Lobby only, not while locked. Head back to balance.                                                                                                                                                                                                                                                                                                                                   |
| `apply(verdicts: [base64 SignedVerdict])`                                                                                                       | anyone                                                                                      | Applies the verdicts in order. If one is refused, the whole call is refused.                                                                                                                                                                                                                                                                                                          |
| `abort(match_id)`                                                                                                                               | anyone                                                                                      | See below.                                                                                                                                                                                                                                                                                                                                                                            |
| `get_config()`, `get_match(match_id)`, `get_heads(match_id)`, `get_balance(account_id, token)`, `get_payout(account_id)`, `get_roots(match_id)` | view                                                                                        | `get_roots` returns `{checkpoints: [{log_size, root}], final_root}`.                                                                                                                                                                                                                                                                                                                  |

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

Every verdict needs `seq == last + 1` and a valid signature from the match's pinned referee key.
Anything other than `Start` needs the match to be running.

| Verdict                                         | Rule                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Start`                                         | All of: the match is in the lobby and not past `start_by_ms`; the lock is still active; min ≤ players ≤ max; `players_hash == players_hash(joined)`; `start_ms` is within 5 min of the block time; `end_ms - start_ms == duration_ms`. Stores `ring_commit`, `start_ms`, `end_ms`.                                                                                                                                       |
| `Hint {from, to, amount}`                       | Both players are in and different, and `from`'s head ≥ amount. Moves `amount`.                                                                                                                                                                                                                                                                                                                                           |
| `Tag {hunter, target}` / `Forfeit {player, to}` | Both players are in and different. The loser's whole head goes to the winner, and the loser is marked out.                                                                                                                                                                                                                                                                                                               |
| `Checkpoint {log_size, root}`                   | Appended, up to `MAX_CHECKPOINTS` (120). One more is refused, and the match then can only be aborted.                                                                                                                                                                                                                                                                                                                    |
| `End {alpha, vrf_signature, log_size, root}`    | `ring_commit == SHA256("tail/ring" ‖ vrf_signature)`, the last `:`-field of `alpha` is the match id in lowercase hex (the ring seed, TECHNICAL 4.8), and `ed25519_verify(vrf_signature, alpha, match.vrf_pk)`. Every player's head goes to their balance. The pot is split equally among survivors, and the first `pot % survivors` survivors in index order get 1 more unit each. Stores the reveal and the final root. |

## Abort (the refund path)

Anyone can abort:

- a lobby after `start_by_ms`, or once its lock ran out without a `Start`;
- a running match with no verdict for `REFEREE_TIMEOUT_MS` (15 min);
- a running match at or after `end_ms + REFEREE_TIMEOUT_MS`. `end_ms` is close to real time,
  because `Start` must land within 5 min of its `start_ms`.

Abort credits every current head to its player and every sponsor contribution back to its
sponsor. All credits go to internal balances.

## Invariant

For each match, `sum(heads) + sponsor_pot` is constant from `Start` until `End` or `abort`, and
both are 0 after settlement. For each token, all internal balances plus all heads and pots equal
the tokens accepted by `ft_on_transfer` minus the tokens paid by `withdraw`. A withdraw in flight
counts as paid until its callback refunds it. A unit test checks both after every step of 4,800
random operations: credits, bad messages, withdraws that succeed or fail, lobbies, locks, joins,
leaves, named and unnamed sponsors, every verdict kind, and aborts.

## Storage and gas

Every byte is paid for up front, and nothing allocates storage later:

- `register_for` charges `PAYOUT_RECORD_BYTES + BALANCE_RECORD_BYTES × allowed tokens` (180 + 2 × 200
  = 580 bytes, 0.0058 NEAR). It writes a zero balance for every allowed token right away. Debits
  leave the record at 0 instead of removing it. A credit, an End payout or a failed-withdraw
  refund therefore only ever overwrites an existing record. The allowed tokens are fixed at `new`,
  so registration covers them all. A maximal registration (64-character ids) measures 563 bytes.
- `create_match` charges `MATCH_STORAGE_BYTES` (8,000 bytes, 0.08 NEAR). That is the most a
  match can ever store: 12 players, 12 invites and 4 sponsors with 64-character ids, a 192-byte
  alpha, and 120 checkpoints. A unit test builds that maximal match and measures 7,959 bytes.
  Matches are kept after settlement for the replay.
- Gas on testnet (e2e), one verdict per `apply`: the contract receipt burns 2.0 to 2.7 Tgas
  (Start 2.00, Hint 1.96, Tag 1.96, Checkpoint 2.14, End 2.65). Batches were not measured.
- Wasm: 271 KB, so about 2.7 NEAR of storage for the code. The curve check for keys adds 24 KB.

## Trust notes

- The contract account has a full-access key (in `.keys/`, used for redeploys). Whoever holds it
  can replace the code. Delete that key to lock the code.
- The owner can rotate the referee and VRF keys only for matches created afterwards.
- Match ids mix in a salt taken from the block's random seed at `new`. A contract recreated on
  the same account never repeats an id, so an old signed verdict cannot apply to a new match.
- The contract checks that the VRF output is OutLayer's for this match's seed, and that the
  `Start` commitment matches it. It cannot stop the referee from requesting several VRF outputs
  for the same seed and picking one (OutLayer request ids differ).

## Run

```sh
cd contracts/tail
cargo test                                   # 113 unit tests: golden vectors, review regressions, property test
cargo clippy --all-targets -- -D warnings && cargo fmt --check
cargo near build non-reproducible-wasm       # target/near/tail_contract.wasm
cd e2e && bun install
bun run e2e.ts                               # testnet, on a throwaway contract; reads the repo-root .env.local
bun run deploy.ts --fresh                    # recreates the live contract pinned to the real referee keys
```

`e2e.ts` creates `tail-e2e-<run>.<NEAR_RELAY_ACCOUNT>` and pins a local test referee key and a
stand-in VRF key on it (`.keys/tail-e2e-*.json`, never printed). It then:

1. creates three player accounts with function-call keys and registers them through the parent;
2. tops them up and opens an invite-only lobby with the parent as named sponsor (11 units);
3. has the players join, then locks the lobby;
4. applies Start, Hint, Tag, Checkpoint and End;
5. checks heads and balances, then withdraws: one paid, one refunded because the payout account is
   not registered on the token.

It also checks that each of these is refused: an unregistered join, an uninvited join, a leave
from a locked lobby, a forged verdict, a replayed verdict, and an over-balance withdraw. At the
end it deletes the throwaway account, and its NEAR goes back to the parent. A run costs the parent
about 0.4 NEAR (three player accounts plus the deposits). It never touches the live contract.

`deploy.ts --fresh` deletes and recreates `tail.<NEAR_RELAY_ACCOUNT>`, which wipes its state. It
takes the referee key from the referee's `pubkeys` command and checks the VRF key against
OutLayer's `/vrf/pubkey`. It then registers the contract on both allowed tokens.
