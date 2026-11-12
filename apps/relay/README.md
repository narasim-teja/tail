# relay

Bun + Hono + `bun:sqlite`. The relay carries sealed messages between the phones and the OutLayer
referee, submits the referee's signed verdicts to the `tail` contract, pays gas, and creates
player accounts. It is untrusted infrastructure: it is trusted for liveness only.

```
phone ──sealed batch──▶ relay ──tick──▶ OutLayer referee (TDX)
phone ◀──sealed HUD──── relay ◀─verdicts, sealed HUDs, log──┘
                         └──apply(verdicts)──▶ tail contract (NEAR testnet)
```

## Trust model

| The relay can                                                                                                                                                                | The relay cannot                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Delay or drop batches, HUDs and verdicts (liveness). A dropped batch counts as "dark" for that player; a stalled match refunds through `abort` after 15 min.                 | Read a batch, a HUD or a player's keys: they are sealed to the enclave or to the phone's box key.                               |
| Refuse to start or tick a match.                                                                                                                                             | Sign a verdict, or move money any other way: heads move only on referee-signed verdicts, in seq order, checked by the contract. |
| See who uploads when, and how big the sealed blobs are.                                                                                                                      | Create a tag. A tag needs mutual radio contact the enclave verifies from both phones' sealed, App Attest-signed batches.        |
| Replay an old sealed state blob. The referee refuses it (`last_seq` check), and two forks of one blob produce verdicts with the same seq, of which the contract accepts one. | Use a player's account: it holds one function-call key, which the phone generated and keeps. The relay never has it.            |
| Check the App Attest attestation at enrolment (v1). A dishonest relay could enrol a fake device.                                                                             | Forge later batches: the enclave checks every batch's assertion against the enrolled key.                                       |

The relay holds two secrets: the NEAR key of `NEAR_RELAY_ACCOUNT` (pays gas, creates accounts,
hosts matches; it is also the contract owner on testnet) and the OutLayer payment key. Neither is
ever logged (`@tail/log` redacts key fields; the config prints facts only).

## Endpoints

Bytes are base64 in JSON unless noted; match ids are 32 hex characters; amounts are decimal
strings in the token's smallest unit. Errors are `{error: "<short message>"}` with a 4xx/5xx status.

| Method, path                     | Auth                                        | Request                                                                                                                                                       | Response                                                                                                                               |
| -------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                    | –                                           | –                                                                                                                                                             | `{ok: true}`                                                                                                                           |
| `GET /referee`                   | –                                           | –                                                                                                                                                             | `{referee_pk, referee_box_pk, box_pk_sig, vrf_pk}` (base64, from the referee's `pubkeys`, cached)                                      |
| `POST /enroll/challenge`         | –                                           | `{handle}`                                                                                                                                                    | `{challenge (32 B), account_id, expires_ms}`                                                                                           |
| `POST /enroll`                   | attestation                                 | `{challenge, key_id (32 B), attestation (CBOR), player_box_pk (32 B), near_pk (32 B ed25519)}`                                                                | `{account_id, app_attest_pk (65 B), enroll_call_id, receipt, receipt_sig}`                                                             |
| `POST /matches`                  | signed (host)                               | `{stake, duration_ms, zone: {lat_e7, lon_e7, radius_m}, safehouses?: [circle], public_replay, min_players, max_players, start_by_ms, invites?: [account_id]}` | `{match_id, zone_hash (hex)}`                                                                                                          |
| `GET /matches/:id`               | –                                           | –                                                                                                                                                             | `{match_id, host, phase, error, start_ms, end_ms, tick_no, last_seq, players, keys: [{player, account_id, sealed}], chain: get_match}` |
| `POST /matches/:id/start`        | signed (host)                               | `{}`                                                                                                                                                          | `{players (index order), keys: [{player, account_id, sealed}], start_ms, end_ms}`                                                      |
| `POST /batch`                    | signed (player)                             | `{match_id, sealed}`                                                                                                                                          | `{queued, player}`; `queued: false` = these bytes already wait for the next tick (success)                                             |
| `GET /hud?match_id=&account_id=` | WebSocket challenge                         | see below                                                                                                                                                     | see below                                                                                                                              |
| `GET /replay/:id`                | – (challenge if not `public_replay`, below) | –                                                                                                                                                             | a `ReplayBundle` (`@tail/protocol` `replay.ts`); 409 until the match has ended                                                         |
| `POST /replay/:id/challenge`     | –                                           | `{account_id}`                                                                                                                                                | `{nonce}` (32 B, single use, 2 min)                                                                                                    |
| `POST /dev/topup`                | signed; testnet only                        | `{account_id, amount}` (≤ 100 USDC.e)                                                                                                                         | `{account_id, credited}`: mints `usdc.fakes.testnet` to the relay and `ft_transfer_call`s it with `{"credit": account_id}`             |
| `POST /dev/ghosts/enroll`        | testing door, see below                     | `{handle: "ghost-…", app_attest_pk (65 B), player_box_pk, near_pk}`                                                                                           | as `POST /enroll`                                                                                                                      |

`sealed` in `keys` is `seal(player_box_pk, borsh PlayerKeys, "tail/keys")`: safe to serve publicly.

### Signed requests

Headers `x-tail-account`, `x-tail-time` (unix ms) and `x-tail-sig` (base64, 64 bytes): an
ed25519 signature by the account's NEAR function-call key (the `near_pk` it enrolled with) over

```
SHA256("tail/relay-req/v1" ‖ borsh(METHOD) ‖ borsh(path incl. query) ‖ u64le(time) ‖ SHA256(body bytes))
```

The time must be within 60 s of the relay's clock, and the same signed request is accepted
once (sign every retry afresh). This keeps strangers from filling a player's batch queue,
opening lobbies on the relay's NEAR, or starting a lobby they do not host. `src/auth.ts` has
both sides (`requestDigest`, `signRequestHeaders`).

### HUD socket

1. Connect `GET /hud?match_id=…&account_id=…` (refused with 403/409 unless the account is a
   player of a started match).
2. The relay sends `{type: "challenge", nonce}` (32 random bytes).
3. The phone answers `{type: "auth", sig}`: ed25519 by its NEAR key over
   `SHA256("tail/hud-auth/v1" ‖ nonce ‖ match_id (16 B) ‖ borsh(account_id))`. A wrong signature
   or 10 s of silence closes the socket with code 4401.
4. Then: `{type: "ready", player}`, `{type: "keys", sealed}`, the latest `{type: "hud", tick, sealed}`,
   and from then on every new HUD, `{type: "handler", hint_id, text}` (the Handler's line for the
   player's own hint), `{type: "rejected" | "refused", detail}` (the player's own batches or
   actions the referee turned down, e.g. a simulated location) and `{type: "over"}`.
   HUDs are `seal(player_box_pk, borsh Hud, "tail/hud")`.

### Replay

`GET /replay/:id` returns a `ReplayBundle`: match meta (zone, safehouses, stake, players), the
referee project and the keys the match pinned, every signed verdict with the NEAR transaction
that applied it (`txHash` is null when that RPC answer was lost; the chain has the verdict
anyway), the full log, the ring reveal from `declassify`, and the Handler lines by `hintId`.
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
   `POST /enroll`. The relay creates `<handle>.<relay account>` holding only the phone's key
   (function-call, contract `TAIL_CONTRACT`, methods `join_match`, `leave_lobby`, `withdraw`,
   0.5 NEAR allowance), funds it with 0.1 NEAR, registers it on the token (`storage_deposit`)
   and in the contract (`register_for`, payout = the account itself).
2. **Join** the lobby on chain with its own key: `join_match({match_id})`, 30 Tgas (`withdraw`
   needs 50 Tgas). The stake is
   debited from its internal balance (the host tops players up; on testnet `POST /dev/topup`).
   The relay does not join for players: it does not hold their keys.
3. **Start**: the host's `POST /matches/:id/start`. Keys arrive in the response, on
   `GET /matches/:id` and on the HUD socket.
4. **Play.** Every `BATCH_MS`: build the next `Batch`, assert `batchClientDataHash(batch)`, seal
   `BatchEnvelope` to `referee_box_pk` (check `box_pk_sig` against the contract's pinned
   `referee_pk` first), `POST /batch` signed. Retry failed uploads in order. Read HUDs from the
   socket.

### Batch queue

The relay queues sealed batches oldest first. It refuses the same bytes only while they are
still waiting for a tick. Bytes the referee has already seen may be queued again, because only
the referee knows whether it accepted them: a phone whose batch was rejected for a seq gap
resends the missing ones, and the referee refuses any seq it already took. Every sealed batch
is kept for the post-End trail release.

## The tick loop (`src/matches.ts`)

One loop per running match; the next step is scheduled `TICK_MS` (10 s) after the previous one
started, and never while it is still running, because OutLayer calls take 2–11 s and two ticks
on one sealed state would fork it. Each step:

1. **Flush verdicts.** Read `get_match().seq` (optimistic finality, so the read sees the
   relay's own last apply), mark everything up to it applied, submit the rest
   in seq order (≤ 20 per `apply`). After an unclear result (timeout, lost answer) the next pass
   reads the seq again before sending anything, so no verdict is submitted twice. The loop does
   not tick while a verdict is unapplied: the referee refuses a state ahead of `last_seq`.
2. **Voice hints.** For each hint the referee issued, call `voice`; keep its receipt for the next
   tick and push the Handler's line to the asker.
3. **Tick.** Send the queued sealed batches (oldest first, ≤ 256), the receipts, the sealed state
   and `last_seq`. Check the returned log against `log_size`/`log_root` (the relay holds the only
   full copy of the log). Then, in one SQLite transaction: the new state, the log entries, the
   signed verdicts, the batches marked sent, the receipts consumed, new hints, HUDs and a tick
   record. A failed call stores nothing, so its batches go again next tick.
4. **Push** each sealed HUD to that player's socket(s), then flush the new verdicts.
5. **End.** When a tick says `over`: `end` with the last receipts → check End's log size and
   root against the stored log → apply End → `declassify` → `declassify_batches` (chunks of 500)
   → store the reveal and the trails for the replay. Each of these retries on the next step if
   it fails; the match counts as ended only when both are stored.

Start: the relay reads the lobby from the chain, checks every player is enrolled, calls
`lock_lobby` (joins frozen), then referee `start` with `start_ms` = now (the contract wants it
within 5 min of block time), stores the result and applies Start at once. Before the referee
answers, a failed start can be retried; after, it cannot (the enclave starts a match id once),
and the lobby refunds through `leave_lobby`/`abort`.

The contract stores only `zone_hash` = SHA256("tail/zone/v1" ‖ borsh(zone, safehouses)) with
circles as `{lat_e7 i32, lon_e7 i32, radius_m u32}`; the replay bundle carries the zone so the replay can
check it.

The relay restarts the loop of every running match on boot (state lives in SQLite).

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

What a ghost cannot do is produce Apple's attestation. Ghost enrolment
(`POST /dev/ghosts/enroll`) therefore skips it, and is a deliberate hole:

- The route exists only when the relay runs with `NEAR_NETWORK=testnet` **and** `ALLOW_GHOSTS=1`
  (`config.ts`; `createRelay` refuses ghosts off testnet, and `NEAR_NETWORK` only accepts testnet).
- Ghost handles must start with `ghost-` and phone handles cannot, so every ghost is visible as
  `ghost-….<relay account>` on chain, in the referee's device record and in `/replay`
  (`kind: "ghost"`).
- A relay with the door open can enrol fake devices. That is exactly what the v1 limitation
  (attestation checked by the relay, not the enclave) already allows a dishonest relay; the
  door only makes it explicit for testing.

## Run

```sh
bun apps/relay/src/main.ts                   # reads the repo-root .env.local; listens on RELAY_PORT
bun test apps/relay                          # unit tests (fakes for the chain and the referee)
bun apps/relay/scripts/pin-referee.ts        # testnet: pin the deployed referee's keys in the contract
ALLOW_GHOSTS=1 bun apps/relay/scripts/ghost-match.ts   # testnet: a full 3-ghost match, end to end
```

Environment (placeholders in `.env.example`): `NEAR_NETWORK` (testnet only), `NEAR_RELAY_ACCOUNT`,
`NEAR_RELAY_PRIVATE_KEY`, `TAIL_CONTRACT`, `OUTLAYER_API`, `OUTLAYER_OWNER`, `REFEREE_PROJECT`,
`REFEREE_PAYMENT_KEY` (or `OUTLAYER_PAYMENT_KEY`), `REFEREE_VERSION` (optional pin), `APPLE_TEAM_ID`,
`IOS_BUNDLE_ID`, `APP_ATTEST_ENV`, `TAIL_TOKEN`, `NEAR_RPC_URL`, `RELAY_PORT`, `RELAY_DB`,
`ALLOW_GHOSTS`. A missing value or a leftover placeholder stops the relay at startup.

`scripts/ghost-match.ts` runs the relay in-process with a fresh database, enrols three ghosts,
opens a 5-minute lobby, tops them up, has them join, starts, and plays `CLEAN_TAG`: the hunter
walks to its target, asks a NEAR hint, and strikes when its HUD lock reaches 4; the bystander
stays 1.1 km away. It checks the contract after each step (`get_match`, `get_heads`, `get_roots`,
balances) and the relay's log copy against the root anchored by End.

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

- No Offline Protocol node yet (TECHNICAL.md 7, P1): batches arrive over HTTPS only. The node
  would accept carried requests `{v: 1, type: "tail/batch", path, account, time_ms, sig, body}`
  signed more than 60 s earlier; a carried batch replayed later is harmless, since the referee
  refuses a seq it already accepted.
- One relay process; no horizontal scaling. SQLite holds everything the loop needs to resume.
- Device attestation is checked here, once, not in the enclave (v1, TECHNICAL.md 4.4).
