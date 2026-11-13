# @tail/protocol

TAIL's wire formats and crypto in TypeScript. `crates/tail-protocol` is the Rust twin. Both
reproduce the same golden vectors in `vectors/`, byte for byte, so the phone, the relay, the
enclave referee and the NEAR contract can't drift apart. This is protocol v2.

```sh
bun test packages/protocol                         # TS against the vectors
cargo test -p tail-protocol                        # Rust against the same vectors
bun run --cwd packages/protocol vectors            # regenerate (only on a deliberate format change)
```

| Vector file        | Pins                                                                    |
| ------------------ | ----------------------------------------------------------------------- |
| `beacon.json`      | key derivation, tokens, UUIDs                                           |
| `batch.json`       | `Batch`, `BatchEnvelope`, batch hash, App Attest client data, enrolment |
| `verdicts.json`    | every `Verdict` kind, signed and chained by `prev`                      |
| `merkle.json`      | the four v1 log entries, roots for every size, audit paths              |
| `log.json`         | the log entries added in v2                                             |
| `consistency.json` | consistency proofs for a set of (m, n) up to 70, with the peaks at m    |
| `presence.json`    | a presence proof and the anchored roots it checks against               |
| `ring.json`        | players hash, ring commitment, ring                                     |
| `seal.json`        | sealing, and every low-order X25519 encoding                            |
| `hud.json`         | HUD v2, and the signed, sealed HUD, keys and Handler line               |
| `auth.json`        | relay request and challenge digests                                     |
| `carry.json`       | mesh carry envelope and relay receipt (TypeScript only: phone ↔ relay)  |

## Encoding

Everything that is signed, hashed or sealed is [borsh](https://borsh.io): little-endian
integers, `u32` length prefixes, `u8` enum tags in declaration order. Enum variants are only
ever appended, so a v1 log entry decodes unchanged. Decoders reject trailing bytes.

## Keys and the beacon

| Value     | Definition                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| `K_m`     | 32 random bytes per match, generated in the enclave                                                                       |
| `K_tag`   | `HKDF-SHA256(salt = ∅, ikm = K_m, info = "tail/tag")`                                                                     |
| `K_p[i]`  | `HKDF-SHA256(salt = ∅, ikm = K_m, info = "tail/beacon" ‖ u16le(i))`                                                       |
| epoch `e` | `floor((now_ms − start_ms) / 15000)`                                                                                      |
| token     | `HMAC(K_tag, "tag" ‖ u32le(e))[0..4] ‖ HMAC(K_p[i], "tok" ‖ u32le(e))[0..12]`, advertised as one 128-bit BLE service UUID |

Phones keep only tokens whose first 4 bytes match this match's tag for `e−1`, `e` or `e+1`.
Only the enclave, which holds every `K_p[i]`, can tell whose token it is.

## Messages

| Message          | Fields (borsh order)                                                                                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Fix`            | `t_ms u64, lat_e7 i32, lon_e7 i32, acc_m u16, speed_cmps u16, flags u8`                                                                                                                                                           |
| `Sighting`       | `epoch u32, token [u8;16], rssi_max i8, rssi_med i8, n u8`                                                                                                                                                                        |
| `Action`         | `Hint { hint u8, nonce u32, text Option<String> }` · `Strike { nonce u32 }`                                                                                                                                                       |
| `Batch`          | `match_id [u8;16], player u16, seq u32, prev [u8;32], t_ms u64, fixes, sightings, actions`                                                                                                                                        |
| `BatchEnvelope`  | `batch, assertion Vec<u8>` (App Attest assertion)                                                                                                                                                                                 |
| `Verdict`        | `Start`, `Hint { from, to, amount u128, hint_id u32, hint u8 }`, `Tag`, `Forfeit`, `Checkpoint`, `End`                                                                                                                            |
| `SignedVerdict`  | `match_id, seq u32, prev [u8;32], call_id [u8;16], body Verdict, sig [u8;64]`                                                                                                                                                     |
| `LogEntry`       | `Batch`, `Contact`, `Verdict`, `HintReceipt` (v1, tags 0–3) · `Tick`, `Rejected`, `Evidence`, `Enrolled` (v2, tags 4–7)                                                                                                           |
| `PresenceProof`  | `match_id, contract String, entry LogEntry, index u64, size u64, path Vec<[u8;32]>, accounts [String;2]`                                                                                                                          |
| `PlayerKeys`     | `match_id, player, start_ms, end_ms, k_tag, k_player, target String`                                                                                                                                                              |
| `Hud`            | `match_id, player u16, tick, epoch, lock, heat, head u128, status, target, leak?, hint_fact?, tagged_by?, next_seq u32, chain_tip [u8;32], dark_ms u32, tags u8, log_size u64, root [u8;32], rejected Option<(seq u32, code u8)>` |
| `VoiceLine`      | `match_id, player u16, hint_id u32, text String`                                                                                                                                                                                  |
| `SignedHud` etc. | `SignedHud { hud, sig }`, `SignedPlayerKeys { keys, sig }`, `SignedVoiceLine { line, sig }`                                                                                                                                       |
| `CarryRequest`   | `account String, time_ms u64, method String, path String, body Vec<u8>, sig [u8;64]` (TypeScript only)                                                                                                                            |
| `CarryAck`       | `status u16, received_ms u64, sig [u8;64]` (TypeScript only)                                                                                                                                                                      |

The v2 log entries:

| Entry      | Fields                                                                      | Written                                                           |
| ---------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `Tick`     | `tick_no u32, now_ms u64, call_id [u8;16]`                                  | every referee tick                                                |
| `Rejected` | `player u16, seq u32, hash [u8;32], code u8`                                | for each refused batch (`code`: `RejectCode`/`reject_code`)       |
| `Evidence` | `hunter u16, target u16, strike_seq u32, strike_epoch u32, epochs Vec<u32>` | just before a Tag's `Verdict` entry: the contact epochs behind it |
| `Enrolled` | `player u16, account String, key_hash [u8;32], attested bool`               | at start, one per player                                          |

## Hashes and signatures

| What                            | Definition                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| batch hash (chain link, log id) | `SHA256(borsh(Batch))`                                                                                                               |
| assertion client data hash      | `SHA256("tail/batch" ‖ borsh(Batch))`                                                                                                |
| enrolment client data hash      | `SHA256("tail/enroll/v1" ‖ challenge[32] ‖ borsh(account_id) ‖ player_box_pk ‖ near_pk)`                                             |
| verdict digest                  | `SHA256("tail/verdict/v2" ‖ borsh(match_id, seq, prev, call_id, body))`, signed with ed25519 by the enclave key                      |
| HUD signature                   | `ed25519(referee_sk, SHA256("tail/hud/v2" ‖ borsh(Hud)))`                                                                            |
| keys signature                  | `ed25519(referee_sk, SHA256("tail/keys/v2" ‖ borsh(PlayerKeys)))`                                                                    |
| Handler line signature          | `ed25519(referee_sk, SHA256("tail/voice/v1" ‖ borsh(VoiceLine)))`                                                                    |
| relay request                   | `SHA256("tail/relay-req/v2" ‖ borsh(contract_id) ‖ borsh(account_id) ‖ borsh(METHOD) ‖ borsh(path) ‖ u64le(time_ms) ‖ SHA256(body))` |
| HUD / replay challenge          | `SHA256("tail/hud-auth/v1" or "tail/replay-auth/v1" ‖ nonce[32] ‖ match_id[16] ‖ borsh(account_id))`                                 |
| carry receipt                   | `ed25519(relay_sk, SHA256("tail/carry-ack/v1" ‖ SHA256(envelope) ‖ u16le(status) ‖ u64le(received_ms)))`                             |
| players hash                    | `SHA256("tail/players" ‖ borsh(Vec<String> sorted by UTF-8 bytes))`                                                                  |
| ring commit                     | `SHA256("tail/ring" ‖ vrf_signature)`                                                                                                |
| ring                            | Fisher–Yates over sorted ids; `r_k = u64le(SHA256(SHA256(vrf_sig) ‖ u32le(k))[0..8])`, `j = r_k mod (i+1)`                           |

`call_id` is the OutLayer call that produced the verdict. With it, anyone can fetch that call's
public attestation record and check which wasm hash actually ran.

**Verdict chain.** `prev` is the verdict digest of the match's previous verdict, and 32 zero
bytes for the first (seq 1). A referee that signed two different verdicts for the same seq
cannot get both onto the chain, and anyone holding the stream can check it
(`verdictChainBreak`).

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
entry's player indexes to accounts through the contract's player list. The caller reads
`roots` and `players` from `proof.contract` for `proof.match_id`. There is no new signature: the
proof is as strong as the referee's signature on that root. `presenceProof(...)` builds one
from the log.

## Sealing

`sealed = eph_pk[32] ‖ ChaCha20-Poly1305(key, nonce = 0¹², plaintext, aad = context)`, where
`key = HKDF-SHA256(ikm = X25519(eph_sk, recipient_pk), salt = eph_pk ‖ recipient_pk, info = "tail/seal/v1")`.
A fresh ephemeral key per message makes the fixed nonce safe. The context names what is sealed,
so a ciphertext can't be replayed as another kind of message:

| Context         | Plaintext                                           | Sealed to       |
| --------------- | --------------------------------------------------- | --------------- |
| `tail/batch`    | `BatchEnvelope`                                     | referee box key |
| `tail/keys/v2`  | `SignedPlayerKeys`                                  | player box key  |
| `tail/hud/v2`   | `SignedHud`                                         | player box key  |
| `tail/voice/v1` | `SignedVoiceLine`                                   | asker's box key |
| `tail/carry/v1` | `u32le(len) ‖ borsh(CarryRequest) ‖ 0…`, 4096 bytes | relay box key   |

Anyone with a phone's box public key can seal to it, the relay included, so what the referee
seals is also signed by it: `openSignedHud`, `openSignedPlayerKeys` and `openSignedVoiceLine`
open, decode and check the signature in one step.

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
