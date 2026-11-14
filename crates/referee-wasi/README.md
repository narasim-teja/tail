# referee-wasi

The TAIL referee as an OutLayer WASI P2 component (`wasm32-wasip2`), deployed as the project
`tail-dev-a38d13.testnet/tail-referee` on hosted OutLayer testnet. Built natively, the same code
is a [local test referee](#local-test-referee), which is not an enclave. One project, one command per
call: the input is JSON with `cmd` plus that command's fields; bytes are base64 unless noted.
Every answer is `{"ok": true, "result": …}` or `{"ok": false, "error": "…"}`.

The rules are `crates/referee-core`. This crate does what the engine cannot:

- host keys, randomness and the VRF
- storage
- opening sealed batches
- signing the engine's verdicts, HUDs, player keys and Handler lines
- sealing HUDs, player keys and Handler lines to players, and the tick state, log entries and
  hint facts to itself
- the Handler voice (NEAR AI Cloud)

App Attest is checked here, not by the relay (`crates/appattest`): `enroll` verifies the
attestation object against Apple's pinned root, and the engine verifies every assertion against
the key it attested.

## Commands

Only the project owner (the relay's account) may call. The worker-set `NEAR_SENDER_ID` and
`NEAR_USER_ACCOUNT_ID` must both equal `OUTLAYER_PROJECT_OWNER`, and the call may name no
secret rows. `call_id` is the OutLayer call UUID.

Protocol v2 (`packages/protocol/README.md`). `verdicts` is a list of borsh `SignedVerdict`s
with `prev` (the digest of the match's previous verdict, zeros for Start), signed over
`verdictDigest`, in seq order. The engine sets `seq`, `prev` and `call_id`. `state` is the
sealed tick state. No plaintext log entry leaves the referee during play. Each call that adds
to the log returns instead:

- `leaves`: `[b64 32 B]`, the RFC 6962 leaf hashes of its new entries, in log order;
- `log_sealed`: b64, the same entries (borsh `Vec<LogEntry>`) sealed to the referee itself
  ([referee-only blobs](#referee-only-blobs)), bound to the log index of the first; opaque to
  the relay.

`proofs` is `[{seq, from_size, path: [b64 32 B]}]`, one per Checkpoint or End verdict in
`verdicts`: the RFC 9162 consistency proof from the previous anchored log size (0 for the
first) to that verdict's `log_size`. `from_size` is a JSON number. The relay passes it to the
contract's `apply` unchanged.

**`pubkeys`** `{}` → `{referee_pk, referee_pk_hex, referee_box_pk, box_pk_sig, vrf_pk, app_id}`.
`box_pk_sig` = ed25519(referee_sk, SHA256(`"tail/referee-box/v1"` ‖ box_pk)). `vrf_pk` is hex.
`app_id` is the App ID pinned in the code (`LKABS9RZAC.com.lkabs9rzac.tail`), which the relay
checks against its own.

**`enroll`** `{account_id, app_attest_pk, player_box_pk, near_pk, attestation?, challenge?, rebind_sig?}`.
`app_attest_pk` is SEC1 P-256, 33 or 65 bytes. `attestation` is the CBOR object the phone got
from `attestKey`, `challenge` the 32 bytes it covers. The referee verifies the chain to Apple's
root, the App ID `LKABS9RZAC.com.lkabs9rzac.tail` (development aaguid), counter 0, and the nonce
over `enroll_client_data_hash(challenge, account_id, player_box_pk, near_pk)`, and requires the
attested key to be `app_attest_pk`. Without both, it enrols only when `ALLOW_UNATTESTED=1`
(ghosts). A low-order `player_box_pk` is refused (`tail_protocol::seal::is_low_order`). An
account keeps the device it first enrolled: the same three keys again return the stored receipt
unchanged (a retry is safe; an attestation of a ghost's same keys upgrades it), and other keys
need `rebind_sig`, the stored device's `near_pk` signing (ed25519, base64)
`rebind_digest(account_id, app_attest_pk, player_box_pk, near_pk)` of the new keys
(`packages/protocol/README.md`); with nothing stored it is ignored. Without it the call is refused, so a relay holding a genuine
iPhone of its own cannot attest it for someone else's account. `rebind_sig` carries no time, so
the record keeps the notBefore of the credential certificate that attested the stored key, and a
move must bring an attestation certified later (in a later second): a relay that kept an earlier
move's attestation and signature cannot put an older key back while that certificate is valid,
nor move an attested device to a ghost. A ghost's record, and one stored before the time was
kept, has time 0 and orders nothing. → `{account_id, app_attest_pk
(65 B), attested, call_id, receipt, sig, referee_pk}`. `receipt` = borsh `Device {account_id,
app_attest_pk: [u8;65], attested: bool, player_box_pk: [u8;32], near_pk: [u8;32], call_id:
[u8;16]}`; `sig` = ed25519 under `referee_pk` (base64) over SHA256(`"tail/enroll-receipt/v1"` ‖
receipt), so the relay can tell which referee holds the device.

**`devices`** `{accounts: [account_id]}`, at most 16. Read-only. → `{devices: [{account_id,
receipt, unreadable?}]}` in input order: `receipt` is the receipt body (borsh `Device`, as
`enroll` returns it) of the record `start` would load for the account, or null when there is
none or it does not decode (`unreadable` then says why). The relay asks before it locks a lobby,
so a player whose device the referee does not hold as the relay recorded it re-enrols first.

**`start`** `{match_id (16 B), players: [account_id], start_ms?, duration_ms, stake ("u128"),
zone: {lat_e7, lon_e7, radius_m}, safehouses?: [circle]}`. `start_ms` defaults to the host
clock. The App ID every assertion is checked against is `LKABS9RZAC.com.lkabs9rzac.tail`, the
constant `enroll` checks attestations against, never the caller's. → `{call_id, seq: 1, verdicts:
[Start], players_hash, ring_commit (hex), players (sorted), start_ms, end_ms, keys: [{player,
account_id, sealed}], state, state_bytes, leaves, log_sealed, log_size, log_root (hex)}`.
`sealed` = seal(player_box_pk, pad(borsh `SignedPlayerKeys`), `"tail/keys/v2"`), signed with
`keys_sig_digest`. Every message sealed to a phone is padded to `PHONE_PAD` (1072 bytes sealed),
so its length names neither the target nor the line. The log so far: one `Enrolled` per player (`attested` from the device
record), then Start.

**`tick`** `{match_id, state, last_seq, now_ms?, batches: [sealed], receipts: [b64]}`. Each
batch is seal(referee_box_pk, borsh `BatchEnvelope`, `"tail/batch"`), at most 256. `receipts`
are the `receipt` blobs `voice` returned since the last tick, in the order received. →

```text
{call_id, tick_no, now_ms, seq, over, state, state_bytes,
 verdicts, proofs, huds: [{player, sealed}], leaves, log_sealed, log_size, log_root (hex),
 hints: [{player, blob}], opened, unopened: [{index, reason}],
 rejected: [{player, seq, reason: <RejectCode>}],
 refused: [{player, nonce, action: "strike" | "hint", reason: <RefuseCode>}]}
```

`sealed` = seal(player_box_pk, pad(borsh `SignedHud`), `"tail/hud/v2"`), signed with
`hud_sig_digest`. `log_size` / `log_root` are the log after this tick; every HUD carries the
same pair. A hint leaves only as its asker's index and `blob` = `match_id ‖` a referee-only
blob of the fact and the question, for `voice`. `rejected[].reason` is the protocol
`RejectCode` number, `refused[].reason` the protocol `RefuseCode` number (`Lock`, `NoContact`,
`Cooldown`, `Funds`, …), without the amounts some reasons carry. The first log entry of a tick
is always its `Tick`; receipts that open are logged after it (once per hint, within 120 s),
each salted for the index it lands at.

**`voice`** `{state, blob}`, one entry of a tick's `hints` plus any state blob of the match
(voice changes no state and appends nothing). → `{player, hint_id, sealed, signed_text,
receipt}`, nothing more: no source, model, latency or fallback reason. Whether a model or a
template spoke shows only as `signed_text` (null: no model signature) and, after End, in the
logged receipt (empty chat id or signature).
`sealed` = seal(asker's box key, pad(borsh `SignedVoiceLine`), `"tail/voice/v1"`), signed with
`voice_sig_digest`. A model line over `VOICE_TEXT_MAX` (930) bytes is replaced by the template. `signed_text` is the exact text NEAR AI signed
(`model:sha256(request):sha256(response)`), or null for a template line; the replay needs it to
check the signature in the logged receipt. The request carries a per-hint nonce in OpenAI's
`user` field, `HMAC(K_log, "tail/voice-nonce" ‖ u32le(hint_id))[0..16]` as hex: without one, a
hint with no question has a dozen possible requests, and `sha256(request)` would name its fact.
`receipt` = `u32le(hint_id) ‖ SHA256(sealed) ‖` the `HintReceipt` sealed to the referee with
those 36 bytes as its bind, so it stands for this one line of this one hint (the relay can check
the prefix against the line it delivers; altered, the receipt does not open); pass it in the next
tick's (or `end`'s) `receipts`. The engine logs one receipt per hint however often it is passed,
so voicing a hint twice cannot put a second line in the log. Its leaf is not known yet: the entry is salted for the index it lands at, and shows
up in that call's `leaves`. `hint_id` is the one the Hint verdict on chain carries.

**`end`** `{match_id, state, last_seq, receipts?}`, only after a tick returned `over`. →
`{call_id, seq, verdicts: [End], proofs, log_size, root (hex), state, leaves, log_sealed}`.
Here `log_size` and `root` are the End verdict's, the log before End's own entry. `end` again
with the same `state` and `receipts` answers with the End it recorded (same `call_id`, verdict,
signature and proof), so a relay whose answer was lost just calls again; a repeat that would
produce another End (other receipts, another state) is refused.

**`declassify`** `{match_id, log_sealed: [b64]}`, only after End, with every `log_sealed` blob
of `start`, each `tick` and `end`, in order. It refuses unless the blobs open in sequence, the
entries before End hash to the End root and the last entry is End's. → `{match_id, start_ms,
end_ms, players: [{account_id, app_attest_pk, attested, player_box_pk, near_pk,
enroll_call_id}], ring, k_m (hex), vrf_alpha, vrf_signature (hex), start_call_id, end: {seq,
log_size, root, call_id}, log: [b64 borsh LogEntry]}`.

**`declassify_batches`** `{match_id, state?, sealed: [sealed BatchEnvelope]}`, only after End
(the stored match record says so), at most 500 per call. `state` is the End state blob; when
given, it saves a storage read. → `{batches: [borsh Batch], assertions: [b64], refused:
[{index, reason}]}`. `assertions[i]` is the App Attest assertion of `batches[i]`, so a verifier
can run the referee's checks again. One that does not open, does not decode or belongs to
another match is refused on its own; the rest of the call goes on.

**`bench_state`** `{mode: "sealed"|"storage", size, state?, last_seq?}` → `{state, bytes, seq,
enclave_ms}`. This is the tick's state round trip alone, for measuring. It touches no match.

Player numbers are positions in the byte-sorted account list. `ring[k]` hunts `ring[k+1 mod n]`.
The engine's rules are in `crates/referee-core/README.md`.

### What the relay must do

- **Store the leaves and the sealed log.** Append every `leaves` list from `start`, each
  `tick` and `end`, in order (not `voice`'s), and keep every `log_sealed` blob of those calls in
  order. The leaves serve inclusion and consistency proofs during play; after End, `declassify`
  with all the blobs returns the plaintext log. A tick's `log_size` and `log_root` let the relay
  check that its leaves are complete. `End` carries the size and root of the log before End's
  own entry, so the final log has `End.log_size + 1` entries.
- **Pass each proof to `apply` with its verdict.** The referee anchors a root when it signs a
  Checkpoint, so a Checkpoint the contract does not apply leaves every later proof starting from
  the wrong size.
- **Submit verdicts in seq order.** The seq is contiguous across `start`, every `tick` and `end`.
  Pass the last seq it holds as `last_seq`.
- **Keep exactly the state blob that came with that seq.** A failed call changes nothing; retry
  it with the same blob. `end` stores its End before it answers, so after a lost `end` answer
  call it again with the same blob and the same `receipts`: it answers with that End. Settle
  every hint first (voiced, or given up on) so the receipts do not change between the calls.
- **Ask `devices` before locking a lobby.** A receipt says the referee held a device once; only
  `devices` says `start` can read it now.
- **Voice every hint.** For each entry in a tick's `hints`, call `voice` with its blob and a
  state blob, send `sealed` to the asker, keep `signed_text` for the replay, and pass
  `receipt` in the next tick's `receipts` (or `end`'s): the one whose prefix names the `sealed`
  it delivered. The engine logs a receipt only for a hint it issued, once, within 120 s of
  referee time. The fact never leaves the referee in the
  clear: `voice` reads it from the blob, which only the referee can make.
- **Keep every sealed batch it forwards.** After End, it sends them back through
  `declassify_batches` in chunks of at most 500 (a 60-minute 12-player match is about 8,600
  batches, so about 18 calls) and serves the trails only to viewers `public_replay` allows.
  The replay checks each returned batch's SHA256 against the log's `LogEntry::Batch` hashes, so
  the referee cannot add a trail. A rejected batch comes back too and matches a
  `LogEntry::Rejected` hash.
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
- the engine's `State`: players, heads, App Attest counters, contacts, the verdict seq and the
  last verdict digest, and the log frontier (the peaks at the last anchored size plus the leaf
  hashes since, so up to one Checkpoint's worth: about 12 KB for 12 players)

`state::VERSION` is 7 (protocol v2 with log salts and each hint's time for demand pricing); a
blob of another version is refused. A hint blob carries its own version byte
(`HINT_BLOB_VERSION`, 1) the same way.

One source of truth: the wrapper keeps no copy of anything the engine owns.

Rollback check: the blob's last seq (`next_verdict_seq − 1`) must equal the caller's
`last_seq`. A lower one is a replayed blob and is refused. A higher one means the caller has
not applied the verdicts returned with it. A relay that forks one blob into two ticks gets two
verdict sets with the same seqs, and the contract accepts only one of them.

Storage holds:

- `referee:box_sk`, generated in the enclave on first use
- `device:{account}`, one per enrolled device: borsh `Device` (the receipt body) ‖ `0x02` ‖
  u64le notBefore of its credential certificate (0 for a ghost). A record of the receipt body
  alone (version 1) reads as notBefore 0. A record from before `attested` existed (borsh
  `Device` without it) is not one `start` or `devices` reads; `enroll` reads it for its keys,
  as unattested with notBefore 0, so a move still needs its `near_pk`'s `rebind_sig`, and
  rewrites it in the current layout from the new call's own attestation. Bytes in no layout
  are refused: they name no key to check a move against.
- `match:{id}`, written once at `start` (`set_if_absent`) and once at `end` (compare-and-swap,
  then checked by every repeat of `end`), so a match never gets two Start or two End verdicts. It holds K_m, the VRF alpha and
  signature, the ring and the devices.

| Domain                                         | Used for                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| `tail/verdict/v2` (protocol)                   | verdicts                                                                  |
| `tail/hud/v2`, `tail/keys/v2`, `tail/voice/v1` | signature digest and seal context of HUDs, keys, Handler lines (protocol) |
| `tail/batch` (protocol)                        | seal context of batches                                                   |
| `tail/referee-box/v1`                          | `box_pk_sig`                                                              |
| `tail/enroll-receipt/v1`                       | enrolment receipt                                                         |
| `tail/state/v1` ‖ match_id                     | aad of the tick state                                                     |
| `tail/bench-state/v1` ‖ 0¹⁶                    | aad of `bench_state` blobs                                                |
| `tail/referee-vault/v1` ‖ purpose ‖ match_id   | HKDF info of the referee-only blob keys (below)                           |

### Referee-only blobs

The log entries, hint facts and voice receipts the relay carries during play are sealed by the
referee to itself (`src/vault.rs`): `nonce (24 B) ‖ XChaCha20-Poly1305(key, aad = bind)`, with
`key = HKDF-SHA256(referee box secret, "tail/referee-vault/v1" ‖ purpose ‖ match_id)` and
purpose `log`, `hint` or `receipt`. Sealing to the box _public_ key would hide them too, but
anyone can seal to a public key, the relay included. A key derived from the box secret means a
blob that opens was made here, so the relay can neither read nor forge a hint fact, a receipt
or a log entry. A log blob's `bind` is u64le of the log index of its first entry, so blobs
cannot be reordered. It is computation inside the module: no extra host call per tick.

## Handler voice

The model is `deepseek-ai/DeepSeek-V4.1-Flash-1017` unless `NEARAI_MODEL` names another;
`openai/*` and `anthropic/*` are refused. It gets the persona prompt, one fact from a fixed
list (never coordinates) and a MARKET line, `tail_protocol::price_reason` for the demand that
priced the hint (how many hints the match bought in the last 5 minutes, public on chain), so the
line can say why intel was dear. The fallback template states only the fact. Thinking is off and
`max_tokens` is 60.

The completion has a hard 3 s deadline: in the enclave a `wasi:io/poll` on the response plus a
monotonic timer, in the local test referee `ureq`'s overall timeout. After that, or on any
error, a template sentence is used. The signature lookup retries for up to 10 s, and its signed
text must end in `sha256(request):sha256(response)` of our exact bytes.

## Measured (hosted testnet, 2026-11-12)

These runs are of the protocol v1 referee (before the verdict chain, consistency proofs, signed
HUDs and the sealed log). No v2 match has run on OutLayer yet, and the build active there has not
answered a call (below); `scripts/match.ts` and `scripts/smoke.ts` pass against the local test
referee. v2 adds one signing call per
HUD per tick (12 for 12 players) on OutLayer's `signing_keys`, whose latency is not measured.

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

## Local test referee

The same crate built natively (`cargo build --release --bin tail-referee`, giving
`target/release/tail-referee`) is a local test referee. The command code, rules engine,
records and wire formats are the same. Only the backend behind `src/host.rs` and `src/http.rs`
changes. It is not an enclave. Its keys sit in files on the developer's machine, and nothing
attests what it signs. Matches it judges must be labelled as test-referee matches and must not
be presented as enclave-refereed.

One process per command: one JSON object on stdin, one `{"ok": true, "result": …}` or
`{"ok": false, "error": "…"}` on stdout, the same as on OutLayer.

| Variable                   | Meaning                                                                                                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TAIL_LOCAL_REFEREE_DIR`   | Required. Holds `verdict.key` and `vrf.key` (ed25519 seeds), `state.key` (XChaCha20-Poly1305) and `storage/` (one file per record, `referee:box_sk` included). Each is generated on first use, mode 0600, dir 0700.    |
| `TAIL_LOCAL_REFEREE_OWNER` | The sender in the VRF alpha, where OutLayer puts the caller. Default `local-test-referee`. It may not contain `:`.                                                                                                     |
| `NEARAI_API_KEY`           | Optional. With it, `voice` asks NEAR AI Cloud exactly as the enclave does; without it, every line is the template.                                                                                                     |
| `NEARAI_MODEL`             | Optional. The model `voice` asks; checked against the model rules ("Handler voice").                                                                                                                                   |
| `ALLOW_UNATTESTED`         | Optional. `1` lets `enroll` take a device without an App Attest attestation (ghosts), stored and receipted as `attested: false`. On OutLayer the same name is read from the author secret row; set it on testnet only. |

How it differs from the enclave:

- No owner check. The process boundary is the trust boundary, and only the relay spawns it.
- `call_id` is a random v4 UUID per process. It names no OutLayer attestation record.
- The VRF is the same construction with a local key: `ed25519(vrf_sk, "vrf:{call_id}:{owner}:{seed}")`.
  The contract's checks (seed = match id hex, length, signature under `vrf_pk`) hold for it.
- The state blob is `nonce (24 B) ‖ XChaCha20-Poly1305(state.key, aad)`.
- Storage writes are files renamed or hard-linked into place. `set_if_absent` is a hard link.
  Compare-and-swap runs under an advisory lock, so two processes on one directory stay
  consistent.
- `voice` makes the same two NEAR AI Cloud calls as the enclave (the completion with its 3 s
  budget, then the signature lookup with its 10 s of retries), natively over HTTPS (`ureq` with
  rustls, `src/http/native.rs`). The line and its signature are real NEAR AI output, which the
  replay and `tail-verify` check as they would the enclave's. What is not attested is the
  referee process itself: no enclave measurement backs the code that built the request and
  sealed the line.
  Without `NEARAI_API_KEY` every line is the template: `signed_text` is null, and the logged
  receipt has no `chat_id` and no signature.

`tests/local.rs` runs the built binary in a temporary directory, offline (it removes
`NEARAI_API_KEY` from the process, so `voice` speaks the template). It covers
`pubkeys` (`box_pk_sig` under `referee_pk`, the same keys from a second process and from 8
concurrent first calls), `enroll` ×3 (receipts naming `referee_pk`), re-enrolment (the same keys
return the stored receipt; other keys are refused without `rebind_sig`, or with one from the
wrong key, and accepted with the enrolled device's) and `start` (signature over the verdict
digest, signed, padded and sealed player keys, a second `start` refused). It then plays three ticks: a hint, a forged
batch refused with `ASSERTION`, signed HUDs naming the log, `voice` (only the five fields, the template padded,
sealed and signed to the asker; a forged hint blob refused), a receipt with an altered prefix
refused, the receipt passed twice and logged once in the next tick, a
Checkpoint, and the end. Then two racing `end`s that record one End between them, the verdict chain,
every consistency proof, the VRF reveal under `vrf_pk` with the contract's alpha checks,
`declassify` (refused with a blob missing; the log equals the leaves, with `Enrolled`, `Tick`,
`Rejected` and the receipt, every salt checked against the released `K_m`),
`declassify_batches` with assertions, and the file modes. A second match ends twice with the
same input (the same End back, byte for byte) and is refused a third `end` that would log a
receipt the first left out.

`REFEREE_MODE=local bun crates/referee-wasi/scripts/smoke.ts` (and `match.ts`) run the same
scripts as on OutLayer against `target/release/tail-referee`, checked with `packages/protocol`,
with keys in `TAIL_LOCAL_REFEREE_DIR` or a fresh temp directory.

## Build, deploy, test

```sh
cd crates/referee-wasi && cargo test && cargo clippy --all-targets -- -D warnings \
  && cargo clippy --target wasm32-wasip2 --all-targets -- -D warnings && cargo fmt --check
bun crates/referee-wasi/scripts/build.ts                     # → target/tail-referee.wasm + sha256
wasm-tools component wit crates/referee-wasi/target/tail-referee.wasm | grep import   # wasi ≤ 0.2.6
OUTLAYER_NETWORK=testnet outlayer upload crates/referee-wasi/target/tail-referee.wasm
OUTLAYER_NETWORK=testnet outlayer deploy [--no-activate] tail-referee <FastFS URL>
# author secrets, read from .env.local inside the command and never echoed (ALLOW_UNATTESTED=1
# lets the ghost scripts enrol software keys; testnet only):
K=$(grep '^NEARAI_API_KEY=' .env.local | cut -d= -f2-) M=$(grep '^NEARAI_MODEL=' .env.local | cut -d= -f2-) \
  sh -c 'OUTLAYER_NETWORK=testnet outlayer secrets set "{\"NEARAI_API_KEY\":\"$K\",\"NEARAI_MODEL\":\"$M\",\"ALLOW_UNATTESTED\":\"1\"}" \
  --project tail-dev-a38d13.testnet/tail-referee --profile referee'
bun crates/referee-wasi/scripts/smoke.ts                     # every command, checked with packages/protocol
bun crates/referee-wasi/scripts/match.ts                     # a full 3-player match with ghost phones
bun crates/referee-wasi/scripts/latency.ts                   # sealed vs storage, 1/16/128 KB, N=50 each
```

The scripts read the repo-root `.env.local`. `REFEREE_PAYMENT_KEY` takes precedence over
`OUTLAYER_PAYMENT_KEY`, and `REFEREE_VERSION=<wasm sha256>` pins a deployed version that is not
active.

Active version on OutLayer: wasm sha256 `092ec57c8dc0b99f815524c1a4ebe016f202ac58faec2206930140679641f694`
(775,347 bytes; WASI imports 0.2.6, HTTP 0.2.4), built by `scripts/build.ts` from this source and
deployed on 2026-11-13; `get_project` on `outlayer.testnet` names it as `active_version`. The
`ALLOW_UNATTESTED` author secret was set the same day. It has never executed a call: that evening
OutLayer's testnet API took requests, but every call, to this build or to the one before it,
returned HTTP 524 after about 125 s. So whether its `pubkeys` returns the project's keys, and a
relay Start against it, are not checked yet. It is not in the replay's pinned list
(`apps/web/src/verify/pins.ts`).

Before it, the v2 build `3f9320a61236f02f72481c2ec2b920854f22c7554924a315eebbea52aad85690`
(768 KB, deployed earlier on 2026-11-13) returned the same keys as the v1 build `20446c64…08664`
and refused unattested devices, since `ALLOW_UNATTESTED` was not set then. It predates `devices`,
the idempotent `end`, the legacy device record read by `enroll`, `pubkeys` `app_id` and state
version 7.

Builds do not reproduce byte for byte: `scripts/build.ts` of the same source in another checkout
on the same machine gave `5e9cbb689229010b5ca91be184f8f3a76fb1150b095876783a4afec4a6514f4b`
(776,147 bytes), which was never uploaded. Compare a call's `executed_wasm_sha256` with the
uploaded hash above, not with a fresh build.
