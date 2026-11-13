# TAIL replay

A web page that replays a finished TAIL match on the park it was played in, in 3D, and checks
in the browser that every tag, hint and payout is the one the referee signed and NEAR settled.

It opens as a short film: the place and the match line come up large over the park and hand
over to the corner title, then the film runs 30x through the quiet stretches, easing to real
time around each tag while the lock line between hunter and target pulls taut, the tag flashes
on the spot and the target's head counts across to the hunter in the roster. At the end the map
dims and the final standings come up: everyone in order, their final head counted up from the
stake, what they won or lost, and how each one went out, with Watch again and What was checked.
Space pauses, the timeline scrubs, a tick jumps to its moment, a player or line opens the
details sheet, Esc closes it.

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

| URL                                 | Shows                                                         |
| ----------------------------------- | ------------------------------------------------------------- |
| `/` or `/?fixture=boston-common`    | the fixture, with trails                                      |
| `/?fixture=boston-common-no-trails` | the same match without released batches                       |
| `/?fixture=boston-common-tampered`  | one Tag verdict rewritten after signing                       |
| `/?match=<32 hex>`                  | a real match from the relay's `GET /replay/:id`               |
| `&relay=<url>`                      | which relay to read (default `VITE_RELAY_URL`, else `/relay`) |
| `&t=<seconds>`                      | open the film at that moment                                  |
| `&gl=0`                             | force the flat 2D map (what browsers without WebGL 2 get)     |

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
whole: every verdict is "Doesn't match NEAR". Publishing a new referee build or key means adding
it here.

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

| Check                             | How                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each verdict is the referee's     | `ed25519.verify(sig, verdictDigest(payload), refereePk)`, seq numbered 1, 2, 3… with no gaps                                                                                                                                                                                                                                                                           |
| Each verdict is in the match log  | the log holds `Verdict{seq, digest}` with the same digest                                                                                                                                                                                                                                                                                                              |
| The log adds up                   | the RFC 6962 root of the log at every Checkpoint/End size equals the root that verdict claims; leaves are hashed over the bytes as sent                                                                                                                                                                                                                                |
| NEAR holds the same log           | `get_roots` over NEAR RPC (view call): the k-th checkpoint and the final root equal the bundle's. A verdict is "Matches NEAR" when the first root NEAR stored after its log entry is the bundle's                                                                                                                                                                      |
| NEAR knows this match             | `get_match` on the pinned contract: same referee key, VRF key, players, token and stake; Start's ring commit and times, End's VRF reveal                                                                                                                                                                                                                               |
| Nothing left out                  | the bundle holds every checkpoint NEAR stored and, once ended, exactly `seq` verdicts; otherwise the match fails as a whole                                                                                                                                                                                                                                            |
| Payouts                           | replaying the verdicts like the contract (hints, tags, forfeits, sponsor split) gives each player's `paid`; before NEAR ends the match this is shown as not checked                                                                                                                                                                                                    |
| The draw was fair                 | `ringCommit(vrfSignature)` equals Start's commit, `ed25519.verify(vrfSignature, utf8(alpha), vrfPk)`, the alpha's seed is this match id; the page rebuilds the ring itself and compares the relay's copy when one is sent                                                                                                                                              |
| Trails come from the log          | each declassified batch's SHA-256 (of its bytes as sent) equals the log's `Batch{player, seq}` hash. Its `prev` link must name the predecessor the log holds; when the log lacks it the link is counted as unchecked. Only batches in the log are drawn                                                                                                                |
| The referee followed the tag rule | from the hunter's released Strike batch, epoch e: the log holds ≥ 4 `Contact` entries for the pair in (e − 8, e], one in e or e − 1, all before the Tag, and the target was the hunter's target. This counts the referee's Contact entries, not the phones' sightings                                                                                                  |
| Handler lines                     | SHA-256 of the quoted text equals the `HintReceipt` text hash in the log                                                                                                                                                                                                                                                                                               |
| Handler chat signature            | the receipt's ECDSA signature, Ethereum `personal_sign` over `model:sha256(req):sha256(resp)`, recovers (secp256k1 + keccak-256) to the logged `signing_address`, for the quoted model. It shows that address signed those hashes; it does not show the address is a TEE key, nor tie the response hash to the quote. Needs `signedText` in the bundle's handler entry |
| Which referee                     | NEAR's `referee_pk` for the match against the pinned enclave and local keys (never the bundle's `referee.kind`). "Enclave" only for a verdict whose record, read from the pinned OutLayer API, names its call and an `executed_wasm_sha256` in the pinned list                                                                                                         |

Marks: **Matches NEAR** (every check passed and NEAR holds the same root), **Signed, not on
NEAR** (every local check passed, but NEAR has no such match or could not be reached),
**Doesn't match NEAR** (a check failed; the event still plays). The tamper tests in
`test/verify.test.ts` flip every byte of a Tag verdict, a log entry and a batch in turn and
assert each one fails.

## The fixture

`makeFixtures()` in `scripts/fixture.ts` builds a valid bundle for a five-player, twenty-minute match on Boston
Common: players walk the park's real paths (`scripts/data/common-paths.json`, from OpenStreetMap
via `scripts/fetch-paths.ts`), phones report every 5 s with real beacon tokens and hash-chained
borsh batches, contacts come from who was within Bluetooth range, and the log, roots and
verdicts are built in the referee's tick order. The story: Eli asks the Handler twice, Ana
tags Bo by the Frog Pond carousel, Cy's phone goes dark near the Central Burying Ground and
forfeits to Ana, and Eli tags Ana near the Parkman Bandstand.

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
- The relay's bundle does not carry the Handler's signed text yet, so on real matches the model
  signature shows as not checked; the fixture carries it, signed with a public test key.
- Whether OutLayer's API answers a browser (CORS) has not been tried; an unreadable record is
  shown as such and no enclave is claimed.
- The phones' App Attest assertions are not re-checked here; the declassified batches do not
  carry them.
- Private replays need a player's NEAR key to answer the relay's challenge; this page has no
  wallet, so it shows who can watch instead.
- deck.gl 9.4 reads `map.transform`, which MapLibre 6 moved onto its camera; `Scene3D.tsx`
  exposes it until deck.gl catches up.
- The flat 2D map draws the source's z14 tiles without labels.

## Credits

Map data © OpenStreetMap contributors, tiles by OpenFreeMap. Type: Archivo (SIL OFL). Brand
colours, the Trail mark and the game icons come from `@tail/brand`.
