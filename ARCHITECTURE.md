# What is proven, and how to check it

This file lists each thing TAIL claims to prove, how the proof is built, where it is enforced,
how you can check it yourself, and where it stops. Wire formats and constants are in
`packages/protocol/README.md`; the rules are in `crates/referee-core/README.md`.

## What runs where today (2026-11-13)

Read every claim below with this in mind:

- **The code in this repository is protocol v2.** It passes the gate, `bun run check`.
- **The live contract runs older code.** `tail.tail-dev-a38d13.testnet` was deployed before
  this round. Its `get_config` has no `vrf_sender` and it has no `get_verdict_head` view, so it
  does not accept v2 verdicts. The in-place upgrade (`contracts/tail/e2e/deploy.ts --upgrade
  --migrate`) has not been run. A check marked **after the upgrade** is enforced by
  `contracts/tail` in this repo, not by the deployed contract.
- **The live contract pins the local test referee.** That is the same referee code built
  natively and run on the relay's machine. It is not an enclave. `get_config` shows
  `referee_pk` `d35338a9…6594` and `vrf_pk` `ad82f28f…defcb`, both local keys. OutLayer testnet
  stopped running calls (HTTP 524) on 2026-11-12. While this referee is pinned, every guarantee
  that rests on the referee reduces to trusting whoever runs that machine.
- **OutLayer still holds the old build.** The active OutLayer version is the protocol v1 build
  `20446c64…08664`. The v2 build has not been uploaded.
- **Real phones have only run v1.** Two iPhones played indoor matches on 2026-11-12, and a Tag
  landed from Bluetooth contact. The v2 phone paths (signed HUDs, chain recovery, receipts,
  presence proofs, mesh carry) have only run in tests.

## Data flow

```
 iPhone A ◀──── BLE: 16-byte token per 15 s epoch, RSSI ────▶ iPhone B
    │  every 5 s: Batch{seq, prev, t_ms, fixes, sightings, actions}
    │    + App Attest assertion over SHA256("tail/batch" ‖ borsh(Batch))
    │    sealed to the referee box key ("tail/batch")
    │  POST /batch, signed by the phone's NEAR key ("tail/relay-req/v2")
    │  (no signal: sealCarry to the relay's key, handed to a nearby phone, POST /carry)
    ▼
 relay  apps/server ── sees accounts, timing, sizes, leaf hashes, refusal codes
    │  every 10 s: tick{sealed batches, sealed state, last_seq}
    ▼
 referee  crates/referee-wasi + crates/referee-core
    │  OutLayer TDX enclave (designed), local test referee (pinned now)
    │  opens batches, checks assertions, resolves tokens, decides contact / lock / strike
    │  returns: verdicts (signed, chained by prev) + consistency proofs,
    │           HUDs signed + sealed to each phone, leaf hashes,
    │           log entries and hint facts sealed to itself
    │  voice: fact only ──▶ NEAR AI Cloud ──▶ line signed + sealed to the asker
    ▼  apply(verdicts, proofs), relay pays gas
 contract  contracts/tail ── ed25519_verify, seq + prev, consistency, replay at End, money
    │  views: get_match, get_roots, get_heads, get_verdict_head*, verify_inclusion*
    ▼  after End: declassify releases the log and K_m
 browser  apps/web ── re-checks the bundle against NEAR    (* after the upgrade)
```

## The verdict chain and the log

```
 verdicts   V1 Start ─prev─▶ V2 Hint ─prev─▶ V3 Checkpoint(n1,R1) ─prev─▶ … ─▶ Vk End(nk,Rk)
            prev(V1) = 32 zero bytes
            digest(V) = SHA256("tail/verdict/v2" ‖ borsh(match_id, seq, prev, call_id, body))
            contract: seq = head.seq + 1, prev = head.digest, ed25519_verify(sig, digest, referee_pk)

 log        e0 e1 … e(n1-1) │ e(n1) … e(n2-1) │ …          RFC 6962
            leaf = SHA256(0x00 ‖ borsh(entry))   node = SHA256(0x01 ‖ left ‖ right)
            R1 = root(e0 … e(n1-1))   R2 = root(e0 … e(n2-1))
            Checkpoint(n2,R2) lands only with a proof P: verify_consistency(n1, n2, R1, R2, P)
            the first one is proved from size 0 and SHA256("")

 link       the log holds Verdict{seq, digest} for every verdict, so the two chains name each other
```

## The claims

Paths are relative to the repo root. "Referee" means `crates/referee-core` (the rules) and
`crates/referee-wasi` (keys, sealing, signing).

### 1. The reports came from a real iPhone running our app

- **Mechanism.** At enrolment the phone creates an App Attest key in its Secure Enclave and
  attests it over `SHA256("tail/enroll/v1" ‖ challenge[32] ‖ borsh(account_id) ‖ player_box_pk ‖
  near_pk)`. The referee verifies the CBOR attestation itself:
  - fmt is `apple-appattest`;
  - x5c chains to the pinned Apple App Attestation Root CA (SHA-256 `1cb9823b…c932`);
  - extension `1.2.840.113635.100.8.2` equals `SHA256(authData ‖ clientDataHash)`;
  - `credentialId = SHA256(key)`;
  - `rpIdHash = SHA256("LKABS9RZAC.com.lkabs9rzac.tail")`;
  - the counter is 0 and the aaguid is the development one;
  - the attested key is the enrolled `app_attest_pk`.

  The App ID and the environment are constants in the code, not inputs. A device without an
  attestation is enrolled only when `ALLOW_UNATTESTED=1`. It is then recorded as
  `attested: false` and logged at Start as `Enrolled{player, account, key_hash, attested}`.
- **Enforced.** `crates/appattest/src/lib.rs` (`verify_attestation`),
  `crates/referee-wasi/src/cmd/enroll.rs`. The relay also checks the attestation
  (`apps/server/src/enroll.ts`), but its check is no longer the one that counts.
- **Check.** `cargo test -p appattest` runs the verifier on a real iPhone capture
  (`crates/appattest/tests/data/s3-tail-attest.json`) and on negative cases. In a replay, each
  player's `Enrolled` entry decides the label, and `attested: false` shows as "test player (no
  Apple attestation)".
- **Limit.** The replay shows the referee's record, not the attestation object, so you trust
  the referee to have checked it. App Attest says "a genuine Apple device and our App ID". It
  does not rule out a jailbroken phone, and Apple's fraud-risk receipt is not used. The active
  OutLayer build predates this check. With the local test referee, the relay's machine runs it.

### 2. The report was not altered

- **Mechanism.** Every batch carries an App Attest assertion. That is a DER ECDSA P-256
  signature over `SHA256(authenticatorData ‖ SHA256("tail/batch" ‖ borsh(Batch)))`, with
  `rpIdHash = SHA256(App ID)` and a counter strictly above the last one accepted. A player's
  batches form a hash chain: `seq` is contiguous from 0, and `prev = SHA256(borsh(previous
  Batch))`. The envelope is sealed to the referee's box key (X25519, HKDF-SHA256
  `"tail/seal/v1"`, ChaCha20-Poly1305, AAD `"tail/batch"`). An accepted batch is logged as
  `Batch{player, seq, SHA256(borsh(Batch))}`. A refused one is logged as `Rejected{player, seq,
  hash, code}`.
- **Enforced.** `crates/referee-core/src/engine.rs` (authentication: seq, prev, assertion,
  counter, before any rule runs).
- **Check.** After End the replay bundle carries the declassified batches. The browser checks
  each batch's SHA-256 against its `Batch` log entry and its `prev` link
  (`apps/web/src/verify/checks.ts`, `checkBatches`).
- **Limit.** Nothing outside the referee re-checks the assertions yet. `declassify_batches`
  returns them, but the replay bundle does not carry them.

### 3. The report is from its 15-second window

- **Mechanism.** The epoch is `e = floor((now_ms − start_ms) / 15000)`, and the token is
  `HMAC(K_tag, "tag" ‖ u32le(e))[0..4] ‖ HMAC(K_p[i], "tok" ‖ u32le(e))[0..12]`, with
  `K_tag = HKDF(K_m, "tail/tag")` and `K_p[i] = HKDF(K_m, "tail/beacon" ‖ u16le(i))`. Only the
  referee holds every `K_p`. It resolves a heard token to (player, epoch e). The token counts
  only if the phone's `Sighting.epoch` is within 1 of e and within 1 of the batch's epoch. A
  batch may be dated at most `CLOCK_SKEW_MS` (20 s) ahead of the referee clock. It may not be
  dated before the player's previous batch, nor before the last `KEEP_EPOCHS` (12 epochs, 3 min).
- **Enforced.** `crates/referee-core/src/engine.rs`. The phone forwards only tokens tagged
  `tag(e−1)`, `tag(e)` or `tag(e+1)`.
- **Check.** `cargo test -p referee-sim`: the `replayed-token` and `relayed-live-token`
  scenarios. `packages/protocol/vectors/beacon.json` pins the token bytes in both languages.
- **Limit.** The window is set by when the token was advertised, give or take one epoch. A token
  rebroadcast before the end of the next epoch (15 to 30 s later) still counts. Batch times come
  from the device clock, within the bounds above. The browser does not recompute tokens.

### 4. The two phones were in mutual radio contact

- **Mechanism.** `contact(a, b, e)` holds when all of these do:
  - each phone's valid batches hold the other's epoch-e token with `rssi_max ≥ −82 dBm` and
    summed `n ≥ 2` (a token counts once per batch);
  - both phones have a fix with `acc ≤ 50 m` within 10 s of the epoch midpoint;
  - the two fixes are within `40 m + acc_a + acc_b` of each other;
  - neither phone is in a safehouse or vehicle-frozen.

  `lock(h→t, e)` counts the contact epochs in `(e − 8, e]` that fall at or after `lock_from`
  (the epoch after h was assigned t). A Strike needs `lock ≥ 4` and contact in e or e − 1.
  Before each Tag the referee logs `Evidence{hunter, target, strike_seq, strike_epoch, epochs,
  salt}`.
- **Enforced.** `crates/referee-core/src/engine.rs` (`contact_holds`, `lock_epochs`).
- **Check.** Click a tag in the replay. "The referee logged N contact windows" re-checks the
  Evidence entry against the rule. It also checks each cited `Contact` entry's Merkle path to an
  anchored root (`apps/web/src/verify/evidence.ts`). Scenarios `mutual` and `one-sided` in
  `crates/referee-sim/scenarios`.
- **Limit.** The browser checks the referee's entries, not the raw sightings. The sightings are
  in the declassified batches, but contact is not recomputed from them. There is no distance
  bounding: see the wormhole attack in the threat model.

### 5. The movement was physically plausible

- **Mechanism.** A batch is refused if:
  - any fix has a source flag set (bit 0 `isSimulatedBySoftware`, bit 1
    `isProducedByAccessory`): `FixFlags`;
  - its fixes are not strictly increasing in time, or are dated after the batch: `FixOrder`;
  - the implied speed is above 15 m/s beyond both accuracies, against the last accepted usable
    fix: `Teleport`.

  A device-reported speed above 7 m/s on consecutive fixes for 20 s freezes the player's
  contact until 120 s after the last fast fix. A fix less accurate than 200 m counts as dark.
- **Enforced.** `crates/referee-core/src/engine.rs`.
- **Check.** Scenarios `teleport`, `simulated-location`, `vehicle-freeze` and `indoor-accuracy`.
- **Limit.** These are plausibility checks, not proof. Apple does not attest the GPS chip,
  speed is what the device reports, and a GPS spoofed over the air sets no flag.

### 6. The ring of targets was drawn fairly

- **Mechanism.** At Start the referee asks for a VRF output with seed = the match id in hex.
  `vrf_signature = ed25519(vrf_sk, alpha)`, with `alpha = "vrf:{request_id}:{sender}:{seed}"`.
  The ring is a Fisher–Yates shuffle of the account ids sorted by UTF-8 bytes, with
  `r_k = u64le(SHA256(SHA256(vrf_signature) ‖ u32le(k))[0..8])` and `j = r_k mod (i+1)`.
  `ring[k]` hunts `ring[k+1 mod n]`. Start carries `ring_commit = SHA256("tail/ring" ‖
  vrf_signature)` and `players_hash = SHA256("tail/players" ‖ borsh(sorted ids))`. End reveals
  `alpha` and `vrf_signature`. A duel's simultaneous strikes are ordered by `SHA256("tail/coin" ‖
  SHA256(vrf_signature) ‖ u32le(tick_no) ‖ u16le(player))`.
- **Enforced.** The contract:
  - at Start, `players_hash` must equal the locked lobby;
  - at End, the commitment must open and `ed25519_verify(vrf_signature, alpha, vrf_pk)` must
    pass, with the seed equal to the match id;
  - after the upgrade, `alpha` must also be exactly four fields with `sender` equal to the
    match's pinned `vrf_sender`.

  `crates/tail-protocol/src/ring.rs` holds the shuffle.
  The revealed ring is also what the End replay checks every tag and hint against (claim 7).
- **Check.** `get_match` shows `ring_commit`, `alpha` and `vrf_signature`. The replay rebuilds
  the ring and checks the commitment and the VRF signature in the browser.
  `packages/protocol/vectors/ring.json` pins the bytes.
- **Limit.** Whoever requests the VRF can ask more than once for the same seed (the request ids
  differ) and keep the ring it likes. With the local test referee, `vrf_pk` is a local key and
  the request id is a random UUID the relay's machine picks, so that machine can choose rings.

### 7. Every tag and hint followed the ring, and money waits for the check (after the upgrade)

Money only becomes withdrawable after the contract has replayed and checked the whole match.

- **Mechanism.** During play the ring is secret, so the contract applies each money verdict as
  it lands, inside the match only:
  - `Hint { from, amount, hint_id, hint }` names only the asker. The amount must be the kind's
    price (`HINT_BPS[kind] × stake / 10 000`). It leaves the asker's head for the match's hint
    pool, onto nobody's head.
  - `Tag { hunter, target, credit }` and `Forfeit { player, to, credit }` first move `credit`
    from the pool onto the loser's head (at most what the pool holds), then the loser's whole
    head to the winner. `credit` is what hints about the loser paid in and nobody was credited.
  - At most `MAX_HINTS` (240) hints per match, so the record the contract keeps is bounded and
    paid for at creation.

  `End { …, hint_targets }` reveals the VRF signature and whom each hint was about, in hint
  order. The contract rebuilds the ring and replays every Hint, Tag and Forfeit in seq order,
  tracking each player's current target (`tail_protocol::settle::replay`):
  - a Tag must be a hunter taking its current target;
  - a Forfeit must pay the forfeiter's hunter, and the winner then hunts the loser's target;
  - each hint's target must be its asker's target at that moment;
  - each credit must equal the hints paid onto that player and not yet credited;
  - at End each survivor is owed their pending hints, and the pool must come to exactly 0.

  If every step holds, survivors get what they are owed and the match pays out. If one fails,
  the End still lands but settles the match as a refund: every player gets their original stake
  back, sponsors get theirs, `get_match` shows `settled_as: "refunded_rule_violation"` with the
  first broken rule in `violation`, and the contract logs a `match_refunded` event. `abort` (the
  referee went silent, or never sent End) refunds every original stake too, hint money with it.
  So no Tag, Forfeit or hint transfer pays out unless the whole match checked.
- **Enforced.** `contracts/tail/src/lib.rs` (`settle`, `refund_stakes`, `abort`),
  `crates/tail-protocol/src/settle.rs` (the replay; twin `packages/protocol/src/settle.ts`). The
  deployed contract does not have it.
- **Check.** `cd contracts/tail && cargo test`: an off-ring Tag, a Tag of someone else's inherited
  target, a Forfeit to the wrong player, a wrong hint target, a short credit, a wrong number of
  hint targets and a corrupted pool are each refunded; an honest match pays out; abort pays
  stakes; a random-operation test keeps `sum(heads) + hint_pool + pot` constant while running.
  `referee-sim` applies every scenario's verdicts as the contract does and requires the replay
  to pass and pay exactly the referee's heads. The web replay runs the same replay in the browser
  and shows "Refunded: rule violation" when it fails.
- **Limit.** It proves who hunted whom and whom each hint was about, not that the proximity
  evidence was real. A referee that breaks the rules cannot take money with it, but it can still
  force a refund. Checks that come before the replay (signature, `prev`, consistency proof, the
  VRF reveal opening its commitment) refuse the End instead, and the match then settles by
  `abort`, also as a refund.

### 8. The verdict history cannot fork (after the upgrade)

- **Mechanism.** Each verdict names the digest of the one before it (diagram above). The
  contract applies a verdict only if `seq = last + 1`, `prev` equals the stored digest of the
  last applied verdict, and the signature verifies under the referee key the match pinned at
  creation. `get_verdict_head(match_id)` returns `{seq, digest}`.
- **Enforced.** `contracts/tail/src/lib.rs` (`apply`). `crates/referee-core` sets `prev`. The
  deployed contract checks `seq` and the signature only.
- **Check.** The replay compares the last verdict digest with `get_verdict_head`
  (`apps/web/src/verify/history.ts`). `/?fixture=boston-common-tampered` has a Tag rewritten
  after signing, and the page reports "Verdict history is broken".
- **Limit.** The referee can still sign two different verdicts for one seq. Only one can land,
  and the other is evidence only if someone kept it. The chain says nothing about whether a
  verdict was right.

### 9. The log is append-only (after the upgrade)

- **Mechanism.** The referee anchors `Checkpoint{log_size, root}` at the first tick after each
  60 s of referee time, and `End{…, log_size, root}` at the end. Each one comes with an
  RFC 9162 consistency proof from the last anchored size and root (0 and `SHA256("")` for the
  first), built from the referee's Merkle frontier. The contract verifies the proof with
  `verify_consistency_with` on `env::sha256` before it stores the root. `log_size` must strictly
  grow. The k-th checkpoint may land no earlier than `k × 30 s` of match time, which keeps a
  match within 120 checkpoints. The relay checks each proof against its own leaves before it
  submits it.
- **Enforced.** `contracts/tail/src/lib.rs` (`check_consistency`),
  `crates/tail-protocol/src/merkle.rs`, `apps/server/src/matches.ts`.
- **Check.** `get_roots(match_id)`. The replay checks every pair of successive anchored roots
  (`apps/web/src/verify/history.ts`). `/?fixture=boston-common-tampered-log` has a Contact entry
  rewritten behind the 5th checkpoint, and every later checkpoint is re-signed over the new log.
  All signatures and the verdict chain hold, the links 4→5 and 5→6 fail, and the page reports
  "The log was rewritten". `cargo test -p tail-protocol` tests the proofs for every
  0 < m ≤ n ≤ 70.
- **Limit.** Entries newer than the last anchor (up to about a minute) are covered only by the
  root in each signed HUD, and the phone does not check those roots for consistency. The proofs
  say the log only grew, not that its entries are true. The deployed contract stores roots
  without a proof.

### 10. My reports were not dropped

- **Mechanism.** The phone keeps the seq and hash of every report the relay took. After the
  match, it computes each one's leaf: `Batch{player, seq, hash}`, or `Rejected{…, code}` for a
  refused report. It asks the relay for an audit path with `GET
  /matches/:id/inclusion?leaf=&size=`, using a size the contract anchored. It reads that size
  from `get_roots` over its own NEAR RPC, verifies the path against that root, and shows "N of M
  reports are in the log anchored on NEAR" with any missing report listed.
- **Enforced.** The phone: `apps/mobile/src/proximity/receipts.ts`, with roots from
  `apps/mobile/src/near/chain.ts`.
- **Check.** The phone's Results screen. After the upgrade, anyone holding a leaf and its path
  can call the `verify_inclusion` view.
- **Limit.** This detects a dropped report; it does not prevent one. It cannot tell whether the
  relay or the referee dropped it: a direct `POST /batch` gets no signed receipt, and only a
  mesh-carried report gets a relay-signed `CarryAck`. It has not run on a phone yet.

### 11. Two players were near each other (presence proof)

- **Mechanism.** A presence proof is `PresenceProof{match_id, contract, entry, index, size, path,
  accounts[2]}`, where `entry` is a `Contact{a, b, epoch, salt}` log entry. `verifyPresence`
  checks three things. The leaf is `SHA256(0x00 ‖ borsh(entry))`. The path leads to the root
  the contract anchored at exactly `size`. And `players[a]`, `players[b]` from `get_match` equal
  `accounts`. It adds no new signature.
- **Enforced.** `packages/protocol/src/presence.ts`, `crates/tail-protocol/src/presence.rs`, and
  after the upgrade the contract's `verify_inclusion`.
- **Check.** In the replay, a tag's contact window offers "Make presence proof".
  `/?presence=<proof>` checks a proof against the roots and players read from the pinned
  contract over RPC, never from a relay. The phone's "Prove I met" exports the same JSON.
- **Limit.** The proof is as strong as the referee's signature on the root plus the contact rule
  (claim 4). It shows that the referee logged a contact; the sightings behind it stay sealed. It
  can only be made after End, from the declassified log. It reveals the two accounts and the
  epoch to whoever holds it. No v2 match is on NEAR yet, so a proof made from the fixture comes
  back "NEAR has no such match".

### 12. The relay learns no positions, contacts or hints during play

- **Mechanism.**
  - Batches are sealed to the referee's box key. The phone checks `box_pk_sig =
    ed25519(referee_sk, SHA256("tail/referee-box/v1" ‖ box_pk))` under the `referee_pk` it reads
    from the contract over its own RPC.
  - HUDs, player keys and Handler lines are signed and sealed to the phone's box key
    (`tail/hud/v2`, `tail/keys/v2`, `tail/voice/v1`).
  - The tick state is sealed with an OutLayer encryption key (AAD `"tail/state/v1" ‖
    match_id`).
  - Log entries, hint facts and voice receipts are sealed with a key only the referee can
    derive: `HKDF(box secret, "tail/referee-vault/v1" ‖ purpose ‖ match_id)`, XChaCha20-Poly1305.
  - The relay holds only leaf hashes. `Contact`, `HintReceipt` and `Evidence` have few possible
    values, so each ends in `salt = HMAC(K_log, "tail/log-salt" ‖ u64le(index))[0..16]`, with
    `K_log = HKDF(K_m, "tail/log")`.
  - The Handler request carries `HMAC(K_log, "tail/voice-nonce" ‖ u32le(hint_id))[0..16]`, so
    NEAR AI's public `sha256(request)` does not name the fact.
  - Low-order X25519 keys and all-zero shared secrets are refused.
  - A mesh envelope is always 4144 bytes.
- **Enforced.** The referee (`crates/referee-wasi/src/vault.rs`, `src/cmd/tick.rs`),
  `packages/protocol` / `crates/tail-protocol` (sealing), and the phone
  (`apps/mobile/src/proximity/referee.ts` and `hud.ts`: signature checks).
- **Check.** After End the replay checks every salt against the released `K_m` (`checkSalts`).
  The vectors `seal.json` and `hud.json` pin the sealing and signing.
- **Limit.** During play the relay still learns:
  - the accounts, the lobby, and the zone and safehouses (it creates the match);
  - the IP address, time and size of every upload, and which player each HUD goes to;
  - each tick's refusals in the clear: player, seq and `RejectCode` for refused batches (for
    example `FixFlags` or `Teleport`), and player, strike or hint, and `RefuseCode` for refused
    actions (for example `Lock` or `NoContact`);
  - who asked for a hint (the Hint verdict on NEAR says so too, but not about whom);
  - how many log entries each tick adds, from which it can work out how many new contacts the
    tick found (but not between whom);
  - with mesh carry, which account carried whose request.

  Verdicts are public on NEAR for everyone (threat model). After End the relay holds the
  plaintext log and trails, and purges a private match's trails 24 h later
  (`apps/server/src/retention.ts`). With the local test referee the relay's machine holds every
  referee key and can read everything.

### 13. The Handler's line came from the model

- **Mechanism.** The referee computes the fact in plain code: NEAR (target within 150 m), BEARING
  (8-way) or TREND (closer or farther than 60 s ago). `voice` sends NEAR AI Cloud a persona, that
  fact and the player's question (at most 140 characters). The model is
  `deepseek-ai/DeepSeek-V4.1-Flash-1017`; `openai/*` and `anthropic/*` are refused. There is a
  3 s deadline, after which a template line is used. The referee fetches the chat signature, an
  Ethereum `personal_sign` over `model:sha256(request):sha256(response)`, and requires the two
  hashes to be of its exact bytes. It logs `HintReceipt{hint_id, chat_id, text_hash, signature,
  signing_address, salt}` and seals the signed line to the asker. The replay bundle carries the
  signed text.
- **Enforced.** `crates/referee-wasi/src/voice.rs`. The browser recovers the signer with
  secp256k1 and keccak-256 and compares it with `signing_address`
  (`apps/web/src/verify/checks.ts`, `checkHandler`).
- **Check.** The Handler entries in the replay.
- **Limit.** It shows that the logged address signed those hashes. It does not show that the
  address is a TEE key (no attestation report is fetched). The browser check is tested on fixture
  signatures; a real NEAR AI signature was verified only in a spike. The local test referee has
  no network and always uses templates, so no v2 match has a model line yet.

### 14. Which referee code signed

- **Mechanism.** The verdict key lives in OutLayer's keystore (`signing_keys`, `bind: project`,
  `caller: none`), and each match pins it in the contract at creation (`referee_pk`). Each
  verdict carries the `call_id` of the OutLayer call that produced it. OutLayer's public record
  `GET /attestations/by-call/{uuid}` names the `executed_wasm_sha256` and holds a TDX quote. The
  replay says "Enclave" only when NEAR's `referee_pk` for the match is the pinned enclave key and
  the record's `executed_wasm_sha256` is in its pinned list. Otherwise it uses the test-referee
  wording.
- **Enforced.** `apps/web/src/verify/pins.ts`, `attestation.ts` and `signer.ts`. The contract
  keeps each match's key.
- **Check.** `bun crates/referee-wasi/scripts/build.ts` prints the wasm sha256 of the current
  source. Compare it with a record's `executed_wasm_sha256`, and compare `get_match`'s
  `referee_pk` with `pins.ts`.
- **Limit.** The key belongs to the project, not the build, so a new version could sign: this
  detects a swap after the fact, it does not prevent one. The browser reads OutLayer's record and
  does not verify the TDX quote, and whether OutLayer's API answers a browser (CORS) has not been
  tried. The only pinned build is the v1 one, so no v2 verdict can show "Enclave" until a v2 build
  is uploaded and pinned. Whether the build reproduces byte for byte on another machine has not
  been tested. The local test referee has no attestation at all.

## Trust

The relay account, the contract owner and the OutLayer project owner are the same testnet
account today, `tail-dev-a38d13.testnet`. That account is us.

| Party                       | Trusted for                                                       | Not trusted for                                        | What bounds it                                                                                                                                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone (attested app)        | Honest sensor readings from a real device                         | Anything else                                          | App Attest (claims 1, 2). Each phone's report is checked against the other's (claim 4).                                                                                                                                                                                |
| Relay (`apps/server`)       | Liveness: forwarding, ticking, paying gas                         | Secrets, positions, verdicts, money                    | Sealing (12), signed verdicts (8), the contract's checks. A stalled match refunds every stake by `abort` after 15 min.                                                                                                                                                 |
| Referee                     | The rules, the secrecy of the ring and the trails, honest entries | Money (the contract checks order, chain, ring, proofs) | Code identity through the per-call attestation record (14). With the local test referee pinned now: nothing but the machine's operator.                                                                                                                                |
| Contract (`contracts/tail`) | Custody and settlement                                            | —                                                      | Public code and state. Its full-access key (ours) can redeploy it, and the owner key (the relay's account) can pin a different referee or VRF key for matches created afterwards. `get_match` shows each match's own keys, and the replay compares them with its pins. |
| NEAR AI Cloud               | Flavour text                                                      | Facts, money                                           | The model sees one coarse fact (13). The signature shows who signed, not the hardware.                                                                                                                                                                                 |
| OutLayer                    | Running the published wasm in TDX, guarding the verdict key       | —                                                      | The attestation record per call. Its own governance is early: operator-held keys (their `NON_CUSTODIAL.md`).                                                                                                                                                           |

## Threat model

| Attack                                                     | Result                                                                                                                                                                                                                                                |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GPS spoofing app, simulator                                | The source flags refuse the batch. A modified app fails App Attest. Even with a fake position, a tag needs mutual radio contact.                                                                                                                      |
| Relay enrols a software key to fake a player               | The v2 referee refuses a device without an Apple attestation, unless `ALLOW_UNATTESTED=1` (testnet), and then logs it as `attested: false` and the replay labels it. The relay owns the OutLayer project, so it can set that flag, but not hide it.   |
| Relay forges a tag or a verdict                            | It cannot sign verdicts. With the local test referee, the relay's machine holds the verdict key, so it can sign, but an off-ring Tag or a wrong hint target is refunded at End (claim 7, after the upgrade).                                          |
| Relay drops batches                                        | It can prevent tags but not create them. The phone finds the gap in its receipts (claim 10). Sustained drops count as dark for the protected player.                                                                                                  |
| Relay replays or forks the sealed state                    | The referee refuses a blob whose last seq is not the caller's `last_seq`. Two forks give two verdicts with one seq, and the contract takes one.                                                                                                       |
| Referee rewrites logged history                            | Refused on-chain once a covering root is anchored (claim 9, after the upgrade). The replay catches it from the roots either way.                                                                                                                      |
| Wormhole: an accomplice relays both phones' Bluetooth live | Not closed: there is no distance bounding. It needs a two-way relay within about 30 s (claim 3) and fixes within 40 m plus accuracies, so one side's GPS must also be spoofed on an attested phone. The `relayed-live-token` scenario shows the hole. |
| Replaying a recorded token later                           | Refused after about one epoch (claim 3), and contact must be mutual.                                                                                                                                                                                  |
| Reading NEAR during play                                   | A Hint names only its asker, so the chain does not say who hunts whom (after the upgrade). A Tag or Forfeit still names both players as it lands, and its credit, set against earlier hint amounts, can show who was hunting the loser before.        |
| Relay traffic analysis                                     | It learns what claim 12 lists: timing, sizes, refusal codes, who asked a hint, the number of new contacts per tick, and who carried whose batch.                                                                                                      |
| Target kills the app or turns on airplane mode             | Dark rules: the hunter gets a 100 m cell after 45 s, and 180 s of total dark time forfeits the head. Mesh carry (off by default) would reduce honest dark time.                                                                                       |
| Riding a car or train                                      | The speed rule freezes contact.                                                                                                                                                                                                                       |
| Referee or relay stalls                                    | `abort` after 15 min of silence, or 15 min past `end_ms`, refunds every original stake (after the upgrade; the deployed contract refunds the current heads).                                                                                          |
| Operator swaps the referee code on OutLayer                | The key survives new versions, so a swap is caught after the fact by the attestation record (claim 14), not prevented. This is bounded by OutLayer's governance.                                                                                      |
| Owner pins another referee key                             | Only for matches created afterwards. Each match keeps its key, and the replay names the referee by NEAR's key for that match. This is how the local test referee is pinned now.                                                                       |
| Prompt injection against the Handler                       | The model sees one coarse fact and has no say over money.                                                                                                                                                                                             |
| Tracking players by their beacons                          | Tokens change every 15 s and are unlinkable without `K_p`. The Bluetooth address rotates on Apple's schedule. With mesh carry on, the mesh link tells two phones that some TAIL phone is in range.                                                    |
| Sybil players                                              | Friends-only lobbies (`invites`). Public matches have no answer yet.                                                                                                                                                                                  |
