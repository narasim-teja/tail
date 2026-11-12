# @tail/protocol

TAIL's wire formats and crypto in TypeScript. `crates/tail-protocol` is the Rust twin. Both
reproduce the same golden vectors in `vectors/`, byte for byte, so the phone, the relay, the
enclave referee and the NEAR contract can't drift apart.

```sh
bun test packages/protocol                         # TS against the vectors
cargo test -p tail-protocol                        # Rust against the same vectors
bun run --cwd packages/protocol vectors            # regenerate (only on a deliberate format change)
```

## Encoding

Everything that is signed, hashed or sealed is [borsh](https://borsh.io): little-endian
integers, `u32` length prefixes, `u8` enum tags in declaration order. Enum variants are only
ever appended. Decoders reject trailing bytes.

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

| Message         | Fields (borsh order)                                                                       |
| --------------- | ------------------------------------------------------------------------------------------ |
| `Fix`           | `t_ms u64, lat_e7 i32, lon_e7 i32, acc_m u16, speed_cmps u16, flags u8`                    |
| `Sighting`      | `epoch u32, token [u8;16], rssi_max i8, rssi_med i8, n u8`                                 |
| `Action`        | `Hint { hint u8, nonce u32, text Option<String> }` · `Strike { nonce u32 }`                |
| `Batch`         | `match_id [u8;16], player u16, seq u32, prev [u8;32], t_ms u64, fixes, sightings, actions` |
| `BatchEnvelope` | `batch, assertion Vec<u8>` (App Attest assertion)                                          |
| `Verdict`       | `Start`, `Hint`, `Tag`, `Forfeit`, `Checkpoint`, `End`                                     |
| `SignedVerdict` | `match_id, seq u32, call_id [u8;16], body Verdict, sig [u8;64]`                            |
| `LogEntry`      | `Batch`, `Contact`, `Verdict`, `HintReceipt`                                               |
| `PlayerKeys`    | `match_id, player, start_ms, end_ms, k_tag, k_player, target String`                       |
| `Hud`           | `tick, epoch, lock, heat, head u128, status, target, leak?, hint_fact?, tagged_by?`        |

## Hashes and signatures

| What                            | Definition                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| batch hash (chain link, log id) | `SHA256(borsh(Batch))`                                                                                     |
| assertion client data hash      | `SHA256("tail/batch" ‖ borsh(Batch))`                                                                      |
| enrolment client data hash      | `SHA256("tail/enroll/v1" ‖ challenge[32] ‖ borsh(account_id) ‖ player_box_pk ‖ near_pk)`                   |
| verdict digest                  | `SHA256("tail/verdict/v1" ‖ borsh(match_id, seq, call_id, body))`, signed with ed25519 by the enclave key  |
| players hash                    | `SHA256("tail/players" ‖ borsh(Vec<String> sorted by UTF-8 bytes))`                                        |
| ring commit                     | `SHA256("tail/ring" ‖ vrf_signature)`                                                                      |
| ring                            | Fisher–Yates over sorted ids; `r_k = u64le(SHA256(SHA256(vrf_sig) ‖ u32le(k))[0..8])`, `j = r_k mod (i+1)` |
| Merkle log                      | RFC 6962: `leaf = SHA256(0x00 ‖ borsh(entry))`, `node = SHA256(0x01 ‖ l ‖ r)`, empty root `SHA256("")`     |

`call_id` is the OutLayer call that produced the verdict. With it, anyone can fetch that call's
public attestation record and check which wasm hash actually ran.

## Sealing

`sealed = eph_pk[32] ‖ ChaCha20-Poly1305(key, nonce = 0¹², plaintext, aad = context)`, where
`key = HKDF-SHA256(ikm = X25519(eph_sk, recipient_pk), salt = eph_pk ‖ recipient_pk, info = "tail/seal/v1")`.
A fresh ephemeral key per message makes the fixed nonce safe. The `context` string
(`"tail/batch"`, `"tail/keys"`, `"tail/hud"`) stops a ciphertext being replayed as another
kind of message.
