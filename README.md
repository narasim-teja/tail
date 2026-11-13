# TAIL

A real-world game of tag where every tag comes with proof.

Location games get spoofed, because anyone can fake GPS. In TAIL a tag only counts when two real
iPhones heard each other over Bluetooth. A referee judges that from both phones' sealed,
signed reports, signs the result, and a NEAR contract settles the money. The referee is built to
run in a hardware enclave (Intel TDX, on OutLayer). There, the relay that runs the game sees no
positions and cannot forge a tag.

**Right now the live contract pins a local test referee, not the enclave.** That is the same
referee code running on our machine, because OutLayer testnet stopped running calls on
2026-11-12. While it is pinned, trust in the referee is trust in us, and the replay labels its
matches "test referee".

Built for the NEAR hackathon. Everything runs on NEAR testnet. What each proof shows and where it
stops is in [ARCHITECTURE.md](ARCHITECTURE.md).

## The game in one breath

Everyone stakes money on their own head and gets one secret target. Get within Bluetooth range of
your target and stay there until your **lock** fills, then **strike**: their head moves to you,
and their target becomes yours. Your target feels **heat** rising but can't see who. Hints from
the Handler cost you money, paid onto your target's head. When time runs out, survivors keep
their heads.

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
- **Unguessable tokens.** A token is an HMAC of the epoch under a per-player key that only the
  player and the referee hold. To everyone else, other players included, tokens are noise.
- **Real devices.** At enrolment the referee checks the phone's Apple App Attest attestation
  itself, against Apple's root (in this code; the OutLayer build now active predates it). Every batch then carries an App Attest assertion from that key.
  Batches with a simulated location are refused. A test player without an attestation is
  recorded as one, and the replay says so.
- **Which code signed.** Each verdict names the OutLayer call that produced it. That call's
  public attestation record names the wasm build that ran, and the replay compares it with the
  published hash. The local test referee has no such record, and the replay says "test referee".
- **Fair targets.** The ring of targets comes from a VRF. It is committed at Start and revealed at
  End, and the contract checks the VRF signature and the commitment.
- **One history.** Every accepted batch, refusal, contact and verdict goes into a Merkle log. Its
  root is anchored on NEAR every minute and at End. Each verdict names the digest of the one
  before it. The upgraded contract also checks a consistency proof for each new root, and checks
  at End that every tag followed the ring. That upgrade is in the code, but not on the live
  contract yet (see Status).

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

- 498 Bun tests: protocol and helper packages 75, web replay 90, relay 129 (one plays a whole
  match through the relay against the real local test referee), iPhone app 204;
- 114 Rust workspace tests, including the golden vectors that pin the TypeScript and Rust wire
  formats to the same bytes, Merkle consistency proofs for every 0 < m ≤ n ≤ 70, App Attest on
  a real iPhone capture, and 30 tests over 26 scripted matches and random 12-player runs;
- 210 contract tests, covering money, abuse, the verdict chain, proofs and the ring check.

The referee module's own tests (`cd crates/referee-wasi && cargo test`, 31 tests) are not in the
gate.

### 2. Watch a verified replay

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
- each tag's logged evidence against the lock rule, with Merkle paths;
- the log salts, the Handler's model signature, and each trail against the log.

It does not re-check the phones' App Attest assertions, which the replay does not carry.

- Open `/?fixture=boston-common-tampered`: one Tag verdict was rewritten after signing. The page
  reports "Verdict history is broken" and marks the tag "Doesn't match NEAR".
- Open `/?fixture=boston-common-tampered-log`: the referee rewrote a contact behind the 5th
  checkpoint and re-signed every later one. Every signature still holds, but the consistency
  proofs 4→5 and 5→6 fail, and the page reports "The log was rewritten".
- Click a tag, open one of its contact windows, choose "Make presence proof", and open the link.
  `/?presence=` checks a proof that two players were near each other against roots and players
  read from the pinned contract over RPC. For the fixture it answers "NEAR has no such match",
  because the fixture never went to NEAR.
- The fixtures are signed with public test keys and were never sent to NEAR, so their header
  reads "Not on NEAR". A real match (`/?match=<id>` against a running relay) is compared with the
  contract's on-chain roots, verdict head and payouts.

### 3. Play a match on testnet with ghost phones

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
command also needs OutLayer testnet to run calls again. The three
passing runs in `apps/server/README.md` (2026-11-12, about 0.43 testnet NEAR and $0.05 of
OutLayer each) were protocol v1, on OutLayer.

Ghosts are a testing door. They have no Apple attestation, so the referee enrols them only with
`ALLOW_UNATTESTED=1` and logs them as unattested. The relay makes them only on testnet with
`ALLOW_GHOSTS=1`, in-process: no HTTP route enrols one, and the host's signed
`POST /dev/ghosts/fill` seats one made on the spot. Their accounts are named `ghost-…`.

### 4. Look at the deployed pieces

- Contract: `tail.tail-dev-a38d13.testnet` (see `contracts/tail/README.md`).

  ```sh
  near contract call-function as-read-only tail.tail-dev-a38d13.testnet get_config \
    json-args '{}' network-config testnet now
  ```

  `referee_pk` reads `d35338a9…6594` and `vrf_pk` `ad82f28f…defcb`: the local test referee's
  keys, pinned since OutLayer testnet stopped running calls. `get_config` has no `vrf_sender` or
  `withdraw_min_gas` field, and `get_verdict_head` does not exist. That is how you can tell the
  in-place upgrade has not been deployed. `apps/server/scripts/pin-referee.ts` puts the enclave's
  keys back.
- Referee: OutLayer project `tail-dev-a38d13.testnet/tail-referee` on testnet. Its active version
  is the protocol v1 build `20446c64…08664`. The v2 build is not uploaded. Commands, manifest
  and measured latency are in `crates/referee-wasi/README.md`.

### 5. Play on iPhones

You need two iPhones with Developer Mode on, an Apple developer team with the App Attest
capability, and the relay running where the phones can reach it. Build and install steps are in
`apps/mobile/README.md`.

## Where NEAR fits

| NEAR piece                                 | Job in TAIL                                                                                                                                                                                              | Code                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Rust contract with `env::ed25519_verify`   | Holds stakes; applies only referee-signed verdicts, in order; checks the VRF reveal; refunds if the referee goes silent. After the upgrade: the verdict chain, consistency proofs, the ring check at End | `contracts/tail`                             |
| `env::sha256` in the contract              | Verifies RFC 9162 consistency proofs and, in the `verify_inclusion` view, Merkle audit paths (after the upgrade)                                                                                         | `contracts/tail`, `crates/tail-protocol`     |
| OutLayer (Intel TDX) on `outlayer.testnet` | The referee: sealed match state, the verdict signing key, VRF, the Handler call. v1 build deployed; not running calls since 2026-11-12                                                                   | `crates/referee-wasi`, `crates/referee-core` |
| NEAR AI Cloud                              | The Handler's lines from an open-weight model; the response signature is logged and re-checked in the replay                                                                                             | `crates/referee-wasi/src/voice.rs`           |
| Named sub-accounts with function-call keys | Each player's account holds only a key that can join, leave and withdraw                                                                                                                                 | `apps/server/src/near.ts`                    |
| NEP-141 token (`usdc.fakes.testnet`)       | Stakes, heads and payouts                                                                                                                                                                                | `contracts/tail`                             |
| Merkle roots on-chain                      | Checkpoints every minute and at End; the replay, the phones' receipts and presence proofs check against them                                                                                             | `contracts/tail`, `apps/web/src/verify`      |

## What this does not claim

- **Not proven GPS.** Apple does not attest the GPS chip. We claim our real app on a real iPhone,
  two phones in mutual radio contact, and physically plausible movement.
- **Not trustless.** The referee is trusted for the rules and for keeping positions secret. With
  the enclave, that trust is bounded by the attestation record of each call. OutLayer's own
  governance is still early (their docs say so). The verdict key belongs to the OutLayer project,
  so a new version of the project could sign, and the attestation record per verdict is how you
  would catch it. With the local test referee pinned now, there is no such bound.
- **Not private from the chain.** Hint, Tag and Forfeit verdicts land on NEAR during play and name
  both players. Each one reveals who hunts whom. The relay also sees timing, sizes, refusal codes
  and how many contacts each tick found (ARCHITECTURE.md, claim 12).
- **Not a full defence against relaying.** An accomplice relaying Bluetooth both ways, within
  about 30 s, plus location spoofing on an attested phone, could fake proximity. There is no
  distance bounding.
- **Foreground only.** The app must stay open. Pocket mode turns the screen off with the
  proximity sensor while the app keeps running.

## Status

| Part                                        | State                                                                                                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wire formats (TS + Rust)                    | Protocol v2; golden vectors shared by both                                                                                                                                                                                           |
| Rules engine and simulator                  | 26 scripted scenarios, random 12-player runs in the tests, and `referee-sim bench` (12 players, 60 minutes by default)                                                                                                               |
| Referee on OutLayer testnet                 | v1 build deployed; a 3-player ghost match passed end to end on 2026-11-12. Calls time out (HTTP 524) since that evening. The v2 build passes its scripts against the local test referee and is not uploaded                          |
| Local test referee                          | Pinned on the live contract; judged the 2026-11-12 iPhone matches (v1)                                                                                                                                                               |
| NEAR contract on testnet                    | Deployed code is from before this round. The v2 code (verdict chain, consistency proofs, `verify_inclusion`, ring check, `withdraw` to a named wallet) passes its 210 tests and is not deployed; the upgrade keeps state (`migrate`) |
| Contract reviews                            | The first version was security-reviewed and the findings fixed, each with a regression test (`contracts/tail/src/tests.rs`). This round's changes are not independently reviewed yet                                                 |
| Relay                                       | Protocol v2; tests pass; runs locally (not deployed)                                                                                                                                                                                 |
| Web replay                                  | Protocol v2, and reads v1 bundles; runs locally                                                                                                                                                                                      |
| iPhone app                                  | Two iPhones (17 Pro Max, 14) ran enrolment with App Attest, lobbies and a Tag from Bluetooth contact indoors on 2026-11-12 (v1). The v2 paths pass their tests and have not run on a phone                                           |
| Range, pocket and outdoor tests             | **Not run yet**                                                                                                                                                                                                                      |
| Mesh carry (Offline Protocol SDK)           | Phone to phone, with no relay node: an offline phone seals its signed request to the relay and a nearby phone posts it. Off by default behind a setting; tested only with a fake mesh; Bluetooth coexistence not measured            |
| Sponsor-funded public matches (Sputnik DAO) | The contract supports sponsors; no DAO flow                                                                                                                                                                                          |

Measured on testnet with the v1 code (2026-11-12): a game tick took 2.9 s at the median and 6.7 s
at p95, of which about 1.5 s was inside the enclave. An `apply` of one verdict burned about
2 Tgas, and an OutLayer call cost about $0.001. The v2 code is not measured on testnet.

## Repository

```
packages/protocol    wire formats, crypto, Merkle and consistency proofs, presence proofs, golden vectors (TypeScript)
crates/tail-protocol the same in Rust, pinned by the same vectors
crates/referee-core  the rules engine: pure and deterministic
crates/referee-sim   scripted matches through the engine
crates/referee-wasi  the referee: OutLayer module, or the local test referee when built natively
crates/appattest     App Attest attestation and assertion checks (Rust; runs in the referee)
contracts/tail       the NEAR contract
apps/server          the relay: Bun, Hono, SQLite
apps/web             the replay and verifier: React, MapLibre, deck.gl
apps/mobile          the iPhone app: Expo, React Native, Swift modules
packages/appattest   App Attest attestation checks (TypeScript; the relay's own check)
packages/brand       logo, colours, icons
packages/log         logging with secret redaction
```

In the iPhone app, the proof machinery is kept apart from the game rules.
`apps/mobile/src/proximity/` holds the beacon, signed and chained reports, chain recovery, signed
HUDs, receipts, presence proofs and mesh carry, and imports nothing from TAIL (a test checks
that). `apps/mobile/src/tail/` holds the hunt on top of it: lock, heat, strikes, hints. This is a
code structure inside the app, not a published package or SDK. The referee's rules are not split
out the same way.

## Prior work and dependencies

- **chainSpeed** (our earlier project): ideas only; no code was reused.
- **Palantiny** (our earlier research): showed that phones rotate their Bluetooth address about
  every 15 minutes, which led to the rotating-token beacon; no code was reused.
- **Offline Protocol SDK** (`@offline-protocol/mesh-sdk`, AGPL-3.0): a dependency of the iPhone
  app for the mesh carry path.
- Map data © OpenStreetMap contributors; tiles by OpenFreeMap; type is Archivo (SIL OFL).

## License

AGPL-3.0-only. See `LICENSE`.
