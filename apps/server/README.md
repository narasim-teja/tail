# relay

Bun + Hono + `bun:sqlite`. The relay carries sealed messages between the phones and the OutLayer
referee, submits the referee's signed verdicts to the `tail` contract, pays gas, and creates
player accounts. It is untrusted infrastructure: it is trusted for liveness only.

```
phone ──sealed batch──▶ relay ──tick──▶ OutLayer referee (TDX)
phone ◀──sealed HUD──── relay ◀─verdicts + proofs, sealed HUDs, leaf hashes, sealed log──┘
                         └──apply(verdicts, proofs)──▶ tail contract (NEAR testnet)
```

## Trust model

| The relay can                                                                                                                                                                | The relay cannot                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Delay or drop batches, HUDs and verdicts (liveness). A dropped batch counts as "dark" for that player; a stalled match refunds through `abort` after 15 min.                 | Read a batch, a HUD or a player's keys: they are sealed to the enclave or to the phone's box key.                               |
| Refuse to start or tick a match.                                                                                                                                             | Sign a verdict, or move money any other way: heads move only on referee-signed verdicts, in seq order, checked by the contract. |
| See who uploads when, and how big the sealed blobs are. With mesh carry it also learns which phone carried whose request (the carrier posts it, the sender signed it).       | Create a tag. A tag needs mutual radio contact the enclave verifies from both phones' sealed, App Attest-signed batches.        |
| Replay an old sealed state blob. The referee refuses it (`last_seq` check), and two forks of one blob produce verdicts with the same seq, of which the contract accepts one. | Use a player's account: it holds one function-call key, which the phone generated and keeps. The relay never has it.            |
| Refuse to enrol a phone, or ask the referee to register a device. The referee checks the Apple attestation itself; the relay's check is only a first filter.                 | Forge later batches: the enclave checks every batch's assertion against the enrolled key.                                       |

The relay holds two secrets: the NEAR key of `NEAR_RELAY_ACCOUNT` (pays gas, creates accounts,
hosts matches; it is also the contract owner on testnet) and the OutLayer payment key. Neither is
ever logged (`@tail/log` redacts key fields; the config prints facts only).

## Endpoints

Bytes are base64 in JSON unless noted; match ids are 32 hex characters; amounts are decimal
strings in the token's smallest unit. Errors are `{error: "<short message>"}` with a 4xx/5xx status.

| Method, path                             | Auth                                        | Request                                                                                                                                                       | Response                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                            | –                                           | –                                                                                                                                                             | `{ok: true, contract, test_players, referee: {kind: "outlayer"\|"local", status: "unknown"\|"up"\|"down", last_ok_ms, last_error}}`            |
| `GET /referee`                           | –                                           | –                                                                                                                                                             | `{referee_pk, referee_box_pk, box_pk_sig, vrf_pk}` (base64, `vrf_pk` hex; from the referee's `pubkeys`, cached)                                |
| `POST /enroll/challenge`                 | – (rate limited per client)                 | `{handle}`                                                                                                                                                    | `{challenge (32 B), account_id, expires_ms}`                                                                                                   |
| `POST /enroll`                           | attestation                                 | `{challenge, key_id (32 B), attestation (CBOR), player_box_pk (32 B), near_pk (32 B ed25519), rebind_sig? (64 B)}`                                            | `{account_id}`, once the referee holds the device and the account exists (below)                                                               |
| `GET /enroll/status`                     | signed (the account)                        | –                                                                                                                                                             | `{account_id, with_referee, app_attest_key_id}`: refresh when `with_referee` is false or the keyId is not the phone's ("Refresh" below)        |
| `POST /enroll/refresh/challenge`         | signed (the account)                        | `{}`                                                                                                                                                          | `{challenge (32 B), account_id, expires_ms}`                                                                                                   |
| `POST /enroll/refresh`                   | signed (the account)                        | `{challenge, key_id (32 B), attestation (CBOR), player_box_pk (32 B), rebind_sig (64 B)}`                                                                     | `{account_id}`, once the referee accepted                                                                                                      |
| `POST /matches`                          | signed (host)                               | `{stake, duration_ms, zone: {lat_e7, lon_e7, radius_m}, safehouses?: [circle], public_replay, min_players, max_players, start_by_ms, invites?: [account_id]}` | `{match_id, zone_hash (hex), code}` (`code`: the short lobby code, e.g. `K7M-4QX`)                                                             |
| `GET /matches/:id`                       | –                                           | –                                                                                                                                                             | `{match_id, code, host, phase, start_ms, end_ms, tick_no, last_seq, players, chain: get_match}`                                                |
| `GET /matches/:id/zone`                  | signed (host, invitee or player)            | –                                                                                                                                                             | `{match_id, zone, keys: [{player, account_id, sealed}], error}`: `keys` holds the caller's own only, once started; `zone` null after the purge |
| `GET /join/:code`                        | –                                           | –                                                                                                                                                             | `{match_id}`; any case, dash optional; 404 unless the lobby is still open (not started here, not called off on chain)                          |
| `POST /matches/:id/start`                | signed (host)                               | `{}`                                                                                                                                                          | `{players (index order), keys: [the host's own {player, account_id, sealed}], start_ms, end_ms}`; 409 `code: "refresh"`, `accounts` (below)    |
| `POST /batch`                            | signed (player)                             | `{match_id, sealed}`                                                                                                                                          | `{queued, player}`; `queued: false` = these bytes already wait for the next tick (success)                                                     |
| `GET /hud?match_id=&account_id=`         | WebSocket challenge                         | see below                                                                                                                                                     | see below                                                                                                                                      |
| `GET /replay/:id`                        | – (challenge if not `public_replay`, below) | –                                                                                                                                                             | a `ReplayBundle` (`@tail/protocol` `replay.ts`); 409 until the match has ended                                                                 |
| `POST /replay/:id/challenge`             | – (rate limited per client)                 | `{account_id}`                                                                                                                                                | `{nonce}` (32 B, single use, 2 min)                                                                                                            |
| `GET /matches/:id/inclusion?leaf=&size=` | –                                           | `leaf`: 64 hex, `size` 1–65536                                                                                                                                | `{index, size, path: [hex]}`: RFC 9162 audit path of the leaf's first index among the first `size` leaves; 404 if not there                    |
| `GET /matches/:id/consistency?from=&to=` | –                                           | `0 ≤ from ≤ to ≤ 65536`                                                                                                                                       | `{from, to, path: [hex]}`: RFC 9162 consistency proof between the trees of the first `from` and `to` leaves                                    |
| `GET /carry/key`                         | –                                           | –                                                                                                                                                             | `{box_pk, ack_pk}` (base64): the relay's X25519 carry key and ed25519 receipt key                                                              |
| `POST /carry`                            | the inner request is signed                 | raw body: `sealCarry(box_pk, CarryRequest)`, 4144 bytes                                                                                                       | `{ack, hud?}`: base64 borsh `CarryAck`, and the sender's latest sealed `SignedHud` when the request was an accepted `/batch`                   |
| `POST /dev/topup`                        | signed; testnet only                        | `{account_id, amount}` (≤ 100 USDC.e)                                                                                                                         | `{account_id, credited}`: mints `usdc.fakes.testnet` to the relay and `ft_transfer_call`s it with `{"credit": account_id}`                     |
| `POST /dev/ghosts/fill`                  | signed (host); testing door                 | `{match_id}`                                                                                                                                                  | `{account_id}` of the test player now in the lobby (below)                                                                                     |

`sealed` in `keys` is a `SignedPlayerKeys` sealed with context `tail/keys/v2` (`openSignedPlayerKeys`).
Each player's keys go to that player only (its zone view, its HUD socket), not to the host: the
seal hides their content, but which blob is whose, and when it changes, is the player's business.

### Signed requests

Headers `x-tail-account`, `x-tail-time` (unix ms) and `x-tail-sig` (base64, 64 bytes): an
ed25519 signature by the account's NEAR function-call key (the `near_pk` it enrolled with) over

```
SHA256("tail/relay-req/v2" ‖ borsh(contract_id) ‖ borsh(account_id) ‖ borsh(METHOD) ‖ borsh(path incl. query) ‖ u64le(time) ‖ SHA256(body bytes))
```

`contract_id` is the contract this relay serves (`GET /health` `contract`), so a signature
made for another deployment, or another account, does not verify here. The time must be within
60 s of the relay's clock, and the same signed request is accepted once: a repeat answers 409
`{error: "request already seen", code: "duplicate"}`, except on `/batch`, where a repeat is
delivery and answers 200 `{duplicate: true, code: "duplicate"}`. A batch's digest is kept until
its match ends. This keeps strangers from filling a player's batch queue, opening lobbies on the
relay's NEAR, or starting a lobby they do not host. `src/auth.ts` has both sides
(`requestDigest`, `signRequestHeaders`).

### Rate limits

Routes anyone can call without a key are limited per client address, with a global cap behind
each (`src/limits.ts`): enrolment and refresh challenges (10 at once, then one per 30 s; at most
1000 open in all and 3 per handle and client, past which that client's oldest for the handle
goes, so a stranger cannot lock a handle's owner out), HUD sockets (30 at once, then one per 2 s; at most 1024 in
their 10 s auth window in all) and replay challenges (10 at once, then one per 10 s; at most 1000
open in all, 4 per player). Over a limit the answer is 429. The client is the TCP peer, or with
`RELAY_CLIENT_IP_HEADER` set, the last entry of that header: set it only behind a proxy you run
that overwrites it, because a client can send any header. A carried request counts against the
phone that posted the envelope. The per-client buckets live in memory; a restart empties them.
When the header is unset and the relay listens beyond loopback, it warns at startup: behind a
proxy or tunnel every phone would share the proxy's one bucket.

New phone enrolments are capped at `RELAY_ENROLS_PER_IP_PER_DAY` (default 3) per client address
and `RELAY_ENROLS_PER_DAY` (default 100) in all, over a rolling 24 h; each costs the relay about
0.1 NEAR. An enrolment the referee or the chain turns down does not count. App Attest proves that a genuine iPhone running this app made the key. It does not
prove a new person: one iPhone can make any number of App Attest keys, and so any number of
accounts, so these caps are what bounds that. A phone with many addresses (mobile data, Wi-Fi,
VPNs) still gets more than one network's share; the daily cap is the backstop. Test players
(ghosts) are made in-process on testnet only and do not count.

### Mesh carry

A phone without signal signs its request as usual, seals it with `sealCarry(box_pk, …)` (every
envelope is 4144 bytes) and hands it to nearby phones; any of them posts it to `POST /carry`.
The relay opens it and runs the inner request through its own routes exactly as if it came
directly (only `POST`, never `/carry` itself; the path must be plain: no `%` escapes, and
unchanged by URL parsing, so `/x/../carry` is refused). For `/batch` the request may be dated anywhere
from the match's start to now + 60 s. The answer is `{ack, hud?}`: `ack` is a `CarryAck` signed
with the key from `GET /carry/key` over SHA256(envelope), the inner status and the time the
relay received it, so sender and carrier can prove delivery; `hud` is the sender's latest
sealed HUD when the relay accepted its batch. The keys live in `RELAY_KEYS_DIR` (default
`.keys/relay/carry.json`), made on first start and never logged.

### HUD socket

1. Connect `GET /hud?match_id=…&account_id=…` (refused with 403/409 unless the account is a
   player of a started match).
2. The relay sends `{type: "challenge", nonce}` (32 random bytes).
3. The phone answers `{type: "auth", sig}`: ed25519 by its NEAR key over
   `SHA256("tail/hud-auth/v1" ‖ nonce ‖ match_id (16 B) ‖ borsh(account_id))`. A wrong signature
   or 10 s of silence closes the socket with code 4401.
4. Then: `{type: "ready", player}`, `{type: "keys", sealed}`, the latest `{type: "hud", tick, sealed}`,
   the Handler lines voiced so far for the player's own hints, and from then on every new HUD,
   `{type: "handler", match_id, sealed}` (the Handler's line for the player's own hint, sent to
   no one else), `{type: "rejected" | "refused", detail}` (`detail.reason` a `RejectCode` for a rejected
   batch, a `RefuseCode` for a refused action; the relay logs them by name) and
   `{type: "over"}`. Everything sealed is signed by the referee: `SignedHud` (`tail/hud/v2`),
   `SignedPlayerKeys` (`tail/keys/v2`), `SignedVoiceLine` (`tail/voice/v1`); open them with
   `openSignedHud` / `openSignedPlayerKeys` / `openSignedVoiceLine` against the contract's
   `referee_pk`, since the relay could seal to the phone too.

### Proofs

The relay keeps every leaf hash of the match log (RFC 6962), and serves proofs over them during
play and after: `GET /matches/:id/inclusion?leaf=&size=` and
`GET /matches/:id/consistency?from=&to=`. A leaf hash reveals nothing about its entry: the
entries with few possible values (`Contact`, `HintReceipt`, `Evidence`) carry a salt from a key
only the referee holds until End, so the relay cannot hash guesses either. Check the
result with `merkleVerify` / `verifyConsistency` against a root the referee signed (a HUD's
`log_size`, `root`) or the contract anchored (`get_roots`).

### Replay

`GET /replay/:id` returns a `ReplayBundleV2` (`@tail/protocol` `replay.ts`): match meta (zone,
safehouses, stake, players), the referee project and the keys the match pinned, every signed
verdict with the NEAR transaction that applied it (`txHash` is null when that RPC answer was
lost; the chain has the verdict anyway), the leaf hashes, the log the referee declassified after
End (each entry must hash to its leaf), the ring reveal with `kM` (the match key the referee
releases with the log, which derives every salt), `devices` with whether the referee
checked each one's attestation, and per answered hint its `hintId` and `signedText` (the message
the model signature covers; the words themselves were sealed to the asker and the relay never
had them). Matches played before protocol v2 are still served as the version 1 bundle they were.
`batches` holds the declassified trails: after End the relay sends every sealed batch it
forwarded (stored per match and player, in arrival order) to the referee's
`declassify_batches` in chunks of 500 with the End state, and keeps each returned borsh `Batch`
whose SHA256 is a `LogEntry::Batch` of the match (batches rejected during play come back too and
are dropped). The replay checks the same hashes, so neither the relay nor the referee can add a
trail. A match without `public_replay` is served only to its players: `POST
/replay/:id/challenge {account_id}` → `{nonce}`, then `GET /replay/:id?account_id=…&nonce=…&sig=…`
with `sig` = ed25519 by the NEAR key over
`SHA256("tail/replay-auth/v1" ‖ nonce ‖ match_id (16 B) ‖ borsh(account_id))`.

## What the phone does

1. **Enrol.** Generate the App Attest key, the X25519 box key and an ed25519 NEAR key. `POST
   /enroll/challenge {handle}` → `{challenge, account_id}`. Attest with clientDataHash =
   `enrollClientDataHash(challenge, account_id, player_box_pk, near_pk)` (`@tail/protocol`).
   `POST /enroll`, with `rebind_sig` (below) if this is a retry the referee may already hold.
   The relay checks the attestation, writes the device row (which holds the handle), and
   registers the device with the referee, which checks the attestation itself and signs a
   receipt. Then it creates `<handle>.<relay account>` holding only the phone's key
   (function-call, contract `TAIL_CONTRACT`, methods `join_match`, `leave_lobby`, `withdraw`,
   0.5 NEAR allowance), funds it with 0.1 NEAR, registers it on the token (`storage_deposit`)
   and in the contract (`register_for`, payout = the account itself), and only then answers
   `{account_id}`. If the referee refuses (502 `The referee refused: …`), does not answer (502 or
   503) or the chain refuses the account (409), the row is deleted and the handle is free: try
   again with a new challenge. The call can take as long as a referee call (seconds; more when
   OutLayer is slow), so give it a 90 s timeout.
2. **Join** the lobby on chain with its own key: `join_match({match_id})`, 30 Tgas (`withdraw`
   needs 50 Tgas). The stake is
   debited from its internal balance (the host tops players up; on testnet `POST /dev/topup`).
   The relay does not join for players: it does not hold their keys.
3. **Start**: the host's `POST /matches/:id/start`. The host's own keys arrive in the response;
   every player (host included) gets its own on the HUD socket and in the signed
   `GET /matches/:id/zone`.
4. **Play.** Every `BATCH_MS`: build the next `Batch`, assert `batchClientDataHash(batch)`, seal
   `BatchEnvelope` to `referee_box_pk` (check `box_pk_sig` against the contract's pinned
   `referee_pk` first), `POST /batch` signed. Retry failed uploads in order. Read HUDs from the
   socket.

### Refresh: after the contract pins another referee

The relay keeps each device's receipt with the referee key that signed it (receipts from before
are recognised by their signature). When the contract pins another referee (local test referee ↔
OutLayer, `scripts/pin-referee.ts`), the new one knows none of the devices, and an old
attestation cannot be sent to it again: Apple's credential certificate in it is valid for about
3 days. The same happens to a device whose record the referee can no longer read (Start asks
the referee before it locks the lobby, and drops the receipt). Start then answers 409 `{error,
code: "refresh", accounts: [account_id]}`, and every listed phone refreshes:

1. `GET /enroll/status` (signed) → `{account_id, with_referee, app_attest_key_id}`. Ask on
   launch; refresh when `with_referee` is false, or when `app_attest_key_id` (base64
   SHA256 of the uncompressed App Attest key the relay holds, Apple's keyId) is not the keyId
   of the key the phone holds.
2. `POST /enroll/refresh/challenge {}` (signed) → `{challenge, account_id, expires_ms}` (5 min,
   single use, only for this account).
3. Attest an App Attest key (a new one, or the same one again) with clientDataHash =
   `enrollClientDataHash(challenge, account_id, player_box_pk, near_pk)`; `near_pk` is the
   account's existing key, `player_box_pk` may be new.
4. `rebind_sig` = ed25519 by the NEAR key over
   `rebindDigest(account_id, app_attest_pk, player_box_pk, near_pk)` (`@tail/protocol`:
   SHA256("tail/rebind/v1" ‖ borsh(account_id) ‖ app_attest_pk (65 B, uncompressed) ‖
   player_box_pk ‖ near_pk), the keys being the ones this refresh sends). The referee needs it
   to move an account it already holds to other keys; with no record, or the same keys, it
   ignores it.
5. `POST /enroll/refresh {challenge, key_id, attestation, player_box_pk, rebind_sig}` (signed) →
   `{account_id}` once the referee accepted. On a refusal the relay keeps the old keys and
   receipt; ask for a new challenge to try again.

While the account plays in a match being started or running, steps 2 and 5 answer 409
`{code: "in_match"}`: the match keeps the device the referee held at its start, so new keys
would lock the phone out of it. Refresh once it ends.

An enrolment that fails after the referee stored the device (the account could not be made)
frees the handle on the relay, but the referee keeps its record under that `near_pk`. Retry
with the same NEAR key: the same App Attest and box keys go straight through, new ones need
`rebind_sig` (step 4) by that key. A retry under another NEAR key is refused by that referee.

Signed means the v2 request signature above, by the account's NEAR key, so only the phone that
holds the account can refresh it. A test player is registered again by the relay itself at Start.

### Batch queue

The relay queues sealed batches oldest first. It refuses the same bytes only while they are
still waiting for a tick. Bytes the referee has already seen may be queued again, because only
the referee knows whether it accepted them: a phone whose batch was rejected for a seq gap
resends the missing ones, and the referee refuses any seq it already took. Every sealed batch
is kept for the post-End trail release.

A batch is acknowledged only when a later tick will carry it. One that arrives while a tick is
in flight is answered once that tick is stored (a few seconds on OutLayer): 200 when the match
goes on, 409 `match is ending` when that tick ended it, since `end` takes no batches. The phone
then stops sending and does not count the batch as delivered.

## The tick loop (`src/matches.ts`)

One loop per running match; the next step is scheduled `TICK_MS` (10 s) after the previous one
started, and never while it is still running, because OutLayer calls take 2–11 s and two ticks
on one sealed state would fork it. Each step:

1. **Flush verdicts.** Read `get_match().seq` (optimistic finality, so the read sees the
   relay's own last apply) and submit every stored verdict after it in seq order (≤ 20 per
   `apply`). After an unclear result (timeout, lost answer) the next pass reads the seq again
   before sending anything, so no verdict is submitted twice. A verdict counts as applied only
   once a `final` read shows it: one in an optimistic block that is dropped is sent again. The
   loop does not tick while a verdict is unsent: the referee refuses a state ahead of
   `last_seq`. After End, nothing is declassified until End is final.
2. **Voice hints.** For each hint the referee issued (an opaque blob sealed to the referee), call
   `voice` with the state and the blob; push the sealed line to the asker only; keep the answer's
   sealed `receipt` for the next tick, and its `hint_id` and `signed_text` for the replay.
3. **Tick.** Send the queued sealed batches (oldest first, ≤ 256), the receipts, the sealed state
   and `last_seq`. Check the stored leaves plus the returned `leaves` against `log_size`/`log_root`,
   and each Checkpoint's root and consistency proof against those leaves (the relay never sees a
   log entry during play: only leaf hashes and the referee's `log_sealed` blob). Then, in one
   SQLite transaction: the new state, the leaves and the blob, the signed verdicts with their
   proofs, the batches marked sent, the receipts consumed, new hints, HUDs and a tick record. A
   failed call stores nothing, so its batches go again next tick.
4. **Push** each sealed HUD to that player's socket(s), then flush the new verdicts:
   `apply(verdicts, proofs)` with `proofs: [{seq, from_size, path}]` for the Checkpoint/End verdicts.
5. **End.** When a tick says `over`: voice the hints that tick issued, and drop any the Handler
   could not voice (a line after End would have no receipt in the log) → `end` with the
   receipts → check End's root and proof against the leaves → apply End → `declassify` with
   every `log_sealed` blob in order (each returned entry must hash to its stored leaf) →
   `declassify_batches` (chunks of 500) → store the log, the reveal and the trails for the
   replay. Each of these retries on the next step if it fails; the match counts as ended only
   when both are stored. `end` asked again with the same state and receipts answers with the End
   it recorded, so a lost answer costs one step.

Start: the relay reads the lobby from the chain, checks every player is enrolled, asks the
referee (`devices`) whether it holds each player's device exactly as the relay's receipt says
(a receipt it does not match, such as one for a record the referee no longer reads, is dropped)
and that each receipt is from the referee the relay runs with (a test player, or a device an
older relay left waiting with its attestation, is registered now; any other phone must refresh,
and the lobby stays open until it has), calls `lock_lobby` (joins frozen), then referee `start` with `start_ms` = now (the contract wants it
within 5 min of block time), stores the result and applies Start at once. Before the referee
answers, a failed start can be retried; after, it cannot (the enclave starts a match id once),
and the lobby refunds through `leave_lobby`/`abort`.

The contract stores only `zone_hash` = SHA256("tail/zone/v1" ‖ borsh(zone, safehouses)) with
circles as `{lat_e7 i32, lon_e7 i32, radius_m u32}`; the replay bundle carries the zone so the replay can
check it.

Every NEAR view the relay makes has a 4 s deadline and every `apply` an 8 s one (`near.ts`), so
a stuck RPC call fails that step and the next step tries again; without them one call could
hold a match for minutes. An `apply` past its deadline may still land: the next flush reads the
chain's seq before it sends anything again.

The relay restarts the loop of every running match on boot (state lives in SQLite), and reopens
the lobby of a Start the last run left unfinished; one whose lease has not run out yet (a
restart within 120 s of a crash) is reopened as soon as it does. On SIGINT
or SIGTERM it takes no new requests or steps, lets the steps and Starts in flight finish (up to
75 s, a referee call's deadline and a NEAR call or two), hands back every match lease it holds
and closes the database, so a restarted relay steps its matches at once rather than after the
lease's 120 s. A second signal exits at once.

## Ghost players: the testing door

`src/ghosts/` simulates phones from scripted traces (`trace.ts`), so a whole match can run with
no phone. A ghost (`ghost.ts`) has a NEAR function-call key, an X25519 box key and a P-256 key;
it uses the relay's real HTTP and WebSocket API, joins with its own key, hears the other ghosts'
real beacon tokens (`beaconToken`, tag-filtered as a phone does), and uploads real chained,
sealed batches. Each batch carries an App Attest-format assertion (`assertion.ts`): CBOR
`{signature, authenticatorData}`, authenticatorData = SHA256(app_id) ‖ 0x00 ‖ u32be(counter),
signature = DER ECDSA-P256 over SHA256(authenticatorData ‖ clientDataHash), the same bytes
`crates/appattest` verifies. The test `assertion.test.ts` checks the verifier steps on two real
iPhone assertions and on ghost assertions.

What a ghost cannot do is produce Apple's attestation. Ghost enrolment therefore skips it, and
is a deliberate hole:

- No HTTP route enrols a ghost: the relay does it in-process (`Enrolment.enrollGhost`, used by
  `POST /dev/ghosts/fill` and `scripts/ghost-match.ts`), and only when it runs with
  `NEAR_NETWORK=testnet` **and** `ALLOW_GHOSTS=1` (`config.ts`; `createRelay` refuses ghosts off
  testnet, and `NEAR_NETWORK` only accepts testnet). The referee takes a device without an
  attestation only with its own `ALLOW_UNATTESTED=1`, and records it as `attested: false`.
- Ghost handles must start with `ghost-` and phone handles cannot, so every ghost is visible as
  `ghost-….<relay account>` on chain, in the referee's device record and in `/replay`
  (`kind: "ghost"`, `attested: false`).
- `GET /health` says `test_players: true` only while the door is open, so the app offers
  "Add a test player" only on such a relay.

### Test players

A match needs three players, so two phones alone cannot start one. `POST /dev/ghosts/fill
{match_id}`, signed by the lobby's host, seats a ghost the relay makes on the spot
(`src/ghosts/fill.ts`): `ghost-<8 random characters>`, its three keys generated in-process and
held only for that call, enrolled through the door, topped up with the stake if its balance is
short (at most 100 USDC.e), and joined with its own key. One fill per match runs at a time; a
second tap meanwhile gets 409. Refusals: 404 `no such match` / `match is not on chain`, 403
`only the host can add a test player`, 409 `match is <phase>`, `match is <phase> on chain`,
`the lobby is locked`, `the lobby's start time has passed`, `the match is full`,
`a test player cannot join an invite-only match`, `a test player covers stakes up to 100 USDC.e`,
`a test player is already joining`.

A test player never sends a batch, so the referee counts it dark (`crates/referee-core`
`dark_rules`): every player starts present at `start_ms`, a gap longer than `DARK_GRACE_MS`
(20 s) counts in full from its start, and once dark time reaches `DARK_FORFEIT_MS` (180 s) the
ghost forfeits its head to its hunter, who takes over its target. Ticks run every 10 s, so the
Forfeit lands 180–190 s after Start, and the phones play on. Until then the phone hunting the
ghost has nothing to find (no beacon, and no fix to leak). In a match shorter than 3 minutes the
ghost never reaches 180 s of dark time: it survives to End and is paid its head, into a balance
nobody can withdraw (its key is gone).

Start checks the players again after `lock_lobby`, so a player who joined between the first
check and the lock still reaches the referee before `start`.

## When the referee is slow or down

Every request is logged with its method, path, status and time. The referee sits behind a guard
(`GuardedReferee` in `src/referee.ts`): two transport failures in a row mark it down, after which
calls fail at once with "The referee isn't answering right now" (HTTP 503) instead of each waiting
60 s, and one call every 30 s goes through to see whether it is back. A refusal counts as an
answer. `GET /health` reports the state.

### The local test referee

`REFEREE_MODE=local` runs the same referee code natively on the relay's machine
(`crates/referee-wasi`, "Local test referee"), one process per command, with its keys in
`.keys/local-referee`. It is for testing while OutLayer is unavailable. It is not an enclave and
nothing attests the code that signed, so:

- it plays on the same `TAIL_CONTRACT`: a player's NEAR key can call only the contract it was
  made for, so a second contract would lock every enrolled player out. Switching referees means
  pinning the other one's keys and VRF caller on the contract (`scripts/pin-referee.ts`), after
  which every phone refreshes its enrolment with the new referee ("Refresh" above). Matches keep
  the keys they were created with, so a lobby made before the switch cannot start: Start
  refuses it with a 409 before locking it, and the host makes a new one;
- the relay checks at startup that the contract pins the keys and the VRF caller (`vrf_sender`:
  `OUTLAYER_OWNER`, or the relay account for the local referee) of the referee it runs with, in
  either mode, and refuses to start otherwise, or when the App ID the referee pins in its code
  (`pubkeys` `app_id`) is not `APPLE_TEAM_ID.IOS_BUNDLE_ID`, the one the relay writes into every
  replay bundle (a referee build from before `app_id` is not checked). A local test referee
  that does not answer (binary missing or broken) stops it too; an enclave that does not answer
  is reported down instead, since OutLayer comes back;
- every replay bundle it serves says `referee.kind: "local"`, and the replay page labels the
  signatures as the test referee's;
- the Handler answers with its template lines (no model call).

```sh
cargo build --release --manifest-path crates/referee-wasi/Cargo.toml --bin tail-referee
REFEREE_MODE=local bun apps/server/scripts/pin-referee.ts   # pin the local keys on TAIL_CONTRACT
REFEREE_MODE=local bun apps/server/src/main.ts
bun apps/server/scripts/pin-referee.ts                      # back to the enclave once OutLayer answers
```

## Run

`bun run --cwd apps/server start` (or `bun apps/server/src/main.ts`) is the one to run a real
match with. `bun run --cwd apps/server dev` restarts the relay on every saved file: for working
on the relay only, never while a match is on.

```sh
bun apps/server/src/main.ts                   # reads the repo-root .env.local; listens on RELAY_PORT
bun test apps/server                          # tests; one plays a match against the real local referee
bun apps/server/scripts/pin-referee.ts        # testnet: pin the deployed referee's keys in the contract
ALLOW_GHOSTS=1 bun apps/server/scripts/ghost-match.ts   # testnet: a full 3-ghost match, end to end
```

Environment (placeholders in `.env.example`): `NEAR_NETWORK` (testnet only), `NEAR_RELAY_ACCOUNT`,
`NEAR_RELAY_PRIVATE_KEY`, `TAIL_CONTRACT`, `OUTLAYER_API`, `OUTLAYER_OWNER`, `REFEREE_PROJECT`,
`REFEREE_PAYMENT_KEY` (or `OUTLAYER_PAYMENT_KEY`), `REFEREE_VERSION` (optional pin), `APPLE_TEAM_ID`,
`IOS_BUNDLE_ID`, `APP_ATTEST_ENV`, `TAIL_TOKEN`, `NEAR_RPC_URL`, `RELAY_PORT`, `RELAY_DB`,
`RELAY_RETENTION_HOURS`, `ALLOW_GHOSTS`, `RELAY_KEYS_DIR` (mesh carry keys, default `.keys/relay`),
`RELAY_CLIENT_IP_HEADER`, `RELAY_ENROLS_PER_DAY`, `RELAY_ENROLS_PER_IP_PER_DAY` (rate limits,
above), `REFEREE_MODE` (`outlayer` or `local`), and for local mode `LOCAL_REFEREE_BIN` and
`LOCAL_REFEREE_DIR` (both optional). A missing value or a leftover placeholder stops the relay at startup.

Most tests run on fakes of the chain and the referee (`test/fakes.ts`). `test/local-referee.test.ts`
builds the native referee (`cargo build --release`, a no-op when current, about 15 s cold) and
plays a whole ghost match through the relay against it, with its keys in a temp directory and a
fake chain that applies verdicts by the contract's rules (`test/contract-chain.ts`): enrolment,
a refused early strike, a template Handler line, a carried batch, a resent batch and a batch with
a simulated fix rejected, a Tag, Checkpoints, End and declassify. The replay must then pass the web
verifier (`apps/web/src/verify`) against that chain, and every leaf's inclusion proof and every
pair of anchored roots' consistency proof from the relay must verify. No network.

Dossiers: registration mints each player's dossier, but accounts registered before the contract
had dossiers hold none, and their function-call keys cannot attach `mint_dossier`'s deposit. At
every start the relay, as their parent, mints each missing one and pays `dossier_deposit`
(`src/dossiers.ts`): one transaction at a time, 1 s apart, at most 100 per run; it checks each
account first, so a second run mints nothing, and it does nothing on a contract without
dossiers. `bun apps/server/scripts/backfill-dossiers.ts` runs the same pass on demand.

`scripts/ghost-match.ts` runs the relay in-process with a fresh database, enrols three ghosts,
opens a 5-minute lobby, tops them up, has them join, starts, and plays `CLEAN_TAG`: the hunter
walks to its target, asks a NEAR hint, and strikes when its HUD lock reaches 4; the bystander
stays 1.1 km away. It checks the contract after each step (`get_match`, `get_heads`, `get_roots`,
balances), the relay's leaves and the declassified log against the root anchored by End, and one
inclusion and one consistency proof from the relay's proof endpoints.

## Measured (testnet, 2026-11-12)

Three runs of `scripts/ghost-match.ts` against `tail.tail-dev-a38d13.testnet` and the referee
`tail-dev-a38d13.testnet/tail-referee` all passed every check. The last run (24 checks)
was match `f40e8fdda22b1276c2851caf49eea037`:

- Verdicts on chain, in order: 1 Start, 2 Hint, 3 Checkpoint, 4 Tag, 5–7 Checkpoint, 8 End.
- The hint was asked at 15 s and applied at tick 3. The lock rose 1 → 4 over ticks 5–8, and the
  Tag landed at tick 9.
- Settlement paid the hunter 2 stakes, the bystander 1 and the target 0.
- The relay's 149-entry log reproduced the root anchored by End.
- The trails matched: 136 of the 139 forwarded batches were logged, and all 136 came back
  from `declassify_batches`.
- Start took 8.2 s. The 31 ticks took p50 2.9 s, p95 6.7 s and at most 8.5 s.
- 40 OutLayer calls cost $0.045. The relay spent about 0.43 NEAR per run: three accounts at
  0.1 NEAR plus registration, and the 0.08 NEAR match deposit.

## Not done

- Mesh carry is served (`POST /carry`), but nothing here has measured it between real phones.
- The relay is not an Offline Protocol node: carried requests reach it as `POST /carry`
  envelopes, posted by whichever phone has signal.
- One relay process; no horizontal scaling. SQLite holds everything the loop needs to resume.
- Retention deletes from the relay's database only (`src/retention.ts` says what goes and what
  stays). A lobby that never started keeps its zone; the relay's own logs and backups are the
  operator's.
