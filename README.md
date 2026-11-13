# TAIL

A real-world game of tag where every tag comes with proof.

Location games get spoofed, because anyone can fake GPS. In TAIL a tag only counts when two real
iPhones heard each other over Bluetooth. A referee judges that from both phones' sealed,
signed reports, signs the result, and a NEAR contract settles the money. The referee is built to
run in a hardware enclave (Intel TDX, on OutLayer). There, the relay that runs the game sees no
positions and holds no key that signs a verdict. Two things qualify that today:

- **The live contract pins a local test referee, not the enclave.** It is the same referee code,
  run on our machine, the one that also runs the relay, because OutLayer testnet stopped running
  calls on 2026-11-12. While it is pinned, that machine holds the verdict key and could sign any
  verdict, so trust in the referee is trust in us. The replay labels its matches "test referee".
- **One account runs the relay, the contract and the OutLayer project**
  (`tail-dev-a38d13.testnet`). With the enclave, that owner could publish a new referee version,
  which signs with the same key. Each verdict's OutLayer attestation record names the build that
  ran, so a swap is caught after the fact, not prevented.

**Nothing from this round is deployed.** This repository is protocol v2. The live contract
`tail.tail-dev-a38d13.testnet` runs the code from before it, OutLayer holds the protocol v1
referee build `20446c64…08664`, and no phone has run the new app. A feature marked **(after the
upgrade)** is in `contracts/tail` and its tests, and reaches the live contract with the in-place
upgrade, which has not been run.

Built for the NEAR hackathon, on NEAR testnet. What each proof shows and where it stops is in
[ARCHITECTURE.md](ARCHITECTURE.md).

## The game in one breath

Everyone stakes money on their own head and gets one secret target. Get within Bluetooth range of
your target and stay there until your **lock** fills, then **strike**: their head moves to you,
and their target becomes yours. Your target feels **heat** rising but can't see who. Hints from
the Handler cost you money, more when many players are buying. The money goes to your target, but
only when they are tagged or the match ends, so the chain never shows who asks about whom (after
the upgrade). When time runs out, survivors keep their heads.

## Tracks

Entered: Games, Privacy, Open, NFTs.

**Games**

- **An NPC that prices intel by demand.** The Handler sells three hints. Each costs its base
  price (2 % or 5 % of the stake) plus 25 % for every hint anyone in the match bought in the last
  5 minutes of match time, at most 4×. The rule is one file per language
  (`crates/tail-protocol/src/pricing.rs`, `packages/protocol/src/pricing.ts`). The referee
  charges it, each phone's signed HUD carries the current prices, the phone shows the Handler's
  one-line reason, and the contract recomputes the price from earlier hints' times and refuses
  any other amount (after the upgrade).
- **Watch the economy move.** The replay's economy view shows the hint pool, the price, every
  player's head and each transfer, all rebuilt from the signed verdicts.
  `/?fixture=boston-common-economy&view=economy` is a 12-player, 60-minute match played through
  the real rules engine, and "Whole match in 1 min" plays it in a minute.
- **A hidden ring.** Who hunts whom is drawn by a VRF, committed at Start and revealed at End. A
  Hint verdict names only the asker, and the money waits in a pool (after the upgrade: the live
  contract's hints name their target).
- **Money moves only after the contract replays the match** (after the upgrade). At End it
  rebuilds the ring and replays every hint, tag and forfeit. One broken rule refunds every stake.
- **Players never see the chain.** There is no wallet, seed phrase or signing popup. The phone
  makes its NEAR key in the Keychain, the relay creates `<handle>.tail-dev-a38d13.testnet` holding
  only that key (it can join, leave and withdraw), funds it, and pays the gas of every verdict.
  The one chain step a player sees is naming a wallet on their first withdraw.

**Privacy**

- **A TEE referee.** It is built for OutLayer's Intel TDX. The local test referee is pinned now
  (above).
- **Sealed reports.** Each phone seals its reports to the referee's box key, after checking that
  key's signature against the `referee_pk` it reads from NEAR itself.
- **The relay learns no positions, contacts or hint targets during play.** HUDs, player keys and
  Handler lines are signed and sealed to each phone and padded, so every one is 1072 bytes and its
  length names neither the target nor the hint. The relay holds only leaf hashes of the match
  log, and the entries with few possible values (contacts, Handler receipts, tag evidence) are
  salted from the match key, so it cannot hash guesses. What it still learns is listed in
  ARCHITECTURE.md, claim 12.
- **The Handler runs on NEAR AI Cloud, with its attestation checked.** The referee sends the model
  one coarse fact, never coordinates. `scripts/verify-nearai.ts` and the replay's Handler panel
  (in the browser, when NEAR AI's API answers it) fetch NEAR AI's attestation report for a fresh
  nonce and check the Intel TDX quote back to Intel's root, that the quote binds the nonce and
  the signing address, and the container manifest. NVIDIA's GPU attestation is judged by NVIDIA's service (NRAS), which only the script
  can reach, and the panel shows the script's saved result for it. No v2 match has a model line
  yet: the local test referee has no network and uses templates.
- **Retention.** A private match's sealed batches, trails, log, zone and Handler lines are purged
  24 h after End (`apps/server/src/retention.ts`, `apps/server/scripts/purge.ts`).

**Open**

- **Proof of physical co-presence.** A presence proof is a logged `Contact` entry with its Merkle
  path to a root anchored on NEAR. Anyone checks it against the contract: `/?presence=` in the
  replay, or the contract's `verify_inclusion` view (after the upgrade).
- **A reusable proximity layer.** `apps/mobile/src/proximity/` (rotating beacon, signed and
  chained reports, signed HUDs, receipts, presence proofs, the log monitor, mesh carry) imports
  nothing from TAIL, and a test checks that. `crates/tail-protocol` and `packages/protocol` hold
  the wire formats and proofs, and `tail-verify` re-runs a finished match. They are code in this
  repository, not published packages, and the referee's rules are not split out the same way.

**NFTs** (all after the upgrade)

- **A soulbound Dossier per player.** NEP-171 with NEP-177 metadata and NEP-181 enumeration, on
  the tail contract. The token id is the player's sub-account, minted at registration. Its record
  is computed on every read from matches the contract replayed and paid out; refunds count for
  nothing.
- **Art on-chain.** `media` is an SVG data URI the contract draws on every read: a trail with one
  segment per match. It is at most 4 KB and byte-identical to `packages/brand/src/dossier.ts`,
  pinned by golden vectors on both sides. The replay shows it at `/dossier/<account>`, the phone
  on Profile.
- **Credential-gated lobbies.** `create_match` takes `requires: {min_matches, min_survived}`, and
  `join_match` refuses a dossier below it. The relay and the app do not set it yet.
- **Why soulbound.** A dossier is an access credential. If it could move, a record could be
  bought to get into a gated match, and the gate would measure money instead of play. So
  `nft_transfer` always refuses.

**Not used, on purpose**

- NEP-245 multi-token: a dossier is one non-fungible record per player, which NEP-171 covers.
- NEAR Intents: there is no testnet deployment to settle against.
- Social login: accounts are bound to an Apple-attested iPhone instead, which is the check against
  spoofing that the game needs.
- A transferable NFT: see "Why soulbound".

## How a tag is proven

```
 iPhone A ──┐  each phone advertises a 16-byte token that changes every 15 s
 iPhone B ──┤  and records the tokens it hears (with RSSI), plus GPS fixes
            │
            ▼  every 5 s: a batch, hash-chained, signed by the phone's App Attest key,
               sealed (X25519 + ChaCha20-Poly1305) to the referee's key
 relay (untrusted) ── forwards sealed batches, pays gas; sees no log entry, only leaf hashes
            │
            ▼  every 10 s: a tick
 referee ── opens batches, checks App Attest, resolves tokens, decides contact,
            │  lock and tags; signs chained verdicts (ed25519); signs and seals HUDs
            ▼
 NEAR contract ── checks each verdict's signature and order on-chain, moves the money
```

- **Mutual contact.** A contact epoch needs both phones to have heard the other's token for that
  15-second epoch, above an RSSI floor, with GPS fixes that are plausibly close. A lock needs 4
  contact epochs in a 2-minute window.
- **Tokens only the match can recognise.** A token is `HMAC(K_tag, epoch)[0..4] ‖ HMAC(K_p[i],
  epoch)[0..12]`. Every player holds `K_tag`, so players can tell that a token comes from their
  match. Only the player and the referee hold `K_p[i]`, so no one else can tell whose it is or link
  one epoch's token to the next. To anyone outside the match, tokens are noise.
- **Real devices.** At enrolment the referee checks the phone's Apple App Attest attestation
  itself, against Apple's root, for the one App ID pinned in its code. From Start on, every batch
  carries an App Attest assertion, checked against the same constant: the relay cannot name
  another app. An enrolled account keeps its device. Moving it to new keys takes a signature by
  the account's NEAR key (`rebind_sig`), so a relay holding an iPhone of its own cannot take over
  someone's seat. The OutLayer build now active predates these checks. Batches with a simulated
  location are refused. A test player without an attestation is recorded as one, and the replay
  says so.
- **Which code signed.** Each verdict names the OutLayer call that produced it. That call's
  public attestation record names the wasm build that ran, and the replay compares it with the
  published hash. The local test referee has no such record, and the replay says "test referee".
- **Fair targets.** The ring of targets comes from a VRF. It is committed at Start and revealed at
  End, and the contract checks the VRF signature and the commitment.
- **One history.** Every accepted batch, refusal, contact and verdict goes into a Merkle log. Its
  root is anchored on NEAR every minute and at End. Each verdict names the digest of the one
  before it, and the contract checks a consistency proof for each new root (both after the
  upgrade). Each phone also checks every root the referee signs into its HUD against the last one,
  the way a Certificate Transparency monitor does: two signed roots that contradict each other are
  kept as evidence of a fork.
- **Checked before paid** (after the upgrade). Money only becomes withdrawable after the contract
  has replayed and checked the whole match. Each Hint must cost exactly the demand price. At End
  the contract rebuilds the ring from the VRF reveal and replays every hint, tag and forfeit: each
  tag must take the hunter's current target, each hint must be about the asker's target, each
  credit must be exact and the pool must end at zero. If one rule fails, it refunds every stake
  and records which rule. A match whose referee goes silent is refunded the same way.
- **What the contract cannot see.** It checks those rules, not the radio evidence behind a tag. A
  referee that invented contact for a tag of the right target would be paid out. That is caught
  only by re-running the match from its released batches with `tail-verify` (step 2 below), and
  only after End.

## Try it

You need [Bun](https://bun.sh) 1.4+ and Rust (the toolchain is pinned in `rust-toolchain.toml`).

### 1. Run every check (no accounts needed)

```sh
bun install
bun run check
```

You should see `all 13 steps passed`. The steps are Biome, TypeScript, the Bun tests, Rust fmt,
clippy and tests, the contract's fmt, clippy and tests, the referee module's fmt and wasm
clippy, Swift lint and a secret scan. On 2026-11-13 they ran:

- 588 Bun tests: protocol and helper packages 96, web replay 118, relay 139, iPhone app 235. One
  relay test plays a whole match through the relay against the real local test referee and runs
  `tail-verify` on the replay bundle the relay serves.
- 152 Rust workspace tests, including the golden vectors that pin the TypeScript and Rust wire
  formats to the same bytes, Merkle consistency proofs for every 0 < m ≤ n ≤ 70, App Attest on
  a real iPhone capture, the End replay's rules, 33 tests over 28 scripted matches and random
  12-player runs (each replayed the way the contract settles it), and 16 `tail-verify` tests.
- 244 contract tests, covering money, abuse, the verdict chain, proofs, demand pricing, the End
  replay and the dossier.

The referee module's own tests (`cd crates/referee-wasi && cargo test`, 37 tests) are not in the
gate. The iPhone app's tests also run on their own: `cd apps/mobile && bun test`.

### 2. Re-run the referee on a finished match

`tail-verify` replays a match from its released data through the same rules engine the referee
runs, and requires every log entry and every verdict to come out byte for byte.

```sh
cargo run -q -p referee-verify --example demo-bundle > /tmp/match.json
cargo run -q -p referee-verify -- /tmp/match.json
```

It ends with `PASS` and exits 0. The `input` lines above that say what it took from the bundle,
and a `warning` line notes that the demo uses the simulator's App ID. Along the way it re-checked
81 App Attest assertions against the device keys, recomputed every contact from the phones'
sightings, and re-derived every salt from the match key. Now forge a tag that still carries a
valid referee signature:

```sh
cargo run -q -p referee-verify --example demo-bundle -- --forge-tag > /tmp/forged.json
cargo run -q -p referee-verify -- /tmp/forged.json
```

It prints `FAIL tick 13: verdict seq 5: the bundle has seq 5 Tag alice→bob …, re-execution gives
seq 5 Tag bob→alice …` and exits 1.

For a real match, save the relay's `GET /replay/:id` and pin the keys to the contract's
`get_match` values: `cargo run -q -p referee-verify -- match.json --referee-pk <hex> --vrf-pk
<hex>`. Without the pins
it checks the bundle against its own keys and says so. It is strict by default: exit 0 means
nothing was taken on trust, 1 a check failed or a pinned key differs, 2 the input is not a v2
bundle, and 3 that the re-execution matched only with items taken from the log, each printed
(for example a refusal whose batch the referee did not release). `--allow-trusted` accepts
those. Details: `crates/referee-verify/README.md`.

### 3. Watch a verified replay

```sh
cd apps/web
bun run dev
```

Open http://localhost:5173. A generated match on Boston Common plays as a short film: players
walk the park's real paths, the lock line tightens, and each tag flashes on the spot. Click a tag
to see its proof. In your browser the page re-checks:

- every verdict signature and the verdict chain;
- every Merkle root, and consistency between successive roots;
- the VRF reveal and the ring;
- the End replay the contract runs, with every head and payout;
- each tag's logged evidence against the lock rule, with Merkle paths;
- the log salts, the Handler's model signature and NEAR AI's attestation of its key, and each
  trail against the log.

It checks the referee's log entries. It does not re-check App Attest assertions or recompute
contact from sightings: `tail-verify` does both.

- Open `/?fixture=boston-common-tampered`: one Tag verdict was rewritten after signing. The page
  reports "Verdict history is broken" and marks the tag "Fails a check".
- Open `/?fixture=boston-common-tampered-log`: the referee rewrote a contact behind the 5th
  checkpoint and re-signed every later one. Every signature still holds, but the consistency
  proofs 4→5 and 5→6 fail, and the page reports "The log was rewritten".
- Open `/?fixture=boston-common-economy&view=economy` and press "Whole match in 1 min". The same
  bundle passes `tail-verify`:
  `cargo run -q -p referee-verify -- apps/web/public/fixtures/boston-common-economy.json`.
- Click a tag, open one of its contact windows, choose "Make presence proof", and open the link.
  `/?presence=` checks a proof that two players were near each other against roots and players
  read from the pinned contract over RPC. For the fixture it answers "NEAR has no such match",
  because the fixture never went to NEAR.
- The fixtures are signed with public test keys and were never sent to NEAR, so their header
  reads "Not on NEAR". A real match (`/?match=<id>` against a running relay) is compared with the
  contract's on-chain roots, verdict head and payouts.

### 4. Play a match on testnet with ghost phones

This needs a funded NEAR testnet account and an OutLayer payment key. Copy `.env.example` to
`.env.local` and fill it in. Then:

```sh
ALLOW_GHOSTS=1 bun apps/server/scripts/ghost-match.ts
REFEREE_MODE=local ALLOW_GHOSTS=1 RELAY_PORT=8788 bun apps/server/scripts/ghost-match.ts   # local test referee
```

Three simulated phones enrol, top up, join a lobby and play a 5-minute match through the real
relay, the referee and the contract. One hunts another, asks the Handler for a hint and strikes
when its lock fills. The script checks the contract after every step. It also checks the relay's
leaves and the declassified log against End's root, and one inclusion and one consistency proof.

**This step needs the contract upgrade first.** This code speaks protocol v2, and the live
contract still runs the code from before this round, which refuses v2 verdicts. The first
command also needs OutLayer testnet to run calls again. The three passing runs in
`apps/server/README.md` (2026-11-12, about 0.43 testnet NEAR and $0.05 of OutLayer each) were
protocol v1, on OutLayer.

Ghosts are a testing door. They have no Apple attestation, so the referee enrols them only with
`ALLOW_UNATTESTED=1` and logs them as unattested. The relay makes them only on testnet with
`ALLOW_GHOSTS=1`, in-process: no HTTP route enrols one, and the host's signed
`POST /dev/ghosts/fill` seats one made on the spot. Their accounts are named `ghost-…`.

### 5. Look at the deployed pieces

- Contract: `tail.tail-dev-a38d13.testnet` (see `contracts/tail/README.md`).

  ```sh
  near contract call-function as-read-only tail.tail-dev-a38d13.testnet get_config \
    json-args '{}' network-config testnet now
  ```

  `referee_pk` reads `d35338a9…6594` and `vrf_pk` `ad82f28f…defcb`: the local test referee's
  keys, pinned since OutLayer testnet stopped running calls. `get_config` has no `vrf_sender` or
  `withdraw_min_gas` field, and `get_verdict_head`, `get_dossier` and `nft_token` do not exist.
  That is how you can tell the in-place upgrade has not been deployed.
  `apps/server/scripts/pin-referee.ts` puts the enclave's keys back; phones then re-enrol with
  the new referee (below).
- Referee: OutLayer project `tail-dev-a38d13.testnet/tail-referee` on testnet. Its active version
  is the protocol v1 build `20446c64…08664`. The v2 build is not uploaded. Commands, manifest
  and measured latency are in `crates/referee-wasi/README.md`.

### 6. Play on iPhones

You need two iPhones with Developer Mode on, an Apple developer team with the App Attest
capability, and the relay running where the phones can reach it. Build and install steps are in
`apps/mobile/README.md`.

## Where NEAR fits

| NEAR piece                                 | Job in TAIL                                                                                                                                                                                                                         | Code                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Rust contract with `env::ed25519_verify`   | Holds stakes; applies only referee-signed verdicts, in order; checks the VRF reveal; refunds if the referee goes silent. After the upgrade: the verdict chain, consistency proofs, the demand price of each hint, the replay at End | `contracts/tail`                                               |
| `env::sha256` in the contract              | Verifies RFC 9162 consistency proofs and, in the `verify_inclusion` view, Merkle audit paths (after the upgrade)                                                                                                                    | `contracts/tail`, `crates/tail-protocol`                       |
| NEP-171 / 177 / 181 on the same contract   | One soulbound Dossier per player, its SVG drawn on-chain, gating who may join a match (after the upgrade)                                                                                                                           | `contracts/tail/src/dossier.rs`, `art.rs`                      |
| OutLayer (Intel TDX) on `outlayer.testnet` | The referee: sealed match state, the verdict signing key, VRF, the Handler call. v1 build deployed; not running calls since 2026-11-12                                                                                              | `crates/referee-wasi`, `crates/referee-core`                   |
| NEAR AI Cloud                              | The Handler's lines from an open-weight model; the chat signature is logged and re-checked, and the signing key's TDX and GPU attestation is verified                                                                               | `crates/referee-wasi/src/voice.rs`, `scripts/verify-nearai.ts` |
| Named sub-accounts with function-call keys | Each player's account holds only a key that can join, leave and withdraw; it is also the Dossier's token id                                                                                                                         | `apps/server/src/near.ts`                                      |
| NEP-141 token (`usdc.fakes.testnet`)       | Stakes, heads and payouts                                                                                                                                                                                                           | `contracts/tail`                                               |
| Merkle roots on-chain                      | Checkpoints every minute and at End; the replay, the phones' receipts, the phones' log monitor and presence proofs check against them                                                                                               | `contracts/tail`, `apps/web/src/verify`                        |

## What this does not claim

- **Not proven GPS.** Apple does not attest the GPS chip. We claim our real app on a real iPhone,
  two phones in mutual radio contact, and physically plausible movement.
- **Not trustless.** The referee is trusted for the rules and for keeping positions secret. With
  the enclave, that trust is bounded by the attestation record of each call. OutLayer's own
  governance is still early (their docs say so). The verdict key belongs to the OutLayer project,
  so a new version of the project could sign, and the attestation record per verdict is how you
  would catch it. With the local test referee pinned now, there is no such bound.
- **Not proximity checked on-chain.** The contract checks the ring, the hint rules and the money,
  not the radio evidence. Fabricated contact behind a ring-valid tag is caught only by
  `tail-verify` on the released batches, after End.
- **Not the referee's clock.** Each tick's time is the referee's word, and the relay may hold it
  back (never more than 20 s ahead). `tail-verify` replays with the logged times and cannot check
  them. The contract bounds it loosely. Start must be within 5 minutes of block time. After the
  upgrade, a checkpoint may land no faster than one per 30 s of block time, while the referee
  anchors one per 60 s of its own, so a referee clock running more than about twice as fast as
  the chain stalls the match into a refund.
- **Not censorship-proof.** The relay can drop a report before the referee sees it; the phone's
  receipts show the gap afterwards. The referee can log a refusal: when it releases the refused
  batch, `tail-verify` re-checks the refusal, and when it does not, `tail-verify` lists it as
  taken on trust and exits 3.
- **Not private from the chain.** Verdicts land on NEAR during play. A Hint names only who asked
  (after the upgrade), but a Tag or Forfeit names both players, and its hint credit can show who
  was hunting the loser earlier. The relay also sees timing, sizes, refusal codes and how many
  contacts each tick found (ARCHITECTURE.md, claim 12).
- **Not a full defence against relaying.** An accomplice relaying Bluetooth both ways, within
  about 30 s, plus location spoofing on an attested phone, could fake proximity. There is no
  distance bounding.
- **Foreground only.** The app must stay open. Pocket mode turns the screen off with the
  proximity sensor while the app keeps running.

## Status

| Part                                        | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wire formats (TS + Rust)                    | Protocol v2, including demand pricing and padded phone seals; golden vectors shared by both                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Rules engine and simulator                  | 28 scripted scenarios, random 12-player runs in the tests, and `referee-sim bench` (12 players, 60 minutes by default)                                                                                                                                                                                                                                                                                                                                                                                               |
| `tail-verify`                               | Re-runs a v2 bundle through the rules engine; passes on the demo, the economy fixture and a relay-served match judged by the local referee (in the tests). No real match has a v2 bundle yet                                                                                                                                                                                                                                                                                                                         |
| Referee on OutLayer testnet                 | v1 build deployed; a 3-player ghost match passed end to end on 2026-11-12. Calls time out (HTTP 524) since that evening. The v2 build passes its scripts against the local test referee and is not uploaded                                                                                                                                                                                                                                                                                                          |
| Local test referee                          | Pinned on the live contract; judged the 2026-11-12 iPhone matches (v1)                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| NEAR contract on testnet                    | Deployed code is from before this round. Each of these passes the 244 tests and is not deployed: the verdict chain (`prev`, `get_verdict_head`); consistency proofs and `verify_inclusion`; hints that name no target, paid into a pool; the demand price check; the End replay and its refund; abort refunding original stakes (the live contract refunds current heads); `withdraw` to a named wallet; the VRF sender check; the timing rules; the Dossier NFT and `requires`. The upgrade keeps state (`migrate`) |
| Contract reviews                            | The first version was security-reviewed and the findings fixed, each with a regression test (`contracts/tail/src/tests.rs`). No outside review of this round's changes yet                                                                                                                                                                                                                                                                                                                                           |
| Relay                                       | Protocol v2; per-address limits on challenges, HUD sockets and new enrolments; re-enrolment when the contract pins another referee; releases device keys, assertions and refused batches after End. Tests pass; runs locally (not deployed)                                                                                                                                                                                                                                                                          |
| Web replay                                  | Protocol v2, and reads v1 bundles; economy view, NEAR AI attestation panel, dossier page; runs locally                                                                                                                                                                                                                                                                                                                                                                                                               |
| iPhone app                                  | Two iPhones (17 Pro Max, 14) ran enrolment with App Attest, lobbies and a Tag from Bluetooth contact indoors on 2026-11-12 (v1). The v2 paths (signed HUDs, chain recovery, receipts, the log monitor, the check of each Handler line against the logged receipt, re-enrolment, the Dossier card) pass their tests and have not run on a phone                                                                                                                                                                       |
| Range, pocket and outdoor tests             | **Not run yet**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Mesh carry (Offline Protocol SDK)           | Phone to phone, with no relay node: an offline phone seals its signed request to the relay and a nearby phone posts it. Off by default behind a setting; tested only with a fake mesh; Bluetooth coexistence not measured                                                                                                                                                                                                                                                                                            |
| Sponsor-funded public matches (Sputnik DAO) | The contract supports sponsors; no DAO flow                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Measured on testnet with the v1 code (2026-11-12): a game tick took 2.9 s at the median and 6.7 s
at p95, of which about 1.5 s was inside the enclave. An `apply` of one verdict burned about
2 Tgas, and an OutLayer call cost about $0.001. The v2 code is not measured on testnet.

## Repository

```
packages/protocol      wire formats, crypto, pricing, Merkle and consistency proofs, presence proofs, golden vectors (TypeScript)
crates/tail-protocol   the same in Rust, pinned by the same vectors
crates/referee-core    the rules engine: pure and deterministic
crates/referee-sim     scripted matches through the engine
crates/referee-verify  tail-verify: re-runs a finished match from its replay bundle
crates/referee-wasi    the referee: OutLayer module, or the local test referee when built natively
crates/appattest       App Attest attestation and assertion checks (Rust; runs in the referee)
contracts/tail         the NEAR contract, with the Dossier NFT
apps/server            the relay: Bun, Hono, SQLite
apps/web               the replay and verifier: React, MapLibre, deck.gl
apps/mobile            the iPhone app: Expo, React Native, Swift modules
packages/appattest     App Attest attestation checks (TypeScript; the relay's own check)
packages/brand         logo, colours, icons, the Dossier card
packages/log           logging with secret redaction
scripts/verify-nearai.ts   checks NEAR AI's attestation of the Handler's signing key
```

In the iPhone app, the proof machinery is kept apart from the game rules.
`apps/mobile/src/proximity/` holds the beacon, signed and chained reports, chain recovery, signed
HUDs, receipts, presence proofs, the log monitor and mesh carry, and imports nothing from TAIL (a
test checks that). `apps/mobile/src/tail/` holds the hunt on top of it: lock, heat, strikes,
hints. This is a code structure inside the app, not a published package or SDK. The referee's
rules are not split out the same way.

## Prior work and dependencies

- **chainSpeed** (our earlier project): ideas only; no code was reused.
- **Palantiny** (our earlier research): showed that phones rotate their Bluetooth address about
  every 15 minutes, which led to the rotating-token beacon; no code was reused.
- **Offline Protocol SDK** (`@offline-protocol/mesh-sdk`, AGPL-3.0): a dependency of the iPhone
  app for the mesh carry path.
- Map data © OpenStreetMap contributors; tiles by OpenFreeMap; type is Archivo (SIL OFL).

## License

AGPL-3.0-only. See `LICENSE`.
