# TAIL

A real-world game of tag where every tag comes with proof.

Location games get spoofed: anyone can fake GPS. In TAIL a tag only counts when two real iPhones
heard each other over Bluetooth. A referee running in a hardware enclave (Intel TDX, on OutLayer)
judges that, signs the result, and a NEAR contract settles the money. Nobody running the game,
including us, can see players' positions during a match or forge a tag.

Built for the NEAR hackathon. Everything runs on NEAR testnet.

## The game in one breath

Everyone stakes money on their own head and gets one secret target. Get within Bluetooth range of
your target and stay there until your **lock** fills, then **strike**: their head moves to you and
their target becomes yours. Your target feels **heat** rising but can't see who. Hints from the
Handler cost you money, paid onto your target's head. When time runs out, survivors keep their
heads.

## How a tag is proven

```
 iPhone A ──┐  each phone advertises a 16-byte token that changes every 15 s
 iPhone B ──┤  and records the tokens it hears (with RSSI), plus GPS fixes
            │
            ▼  every 5 s: a batch, signed by the phone's App Attest key,
               sealed (X25519 + ChaCha20-Poly1305) to the referee's key
 server (relay, untrusted) ── forwards sealed batches, pays gas, stores the log
            │
            ▼  every 10 s: POST to OutLayer
 referee in a TDX enclave ── opens batches, checks App Attest, resolves tokens,
            │                decides contact, lock, tags; signs verdicts (ed25519)
            ▼
 NEAR contract ── verifies each verdict's signature on-chain, moves the money
```

- **Mutual contact.** A contact epoch needs both phones to have heard the other's token for that
  15-second epoch, above an RSSI floor, with GPS fixes that are plausibly close. A lock needs 4
  contact epochs in a 2-minute window.
- **Unguessable tokens.** A token is an HMAC of the epoch under a per-player key that only the
  player and the enclave hold. To everyone else, other players included, tokens are noise.
- **Real devices.** Every batch carries an Apple App Attest assertion: it came from our unmodified
  app on a real iPhone. Batches flagged as simulated location are rejected.
- **A referee nobody can steer.** Verdicts are signed inside the enclave with a key the contract
  pins. Each verdict names the OutLayer call that produced it; that call's public attestation
  record shows which wasm build ran.
- **Fair targets.** The ring of targets comes from OutLayer's VRF. It is committed at Start and
  revealed at End; the contract checks the VRF signature and the commitment.
- **Tamper-evident history.** Every accepted batch, contact and verdict goes into a Merkle log
  whose root is anchored on NEAR every minute and at End. After the match the replay rebuilds and
  checks all of it in the browser.

## Try it

You need [Bun](https://bun.sh) 1.4+ and Rust (the toolchain is pinned in `rust-toolchain.toml`).

### 1. Run every check (no accounts needed)

```sh
bun install
bun run check
```

You should see 13 steps pass: Biome, TypeScript, the Bun tests, Rust fmt, clippy and tests, the
contract's tests, the referee module's lints, Swift lint and a secret scan. These include the
golden vectors that pin the TypeScript and Rust wire formats to the same bytes, 18 scripted
matches through the rules engine, and the contract's money and abuse tests.

### 2. Watch a verified replay

```sh
cd apps/web
bun run dev
```

Open http://localhost:5173. A generated match on Boston Common plays as a short film: players
walk the park's real paths, the lock line tightens, and each tag flashes on the spot. Click a tag
to see its proof. Every signature, Merkle root and trail is re-checked in your browser.

- Open `/?fixture=boston-common-tampered`: one Tag verdict was rewritten after signing. The page
  marks it "Doesn't match NEAR".
- This fixture is signed with a public test key and was never sent to NEAR, so its header reads
  "Not on NEAR". A replay of a real match (`/?match=<id>` against a running server) is compared
  with the contract's on-chain roots and payouts.

### 3. Play a real match on testnet with ghost phones

This needs a funded NEAR testnet account and an OutLayer payment key. Copy `.env.example` to
`.env.local` and fill it in. Then:

```sh
ALLOW_GHOSTS=1 bun apps/server/scripts/ghost-match.ts
```

Three simulated phones enrol, top up, join a lobby and play a 5-minute match through the real
server, the real enclave referee and the real contract. One hunts another, asks the Handler for a
hint and strikes when its lock fills. The script checks the contract after every step and prints
the match id. Each run costs about 0.43 testnet NEAR and $0.05 of testnet USDC on OutLayer.

Ghosts are a testing door: they skip Apple's attestation, the route exists only on testnet with
`ALLOW_GHOSTS=1`, and ghost accounts are named `ghost-…` on chain.

### 4. Look at the deployed pieces

- Contract: `tail.tail-dev-a38d13.testnet` (see `contracts/tail/README.md`).

  ```sh
  near contract call-function as-read-only tail.tail-dev-a38d13.testnet get_config \
    json-args '{}' network-config testnet now
  ```

  Normally `referee_pk` is the enclave's verdict key and `vrf_pk` is OutLayer's testnet VRF key.
  Since 2026-11-12, while OutLayer testnet does not answer calls (HTTP 524), the contract pins
  the **local test referee's** keys instead: the same referee code run on the relay's machine,
  not in an enclave (`apps/server/README.md`, "The local test referee"). Matches it judges say so
  in the replay. `apps/server/scripts/pin-referee.ts` puts the enclave's keys back.
- Referee: OutLayer project `tail-dev-a38d13.testnet/tail-referee` on testnet. Its commands,
  manifest and measured latency are in `crates/referee-wasi/README.md`.

### 5. Play on iPhones

Two iPhones with Developer Mode on, an Apple developer team with the App Attest capability, and
the server running where the phones can reach it. Build and install steps are in
`apps/mobile/README.md`.

## Where NEAR fits

| NEAR piece                                 | Job in TAIL                                                                                                             | Code                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Rust contract with `env::ed25519_verify`   | Holds stakes; applies only enclave-signed verdicts, in order; checks the VRF reveal; refunds if the referee goes silent | `contracts/tail`                             |
| OutLayer (Intel TDX) on `outlayer.testnet` | The referee: sealed match state, the verdict signing key, VRF, the Handler call                                         | `crates/referee-wasi`, `crates/referee-core` |
| NEAR AI Cloud                              | The Handler's lines, from a model in a TEE; the response signature is logged                                            | `crates/referee-wasi/src/voice.rs`           |
| Named sub-accounts with function-call keys | Each player's account holds only a key that can join, leave and withdraw                                                | `apps/server/src/near.ts`                    |
| NEP-141 token (`usdc.fakes.testnet`)       | Stakes, heads and payouts                                                                                               | `contracts/tail`                             |
| Merkle roots on-chain                      | Checkpoints every minute and at End; the replay checks against them                                                     | `contracts/tail`, `apps/web/src/verify`      |

## What this does not claim

- **Not proven GPS.** Apple does not attest the GPS chip. We claim: our real app, on a real
  iPhone, two phones in mutual radio contact, and physically plausible movement.
- **Not trustless.** The referee is trusted because its code runs in a measured enclave and every
  call has a public attestation record. OutLayer's own governance is still early (their docs say
  so). The verdict key belongs to the OutLayer project, so a new version of the project could
  sign; the attestation record per verdict is how you would catch it.
- **Not a full defence against relaying.** An accomplice relaying Bluetooth both ways live, plus
  location spoofing on an attested phone, could fake proximity. There is no distance bounding.
- **Foreground only.** The app must stay open; pocket mode turns the screen off with the
  proximity sensor while the app keeps running.

## Status

| Part                                                                           | State                                                                                                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wire formats (TS + Rust)                                                       | Done; golden vectors shared by both                                                                                                              |
| Rules engine and simulator                                                     | Done; 18 scripted scenarios and a 12-player, 60-minute stress run                                                                                |
| Enclave referee on OutLayer testnet                                            | Deployed; a 3-player ghost match passed end to end. Testnet calls time out since 2026-11-12, so the contract pins the local test referee for now |
| NEAR contract on testnet                                                       | Deployed; two independent security reviews, all findings fixed                                                                                   |
| Server (relay)                                                                 | Done; ghost matches pass on testnet; runs locally (not deployed)                                                                                 |
| Web replay                                                                     | Done; runs locally                                                                                                                               |
| iPhone app                                                                     | Runs on two iPhones; matches settle on testnet with the local test referee                                                                       |
| Two-phone Bluetooth test on real iPhones                                       | Run indoors (2026-11-12): a Tag landed from the phones' Bluetooth contact. Range, pocket and outdoor tests **not run yet**                       |
| Offline Protocol mesh carry (batches hop through nearby phones without signal) | In the app behind a setting; no mesh node yet, so not exercised                                                                                  |
| Sponsor-funded public matches (Sputnik DAO)                                    | Contract supports sponsors; no DAO flow                                                                                                          |

Measured on testnet (2026-11-12): a game tick takes 2.9 s at the median and 6.7 s at p95, of
which about 1.5 s is inside the enclave; an `apply` of one verdict burns about 2 Tgas; an
OutLayer call costs about $0.001.

## Repository

```
packages/protocol    wire formats, crypto and golden vectors (TypeScript)
crates/tail-protocol the same in Rust, pinned by the same vectors
crates/referee-core  the rules engine: pure and deterministic
crates/referee-sim   scripted matches through the engine
crates/referee-wasi  the OutLayer enclave module
crates/appattest     App Attest assertion checks (Rust)
contracts/tail       the NEAR contract
apps/server          the relay: Bun, Hono, SQLite
apps/web             the replay: React, MapLibre, deck.gl
apps/mobile          the iPhone app: Expo, React Native, Swift modules
packages/appattest   App Attest attestation checks (TypeScript)
packages/brand       logo, colours, icons
packages/log         logging with secret redaction
```

## Prior work and dependencies

- **chainSpeed** (our earlier project): ideas only; no code was reused.
- **Palantiny** (our earlier research): showed that phones rotate their Bluetooth address about
  every 15 minutes, which led to the rotating-token beacon; no code was reused.
- **Offline Protocol SDK** (`@offline-protocol/mesh-sdk`, AGPL-3.0): a dependency of the iPhone
  app for the mesh carry path.
- Map data © OpenStreetMap contributors; tiles by OpenFreeMap; type is Archivo (SIL OFL).

## License

AGPL-3.0-only. See `LICENSE`.
