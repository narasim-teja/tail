# @tail/protocol

TAIL's wire formats and crypto in TypeScript. `crates/tail-protocol` is the Rust twin. Both
reproduce the same golden vectors in `vectors/`, byte for byte, so the phone, the relay, the
enclave referee and the NEAR contract can't drift apart. This is protocol v2.

```sh
bun test packages/protocol                         # TS against the vectors
cargo test -p tail-protocol                        # Rust against the same vectors
bun run --cwd packages/protocol vectors            # regenerate (only on a deliberate format change)
```

| Vector file        | Pins                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------- |
| `beacon.json`      | key derivation, tokens, UUIDs                                                         |
| `batch.json`       | `Batch`, `BatchEnvelope`, batch hash, App Attest client data, enrolment, re-enrolment |
| `verdicts.json`    | every `Verdict` kind, signed and chained by `prev`                                    |
| `merkle.json`      | the four v1 log entries, roots for every size, audit paths                            |
| `log.json`         | the log entries added in v2                                                           |
| `consistency.json` | consistency proofs for a set of (m, n) up to 70, with the peaks at m                  |
| `presence.json`    | a presence proof and the anchored roots it checks against                             |
| `ring.json`        | players hash, ring commitment, ring                                                   |
| `seal.json`        | sealing, and every low-order X25519 encoding                                          |
| `hud.json`         | HUD v2, and the signed, padded, sealed HUD, keys and Handler line, `PHONE_PAD`        |
| `pricing.json`     | hint prices over (stake, kind, demand), the demand window, the reasons                |
| `auth.json`        | relay request and challenge digests                                                   |
| `carry.json`       | mesh carry envelope and relay receipt (TypeScript only: phone ↔ relay)                |

## Encoding

Everything that is signed, hashed or sealed is [borsh](https://borsh.io): little-endian
integers, `u32` length prefixes, `u8` enum tags in declaration order. Enum variants are only
ever appended. A v1 log does not decode here: v2 added a salt to `Contact` and `HintReceipt`, and
the web replay reads v1 logs with its own decoder (`apps/web/src/verify/v1.ts`). Decoders reject
trailing bytes.

## Keys and the beacon

| Value     | Definition                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| `K_m`     | 32 random bytes per match, generated in the enclave                                                                       |
| `K_tag`   | `HKDF-SHA256(salt = ∅, ikm = K_m, info = "tail/tag")`                                                                     |
| `K_p[i]`  | `HKDF-SHA256(salt = ∅, ikm = K_m, info = "tail/beacon" ‖ u16le(i))`                                                       |
| `K_log`   | `HKDF-SHA256(salt = ∅, ikm = K_m, info = "tail/log")`                                                                     |
| log salt  | `HMAC(K_log, "tail/log-salt" ‖ u64le(leaf index))[0..16]`                                                                 |
| epoch `e` | `floor((now_ms − start_ms) / 15000)`                                                                                      |
| token     | `HMAC(K_tag, "tag" ‖ u32le(e))[0..4] ‖ HMAC(K_p[i], "tok" ‖ u32le(e))[0..12]`, advertised as one 128-bit BLE service UUID |

Phones keep only tokens whose first 4 bytes match this match's tag for `e−1`, `e` or `e+1`.
Only the enclave, which holds every `K_p[i]`, can tell whose token it is. `K_m` stays in the
enclave until `declassify` releases it with the log after End.

## Messages

| Message          | Fields (borsh order)                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Fix`            | `t_ms u64, lat_e7 i32, lon_e7 i32, acc_m u16, speed_cmps u16, flags u8`                                                                                                                                                                                                  |
| `Sighting`       | `epoch u32, token [u8;16], rssi_max i8, rssi_med i8, n u8`                                                                                                                                                                                                               |
| `Action`         | `Hint { hint u8, nonce u32, text Option<String> }` · `Strike { nonce u32 }`                                                                                                                                                                                              |
| `Batch`          | `match_id [u8;16], player u16, seq u32, prev [u8;32], t_ms u64, fixes, sightings, actions`                                                                                                                                                                               |
| `BatchEnvelope`  | `batch, assertion Vec<u8>` (App Attest assertion)                                                                                                                                                                                                                        |
| `Verdict`        | `Start`, `Hint { from u16, amount u128, hint_id u32, hint u8, t_ms u64 }` (no target), `Tag { hunter, target, credit u128 }`, `Forfeit { player, to, credit u128 }`, `Checkpoint`, `End { alpha, vrf_signature, log_size, root, hint_targets Vec<u16> }`                 |
| `SignedVerdict`  | `match_id, seq u32, prev [u8;32], call_id [u8;16], body Verdict, sig [u8;64]`                                                                                                                                                                                            |
| `LogEntry`       | `Batch`, `Contact`, `Verdict`, `HintReceipt` (tags 0–3) · `Tick`, `Rejected`, `Evidence`, `Enrolled` (v2, tags 4–7)                                                                                                                                                      |
| `PresenceProof`  | `match_id, contract String, entry LogEntry, index u64, size u64, path Vec<[u8;32]>, accounts [String;2]`                                                                                                                                                                 |
| `PlayerKeys`     | `match_id, player, start_ms, end_ms, k_tag, k_player, target String`                                                                                                                                                                                                     |
| `Hud`            | `match_id, player u16, tick, epoch, lock, heat, head u128, status, target, leak?, hint_fact?, tagged_by?, next_seq u32, chain_tip [u8;32], dark_ms u32, tags u8, log_size u64, root [u8;32], rejected Option<(seq u32, code u8)>, hint_prices [u128;3], hint_recent u32` |
| `VoiceLine`      | `match_id, player u16, hint_id u32, text String`                                                                                                                                                                                                                         |
| `SignedHud` etc. | `SignedHud { hud, sig }`, `SignedPlayerKeys { keys, sig }`, `SignedVoiceLine { line, sig }`                                                                                                                                                                              |
| `CarryRequest`   | `account String, time_ms u64, method String, path String, body Vec<u8>, sig [u8;64]` (TypeScript only)                                                                                                                                                                   |
| `CarryAck`       | `status u16, received_ms u64, sig [u8;64]` (TypeScript only)                                                                                                                                                                                                             |

The log entries:

| Entry         | Fields                                                                                                    | Written                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `Batch`       | `player u16, seq u32, hash [u8;32]`                                                                       | for each accepted batch                                           |
| `Contact`     | `a u16, b u16, epoch u32, salt [u8;16]`                                                                   | when two players' contact in an epoch is established              |
| `Verdict`     | `seq u32, digest [u8;32]`                                                                                 | for each verdict                                                  |
| `HintReceipt` | `hint_id u32, chat_id String, text_hash [u8;32], signature Vec<u8>, signing_address String, salt [u8;16]` | when a Handler line's receipt comes back                          |
| `Tick`        | `tick_no u32, now_ms u64, call_id [u8;16]`                                                                | every referee tick                                                |
| `Rejected`    | `player u16, seq u32, hash [u8;32], code u8`                                                              | for each refused batch (`code`: `RejectCode`/`reject_code`)       |
| `Evidence`    | `hunter u16, target u16, strike_seq u32, strike_epoch u32, epochs Vec<u32>, salt [u8;16]`                 | just before a Tag's `Verdict` entry: the contact epochs behind it |
| `Enrolled`    | `player u16, account String, key_hash [u8;32], attested bool`                                             | at start, one per player                                          |

**Salts.** During play the relay holds every leaf hash, and the entries it could guess are few:
`Contact { a, b, epoch }` has about 16,000 values in a 12-player hour, so without a salt the
relay could hash each one and read the whole contact graph off the leaves, and a template
`HintReceipt` or an `Evidence` would give its facts away the same way. Those three end in
`salt = logSalt(K_log, index)` / `log_salt`, bound to the entry's position, so the referee has
no choice of salt either. After End anyone with the released `K_m` checks every salt:
`badLogSalts(K_m, log)` returns the indexes that fail, `check_log_salts` the first. The leaf
rule is unchanged, so the contract's `verify_inclusion` takes salted entries as they are.

**Refusal codes.** Why the referee refused a batch (`Rejected.code`, `Hud.rejected`) and why it
took no action on a valid batch's Strike or Hint (the tick's `refused[].reason`):

| `RejectCode` / `reject_code` |                | `RefuseCode` / `refuse_code` |                 |
| ---------------------------- | -------------- | ---------------------------- | --------------- |
| 1 `UnknownPlayer`            | 7 `ClockSkew`  | 1 `PlayerOut`                | 6 `UnknownHint` |
| 2 `WrongMatch`               | 8 `FixFlags`   | 2 `TimeUp`                   | 7 `TextTooLong` |
| 3 `PlayerOut`                | 9 `FixOrder`   | 3 `MatchOver`                | 8 `Cooldown`    |
| 4 `Seq`                      | 10 `Teleport`  | 4 `Lock`                     | 9 `Funds`       |
| 5 `Prev`                     | 11 `TimeOrder` | 5 `NoContact`                | 10 `NoFix`      |
| 6 `Assertion`                | 12 `TooOld`    |                              | 11 `HintLimit`  |

## Hashes and signatures

| What                            | Definition                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| batch hash (chain link, log id) | `SHA256(borsh(Batch))`                                                                                                                    |
| assertion client data hash      | `SHA256("tail/batch" ‖ borsh(Batch))`                                                                                                     |
| enrolment client data hash      | `SHA256("tail/enroll/v1" ‖ challenge[32] ‖ borsh(account_id) ‖ player_box_pk ‖ near_pk)`                                                  |
| re-enrolment (`rebind_sig`)     | `ed25519(old near_sk, SHA256("tail/rebind/v1" ‖ borsh(account_id) ‖ app_attest_pk[65] ‖ player_box_pk ‖ near_pk))`, the new device's keys |
| verdict digest                  | `SHA256("tail/verdict/v2" ‖ borsh(match_id, seq, prev, call_id, body))`, signed with ed25519 by the enclave key                           |
| HUD signature                   | `ed25519(referee_sk, SHA256("tail/hud/v2" ‖ borsh(Hud)))`                                                                                 |
| keys signature                  | `ed25519(referee_sk, SHA256("tail/keys/v2" ‖ borsh(PlayerKeys)))`                                                                         |
| Handler line signature          | `ed25519(referee_sk, SHA256("tail/voice/v1" ‖ borsh(VoiceLine)))`                                                                         |
| relay request                   | `SHA256("tail/relay-req/v2" ‖ borsh(contract_id) ‖ borsh(account_id) ‖ borsh(METHOD) ‖ borsh(path) ‖ u64le(time_ms) ‖ SHA256(body))`      |
| HUD / replay challenge          | `SHA256("tail/hud-auth/v1" or "tail/replay-auth/v1" ‖ nonce[32] ‖ match_id[16] ‖ borsh(account_id))`                                      |
| carry receipt                   | `ed25519(relay_sk, SHA256("tail/carry-ack/v1" ‖ SHA256(envelope) ‖ u16le(status) ‖ u64le(received_ms)))`                                  |
| players hash                    | `SHA256("tail/players" ‖ borsh(Vec<String> sorted by UTF-8 bytes))`                                                                       |
| ring commit                     | `SHA256("tail/ring" ‖ vrf_signature)`                                                                                                     |
| ring                            | Fisher–Yates over sorted ids; `r_k = u64le(SHA256(SHA256(vrf_sig) ‖ u32le(k))[0..8])`, `j = r_k mod (i+1)`                                |

`call_id` is the OutLayer call that produced the verdict. With it, anyone can fetch that call's
public attestation record and check which wasm hash actually ran.

**Verdict chain.** `prev` is the verdict digest of the match's previous verdict, and 32 zero
bytes for the first (seq 1). A referee that signed two different verdicts for the same seq
cannot get both onto the chain, and anyone holding the stream can check it
(`verdictChainBreak`).

**Settlement replay.** `settle.ts` / `settle.rs` hold the one rule the contract runs at End
(TECHNICAL 4.10): `replaySettlement(ring, events, hintTargets, pool)` replays every Hint, Tag
and Forfeit against the ring (`ringOrder`, player indices) and End's `hintTargets`, and returns
what each survivor is still owed, or the first broken rule (`SettleCheck`, stored by the
contract as a borsh enum: append, never reorder). `MAX_HINTS` (240) bounds the hints per match.

**Hint pricing.** `pricing.ts` / `pricing.rs` are the only place hint prices are defined. The
Handler prices intel by demand: `hintPrice(stake, kind, recent) = HINT_BPS[kind] × stake / 10 000
× min(10 000 + PRICE_STEP_BPS × recent, PRICE_CAP_BPS) / 10 000`, each division rounded down,
where `recent = recentHints(earlier hints' t_ms, t_ms)` counts the match's hints with
`t_ms − PRICE_WINDOW_MS < t ≤ t_ms`. Base prices are 2 % of the stake (NEAR, TREND) and 5 %
(BEARING); each hint in the last 5 minutes adds 25 %, up to 4x. A Hint verdict carries its
`t_ms` (the referee clock when charged, at most `end_ms`), so the contract recomputes the price
from public data alone and refuses any other amount. The HUD's `hint_prices` (indexed by
`HintKind`) and `hint_recent` are the board at the end of the tick; `priceReason(kind, recent)`
is the Handler's one line on it, the same words the voice prompt gets.

**Request auth.** The relay request digest names the account and the contract, so a signature
cannot be replayed for another account that shares the key, or against another deployment.

ed25519 checks are strict RFC 8032 in both languages (noble with `zip215: false`, dalek
`verify_strict`; Rust behind the `verify` feature).

## Merkle log

RFC 6962: `leaf = SHA256(0x00 ‖ borsh(entry))`, `node = SHA256(0x01 ‖ l ‖ r)`, empty root
`SHA256("")`. Both languages provide:

- inclusion proofs and their RFC 9162 §2.1.3 verifier;
- consistency proofs (§2.1.4): `consistencyProof(leaves, m)` / `consistency_proof`, and the
  verifier `verifyConsistency(m, n, oldRoot, newRoot, proof)` / `verify_consistency`. Size 0 is
  a prefix of every log (old root = empty root, empty proof);
- a frontier prover, `consistencyProofFromFrontier(m, peaks, appended)` /
  `consistency_proof_from_frontier`, that needs only the peaks at size m (one subtree root per
  set bit of m, largest first) and the leaf hashes appended since. That is what the referee
  keeps. `merkleRootFromFrontier` / `root_from_frontier` gives the new root from the same data.

In Rust, `verify_with` and `verify_consistency_with` take the hash function, so the NEAR
contract can run them on its SHA-256 host function. Both sides are tested against a
level-by-level reference tree for every 0 < m ≤ n ≤ 70.

## Presence proofs

A `PresenceProof` says "these two phones were near each other". It is a `Contact` log entry,
its index, the log size of a root the contract anchored (a `Checkpoint` or `End`), the audit
path and the two account ids. `verifyPresence(proof, roots, players)` / `verify_presence`
recomputes the leaf, checks the path against the anchored root of that size, and maps the
entry's player indexes to accounts through the contract's player list (the entry's salt is
part of the leaf, so a proof carries it). The caller reads
`roots` and `players` from `proof.contract` for `proof.match_id`. There is no new signature: the
proof is as strong as the referee's signature on that root. `presenceProof(...)` builds one
from the log.

## Sealing

`sealed = eph_pk[32] ‖ ChaCha20-Poly1305(key, nonce = 0¹², plaintext, aad = context)`, where
`key = HKDF-SHA256(ikm = X25519(eph_sk, recipient_pk), salt = eph_pk ‖ recipient_pk, info = "tail/seal/v1")`.
A fresh ephemeral key per message makes the fixed nonce safe. The context names what is sealed,
so a ciphertext can't be replayed as another kind of message:

| Context         | Plaintext                                               | Sealed to       |
| --------------- | ------------------------------------------------------- | --------------- |
| `tail/batch`    | `BatchEnvelope`                                         | referee box key |
| `tail/keys/v2`  | `u32le(len) ‖ borsh(SignedPlayerKeys) ‖ 0…`, 1024 bytes | player box key  |
| `tail/hud/v2`   | `u32le(len) ‖ borsh(SignedHud) ‖ 0…`, 1024 bytes        | player box key  |
| `tail/voice/v1` | `u32le(len) ‖ borsh(SignedVoiceLine) ‖ 0…`, 1024 bytes  | asker's box key |
| `tail/carry/v1` | `u32le(len) ‖ borsh(CarryRequest) ‖ 0…`, 4096 bytes     | relay box key   |

Everything the referee seals to a phone is padded to `PHONE_PAD` (1024) bytes first, so every
one seals to 32 + 1024 + 16 bytes. Otherwise the relay could read the target's account id off
the length of the keys, and a template Handler line's hint off its length. The padding lives
inside the helpers, so no caller can forget it: `sealToPhone` / `openOnPhone` (TS) and
`seal_to_phone_with` / `open_on_phone` (Rust, typed by `ToPhone`, which also fixes the context).
Unpadding is strict (size, length and zero padding), and an oversized message is refused. The
largest HUD (two 64-byte account ids, every option) is 401 bytes and keys at most 230, so the
voice is the only variable one: its text may be at most `VOICE_TEXT_MAX` (930) bytes.

Anyone with a phone's box public key can seal to it, the relay included, so what the referee
seals is also signed by it: `openSignedHud`, `openSignedPlayerKeys` and `openSignedVoiceLine`
open, unpad, decode and check the signature in one step.

Low-order X25519 public keys (the 7 encodings of points of order dividing 8, with or without bit
255) are refused when sealing and when opening (`isLowOrderX25519` / `is_low_order`), and an
all-zero shared secret is refused as well. With such a key the "sealed" message would be
readable by anyone.

## Mesh carry

A phone without signal hands `sealCarry(relay_box_pk, request)` to nearby phones. Every
envelope is the same size, so carriers learn nothing from it. The relay opens it with
`openCarry`, checks the sender's request signature as usual, and answers with a `CarryAck`
(`signCarryAck` / `verifyCarryAck`) over the envelope's hash, the HTTP status and the time it
received it.
