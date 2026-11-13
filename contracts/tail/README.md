# tail contract

near-sdk 5.30.1 contract for TAIL's custody and settlement. Money enters only through NEP-141
`ft_transfer_call` and leaves only through `withdraw`. Inside a match, heads move only when `apply`
accepts a verdict signed by the referee key the match pinned at creation. Each verdict names the
digest of the one before it, so a match has one verdict chain and a forked stream cannot land.
Each Checkpoint and End carries an RFC 9162 consistency proof from the last anchored log root, so
the anchored roots form one append-only log, and `verify_inclusion` checks a log entry against
them on-chain. At `End` the contract rebuilds the ring from the revealed VRF output and refuses the
match unless every Tag and Forfeit followed it. `abort` refunds a match whose referee went quiet.

Testnet: `tail.tail-dev-a38d13.testnet`, deployed by `e2e/deploy.ts`. It pins the referee
enclave's verdict key `e1c64271…7d6c56` and OutLayer's testnet VRF key `c0c5aeae…f8cfa8`.

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

| Method                                                                                                                                          | Who                                                                                         | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new(owner, referee_pk, vrf_pk, vrf_sender, allowed_tokens)`                                                                                    | deploy tx                                                                                   | Keys are 32-byte ed25519 hex. Small-order, mixed-order and non-canonical keys are refused. `vrf_sender` is the account OutLayer names as `sender` in the VRF alpha (the referee's OutLayer caller). Call it in the same transaction as the deploy.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `migrate(vrf_sender)`                                                                                                                           | owner, or the contract account itself                                                       | Upgrades the first state layout (the one deployed) in place: keeps every balance, payout, match and checkpoint, pins `vrf_sender`, and adds the ring records and verdict heads. Deploy and migrate in one transaction (`deploy.ts --upgrade --migrate`). A second call fails. Matches created before it have no ring record or verdict head: they take no more verdicts and settle by `abort`.                                                                                                                                                                                                                                                                 |
| `set_referee_pk(referee_pk)`, `set_vrf_pk(vrf_pk)`, `set_vrf_sender(vrf_sender)`                                                                | owner, 1 yocto                                                                              | Same key check. Only matches created afterwards use the new value. A match keeps the keys and VRF sender it was created with.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `register_for(account_id, payout_account)`                                                                                                      | the account itself or its direct parent, attach exactly `get_config().registration_deposit` | Registers the account and sets where `withdraw` pays it. The deposit pays for the payout record and one balance record per allowed token. Required before credit, join or sponsor. The payout cannot be this contract.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `set_payout(account_id, payout_account)`                                                                                                        | the account itself or its current payout account, 1 yocto                                   | Repoints the payout. The 1 yocto keeps it off function-call keys, so a stolen player key cannot redirect winnings. Relay-created player accounts hold only a function-call key and cannot call it; they name a wallet once through `withdraw`'s `to`, and that wallet can repoint it from then on. The payout cannot be this contract.                                                                                                                                                                                                                                                                                                                         |
| `ft_on_transfer(sender_id, amount, msg)`                                                                                                        | allowed token                                                                               | `{"credit":"<account>"}` adds to that account's balance. `{"sponsor":"<match id>"}` adds to a lobby's sponsor pot (the sender must be a sponsor the host named). Returns `"0"` when accepted, the full amount when refused (unregistered account or sponsor, unnamed sponsor, unknown or started match, wrong token, bad msg). Other tokens panic.                                                                                                                                                                                                                                                                                                             |
| `withdraw(token, amount, to?) -> bool`                                                                                                          | registered, at least `get_config().withdraw_min_gas` (50) Tgas                              | Refused below 50 Tgas. If the payout is the caller itself (a player account with only a function-call key would strand the tokens), `to` is required: it becomes the payout for good and this withdraw goes there. Otherwise `to` must be absent or equal the payout. Debits the balance, then `ft_transfer`s to the payout account with 1 yocto the contract attaches itself (20 Tgas). A `#[private]` callback `on_withdraw` (10 Tgas; the refund path burned 1.69 Tgas on testnet) restores the balance if the transfer fails. The final result is `true` when paid and `false` when refunded. The payout account must be `storage_deposit`ed on the token. |
| `create_match(cfg) -> "<match id hex>"`                                                                                                         | anyone (host), attach exactly `get_config().match_storage_deposit`                          | `cfg = {token, stake, duration_ms, zone_hash, public_replay, min_players, max_players, start_by_ms, invites?, sponsors?}`. Limits: 3 ≤ min ≤ max ≤ 12, 0 < duration ≤ 1 h, `now < start_by_ms ≤ now + 7 days`, up to 12 invites, up to 4 sponsors (no duplicates). `invites` empty means any registered account may join. `sponsors` empty means there is no pot. Stake 0 is allowed.                                                                                                                                                                                                                                                                          |
| `set_invites(match_id, invites)`                                                                                                                | host                                                                                        | Lobby only, before the lock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `join_match(match_id)`                                                                                                                          | registered player                                                                           | Lobby only: not after the lock, not after `start_by_ms`, invited if there is a list. Moves `stake` from balance to head.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `lock_lobby(match_id)`                                                                                                                          | host, once                                                                                  | Needs at least `min_players`. Closes joins for good and leaves for `LOCK_MS` (10 min). `Start` only lands while the lock holds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `leave_lobby(match_id)`                                                                                                                         | player                                                                                      | Lobby only, not while locked. Head back to balance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `apply(verdicts: [base64 SignedVerdict], proofs?: [{seq, from_size, path}])`                                                                    | anyone                                                                                      | Applies the verdicts in order. If one is refused, the whole call is refused. `proofs` has exactly one consistency proof per Checkpoint and End in the call, matched by seq; a missing, duplicate or unused proof refuses the call. Checkpoints and Ends of two matches in one call cannot share a seq.                                                                                                                                                                                                                                                                                                                                                         |
| `abort(match_id)`                                                                                                                               | anyone                                                                                      | See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `get_config()`, `get_match(match_id)`, `get_heads(match_id)`, `get_balance(account_id, token)`, `get_payout(account_id)`, `get_roots(match_id)` | view                                                                                        | `get_config` includes `vrf_sender`, `withdraw_min_gas` (Tgas), `verdict_grace_ms` and `checkpoint_spacing_ms`. `get_match` includes the match's pinned `vrf_sender` (`null` for a match from before `migrate`). `get_roots` returns `{checkpoints: [{log_size, root}], final_root}`.                                                                                                                                                                                                                                                                                                                                                                           |
| `get_verdict_head(match_id) -> {seq, digest} \| null`                                                                                           | view                                                                                        | The last applied seq and its verdict digest (hex; seq 0 and zeros before `Start`). A client holding the same digest at that seq has seen the same verdict history. `null` for an unknown match or one from before `migrate`.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `verify_inclusion(match_id, entry, index, size, path) -> bool`                                                                                  | view                                                                                        | Hashes `entry` (borsh `LogEntry`) as the RFC 9162 leaf `SHA256(0x00 ‖ entry)` on-chain, takes the root the match anchored at exactly `size` entries (a checkpoint's or the final one) and checks the audit `path` (base64 32-byte hashes) for leaf `index`. `false` if no root has that size, the bytes are not a `LogEntry`, or the path does not verify.                                                                                                                                                                                                                                                                                                     |

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
land. Anything other than `Start` needs the match to be running. Hint, Tag and Forfeit are refused once
block time passes `end_ms + VERDICT_GRACE_MS` (5 min: the referee's last tick, its OutLayer call and
relay retries, well inside the 15-min overdue abort).

| Verdict                                         | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Start`                                         | All of: the match is in the lobby and not past `start_by_ms`; the lock is still active; min ≤ players ≤ max; `players_hash == players_hash(joined)`; `start_ms` is within 5 min of the block time; `end_ms - start_ms == duration_ms`. Stores `ring_commit`, `start_ms`, `end_ms`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Hint {from, to, amount, hint_id, hint}`        | Both players are in and different, `hint` is a known kind, `amount == HINT_BPS[hint] × stake / 10000` rounded down (NEAR and TREND 2 %, BEARING 5 %, from `tail_protocol::hint_price`), and `from`'s head ≥ amount. Moves `amount`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Tag {hunter, target}` / `Forfeit {player, to}` | Both players are in and different. The loser's whole head goes to the winner, and the loser is marked out. The pair is recorded for the ring check at `End` (at most 11 per match).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Checkpoint {log_size, root}`                   | The k-th checkpoint needs `k × CHECKPOINT_SPACING_MS` (30 s, half the referee's cadence) of match time since `start_ms`, counted no further than `end_ms`, so a match never holds more than `MAX_CHECKPOINTS` (120). `log_size` must be larger than the previous checkpoint's. Its proof must start at the last anchored size (the previous checkpoint's, or 0 with the empty root `SHA256("")` for the first) and verify (`verify_consistency_with` on the `env::sha256` host function) from that root to this one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `End {alpha, vrf_signature, log_size, root}`    | `ring_commit == SHA256("tail/ring" ‖ vrf_signature)`; `alpha` is exactly `vrf:{request_id}:{sender}:{seed}` with a non-empty request id, `seed` = the match id in lowercase hex (TECHNICAL 4.8) and `sender` = the match's pinned `vrf_sender`; `ed25519_verify(vrf_signature, alpha, match.vrf_pk)`. Before `end_ms` only with exactly one survivor. `log_size` ≥ the last checkpoint's, with a consistency proof from the last checkpoint (or size 0) to the final root, as for a Checkpoint (at the same size the roots must be equal). The ring is rebuilt from `vrf_signature` (`tail_protocol::ring::build_ring`) and the recorded Tags and Forfeits are replayed in order: each winner must be hunting the loser at that point, and then hunts the loser's target. Every player's head goes to their balance. The pot is split equally among survivors, and the first `pot % survivors` survivors in index order get 1 more unit each. Stores the reveal and the final root. A refused End leaves the match to `abort`; an End refused only for being early can be resubmitted once block time reaches `end_ms`. |

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
- `create_match` charges `MATCH_STORAGE_BYTES` (8,300 bytes, 0.083 NEAR). That is the most a
  match can ever store: 12 players, 12 invites and 4 sponsors with 64-character ids, a 192-byte
  alpha, 120 checkpoints, a ring record (64-character VRF sender, 11 eliminations) and the
  verdict head (written at creation). A unit test builds that maximal match and measures 8,232
  bytes. Matches are kept after settlement for the replay.
- Gas on testnet (e2e, before the ring check, alpha parsing and timing rules), one verdict per
  `apply`: the contract receipt burned 2.0 to 2.7 Tgas (Start 2.00, Hint 1.96, Tag 1.96,
  Checkpoint 2.14, End 2.65). The current code has not been measured on testnet yet; End now also
  rebuilds the ring (up to 12 SHA-256 in wasm) and Checkpoint and End verify a proof. Batches
  were not measured.
- Proofs, host-function gas only (the unit-test VM does not meter wasm instructions), over a
  15,013-entry log: `apply` of one Checkpoint with its 13-hash proof from 14,750 entries 0.57 Tgas
  (a Hint alone 0.22 Tgas); `verify_inclusion` with a 14-hash path 0.26 Tgas. The e2e prints the
  real receipt gas of `End` with its proof.
- Wasm: 309 KB, so about 3.1 NEAR of storage for the code. The curve check for keys adds 24 KB;
  the proof checks and `LogEntry` decoding about 22 KB.

## Trust notes

- The contract account has a full-access key (in `.keys/`, used for redeploys). Whoever holds it
  can replace the code. Delete that key to lock the code.
- The owner can rotate the referee and VRF keys only for matches created afterwards.
- Match ids mix in a salt taken from the block's random seed at `new`. A contract recreated on
  the same account never repeats an id, so an old signed verdict cannot apply to a new match.
- The contract checks that the VRF output is OutLayer's for this match's seed and was requested
  by the pinned `vrf_sender`, that the `Start` commitment matches it, and that every Tag and
  Forfeit followed the ring it yields. It cannot stop the referee (the pinned sender) from
  requesting several VRF outputs for the same seed and picking one (OutLayer request ids differ).
- The ring check proves who hunted whom, not that a Tag's proximity evidence was real: that part
  is still the referee's word.
- The consistency proofs show that every anchored root extends the one before, so the referee
  cannot drop or rewrite an entry once a root covering it is on-chain. They say nothing about
  whether the entries are true.

## Run

```sh
cd contracts/tail
cargo test                                   # 210 unit tests: golden vectors, review regressions, proofs, property test
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
4. applies Start (dated 4.5 min back, so the 4-min match is past `end_ms` when End lands), Hint, a
   Tag by the ring's hunter of player 1, Checkpoint and End, each chained to the one before, the
   Checkpoint and End with consistency proofs over a stand-in log of 99 entries (built with
   `@tail/protocol`'s `consistencyProof`), then checks `get_verdict_head` and `verify_inclusion`;
5. checks heads and balances, then withdraws: a player whose payout is itself names a wallet once
   (paid there), and one is refunded because the payout account is not registered on the token.

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
