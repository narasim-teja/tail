# TAIL web: the front page, the docs and the replay

The site at `/` is TAIL's front page and `/docs` its docs (below, [The front page and the
docs](#the-front-page-and-the-docs)). Everything else is the replay: a web page that replays a
finished TAIL match on the park it was played in, in 3D, and checks in the browser that every
tag, hint and payout is the one the referee signed and NEAR settled. It re-runs the replay the
contract runs at the end: money only becomes withdrawable after the contract has replayed and
checked the whole match.

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
its length ÷ 1 minute (60× for the economy fixture); the length runs to the referee's last tick
at End, so a match that ended early is not padded to its planned end. Every figure comes from the signed verdicts in
the bundle, applied in order as the contract applies them (`src/model/economy.ts`); there is no
other data path. The price chart is the demand multiplier (1× to 4× the base price) rebuilt from
each Hint verdict's `tMs` with `demandBps`/`recentHints` from `@tail/protocol`, with a dot for what
each hint actually paid (its amount ÷ the base price). A bundle whose Hint verdicts carry no time
(v1) shows hints bought per 5 minutes instead.

Pages with no film to play (loading, private, not finished, called off, deleted after the relay's
retention window, missing, broken) carry the Chase,
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
bun run dev                     # http://localhost:5173: the front page
open "http://localhost:5173/?fixture=boston-common"   # the Boston Common fixture film
```

The dev server listens on every interface, so a phone on the same network opens it at
`http://<mac>.local:5173`.

`dev`, `build` and `preview` first run `scripts/make-fixture.ts`, which writes the fixture
bundles to `public/fixtures/` (generated, ignored by git). The bundles come from the pure
`makeFixtures()` in `scripts/fixture.ts`; the tests build them in memory from the same function,
so `bun test` needs no generated files.

The fixture is a generated match, not a real one (see below). Other URL options:

| URL                                    | Shows                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `/`                                    | the front page (also with tracking tags such as `utm_source`)                                                       |
| `/docs`                                | the docs; each section has an anchor (`/docs#proof`)                                                                |
| `/?fixture=boston-common`              | the fixture, with trails (any replay option below without a `fixture` or `match` plays it too, e.g. `/?t=372`)      |
| `/?fixture=boston-common-no-trails`    | the same match without released batches                                                                             |
| `/?fixture=boston-common-tampered`     | one Tag verdict rewritten after signing                                                                             |
| `/?fixture=boston-common-tampered-log` | history rewritten behind a checkpoint (consistency fails)                                                           |
| `/?fixture=boston-common-refunded`     | signed, but End names a hint's target wrongly: refunded                                                             |
| `/?fixture=boston-common-v1`           | the same match as recorded before protocol v2 (read only)                                                           |
| `/?fixture=boston-common-economy`      | 12 players, 60 minutes, from the Rust engine (see below)                                                            |
| `&view=economy`                        | open on the economy view                                                                                            |
| `/?presence=<proof>` or `/?presence`   | the presence proof page: check one, or paste one                                                                    |
| `/dossier/<account>`                   | a player's dossier, read from the pinned contract                                                                   |
| `/?match=<32 hex>`                     | a real match: the site's published copy if `public/matches/index.json` lists it, else the relay's `GET /replay/:id` |
| `#account_id=…&nonce=…&sig=…`          | a player's one-time sign-in for a private match (below)                                                             |
| `&relay=<url>`                         | which relay to read (default `VITE_RELAY_URL`, else `/relay`), even for a published match                           |
| `&t=<seconds>`                         | open the film at that moment                                                                                        |
| `&gl=0`                                | force the flat 2D map (what browsers without WebGL 2 get)                                                           |

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
`VITE_NEAR_RPC_TESTNET` (default `https://test.rpc.fastnear.com`), and the front page's own
(below, [Settings](#settings)).

### A private match

The relay serves a private match's replay only to one of its players, who signs its challenge
with their NEAR key (`apps/server/src/routes/replay.ts`). The page holds no key, so the TAIL app
asks for the challenge, signs it on the phone and opens:

```
/?match=<32 hex>#account_id=<account>&nonce=<nonce>&sig=<sig>
```

`nonce` (32 bytes) and `sig` (64-byte ed25519 over `replayDigest(nonce, match_id, account_id)`)
are unpadded base64url, `account_id` a NEAR account id; each appears once. Anything else is
ignored as if there were no sign-in. The values sit in the fragment because a browser never
sends it to a web server, and `src/main.tsx` removes it from the address with `replaceState`
before the first render or request, so a copied or shared address carries no signature. The page
re-encodes nonce and sig as standard base64 and sends all three once, as the query
`GET /replay/:id?account_id=…&nonce=…&sig=…` reads (percent-encoded: the relay reads a bare
`+` as a space). Nothing is stored; the bundle lives in this page view's memory only.

A nonce works once, for 2 minutes. A reload, or a link without a sign-in, shows the private page
and asks a player to open the replay from the TAIL app; a sign-in the relay refuses (403) says
the link had expired or was already used. A public match's relay ignores the values.

What the sign-in proves, it proves to the relay: that whoever opened the link holds the NEAR key
the relay enrolled for one of the match's players. It proves nothing to this page about the
replay, and no trust comes from it: the bundle is checked exactly as any other, against the pins
below.

### What the page trusts

`src/verify/pins.ts` holds everything the bundle is checked against; none of it is read from the
bundle, so a relay running its own contract copy, referee or OutLayer mirror cannot earn a mark:

| Pin                    | Value                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| contract, network      | `VITE_TAIL_CONTRACT` at build time, else `tail.tail-dev-a38d13.testnet`, testnet                                                                 |
| OutLayer API           | `https://testnet-api.outlayer.ai` (testnet), `https://api.outlayer.ai` (mainnet)                                                                 |
| enclave referee key    | `e1c64271f1d5370eef04929835bbc60aab9ddef5b92f092217d287198a7d6c56`                                                                               |
| local test referee key | `d35338a9a4636d104deca3291c588cd9a7369c0b957b284b68be8ce64d286594`                                                                               |
| published referee wasm | `3f9320a61236f02f72481c2ec2b920854f22c7554924a315eebbea52aad85690` (v2), `20446c643bd4b1cc8a017669596ed361506ad557c99464ecfe19beead6d08664` (v1) |

A bundle that names another contract or network, or (for `?match=`) another match id, fails
whole: the header names the reason ("Names another contract", "Names another network", "Not the
match in the link") and nothing in it is compared with NEAR. Publishing a new referee build or
key means adding it here. The build active on OutLayer since 2026-11-13,
`092ec57c8dc0b99f815524c1a4ebe016f202ac58faec2206930140679641f694`, is not in the list yet: it has
not run a call, and a verdict it signed would show as a build that "isn't a published referee
build".

### Build, test, screenshots

```sh
bun run --filter @tail/web typecheck
bun test apps/web                          # verification, tamper and model tests
cd apps/web && bun run build                # fixtures, then the static site in dist/
bun apps/web/scripts/make-fixture.ts       # write the fixtures without building
bun apps/web/scripts/shots.ts http://localhost:5173/   # every state at 390, 1440 and 1920 wide
bun apps/web/scripts/landing-shots.ts http://localhost:5173/   # front page and docs: 390, 768, 1024, 1440; motion and reduced
bun apps/web/scripts/og-image.ts           # redraw public/og.png (after make-fixture)
```

## The front page and the docs

`/` answers two questions for a visitor arriving from a shared link: what TAIL is, and whether it
is real, in about three scrolls. `/docs` holds the rest, for a curious visitor and for a judge who
wants to check the claims. Both are their own small bundles (`src/landing/`, `src/docs-page/`): they
never load MapLibre, deck.gl or the verifier, and the replay never loads them (`src/main.tsx`
picks the page from `src/route.ts`, the one owner of which address opens what, and imports only
that page's code).

They are drawn in the phone app's design system, not a reinterpretation of it: the app's paper,
sand, ink, mute and persimmon from `@tail/brand`; Archivo at its normal width; the app's 4-point
spacing scale, radii (10, 16, 24) and text styles (12 px tracked caps with a brand icon beside
them, the 40 px head and heat numbers, the giant lock numeral); its 52-point buttons (one ink,
the rest sand) and round stepper. The lock arc, heat bar and head are `apps/mobile/src/ui/game.tsx`
redrawn at the same proportions (`src/landing/instruments.tsx`): 270° in four segments 7° apart,
a ring 24/232 of the arc wide, heat segments 22 tall, 6 apart, radius 6.

Day to dusk: the front page opens on the app's daylight paper and, as the visitor reads down, the
ground warms through noon and an evening sand, falls through a low-sun band (no text sits on it)
and lands on the replay's dusk, where the matches are listed. Every colour is derived in OKLCH
from `@tail/brand` (`src/landing/palette.ts`), and `test/landing.test.tsx` holds each text colour
to WCAG AA on each ground it is set on, the map's labels included. Persimmon is spent on the game
only: the hunter, the lock, and the STRIKE fold, which floods it as the phone's lock-full
takeover does.

- **Hero.** The line, and beside it the phone's hunt screen opened out (on a phone it stacks into
  the app's own): the top strip (target, time left), the lock arc, the head, the heat bar, and the
  map panel, all reading the same moment of a recorded match. The map is the place drawn in SVG
  from OpenStreetMap (below), with the app's marks on it: the dotted zone edge, the safehouse
  glyph, the others as soft dots with their trails fading behind, the hunter as the Trail mark on
  its paper disc turned to its heading, and the strike ring where the tag lands. The match is the
  featured published one, else the generated Boston Common fixture, labelled as generated; its
  scene is cut from the bundle by the replay's own model (`scripts/scene.ts`), including the
  hunter's lock, heat and head as they changed. It runs only on screen with the tab visible;
  Reduce Motion draws one still frame of the strike.
- **Lock and heat, Strike, Hints.** One sentence each, the instruments doing the talking. Lock and
  heat share a fold: they are one number seen from both sides, so the hunter's arc and the
  target's bar climb together. The Handler's sheet prices each hint with `hintPrice` at a 5 USDC
  stake for the demand the visitor sets (pinned by a test).
- **How it's checked.** Four steps, a line each, a link to the docs' six, and one line on where
  things stand (testnet, a test referee, iPhone only) with a link to everything not claimed.
- **Matches.** The published matches, each with how the pinned contract settled it, read live with
  `get_match` (paid out, refunded, not on NEAR, or that NEAR didn't answer). That is the contract's
  record, not the replay's checks, which run when a row is opened. With none published, the
  generated demos (`public/fixtures/demos.json`, written by `make-fixture.ts`) are offered,
  labelled as generated and not on NEAR.
- **A dossier.** One player's card, the contract's own `nft_token` media, when
  `VITE_DOSSIER_ACCOUNT` is set and NEAR returns it; otherwise the section is absent.

Everything the first screen needs (type, the match list, the scene and its map, the demos) is
fetched before the first render, so nothing moves when a font or file arrives. The browser's theme
colour follows the ground: paper, then dusk once the matches come up.

**The docs** (`src/docs-page/`) are long-form reading on the paper: how a match works (with the rules'
numbers read from `@tail/protocol`'s constants, and the Handler's sheet), the worked hunt as a
ledger (every figure from the pricing rule; the table's total never changes), the six steps of
what a tag proves with where to check each, how to check a match yourself (the replay, the
contract's views, `tail-verify`), the dossier, everything not claimed, where it stands today, and
what TAIL is built on. Every fact in them is one the root `README.md` and `ARCHITECTURE.md` state.

### The hero's map

`public/maps/<name>.json` (`src/landing/map.ts`) is one place drawn from OpenStreetMap: lawns and
gardens, water, street centre lines classed main or side, the footpaths inside the parks, where
each street's name can sit, and a few place names, in whole metres from the map's centre, with
the box the hero frames. `scripts/fetch-paths.ts` writes it from the Overpass API
(`scripts/osm-map.ts`: clipped to the box, simplified to about a metre, each shape once); the site
never fetches tiles. Boston Common's is 59 KB, 17 KB gzipped. The scene names its zone's centre,
so the hero lays the match on the map by the distance between the two centres; a map that
doesn't cover the zone, or none, draws the plain zone in the same style. Map data © OpenStreetMap
contributors (ODbL), credited at the map's corner.

A match published in another park needs that park's map: add it to `MAPS` in `fetch-paths.ts`
(its centre, the box to fetch, the box to frame, the streets and places to name), run
`bun apps/web/scripts/fetch-paths.ts --map <name>`, commit the file, and publish with
`--map <name>`.

### Published matches

`public/matches/index.json` lists the matches the site ships, newest first (it is committed empty):
`{ id, place, playedAt, players, minutes, survivors?, featured?, map? }`. Each has its bundle at
`public/matches/<id>.json` and the front page's scene of it at `<id>.scene.json`. A link
`/?match=<id>` reads a listed match from the site instead of the relay; it is checked exactly as
any other, against the pinned contract and the linked id, so the site's copy earns no trust of its
own. A list that can't be read (none deployed, or not the documented shape) sends every link to
the relay, as before.

```sh
bun apps/web/scripts/publish-match.ts <match id> --place "Boston Common" [--map <name>] [--relay <url>] [--featured]
```

It fetches the finished match from a relay (default `http://localhost:8787`), refuses a private one
(the relay's 403, or a bundle whose `publicReplay` isn't true), reads the stake token's decimals
from NEAR (`ft_metadata`, for the hero's head), writes the bundle and its scene, lists it first
(with `--featured`, it becomes the hero's match; with `--map`, it names its place's map, which
must exist), and prints what it published.
**The bundle holds every player's location trail for the whole match**, and the script says so:
once deployed anyone can download it, so publish only a match whose players agreed. No real match
has been published.

### Settings

Build-time, all optional.

| Variable               | What it does                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_SITE_URL`        | the canonical origin (default `https://playtail.app`; https only): the canonical link, `og:url`, `og:image`, the footer                                              |
| `VITE_REPO_URL`        | the source repository (default `https://github.com/narasim-teja/tail`): GitHub in the top bar and footer, the docs' links into the repo (GitHub-style `/blob/main/`) |
| `VITE_DOCS_URL`        | where Docs links to (default the site's own `/docs`)                                                                                                                 |
| `VITE_DOSSIER_ACCOUNT` | the player whose Dossier the front page shows; unset, the section is left out                                                                                        |

### Hosting

`dist/` is a static site. `public/_redirects` sends `/docs` and `/dossier/<account>` to
`index.html` for Cloudflare Pages (and Netlify), so those links open directly; every other page is
`/` with a query. `public/og.png` is the social card (`scripts/og-image.ts`, committed), named with absolute
URLs from `VITE_SITE_URL` in `index.html`.

## What the page checks, and how

The bundle from the relay is untrusted. `src/verify/` is pure (no DOM, no network) and runs the
same in the browser and under `bun test`. Checks run one verdict per animation frame while the
film plays, so each event's mark appears when its own checks have run.

| Check                                                  | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each verdict is the referee's                          | `verifyEd25519(refereePk, verdictDigest(payload), sig)` from `@tail/protocol`, strict (a non-canonical point encoding or a small-order key fails; noble's permissive ZIP-215 default is not used anywhere) (domain `tail/verdict/v2`; a v1 bundle uses its own v1 digest), seq numbered 1, 2, 3… with no gaps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Verdict history is one unbroken chain, same as on NEAR | v2: every verdict's `prev` is the digest of the one before, zeros for the first (`verdictChainBreak`), and the last digest equals the contract's `get_verdict_head(match_id)`. A contract without that view, or no match on NEAR, reads "not compared"; the links are still checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Each verdict is in the match log                       | the log holds `Verdict{seq, digest}` with the same digest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| The log adds up                                        | the RFC 6962 root of the log at every Checkpoint/End size equals the root that verdict claims; leaves are hashed over the entries' bytes as sent, and every leaf hash the bundle sends must be its entry's                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Each checkpoint extends the previous one               | for each pair of successive anchored roots (NEAR's `get_roots` when NEAR answered, else the signed ones), an RFC 9162 consistency proof is built from the bundle's leaves (the frontier prover, equal to `consistencyProof`) and checked with `verifyConsistency` against both roots. It holds only if, over this bundle's log, the log at the earlier checkpoint is a prefix of the later one; a failing link means the log changed after a checkpoint or isn't the anchored one. The v2 contract checks the referee's own proof on-chain before it stores each checkpoint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| NEAR holds the same log                                | `get_roots` over NEAR RPC (view call): the k-th checkpoint and the final root equal the bundle's. A verdict is "Matches NEAR" when the first root NEAR stored after its log entry is the bundle's                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| NEAR knows this match                                  | `get_match` on the pinned contract: same referee key, VRF key, players, token and stake; Start's ring commit and times, End's VRF reveal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Nothing left out                                       | the bundle holds every checkpoint NEAR stored and, once ended, exactly `seq` verdicts; otherwise the match fails as a whole                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Settlement                                             | v2: the contract's End replay, re-run in the browser (`src/verify/settle.ts`, `replaySettlement` from `@tail/protocol`): the ring rebuilt from End's VRF signature (`ringOrder`), then every Hint, Tag and Forfeit in order against End's `hintTargets`. Each hint must be about its asker's current target, each Tag and Forfeit must follow the ring, each credit must be the hint money paid onto that player, and the pool must end at 0. Passing, the match pays out; failing, it reads "Refunded: rule violation" with the contract's words for the broken rule, and every head ends at the stake. Not run when a verdict isn't the referee's or there is no End. v1: doesn't apply                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Payouts                                                | the heads as the contract moves them during play (a hint into the pool, a credit onto the loser, the loser's head to the winner), then End's outcome: survivors credited what the pool owes them plus the sponsor split, or every stake back. Compared with `get_match`'s `paid`, and with `settled_as` and `violation` when the contract reports them; before NEAR ends the match this is shown as not checked. v1: hints paid their target directly, and only `paid` is compared                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| The draw was fair                                      | `ringCommit(vrfSignature)` equals Start's commit, `verifyEd25519(vrfPk, utf8(alpha), vrfSignature)`, the alpha's seed is this match id; the page rebuilds the ring itself and compares the relay's copy when one is sent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Trails come from the log                               | each declassified batch's SHA-256 (of its bytes as sent) equals the log's `Batch{player, seq}` hash. Its `prev` link must name the predecessor the log holds; when the log lacks it the link is counted as unchecked. Only batches in the log are drawn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| The referee followed the tag rule                      | v2: the `Evidence` entry logged just before the Tag names the same hunter and target, and its contact epochs are distinct, in (e − 8, e] for the strike epoch e, at least 4, one in e or e − 1, none before the hunter was assigned this target (the epoch after the `Tick` of the hunter's last win), each a `Contact` entry for the pair logged before the Tag; the target was the hunter's target; when the strike batch was released, it carries the Strike in epoch e. v1: the same rule from the hunter's released Strike batch and the logged contacts (without the batch, the tag is shown as not re-checked). Both check the referee's entries, not the phones' sightings. Each tag is checked once per replay (`prepare` in `src/verify/index.ts`): a tag that breaks the rule fails its own verdict's mark ("Fails a check") and the header's count, and the summary counts every tag ("Every tag's evidence fits the lock rule", or how many break it)                                                                                                                                               |
| Contacts behind a tag                                  | each cited `Contact` entry's Merkle inclusion path to the first anchored root that covers it, verified in the browser (`merkleVerify`); "Check on NEAR" calls the contract's `verify_inclusion` view over RPC so NEAR checks the same path itself                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Presence proofs                                        | "Make presence proof" on a contact window builds a `PresenceProof` (the Contact entry, its index, an anchored size, the path, the two accounts). `/?presence=` checks one with `verifyPresence` against the roots and player list read from the pinned contract over RPC, never from a relay; a proof naming another contract fails. It reads the page's JSON, the bare borsh form, and the phone's share (`kind: "tail/presence-proof/v1"`), whose `proof` field it decodes and whose other fields must agree with that proof. The page says the referee logged the contact, and names the test referee when NEAR's key for the match is its                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| The log stayed private during play                     | v2: every `Contact`, `HintReceipt` and `Evidence` entry ends in `logSalt(K_log, index)`, K_log = HKDF(K_m, "tail/log"), with K_m from the bundle's `reveal.kM` (`badLogSalts`). The referee releases K_m only with the log after End, so during play the relay could not hash guesses of these entries against its leaves. No `kM`: not checked. v1 logs had no salts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Devices                                                | v2: each player's `Enrolled` log entry; `attested: false` is labelled "test player (no Apple attestation)" on the player and on every verdict involving them. The relay's `devices` list is not used here (`tail-verify` uses it to re-check App Attest assertions). A relay test player (a `ghost-…` account) is named "Test player" and its handle's letter, numbered in player order when two share one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Handler key's hardware                                 | the "Verified" panel under a Handler line fetches NEAR AI's attestation report for the model with a fresh 32-byte nonce (`src/verify/nearai.ts`, `nearai-live.ts`) and checks the Intel TDX quote with dcap-qvl against Intel-signed collateral (through Phala's cache, which sends CORS headers), that Intel rates the platform UpToDate and the TD is not in debug mode, the signing address and nonce in its report data, and `mr_config_id` against the container manifest the same report sends. NVIDIA's NRAS refuses browsers, so the GPU row comes from `public/nearai-attestation.json`, the saved output of `scripts/verify-nearai.ts`, with its date and its own glyph (checked earlier by the script). It checks NEAR AI's current key, and says whether the line's logged address is that key. A result is reused for 10 minutes in the same tab. **Nothing pins NEAR AI's expected image**: NEAR AI publishes no expected MRTD, RTMRs or manifest, so any genuine, non-debug TDX VM that puts a key and the nonce in its report data passes; the GPUs are tied to that TD only by the shared nonce |
| Handler lines                                          | v1: SHA-256 of the quoted text equals the `HintReceipt` text hash. v2: the words were sealed to the asker, so the bundle has none and the page doesn't quote them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Handler chat signature                                 | the receipt's ECDSA signature, Ethereum `personal_sign` over the bundle's `signedText` (`model:sha256(req):sha256(resp)`), recovers (secp256k1 + keccak-256) to the logged `signing_address` (and, for v1, names the quoted model). It shows that address signed those hashes, not that the address is a TEE key (the next row checks that) nor that the response hash is any quote                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Which referee                                          | NEAR's `referee_pk` for the match against the pinned enclave and local keys (never the bundle's `referee.kind`). "Enclave" only for a verdict whose record, read from the pinned OutLayer API, names its call and an `executed_wasm_sha256` in the pinned list. A match NEAR pins to the local test referee carries a "Test referee" chip beside the header line and on the finale, as a fixture carries "Fixture". When NEAR can't be reached or has no such match, the key is shown as not read, not as unknown                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Forfeits                                               | not re-checked here. The referee forfeits a player once their dark time over the whole match adds up to 3 minutes (`DARK_FORFEIT_MS`): time without a fresh report and time reporting from outside the zone both count. The forfeit's sheet shows what the log holds (the last released position, how long before the forfeit, inside or outside the zone) and the rule in words, with no pass or fail; `tail-verify` re-runs the rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Dossier card                                           | `/dossier/<account>` reads `get_dossier` and `nft_token` at one final block, shows the contract's own `metadata.media`, and compares it byte for byte with `dossierSvg` (`@tail/brand`) drawn from the record: "Same picture as the contract's NFT", a failing line if not, or a not-checked line when NEAR didn't return the NFT (the card is then drawn here). An entry with `log_size` 0 was called off before any checkpoint and anchored no root, so it isn't checked against `get_roots`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

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
"Matches NEAR", "The draw matches its commitment", "Every tag's evidence fits the lock rule" (or
how many tags break it), "Trails come from the log", "The referee says it checked every phone's
Apple attestation" (or "… skipped some phones' …": the log's record, not Apple's attestation),
"Log salts come from the match key" (with who held that key) and "Handler lines: N of M carry a
NEAR AI signature" (a fixture's: "… carry the fixture's test-key signature"; template lines carry
none). The tamper tests in
`test/verify.test.ts` flip every byte of a Tag verdict, a log entry and a batch in turn and
assert each one fails; `test/v2.test.ts` covers the verdict chain, consistency, tag evidence,
presence proofs, unattested players, both tampered fixtures and the v1 bundle;
`test/settle.test.ts` covers the settlement replay, both refunded variants and the comparison
with NEAR's `settled_as` and `paid` (against a contract view built from the contract's rules in
`test/chain.ts`); `test/sheets.test.tsx` renders the summary, event sheets, header, finale and
presence result from real bundles (`test/render.tsx`) and pins what their rows say;
`test/pages.test.ts` the pages with no film; `test/dossier.test.tsx` the dossier card check.

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
second Tag is signed for Dee, who was hunting Eli, which the replay refunds as off the ring (and
whose Evidence, naming Eli, fails that tag's mark), and one whose first Tag's Evidence cites a
window just outside the lock window: every signature and root holds and NEAR matches, but that
tag reads "Fails a check" and the header "1 verdict fails a check".

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
  without trails they are good to about a tick (10 s). End is at the referee's last tick before
  it (a v1 log has no ticks, so there it is the planned end).
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
- Private replays need a player's NEAR key to answer the relay's challenge, and this page has
  no wallet: it shows one only when the TAIL app opens it with a fresh sign-in (above). Anyone
  else, and a player who reloads or follows a plain link, gets the private page.
  A replay whose trails the relay deleted after its retention window (410) says so.
- The private sign-in and the dossier page have run only in tests. The dossier page's comparison
  was checked against the live contract's `get_dossier` and `nft_token` by a script, not in a
  browser. The checks did run, outside a browser, on the bundle of the 2026-11-13 iPhone match: 8
  of 8 verdicts passed and its tag's evidence fits the lock rule.
- deck.gl 9.4 reads `map.transform`, which MapLibre 6 moved onto its camera; `Scene3D.tsx`
  exposes it until deck.gl catches up.
- The flat 2D map draws the source's z14 tiles without labels.

## Credits

Map data © OpenStreetMap contributors, tiles by OpenFreeMap. Type: Archivo (SIL OFL). Brand
colours, the Trail mark and the game icons come from `@tail/brand`.
