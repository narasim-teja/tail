# TAIL replay

A web page that replays a finished TAIL match on the park it was played in, in 3D, and checks
in the browser that every tag, hint and payout is the one the referee signed and NEAR settled. It
re-runs the replay the contract runs at the end: money only becomes withdrawable after the
contract has replayed and checked the whole match.

It opens as a short film: the place and the match line come up large over the park and hand
over to the corner title, then the film runs 30x through the quiet stretches, easing to real
time around each tag while the lock line between hunter and target pulls taut, the tag flashes
on the spot and the target's head counts across to the hunter in the roster. At the end the map
dims and the final standings come up: everyone in order, their final head counted up from the
stake, what they won or lost, and how each one went out, with Watch again and What was checked.
Space pauses, the timeline scrubs, a tick jumps to its moment, a player or line opens the
details sheet, Esc closes it.

**Economy** (under the roster, or `&view=economy`) swaps the roster for the match's money,
synced to the playhead: the hint pool, the hint price, every player's head on one shared scale
(small multiples; the player you pick is persimmon, everyone else neutral), and each transfer as
it lands (winner ← loser's head + the hint credit the pool owed the loser, then End's payout of the
pool to the survivors), each with its verdict's mark. **Whole match in 1 min** plays the match at
duration ÷ 1 minute (60× for the economy fixture). Every figure comes from the signed verdicts in
the bundle, applied in order as the contract applies them (`src/model/economy.ts`); there is no
other data path. The price chart is the demand multiplier (1× to 4× the base price) rebuilt from
each Hint verdict's `tMs` with `demandBps`/`recentHints` from `@tail/protocol`, with a dot for what
each hint actually paid (its amount ÷ the base price). A bundle whose Hint verdicts carry no time
(v1) shows hints bought per 5 minutes instead.

Pages with no film to play (loading, private, not finished, missing, broken) carry the Chase,
the brand's ambient scene: the Trail mark tailing a target round a dotted zone, drawn from the
same `@tail/brand` geometry as the phone app. Reduced motion holds it still and skips the
cold open.

Screenshots of every state at phone, laptop and TV sizes are generated, not committed: run
`bun apps/web/scripts/shots.ts <url>` against a dev or preview server (they land in
`screenshots/`, which is ignored).

## Run it

From the repo root, after `bun install`:

```sh
cd apps/web
bun run dev                     # http://localhost:5173, plays the Boston Common fixture
```

`dev`, `build` and `preview` first run `scripts/make-fixture.ts`, which writes the fixture
bundles to `public/fixtures/` (generated, ignored by git). The bundles come from the pure
`makeFixtures()` in `scripts/fixture.ts`; the tests build them in memory from the same function,
so `bun test` needs no generated files.

The fixture is a generated match, not a real one (see below). Other URL options:

| URL                                    | Shows                                                         |
| -------------------------------------- | ------------------------------------------------------------- |
| `/` or `/?fixture=boston-common`       | the fixture, with trails                                      |
| `/?fixture=boston-common-no-trails`    | the same match without released batches                       |
| `/?fixture=boston-common-tampered`     | one Tag verdict rewritten after signing                       |
| `/?fixture=boston-common-tampered-log` | history rewritten behind a checkpoint (consistency fails)     |
| `/?fixture=boston-common-refunded`     | signed, but End names a hint's target wrongly: refunded       |
| `/?fixture=boston-common-v1`           | the same match as recorded before protocol v2 (read only)     |
| `/?fixture=boston-common-economy`      | 12 players, 60 minutes, from the Rust engine (see below)      |
| `&view=economy`                        | open on the economy view                                      |
| `/?presence=<proof>` or `/?presence`   | the presence proof page: check one, or paste one              |
| `/?match=<32 hex>`                     | a real match from the relay's `GET /replay/:id`               |
| `&relay=<url>`                         | which relay to read (default `VITE_RELAY_URL`, else `/relay`) |
| `&t=<seconds>`                         | open the film at that moment                                  |
| `&gl=0`                                | force the flat 2D map (what browsers without WebGL 2 get)     |

### Against a relay

```sh
RELAY_URL=http://localhost:8787 bun run dev   # proxies /relay/* to the relay
open "http://localhost:5173/?match=<match id>"
```

The relay does not send CORS headers today, so a page on another origin cannot read it. In
development the Vite proxy covers that; in production either serve `dist/` from the relay's
origin, or set `VITE_RELAY_URL` at build time and have the relay allow the page's origin.

Other build-time settings: `VITE_TAIL_CONTRACT` (default `tail.tail-dev-a38d13.testnet`; the
contract every replay is checked against, and its network follows from its name),
`VITE_NEAR_RPC_TESTNET` (default `https://test.rpc.fastnear.com`).

### What the page trusts

`src/verify/pins.ts` holds everything the bundle is checked against; none of it is read from the
bundle, so a relay running its own contract copy, referee or OutLayer mirror cannot earn a mark:

| Pin                    | Value                                                                            |
| ---------------------- | -------------------------------------------------------------------------------- |
| contract, network      | `VITE_TAIL_CONTRACT` at build time, else `tail.tail-dev-a38d13.testnet`, testnet |
| OutLayer API           | `https://testnet-api.outlayer.ai` (testnet), `https://api.outlayer.ai` (mainnet) |
| enclave referee key    | `e1c64271f1d5370eef04929835bbc60aab9ddef5b92f092217d287198a7d6c56`               |
| local test referee key | `d35338a9a4636d104deca3291c588cd9a7369c0b957b284b68be8ce64d286594`               |
| published referee wasm | `20446c643bd4b1cc8a017669596ed361506ad557c99464ecfe19beead6d08664`               |

A bundle that names another contract or network, or (for `?match=`) another match id, fails
whole: the header names the reason ("Names another contract", "Names another network", "Not the
match in the link") and nothing in it is compared with NEAR. Publishing a new referee build or
key means adding it here.

### Build, test, screenshots

```sh
bun run --filter @tail/web typecheck
bun test apps/web                          # verification, tamper and model tests
cd apps/web && bun run build                # fixtures, then the static site in dist/
bun apps/web/scripts/make-fixture.ts       # write the fixtures without building
bun apps/web/scripts/shots.ts http://localhost:5173/   # every state at 390, 1440 and 1920 wide
```

## What the page checks, and how

The bundle from the relay is untrusted. `src/verify/` is pure (no DOM, no network) and runs the
same in the browser and under `bun test`. Checks run one verdict per animation frame while the
film plays, so each event's mark appears when its own checks have run.

| Check                                                  | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each verdict is the referee's                          | `ed25519.verify(sig, verdictDigest(payload), refereePk)` (domain `tail/verdict/v2`; a v1 bundle uses its own v1 digest), seq numbered 1, 2, 3… with no gaps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Verdict history is one unbroken chain, same as on NEAR | v2: every verdict's `prev` is the digest of the one before, zeros for the first (`verdictChainBreak`), and the last digest equals the contract's `get_verdict_head(match_id)`. A contract without that view, or no match on NEAR, reads "not compared"; the links are still checked                                                                                                                                                                                                                                                                                                                                                                                                       |
| Each verdict is in the match log                       | the log holds `Verdict{seq, digest}` with the same digest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| The log adds up                                        | the RFC 6962 root of the log at every Checkpoint/End size equals the root that verdict claims; leaves are hashed over the entries' bytes as sent, and every leaf hash the bundle sends must be its entry's                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Each checkpoint extends the previous one               | for each pair of successive anchored roots (NEAR's `get_roots` when NEAR answered, else the signed ones), an RFC 9162 consistency proof is built from the bundle's leaves (the frontier prover, equal to `consistencyProof`) and checked with `verifyConsistency`. It holds only if the log at the earlier checkpoint is a prefix of the later one: nothing was rewritten. The v2 contract checks the referee's own proof on-chain before it stores each checkpoint                                                                                                                                                                                                                       |
| NEAR holds the same log                                | `get_roots` over NEAR RPC (view call): the k-th checkpoint and the final root equal the bundle's. A verdict is "Matches NEAR" when the first root NEAR stored after its log entry is the bundle's                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| NEAR knows this match                                  | `get_match` on the pinned contract: same referee key, VRF key, players, token and stake; Start's ring commit and times, End's VRF reveal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Nothing left out                                       | the bundle holds every checkpoint NEAR stored and, once ended, exactly `seq` verdicts; otherwise the match fails as a whole                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Settlement                                             | v2: the contract's End replay, re-run in the browser (`src/verify/settle.ts`, `replaySettlement` from `@tail/protocol`): the ring rebuilt from End's VRF signature (`ringOrder`), then every Hint, Tag and Forfeit in order against End's `hintTargets`. Each hint must be about its asker's current target, each Tag and Forfeit must follow the ring, each credit must be the hint money paid onto that player, and the pool must end at 0. Passing, the match pays out; failing, it reads "Refunded: rule violation" with the contract's words for the broken rule, and every head ends at the stake. Not run when a verdict isn't the referee's or there is no End. v1: doesn't apply |
| Payouts                                                | the heads as the contract moves them during play (a hint into the pool, a credit onto the loser, the loser's head to the winner), then End's outcome: survivors credited what the pool owes them plus the sponsor split, or every stake back. Compared with `get_match`'s `paid`, and with `settled_as` and `violation` when the contract reports them; before NEAR ends the match this is shown as not checked. v1: hints paid their target directly, and only `paid` is compared                                                                                                                                                                                                        |
| The draw was fair                                      | `ringCommit(vrfSignature)` equals Start's commit, `ed25519.verify(vrfSignature, utf8(alpha), vrfPk)`, the alpha's seed is this match id; the page rebuilds the ring itself and compares the relay's copy when one is sent                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Trails come from the log                               | each declassified batch's SHA-256 (of its bytes as sent) equals the log's `Batch{player, seq}` hash. Its `prev` link must name the predecessor the log holds; when the log lacks it the link is counted as unchecked. Only batches in the log are drawn                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| The referee followed the tag rule                      | v2: the `Evidence` entry logged just before the Tag names the same hunter and target, and its contact epochs are distinct, in (e − 8, e] for the strike epoch e, at least 4, one in e or e − 1, none before the hunter was assigned this target (the epoch after the `Tick` of the hunter's last win), each a `Contact` entry for the pair logged before the Tag; the target was the hunter's target; when the strike batch was released, it carries the Strike in epoch e. v1: the same rule from the hunter's released Strike batch and the logged contacts. Both check the referee's entries, not the phones' sightings                                                                |
| Contacts behind a tag                                  | each cited `Contact` entry's Merkle inclusion path to the first anchored root that covers it, verified in the browser (`merkleVerify`); "Check on NEAR" calls the contract's `verify_inclusion` view over RPC so NEAR checks the same path itself                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Presence proofs                                        | "Make presence proof" on a contact window builds a `PresenceProof` (the Contact entry, its index, an anchored size, the path, the two accounts). `/?presence=` checks one with `verifyPresence` against the roots and player list read from the pinned contract over RPC, never from a relay; a proof naming another contract fails                                                                                                                                                                                                                                                                                                                                                       |
| The log stayed private during play                     | v2: every `Contact`, `HintReceipt` and `Evidence` entry ends in `logSalt(K_log, index)`, K_log = HKDF(K_m, "tail/log"), with K_m from the bundle's `reveal.kM` (`badLogSalts`). The referee releases K_m only with the log after End, so during play the relay could not hash guesses of these entries against its leaves. No `kM`: not checked. v1 logs had no salts                                                                                                                                                                                                                                                                                                                     |
| Devices                                                | v2: each player's `Enrolled` log entry; `attested: false` is labelled "test player (no Apple attestation)" on the player and on every verdict involving them. The relay's `devices` list is not used here (`tail-verify` uses it to re-check App Attest assertions)                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Handler key's hardware                                 | the "Verified" panel under a Handler line fetches NEAR AI's attestation report for the model with a fresh 32-byte nonce (`src/verify/nearai.ts`, `nearai-live.ts`) and checks the Intel TDX quote with dcap-qvl against Intel-signed collateral (through Phala's cache, which sends CORS headers), the signing address and nonce in its report data, and `mr_config_id` against the container manifest. NVIDIA's NRAS refuses browsers, so the GPU row comes from `public/nearai-attestation.json`, the saved output of `scripts/verify-nearai.ts`, with its date. It checks NEAR AI's current key, and says whether the line's logged address is that key                                |
| Handler lines                                          | v1: SHA-256 of the quoted text equals the `HintReceipt` text hash. v2: the words were sealed to the asker, so the bundle has none and the page doesn't quote them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Handler chat signature                                 | the receipt's ECDSA signature, Ethereum `personal_sign` over the bundle's `signedText` (`model:sha256(req):sha256(resp)`), recovers (secp256k1 + keccak-256) to the logged `signing_address` (and, for v1, names the quoted model). It shows that address signed those hashes, not that the address is a TEE key (the next row checks that) nor that the response hash is any quote                                                                                                                                                                                                                                                                                                       |
| Which referee                                          | NEAR's `referee_pk` for the match against the pinned enclave and local keys (never the bundle's `referee.kind`). "Enclave" only for a verdict whose record, read from the pinned OutLayer API, names its call and an `executed_wasm_sha256` in the pinned list                                                                                                                                                                                                                                                                                                                                                                                                                            |

A broken verdict chain, a head that isn't NEAR's or a failed consistency link fails the match
as a whole, like a left-out checkpoint.

A bundle recorded before protocol v2 (`version: 1`) is still read, labelled "Recorded before
protocol v2": its verdicts have no `prev` and its tags no Evidence entry, so the chain and
evidence checks say they don't apply. Its hints named their target and paid it at once, and its
tags, forfeits and End carry no credits or hint targets; the page keeps that shape (`VerdictV1`)
and says no settlement replay ran.

Marks: **Matches NEAR** (every check passed and NEAR holds the same root), **Signed, not on
NEAR** (every local check passed, but NEAR has no such match or could not be reached), **Fails a
check** (a check failed here; the event still plays), which the details sheet words as **Doesn't
match NEAR** only when NEAR was asked and holds something else. The header line counts failures
the same way ("2 verdicts fail a check"). The match's checks are badges, each named for exactly
what it checked: "Signed by the referee", "Verdict history is one unbroken chain" (", same as on
NEAR" only when NEAR's head was read and compared), "Each checkpoint extends the previous one",
"Ran the published code in the enclave" (only for an enclave-pinned match), "The log adds up",
"Matches NEAR", "The draw matches its commitment", "Trails come from the log", "The referee says it
checked every phone's Apple attestation" (or "… skipped some phones' …": the log's record, not
Apple's attestation), "Log salts come from the match key" (with who held that key) and "Handler
chats are signed". The tamper tests in
`test/verify.test.ts` flip every byte of a Tag verdict, a log entry and a batch in turn and
assert each one fails; `test/v2.test.ts` covers the verdict chain, consistency, tag evidence,
presence proofs, unattested players, both tampered fixtures and the v1 bundle;
`test/settle.test.ts` covers the settlement replay, both refunded variants and the comparison
with NEAR's `settled_as` and `paid` (against a contract view built from the contract's rules in
`test/chain.ts`).

## The fixture

`makeFixtures()` in `scripts/fixture.ts` builds a valid bundle for a five-player, twenty-minute match on Boston
Common: players walk the park's real paths (`scripts/data/common-paths.json`, from OpenStreetMap
via `scripts/fetch-paths.ts`), phones report every 5 s with real beacon tokens and hash-chained
borsh batches, contacts come from who was within Bluetooth range, and the log, roots and
verdicts are built in the referee's tick order, in protocol v2: verdicts chained by `prev`, a
`Tick` entry opening every tick, an `Enrolled` entry per player at start, an `Evidence` entry
before each Tag, the leaf hashes beside the log, and Handler lines as signed text only. Money
moves as the referee and contract move it: a hint pays into the hint pool without naming its
target, a Tag or Forfeit carries the hint money paid onto its loser as `credit`, and End lists
each hint's target. The story: Eli asks the Handler twice about Ana, Ana tags Bo by the Frog Pond
carousel, Cy's phone goes dark near the Central Burying Ground and forfeits to Ana, Eli tags Ana
near the Parkman Bandstand (her head carries his two hints), and Eli asks once about Dee, which
End credits to her.

Variants: without trails; **tampered**, where the second Tag was rewritten to credit Dee and keeps
the old signature (its signature and the verdict chain fail there); **tampered-log**, where the
referee changed a Contact entry logged between the 4th and 5th checkpoints after signing the 5th
and signed every later checkpoint over the new log (every signature and the chain hold, but the
consistency links 4→5 and 5→6 fail, and so does the 5th checkpoint's root); **refunded**, signed,
chained and logged like the honest match, but End names Bo as the target of Eli's first hint, so
the settlement replay finds "event 0: a hint was not about its asker's target" and every stake
is refunded; and **v1**, the same match in the pre-v2 format. The tests also build one whose
second Tag is signed for Dee, who was hunting Eli, which the replay refunds as off the ring.

### The economy fixture

`boston-common-economy` is not built by `fixture.ts`: it is a 12-player, 60-minute match played
through the real engine (`referee-core`) by `crates/referee-verify/examples/economy-bundle.rs`,
with `referee-sim`'s phones (real tokens, hash chains and App Attest assertions). Scripted walkers
wander the Common's paths, buy hints in four waves (so the price climbs to its 4× cap in the third
and falls back), and hunt along the ring: a hunter closes in, shadows its target until the lock
fills and strikes. One phone goes dark and one player walks out of the zone; both forfeit. Seven
tags, two forfeits, three survivors. `scripts/economy-fixture.ts` (run by `make-fixture.ts`) needs
`cargo`; it plays the match again only when the example binary is newer than the file (about a
minute in a debug build), and skips it without cargo. Its Handler lines are templates, so their
receipts are unsigned. Check it the way you would a real match:

```sh
cargo run -q -p referee-verify --bin tail-verify -- apps/web/public/fixtures/boston-common-economy.json
```

**The referee, VRF and Handler-model keys in the fixture are public test keys** derived from
strings in the script. They were never used on NEAR, the bundle names no transactions, and the page labels it
"Fixture" and "Not on NEAR". The Handler lines in it were written by hand, not by a model.

## Known limits

- Trails appear only after End: the server then asks the referee to open the match's stored
  batches and keeps those whose hash is in the log. A replay opened before that (or of a match
  whose batches were not released) plays events, heads and locks without trails.
- Event times come from the log's order (batch times, contact epochs and checkpoint minutes);
  without trails they are good to about a tick (10 s).
- Transactions are linked to the explorer, not fetched. NEAR's agreement is established from
  contract state (`get_match`, `get_roots`), which covers every verdict.
- v1 bundles don't carry the Handler's signed text, so their model signatures show as not
  checked. v2 bundles carry it but not the words, which only the asker's phone could read.
- "Check on NEAR" and the verdict head need the contract's `verify_inclusion` and
  `get_verdict_head` views; against a contract deployed without them the page says so and
  checks the path and the chain itself only.
- Presence proofs rest on the referee's signature over the anchored root, and say that the
  referee logged a contact: the phones' sightings behind it stay sealed.
- Whether OutLayer's API answers a browser (CORS) has not been tried; an unreadable record is
  shown as such and no enclave is claimed.
- On a refund the page checks that every player's `paid` is their stake; what each sponsor got
  back is not compared (`get_match` lists sponsors' contributions, not their refunds).
- Whom a v2 hint was about comes only from End's `hintTargets`, so it is shown only for a match
  that has ended (the only kind this page replays).
- The phones' App Attest assertions are not re-checked here, and contact is not recomputed from
  the sightings: the bundle carries the assertions and device keys, and `tail-verify`
  (`crates/referee-verify`) re-runs both.
- Private replays need a player's NEAR key to answer the relay's challenge; this page has no
  wallet, so it shows who can watch instead.
- deck.gl 9.4 reads `map.transform`, which MapLibre 6 moved onto its camera; `Scene3D.tsx`
  exposes it until deck.gl catches up.
- The flat 2D map draws the source's z14 tiles without labels.

## Credits

Map data © OpenStreetMap contributors, tiles by OpenFreeMap. Type: Archivo (SIL OFL). Brand
colours, the Trail mark and the game icons come from `@tail/brand`.
