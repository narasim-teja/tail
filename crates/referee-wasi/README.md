# referee-wasi

The TAIL referee as an OutLayer WASI P2 component (`wasm32-wasip2`), deployed as the project
`tail-dev-a38d13.testnet/tail-referee` on hosted OutLayer testnet. One project, one command per
call: the input is JSON with `cmd` plus that command's fields; bytes are base64 unless noted.
Every answer is `{"ok": true, "result": …}` or `{"ok": false, "error": "…"}`.

The rules are `crates/referee-core`. This crate does what the engine cannot:

- host keys, randomness and the VRF
- storage
- opening sealed batches
- signing the engine's verdicts
- sealing HUDs, player keys and the tick state
- the Handler voice (NEAR AI Cloud)

App Attest assertions are verified by the engine (`crates/appattest`). The attestation
object itself is checked once, by the relay, at enrolment (v1).

## Commands

Only the project owner (the relay's account) may call. The worker-set `NEAR_SENDER_ID` and
`NEAR_USER_ACCOUNT_ID` must both equal `OUTLAYER_PROJECT_OWNER`, and the call may name no
secret rows. `call_id` is the OutLayer call UUID.

`verdicts` is a list of borsh `SignedVerdict`s, signed over `verdictDigest`, in seq order. The
engine sets their `seq` and `call_id`. `log` is a list of borsh `LogEntry`s in log order.
`state` is the sealed tick state.

| cmd                  | input                                                                                                                                                                                                                                               | result                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pubkeys`            | `{}`                                                                                                                                                                                                                                                | `{referee_pk, referee_pk_hex, referee_box_pk, box_pk_sig, vrf_pk}`. `box_pk_sig` = ed25519(referee_sk, SHA256(`"tail/referee-box/v1"` ‖ box_pk)). `vrf_pk` is hex.                                                                                                                                                                               |
| `enroll`             | `{account_id, app_attest_pk, player_box_pk, near_pk}`. `app_attest_pk` is SEC1 P-256, 33 or 65 bytes.                                                                                                                                               | `{account_id, app_attest_pk (65 B), call_id, receipt, sig}`. `receipt` = borsh `Device {account_id, app_attest_pk: [u8;65], player_box_pk: [u8;32], near_pk: [u8;32], call_id: [u8;16]}`; `sig` = ed25519 over SHA256(`"tail/enroll-receipt/v1"` ‖ receipt).                                                                                     |
| `start`              | `{match_id (16 B), players: [account_id], start_ms?, duration_ms, stake ("u128"), zone: {lat_e7, lon_e7, radius_m}, safehouses?: [circle], app_id?}`. `start_ms` defaults to the host clock; `app_id` defaults to `LKABS9RZAC.com.lkabs9rzac.tail`. | `{call_id, seq: 1, verdicts: [Start], players_hash, ring_commit (hex), players (sorted), start_ms, end_ms, keys: [{player, account_id, sealed}], state, state_bytes, log}`. `sealed` = seal(player_box_pk, borsh `PlayerKeys`, `"tail/keys"`). `end_ms = start_ms + duration_ms`.                                                                |
| `tick`               | `{match_id, state, last_seq, now_ms?, batches: [sealed], receipts: [HintReceipt]}`. Each batch is seal(referee_box_pk, borsh `BatchEnvelope`, `"tail/batch"`), at most 256.                                                                         | `{call_id, tick_no, now_ms, seq, over, state, state_bytes, verdicts, huds: [{player, sealed}], log, log_size, log_root, hints: [{hint_id, from, to, amount, hint, value, nonce, text}], opened, unopened: [{index, reason}], rejected: [{player, seq, reason}], refused: [{player, nonce, action, reason}]}`. HUDs are sealed with `"tail/hud"`. |
| `voice`              | `{hint_id, hint, value, question?}`, one entry of a tick's `hints`                                                                                                                                                                                  | `{text, source: "model"\|"template", fact, model, latency_ms, fallback_reason, chat_id, text_sha256, request_sha256, response_sha256, signature, signing_address, signature_kind, signed_text, signature_error, hint_id, receipt}`. `receipt` is a borsh `referee_core::HintReceipt` for the next tick's `receipts`.                             |
| `end`                | `{match_id, state, last_seq, receipts?}`, only after a tick returned `over`                                                                                                                                                                         | `{call_id, seq, verdicts: [End], log_size, root (hex), state, log}`. The End log size and root are the engine's own.                                                                                                                                                                                                                             |
| `declassify`         | `{match_id}`, only after End                                                                                                                                                                                                                        | `{match_id, start_ms, end_ms, players: [{account_id, app_attest_pk, player_box_pk, near_pk, enroll_call_id}], ring, k_m (hex), vrf_alpha, vrf_signature (hex), start_call_id, end: {seq, log_size, root, call_id}}`                                                                                                                              |
| `declassify_batches` | `{match_id, state?, sealed: [sealed BatchEnvelope]}`, only after End (the stored match record says so), at most 500 per call. `state` is the End state blob; when given, it saves a storage read.                                                   | `{batches: [borsh Batch], refused: [{index, reason}]}`. Batches come back in input order, without their assertion. One that does not open, does not decode or belongs to another match is refused on its own; the rest of the call goes on.                                                                                                      |
| `bench_state`        | `{mode: "sealed"\|"storage", size, state?, last_seq?}`                                                                                                                                                                                              | `{state, bytes, seq, enclave_ms}`. This is the tick's state round trip alone, for measuring. It touches no match.                                                                                                                                                                                                                                |

Player numbers are positions in the byte-sorted account list. `ring[k]` hunts `ring[k+1 mod n]`.
The engine's rules are in `crates/referee-core/README.md`.

### What the relay must do

- **Store the log.** Append every `log` entry from `start`, each `tick` and `end`, in order. The
  engine keeps only a Merkle frontier, and `declassify` returns secrets, not the log. A tick's
  `log_size` and `log_root` let the relay check that its copy is complete. `End` carries the
  size and root of the log before End's own entry, so the final log has `End.log_size + 1`
  entries.
- **Submit verdicts in seq order.** The seq is contiguous across `start`, every `tick` and `end`.
  Pass the last seq it holds as `last_seq`.
- **Keep exactly the state blob that came with that seq.** A failed call changes nothing; retry
  it with the same blob.
- **Voice every hint.** For each entry in a tick's `hints`, call `voice`, then pass its `receipt`
  in the next tick's `receipts` (or in `end`'s). The engine logs a receipt only for a hint it
  issued, once, within 120 s of referee time. `voice` takes the fact from the caller. The
  sealed HUD's `hint_fact` is the one the player can rely on.
- **Keep every sealed batch it forwards.** After End, it sends them back through
  `declassify_batches` in chunks of at most 500 (a 60-minute 12-player match is about 8,600
  batches, so about 18 calls) and serves the trails only to viewers `public_replay` allows.
  The replay checks each returned batch's SHA256 against the log's `LogEntry::Batch` hashes, so
  the referee cannot add a trail. Only valid batches are logged; rejected ones come back too
  but match no log entry.
- **Tick in real time, and call `end` after `over`.** `now_ms` may lag the host clock but never
  run more than `CLOCK_SKEW_MS` (20 s) ahead of it. A relay that withholds or delays ticks gains
  nothing it could not get by not calling. Nothing here stops a backdated `start_ms` (that is
  how `scripts/match.ts` fast-forwards). The contract should refuse a `Start` far from block
  time.

## Manifest (`manifest.json`)

| Entry                                                              | Why                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signing_keys: verdicts`, ed25519, `bind: project`, `caller: none` | One verdict key for the project, pinned in the contract. HTTPS runs projects, so `project` is the only binding (S2). The key survives new versions, so code pinning comes from each call's attestation record (`executed_wasm_sha256`), which verdicts link to through `call_id`. |
| `encryption_keys: state`, `bind: project`, `caller: signer`        | Seals the tick state. `none` is refused for encryption keys. Over HTTPS, `signer` is the payment key's owner, which is the relay, the only caller.                                                                                                                                |
| `author_secrets: {profile: "referee"}`                             | `NEARAI_API_KEY` and `NEARAI_MODEL` come from the owner's row on every run. The row is whitelisted to the owner, which also refuses other callers before any code runs.                                                                                                           |
| `callers: {direct: deny, contract: deny}`                          | HTTPS only. The P2 dispute stretch would need `contract` opened, in a new version.                                                                                                                                                                                                |
| `capabilities.network: [cloud-api.near.ai, 10 s]`                  | Without `connector_id`, a missing list means unrestricted egress, but an explicit list is enforced. One host is enough.                                                                                                                                                           |

`#[link_section]` is an unsafe attribute and the crate forbids unsafe code. So
`scripts/build.ts` appends the minified `manifest.json` to the component as a top-level
`outlayer.manifest` custom section. The worker's `wasmparser` `parse_all` finds it there, and
the wasm hash covers it.

**Toolchain.** `rust-toolchain.toml` pins 1.94.1. Newer std imports WASI above 0.2.6, which the
worker (wasmtime 36) cannot instantiate. Before deploying, check that
`wasm-tools component wit target/tail-referee.wasm | grep import` shows `wasi:*@0.2.6` or lower.

## State sealing

`tick` never touches OutLayer storage. The relay holds the tick state between calls as a blob:
`encrypt(state key, borsh(MatchState), aad = "tail/state/v1" ‖ match_id)`. `MatchState` holds:

- the version and the match id
- the wrapper's tick counter
- the referee box secret
- each player's box key
- the engine's `State`: players, heads, App Attest counters, contacts, the log frontier and the
  verdict seq

One source of truth: the wrapper keeps no copy of anything the engine owns.

Rollback check: the blob's last seq (`next_verdict_seq − 1`) must equal the caller's
`last_seq`. A lower one is a replayed blob and is refused. A higher one means the caller has
not applied the verdicts returned with it. A relay that forks one blob into two ticks gets two
verdict sets with the same seqs, and the contract accepts only one of them.

Storage holds:

- `referee:box_sk`, generated in the enclave on first use
- `device:{account}`, one per enrolled device
- `match:{id}`, written once at `start` (`set_if_absent`) and once at `end` (compare-and-swap),
  so a match never gets two Start or two End verdicts. It holds K_m, the VRF alpha and
  signature, the ring and the devices.

| Domain                                | Used for                                    |
| ------------------------------------- | ------------------------------------------- |
| `tail/verdict/v1` (protocol)          | verdicts                                    |
| `tail/referee-box/v1`                 | `box_pk_sig`                                |
| `tail/enroll-receipt/v1`              | enrolment receipt                           |
| `tail/state/v1` ‖ match_id            | aad of the tick state                       |
| `tail/bench-state/v1` ‖ 0¹⁶           | aad of `bench_state` blobs                  |
| `tail/keys`, `tail/hud`, `tail/batch` | seal contexts for PlayerKeys, HUDs, batches |

## Handler voice

The model is `deepseek-ai/DeepSeek-V4.1-Flash-1017` unless `NEARAI_MODEL` names another;
`openai/*` and `anthropic/*` are refused. It gets the persona prompt and one fact from a fixed
list, never coordinates. Thinking is off and `max_tokens` is 60.

The completion has a hard 3 s deadline: a `wasi:io/poll` on the response plus a monotonic
timer. After that, or on any error, a template sentence is used. The signature lookup retries
for up to 10 s, and its signed text must end in `sha256(request):sha256(response)` of our exact
bytes.

## Measured (hosted testnet, 2026-11-12)

`scripts/match.ts` runs 3 ghost phones and starts the match 4 minutes in the past so it can
fast-forward: 3 minutes long, 10 s ticks.

- Each ghost has a P-256 key and signs App Attest-format assertions.
- Every second it records a fix a few metres from the others inside a 500 m zone, and hears the
  others' real beacon tokens.
- The hunter asks one NEAR hint at tick 2 and strikes once its HUD lock reaches 4.

All checks passed:

- 6 verdicts (Start, Hint, Tag, Checkpoint, Checkpoint, End), seq contiguous from 1, each
  verifying with `referee_pk` and naming its OutLayer call.
- Hint: 0 → 2, 20 000. Tag: 0 tags 2.
- The hunter's head ends at 2 × stake, and the target's HUD says OUT.
- Lock rose 1 → 4 over five ticks before the strike.
- The End root equals the Merkle root of all 68 returned entries before End (69 with End's own).
- The VRF reveal verifies, `ring_commit` opens, the declassified ring matches.
- The voice receipt joined the log, and an old state blob is refused as a rollback.
- `declassify_batches` returned all 42 sent batches, each hashing to a `LogEntry::Batch`. A
  batch of another match and a garbage blob were refused one by one.

| tick | sim t | batches | wall     | enclave | state  | verdicts        | lock (hunter) | heat (target) |
| ---- | ----- | ------- | -------- | ------- | ------ | --------------- | ------------- | ------------- |
| 1    | 10 s  | 3       | 9371 ms  | 1515 ms | 1490 B |                 | 1             | 1             |
| 2    | 20 s  | 3       | 4361 ms  | 1525 ms | 1633 B | Hint            | 2             | 2             |
| 3    | 30 s  | 3       | 3738 ms  | 1187 ms | 1688 B |                 | 2             | 2             |
| 4    | 40 s  | 3       | 6289 ms  | 1519 ms | 1712 B |                 | 3             | 3             |
| 5    | 50 s  | 3       | 11233 ms | 1494 ms | 1899 B |                 | 4             | 4             |
| 6    | 60 s  | 3       | 4366 ms  | 1543 ms | 1799 B | Tag, Checkpoint | 4             | 0             |
| 7    | 70 s  | 2       | 2809 ms  | 1588 ms | 1807 B |                 | 5             | 0             |
| 8    | 80 s  | 2       | 2618 ms  | 1565 ms | 1875 B |                 | 6             | 0             |
| 9    | 90 s  | 2       | 2768 ms  | 1564 ms | 1967 B |                 | 6             | 0             |
| 10   | 100 s | 2       | 2620 ms  | 1564 ms | 1975 B |                 | 7             | 0             |
| 11   | 110 s | 2       | 2625 ms  | 1585 ms | 2011 B |                 | 8             | 0             |
| 12   | 120 s | 2       | 3126 ms  | 1535 ms | 2071 B | Checkpoint      | 7             | 0             |
| 13   | 130 s | 2       | 5094 ms  | 1262 ms | 2143 B |                 | 8             | 0             |
| 14   | 140 s | 2       | 3279 ms  | 1535 ms | 2179 B |                 | 8             | 0             |
| 15   | 150 s | 2       | 2712 ms  | 1543 ms | 2239 B |                 | 7             | 0             |
| 16   | 160 s | 2       | 2600 ms  | 1541 ms | 2311 B |                 | 8             | 0             |
| 17   | 170 s | 2       | 3586 ms  | 1583 ms | 2251 B |                 | 8             | 0             |
| 18   | 180 s | 2       | 6284 ms  | 1527 ms | 2311 B |                 | 7             | 0             |

- Tick wall time: p50 3.6 s, p95 11.2 s. Enclave time: p50 1.5 s. State: 1.5 to 2.3 KB.
- `start` took 5.9 s wall and `end` 8.6 s.
- After the tag, the hunter's lock column follows its inherited target.
- The voice call: model line in 0.9 s, call 3.6 s wall, `provider_tee` signature.
- In `smoke.ts` the model missed the 3 s budget once, and the template line was used.
- The run cost 27 calls, $0.028.

`declassify_batches` with a chunk of 500 batches shaped like a 12-player match at 5 s cadence
(5 fixes, 22 sightings, a 115-byte assertion):

- request 559 KB, response 449 KB
- 9.0 s wall, 2.4 s in the enclave
- all 500 returned; 501 are refused

The per-call cap is the code's 500. Larger calls were not tried, so OutLayer's own HTTPS body
limit was not measured. The second match run cost 30 calls, $0.034.

`scripts/latency.ts` measures sealed state against storage read + write at 1, 16 and 128 KB.
Its numbers are from the main session's run and are not recorded in this file.

## Build, deploy, test

```sh
cd crates/referee-wasi && cargo test && cargo clippy --target wasm32-wasip2 --all-targets -- -D warnings && cargo fmt --check
bun crates/referee-wasi/scripts/build.ts                     # → target/tail-referee.wasm + sha256
wasm-tools component wit crates/referee-wasi/target/tail-referee.wasm | grep import   # wasi ≤ 0.2.6
OUTLAYER_NETWORK=testnet outlayer upload crates/referee-wasi/target/tail-referee.wasm
OUTLAYER_NETWORK=testnet outlayer deploy [--no-activate] tail-referee <FastFS URL>
# author secrets, read from .env.local inside the command and never echoed:
K=$(grep '^NEARAI_API_KEY=' .env.local | cut -d= -f2-) M=$(grep '^NEARAI_MODEL=' .env.local | cut -d= -f2-) \
  sh -c 'OUTLAYER_NETWORK=testnet outlayer secrets set "{\"NEARAI_API_KEY\":\"$K\",\"NEARAI_MODEL\":\"$M\"}" \
  --project tail-dev-a38d13.testnet/tail-referee --profile referee'
bun crates/referee-wasi/scripts/smoke.ts                     # every command, checked with packages/protocol
bun crates/referee-wasi/scripts/match.ts                     # a full 3-player match with ghost phones
bun crates/referee-wasi/scripts/latency.ts                   # sealed vs storage, 1/16/128 KB, N=50 each
```

The scripts read the repo-root `.env.local`. `REFEREE_PAYMENT_KEY` takes precedence over
`OUTLAYER_PAYMENT_KEY`, and `REFEREE_VERSION=<wasm sha256>` pins a deployed version that is not
active.

Active version: wasm sha256 `bc1d952b9ef8fc4c728b3947f0d539662ad2180cb04f2b1f26ca05d299b926fc`.
