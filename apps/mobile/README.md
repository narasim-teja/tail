# TAIL iPhone app (`apps/mobile`)

Expo SDK 58 dev-client app, TypeScript strict, iOS only, new architecture. It enrols the phone,
runs the lobby, and during the hunt broadcasts rotating beacon tokens, listens for other players,
and sends sealed, App Attest-signed reports to the referee through the relay. Everything the
referee sends back (keys, HUDs, Handler lines) is checked against the referee key the match
pinned on NEAR, read through the phone's own RPC, and after the match the phone checks that each
of its reports is in the log root anchored on NEAR.

**Status.** Unit and integration tests pass without a phone (below). Release builds run on two
iPhones (17 Pro Max, 14): enrolment with App Attest, lobbies, test players, the hunt and a Tag from
Bluetooth contact all ran indoors on 2026-11-12, against the relay on a Mac with the local test
referee. Those runs were protocol v1. The v2 paths (signed HUDs, chain recovery, inclusion
receipts, presence proofs, mesh carry, the log monitor) pass their tests here but have not run on
a phone yet. Range, pocket and outdoor play are not tested yet.

## Layout

| Path                      | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modules/tail-radio`      | Swift: advertise one 128-bit UUID, scan with duplicates (only UUIDs whose first 4 bytes match this match's tags reach JS), location with the `CLLocationSourceInformation` flags, pocket mode, app-state and proximity events                                                                                                                                                                                                                                                                                                                                   |
| `modules/tail-attest`     | Swift: App Attest over a raw 32-byte clientDataHash (the S3 spike's chosen path)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/proximity/`          | Game-agnostic play, reusable by another location game ([README](src/proximity/README.md)): epoch timer, sighting aggregation, fixes, batch builder and hash chain, ordered outbox and chain recovery, the HUD socket and signed-HUD opening, the referee box-key check, mesh carry (`carry/`, behind a Settings switch, off by default), inclusion receipts and presence proofs, the log monitor (`monitor.ts`), request signing (`auth.ts`, `relay.ts`), and `client.ts` (`ProximityClient`), which wires them. Imports nothing from TAIL (`boundary.test.ts`) |
| `src/relay/`              | TAIL's own relay calls (`client.ts`: enrolment, lobbies and codes, match views, replay log, test relay), on top of `proximity/relay.ts`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/near/`               | NEAR transactions for the player's function-call key (`join_match`, `leave_lobby`, `withdraw`), views, and what the phone reads from NEAR itself (`chain.ts`: the match's referee key, players, anchored roots)                                                                                                                                                                                                                                                                                                                                                 |
| `src/identity/`           | Keys in the Keychain and enrolment (TECHNICAL.md 4.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/tail/`               | TAIL's hunt on top of the proximity layer: `hunt.ts` (`TailHunt`: strikes and hints, the HUD read as lock, heat, target and tags, zone and vehicle warnings, the Handler, notes), the HUD view and words (`hud.ts`), rules, zone, the hunt view model, Results' receipt lines                                                                                                                                                                                                                                                                                   |
| `src/state/`              | App model (`app.ts`), device adapters, file persistence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/screens/`, `src/ui/` | Screens; `ui/theme.ts` (every colour, size and font), `ui/brand.tsx` (mark, icons)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `test/`                   | Test helpers: fake clock, minimal CBOR, App Attest assertions in Apple's format                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## How `@tail/protocol` and `@tail/brand` are wired

The app uses `packages/protocol` (wire formats) and `packages/brand` (colours, the Trail mark,
game icons) from source, never copies.

- **Metro** (`metro.config.js`): both packages are watch folders and `@tail/protocol` /
  `@tail/brand` map to them. `packages/protocol` has no `node_modules`, so its `@noble/*` imports are resolved as if
  imported from the app. The bundle has exactly one copy of each `@noble` package (checked in the
  export's source map).
- **TypeScript** (`tsconfig.json` `paths`): `@tail/protocol` → `../../packages/protocol/src/index.ts`,
  `@tail/brand` → `../../packages/brand/src/index.ts`, `@noble/*` → `./node_modules/@noble/*`.
- **Bun tests** (`test/preload.ts`, loaded by `bunfig.toml`): the same redirects.
- **Brand in the UI**: `src/ui/theme.ts` takes every colour from `@tail/brand` `colors` (a test
  checks no other colour is used). `src/ui/brand.tsx` renders `markSvg()` and `iconSvg(name)` with
  react-native-svg `SvgXml`: your map marker is the Trail mark, turned so its trail points back
  along your CoreLocation course (`src/ui/mark.ts`; the map is fixed north-up). The app icon is
  `packages/brand/assets/app-icon-1024.png`, referenced from `app.config.ts`.
- The app pins the same `@noble` versions as the protocol package; `test/setup.test.ts` fails if
  they drift apart.
- Hermes has no `TextDecoder` and no `crypto.getRandomValues`; `src/polyfills.ts` installs a strict
  UTF-8 decoder (tested against the platform one) and `expo-crypto`'s random source.

## Screens

| Screen   | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enrol    | The Chase scene, TAIL, one field (handle), Join; states: checking this phone, handle taken, no App Attest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Primer   | Three swipeable cards (Lock, Heat, Strike), once, skippable; each plays the real readout it explains                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Home     | You (avatar and handle) and Settings; the Chase in a sand well; balance (rolls when it changes); Create a match and Scan to join; code entry; recent matches, or on first run how a match goes in three lines. You and the balance open Profile                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Profile  | Handle and account id (select to copy, Share, View on NEAR); the Dossier card; balance with Top up 10 (testnet) and Withdraw (the first one names the payout wallet for good, said above the field; a withdraw the token refused says nothing moved); this iPhone verified, where withdrawals go, network                                                                                                                                                                                                                                                                                                                                                                                     |
| Create   | Live map of the zone around you; zone, stake and length as chips, players as a stepper (all inside the server's bounds); public replay, off by default (a replay shows every player's trail)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Scan     | Camera reads a lobby QR (`tail://join/<id>`); permission asked or Open Settings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Lobby    | Big QR first, code and Share, stake, length, players as initials (each slides in with a tick as they join), open seats as dashed pulsing rings; waiting, ready, starting (rings run round each player), failed (retry), called off; Join, Start (host), Leave; on a test relay the host can Add a test player (it forfeits after 3 min dark)                                                                                                                                                                                                                                                                                                                                                  |
| Briefing | The Chase with the target's initials on the ink dot; the handle rises out of a mask with a haptic tick; your head and the start countdown, ticking by feel in the last 5 s. Reporting starts as soon as the orders open here; Hunt only moves to the hunt screen. Until the orders open it offers Settings (a wrong relay or RPC can be fixed while the match stays open) and says the phone can't report yet, which counts as dark time                                                                                                                                                                                                                                                      |
| Hunt     | Target and time left; LOCK arc with its numeral, HEAD, HEAT bar with its numeral; live map (you as the Trail mark, zone edge dotted, safehouses, leaked cell); Handler at thumb reach. Lock full floods persimmon and STRIKE replaces the map; strike sent; landed (flash, new target slides in); a refused strike's reason as a banner for 10 s; dark and out-of-zone banners with countdowns; vehicle freeze; Handler dispatch and pull-down log; hint sheet; tagged (ink); Bluetooth or location off; a screen that stays when iOS has lost the device key (the match will be forfeited)                                                                                                   |
| Settings | Whether the relay answers and which referee it says it runs, and a contract mismatch if there is one; Advanced (collapsed, open when no relay is set): relay address, NEAR RPC, the build's contract (read only), Mesh carry (experimental); the app version. Settings from an older build keep the relay address and the mesh switch; a stored contract or replay site is ignored                                                                                                                                                                                                                                                                                                            |
| Results  | Outcome emblem; survived, out or last one standing; final head and tags roll up; the Handler's sign-off; Watch the replay (Safari); How it's verified; your reports ("N of M reports are in the log anchored on NEAR", refusals with their reason, any missing report as a problem); after the end, Prove I met (name) for each player you met. It reads the match every 5 s until End is in and checked; it checks your reports on arrival and, after the end, again only when NEAR holds a root it has not checked against (End's), so a poll never re-asks the relay for the same proofs. A match the contract paid before the upgrade says it was paid on the old rules, without a replay |

## Design system

The look follows `docs/DESIGN.md` and the confirmed brief `docs/briefs/mobile.md`.

- **Tokens** (`src/ui/theme.ts`): colours only from `@tail/brand`; Archivo (the replay's family),
  embedded by the expo-font config plugin and addressed by PostScript name, with tabular figures
  on every number; a 4-point spacing scale; motion durations and exponential easings.
- **Contrast** (`test/contrast.test.ts`): every text/background pair the app draws is listed in
  `contrastPairs` and checked against WCAG AA. Persimmon on paper (2.9:1) is never text and never
  the only carrier of a state.
- **Haptics** (`src/ui/haptics.ts`): heat tick (cadence by heat level, `src/ui/cadence.ts`), lock
  full, strike sent, tagged, and the Handler's dispatch. They stay on with Reduce Motion.
- **Motion** (`src/ui/motion.ts`, `src/ui/scene.tsx`): screens arrive with a short fade and rise;
  buttons give under the thumb; the lock's newest segment flashes in and its numeral steps up;
  STRIKE breathes; high heat throbs at the haptic cadence; being tagged lands with a beat. All
  transforms and opacity on the native driver, exponential ease-out, no bounce.
- **Reduce Motion**: the lock-full flood, the landing flash, banners, the hint sheet and every
  arrival become instant changes; the Chase and the rings hold a still frame; nothing pulses.
- **The Chase** (`src/ui/scene.tsx`): the Trail mark set moving. You (persimmon, trail fading
  behind) tail your target (ink) round a loop inside a dotted zone while the field drifts the
  other way; once a lap the gap closes and a ring lands. Drawn from brand colours only, one
  looping value on the native driver, hidden from VoiceOver. Used where a screen would sit empty:
  enrol, home, briefing. Find My-style rings (`Ripple`) mark loading, waiting and open seats.
- **System icons**: everyday controls (settings, scan, share, back, top up) use SF Symbols through
  `expo-symbols` (`SystemIcon`, `IconButton` in `src/ui`), so they read as iOS. Game concepts keep
  the brand's icons.
- **Brand assets**: the Trail mark (loading, home, results, splash, your map marker) and the game
  icons (lock, heat, head, strike, near, bearing, trend, handler, safehouse, zone, dark,
  verified) all render from `@tail/brand` strings with react-native-svg. Everyday controls use SF Symbols (above).
- **Design preview** (`src/preview/Preview.tsx`, development builds only, behind `__DEV__`):
  every screen and every state from the brief, rendered through the live views with fixture
  data. Open `tail://preview` (list) or `tail://preview/<state>`, add `?frame=small` for a 375 ×
  667 pt frame. Screenshots of each state are in `screenshots/`.

## Install (standalone, outside the root workspace)

`package.json` has **no `name` on purpose**: Bun only treats a folder matched by the root
`workspaces` glob (`apps/*`) as a member if it has a name. Without one, `bun install` here keeps
its own `bun.lock` and `node_modules`, and a root install ignores this folder. The root
`workspaces` also says so explicitly, with `"!apps/mobile"`.

```sh
cd apps/mobile
bun install
```

## Checks without a phone

```sh
cd apps/mobile
bun test
bunx tsc -p . && bunx tsc -p tsconfig.test.json
bunx expo export --platform ios --output-dir /tmp/tail-export
CI=1 bunx expo prebuild --platform ios --clean
cd ios && xcodebuild -workspace TAIL.xcworkspace -scheme TAIL -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
# from the repo root:
bunx biome check apps/mobile
xcrun swift-format lint --strict --recursive apps/mobile/modules
```

What the tests prove:

- **Batch path end to end** (`src/proximity/batch.test.ts`): batches built by the real builder with a
  test P-256 key signing in Apple's assertion format open with the referee's box key
  (`"tail/batch"`), decode as `BatchEnvelope`, chain by `batchHash`, and pass the referee's
  checks from `crates/appattest` (signature over the nonce, rpIdHash, increasing counter). The
  same verifier accepts the two **real iPhone assertions** from the S3 spike
  (`crates/appattest/tests/data/s3-tail-attest.json`).
- **Hunt** (`src/tail/hunt.test.ts`, through `TailHunt` and `ProximityClient`; `src/proximity/client.test.ts` drives the client alone): with a fake radio and clock, the token and scan filter
  rotate each epoch, a batch goes out every 5 s with that window's fixes and sightings, STRIKE goes
  out at once, an action the game queued is carried unread, a signed HUD drives lock/heat/STRIKE, tags and the dark banner, a HUD or Handler
  line not signed by the referee is shown as such and ignored, an older HUD replayed is ignored,
  and being out stops the radio.
- **Chain recovery** (`src/proximity/chain.test.ts`, hunt tests): a report refused for its App
  Attest assertion, a report that never reached the referee (resent once, then rebuilt), a phone
  whose chain parted from the referee's, and a relaunch mid-chain or with the match file lost all
  carry on from the HUD's `next_seq` and `chain_tip`; a lost strike or hint is said plainly.
- **Inclusion receipts and presence proofs** (`src/proximity/receipts.test.ts`): against a log built
  with the protocol's own Merkle helpers, accepted and refused reports are found under the
  anchored root, a missing one is a problem, and a tampered path, a wrong size or a made-up root
  does not count; presence proofs from the log verify with `verifyPresence`, and a tampered log
  yields none.
- **Log monitor** (`src/proximity/monitor.test.ts`, client tests): honest growth verifies; a later
  HUD with a smaller log, or two signed roots (HUD or anchor) of one size that differ, is a fork,
  kept with both signed HUDs (their referee signatures verify); a consistency proof that does not
  verify is a relay fault, kept as evidence and asked again with a doubling wait while the
  monitor carries on; a relay it can't reach is retried; HUDs that arrive during a fetch are
  caught up with one proof; a saved pending root is proven after a relaunch.
- **Enrolment and refresh** (`src/identity/identity.test.ts`): the phone attests nothing for an
  account other than `<handle>.<NEAR_RELAY_ACCOUNT>` pinned in the build; a refresh attests a new
  key over the fresh challenge, signs `rebind_sig` with the NEAR key over the App Attest key read
  out of the attestation (checked against a real iPhone attestation), keeps the account, and a
  Start refused with `code: "refresh"` for this account re-enrols and tries once more.
- **Handler lines** (`src/tail/handler.test.ts`, hunt tests): each signed line's hint id and text
  hash are kept in the match file; after End a line whose logged HintReceipt hashes another text
  is named, and a log that does not hash to End's root counts for nothing.
- **Mesh carry** (`src/proximity/carry/mesh.test.ts`, hunt tests): envelopes are 4144 bytes of
  ciphertext with no account, path or match id in the clear; a forwarder posts an envelope once
  however often it hears it and sends the relay's answer back; a report counts as delivered only
  when the relay's receipt verifies under its ack key; a report the mesh delivered is not sent
  again over HTTP, nor counted twice.
- **Outbox** order, retry and offline rules, and that a batch stays until the referee confirms
  it; **sighting** aggregation and tag filter; **epoch** timer; **NEAR** transactions byte-equal
  to `near-api-js`; signed requests accepted by the relay's own check
  (`apps/server/src/routes/util.ts` `RequestAuth`, protocol v2: contract and account in the
  digest); the referee box-key check.

## Build onto a phone

`bunx expo run:ios --device` does **not** pass `-allowProvisioningUpdates`, so Xcode falls back
to the wildcard team profile, which cannot carry the App Attest entitlement, and the build fails.
Use xcodebuild directly (the route that worked in the device spike on 2026-11-12).

1. Repo-root `.env.local` holds `APPLE_TEAM_ID`, `IOS_BUNDLE_ID`, `TAIL_CONTRACT` (the only
   contract the build plays on; the app has no setting for it) and optionally `TAIL_RELAY_URL`
   (the relay a fresh install uses; a player can type another under Settings > Advanced).
   `app.config.ts` reads only these public names, plus `NEAR_NETWORK` and `NEAR_RELAY_ACCOUNT`.
2. Build and install, once per phone (each build registers that phone in the profile):

   ```sh
   cd apps/mobile
   bun install
   CI=1 bunx expo prebuild --platform ios --clean
   xcrun devicectl list devices                      # UDIDs
   cd ios
   xcodebuild -workspace TAIL.xcworkspace -scheme TAIL -configuration Release \
     -destination "id=<phone UDID>" -derivedDataPath build \
     -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
   xcrun devicectl device install app --device <phone UDID> build/Build/Products/Release-iphoneos/TAIL.app
   ```

   After the last phone is registered, reinstall that last build on every phone so they all carry
   the same profile. Use **Release** for play: the JavaScript is inside the app. A Debug build
   loads it from Metro over Wi-Fi, which breaks when you walk away.
3. If signing complains about App Attest: open `ios/TAIL.xcworkspace`, target TAIL > Signing &
   Capabilities, check the team and that App Attest is present
   (`com.apple.developer.devicecheck.appattest-environment = development`).
4. First launch asks for Bluetooth and location. Allow both. Keep automatic date and time on: the
   epochs come from the wall clock.

## Playing a test match

1. Run the relay (`apps/server`). A build made with `TAIL_RELAY_URL` already knows it. Otherwise,
   on the first screen tap **Settings**, which opens on **Advanced**, and enter the relay address
   (`http://<Mac LAN IP>:8787` works: local networking is allowed for development). The NEAR RPC
   is there too (the phone reads the referee key and the log roots from it). **Save**. Settings
   then says whether the relay answers and which referee it says it runs.
2. Enter a handle, **Join**. The phone generates its keys, App Attest attests them over the
   relay's challenge, and the relay creates `<handle>.<relay account>` with only this phone's
   function-call key. The phone attests only for `<handle>.<NEAR_RELAY_ACCOUNT>` as the build
   pinned it (`app.config.ts`); a relay that names any other account is refused.
3. Host: fill **New match** and **Create** (the zone is centred on you). The lobby shows a short
   code (`K7M-4QX`) and a QR of `tail://join/<match id>`. **Share** sends the code and
   `tail://join/<code>`; others scan the QR, open the link, or type the code into **Or enter a
   code** (the relay's `GET /join/:code` resolves it while the lobby is open). A full match id
   works there too.
4. Everyone: **Top up 10** (testnet: the relay credits test USDC), then **Join** (a NEAR
   `join_match` signed on the phone). Host: **Start** once enough players joined.
5. Briefing shows your target. Beacon, scan, location and pocket mode start as soon as the orders
   open, before you tap **Hunt**, which only moves to the hunt screen. Keep the app in front; put
   the phone in a pocket screen-in (the proximity sensor turns the screen off). Do not press the
   side button: that locks the phone and stops the game.
6. Lock fills when you are near your target; heat when your hunter is near you. **STRIKE**
   appears at a full lock. **Handler** sells three hints with an optional question.
7. When you are out or the match ends: your head, your tags, and your reports checked against
   the log root on NEAR. After the end, **Watch the replay**, and **Prove I met** a player shares
   a JSON presence proof (below).

## What the app uses from the server

All served by `apps/server` (shapes in its README):

- `GET /health`: the contract the relay serves. Every signed request names it (request auth v2:
  `requestDigest({contractId, accountId, method, path, timeMs, body})`); the app also compares it
  with the contract its build names and says so when they differ (it never switches). `replay_url` is the web replay that
  Watch the replay and the Dossier card open; the app keeps it only if it is a plain http(s)
  address and uses it for nothing but that link.
- `GET /referee`: the referee's keys. The app checks `box_pk_sig` (ed25519 over
  `SHA256("tail/referee-box/v1" ‖ box_pk)`) under the `referee_pk` the match pinned, read from
  the contract's `get_match` through the phone's own NEAR RPC (not the relay's chain view), and
  refuses to seal otherwise. The same key checks the sealed `SignedPlayerKeys`, every
  `SignedHud` and every `SignedVoiceLine`; anything that does not verify shows "This update was
  not signed by the referee" and is ignored.
- `GET /matches/:id` (public): lobby, phase, the join `code` and the chain view. No zone, no keys.
- `GET /matches/:id/zone` (signed like the POSTs, empty body; host and players only): the zone and
  safehouses, this player's own sealed keys once the match has started, and why a Start failed.
  The zone is drawn only if it hashes to the chain's `zone_hash`.
- `GET /join/:code`: a short lobby code (`K7M-4QX`) to a match id.
- `POST /matches` answers 409 with the `match_id` when the host already has an open lobby; Create
  says so and offers to open it. 429 (limits) and 413 (too large) show as short sentences.
- `GET /enroll/status`, `POST /enroll/refresh/challenge`, `POST /enroll/refresh` (signed): when
  the contract pins another referee, that referee knows no device. The phone asks on start-up,
  when the relay is checked and when a Start fails, again every 30 s while the lobby shows a
  failed Start, and on pull to refresh in the lobby; never during a hunt. The status names the
  App Attest key the relay holds (`app_attest_key_id`): a key the phone sent before an answer was
  lost is kept as pending and settled against it, and a key the phone does not hold means a
  refresh. Then it makes one trial assertion with its key, so a key iOS threw away (after a
  reinstall) is replaced before the hunt. If the referee doesn't hold its device, the key is not
  the relay's or fails the trial, or Start answers 409 with `code: "refresh"` naming it, the
  phone attests a new App Attest key over a fresh challenge for the same account and signs
  `rebind_sig` (`rebindDigest`) with the NEAR key from the Keychain. It says so in one line on
  Home and the lobby. Not run on a phone yet.
- `POST /enroll/challenge`, `POST /enroll`, `POST /matches/:id/start`,
  `POST /batch`, `GET /hud` (WebSocket), `POST /dev/topup` (testnet).
- `GET /matches/:id/inclusion?leaf=&size=`: audit paths for the receipts. The size is always one
  the contract anchored (`get_roots`, read from NEAR directly), and each path is verified with
  `merkleVerify` against that root; the relay's answer alone counts for nothing.
- `GET /matches/:id/consistency?from=&to=`: consistency proofs for the log monitor, verified with
  `verifyConsistency` against two roots the referee signed or NEAR anchored.
- `POST /replay/:id/challenge`, then `GET /replay/:id` with the signed nonce: the plaintext log
  after End, for presence proofs. Each proof is checked with `verifyPresence` against End's root
  and the contract's player list before it is offered.
- `GET /carry/key` (at briefing, when mesh carry is on) and `POST /carry` (as a forwarder).

The HUD socket's own frames are not trusted: a `rejected` frame is ignored (the signed HUD carries
the referee's latest refusal), and a Handler line counts only sealed and signed.

## Chain recovery

The referee takes a player's reports only as one hash chain. Before, one report it never took
(refused for its App Attest assertion, or never opened) left every later one chained to it, so
all were refused until the player forfeited for being dark. Now a report stays in the outbox until
a signed HUD's `next_seq` and `chain_tip` show the referee took it, and after each HUD the phone
confirms, sends the waiting report again (once, if the relay took it 30 s ago and the referee
still has not), or rebuilds its chain from `next_seq`/`chain_tip` (the chains parted, the waiting
report was refused for its assertion, or it stalled twice). Refusals show in plain words; the
dark banner is the referee's `dark_ms`; tags are the referee's `tags`.

## Receipts and presence proofs

The relay passes each Handler line's HintReceipt (SHA256 of the text) to the referee's next
tick. The phone keeps the hint id and text hash of every signed line it received; after End it
checks them against the HintReceipts in the replay log, once that log hashes to End's root on
NEAR. A different hash shows on Results as "The relay delivered a different Handler line than
the referee logged".

Each report the relay takes is kept in the match file (seq, batch hash). On Results the phone
computes each one's log leaf (`Batch`, or `Rejected` with the refusal code), asks the relay for a
path at the size of the newest root anchored on NEAR, and verifies it against that root. It says
"N of M reports are in the log anchored on NEAR", "K refused by the referee (reason)", and lists
a report that is in neither form as a problem once End's root is there. Against a checkpoint the
phone tries only the refusal code its HUD named, since a report not found there is only "not
anchored yet"; against End's root it tries every code.

**Prove I met (name)** shares a JSON document: `proof` is the borsh `PresenceProof` (base64), a
`Contact` entry with its path to End's root, plus the accounts, epoch, index and size. Anyone can
check it from chain data alone: `decodePresenceProof`, then `verifyPresence(proof, roots, players)`
from `@tail/protocol`, with `roots` from `get_roots` and `players` from `get_match` on the
contract. The replay's `/?presence=` page reads this document too (its `kind` is
`tail/presence-proof/v1`); the app does not link to it yet.

## Log monitor

Every signed HUD carries the referee's `log_size` and `root`. The phone checks they form one
growing log, the way Certificate Transparency monitors do (`src/proximity/monitor.ts`): when a
HUD's log has grown it fetches a consistency proof from the last root it verified and checks it
with `verifyConsistency`; about once a checkpoint, and again on Results, it reads `get_roots` from
NEAR and checks each new anchored root against the newest verified HUD root. One fetch at a time:
HUDs that arrive meanwhile are caught up with a single proof, and a fetch that fails is retried
15 s later. A later HUD with a smaller log, or a root of the same size that differs, needs no
proof.

A fork is two roots the referee committed to that contradict each other with no relay data: a
later signed HUD with a smaller log, or two roots (signed HUDs, or a HUD and an anchor on NEAR)
for one log size. It is a hard alarm in the hunt and on Results ("The referee showed you a log
it later changed"), saved in the match file, and the monitor stops. **Export the proof** shares a
JSON document (`tail/log-fork/v2`) with both signed HUDs as the referee signed them (borsh
`SignedHud`, base64), or the HUD and the anchored root.

A consistency proof that does not verify came from the relay, which is untrusted, so it blames
the relay only: it is kept in the match file (with the proof, and a count), shown quietly in the
hunt's status line and on Results, and the same check is asked again after 15 s, doubling up to
4 minutes. HUDs that arrive meanwhile only move the target. Monitoring carries on; if the
referee's log really changed, the next signed root that contradicts by itself is the fork.

The tagged screen names who got you from the HUD's `tagged_by` (the hunter for a tag, the
receiver for a forfeit). A HUD without it falls back to "your hunter".

## Behind settings or not done

- **Mesh carry is off by default** (Settings > Advanced > Mesh carry (experimental)). With it on, every
  phone runs the Offline Protocol mesh for the whole hunt (Bluetooth only, a fresh SDK profile
  per match, wiped when the hunt stops). A phone with no relay contact for 20 s seals each signed
  report request with `sealCarry` to the relay's carry key and hands it to its mesh neighbours; a
  phone with signal posts what it hears to `POST /carry` unchanged and sends the relay's answer
  back. A report counts as delivered only when the relay's signed receipt verifies, and a HUD that
  rides back is opened like any other. There is no relay mesh node. Carriers see only a 4144-byte
  ciphertext and the sender's per-match mesh address: no account, no match id. The mesh link
  itself still tells two phones that some TAIL phone is in Bluetooth range (TECHNICAL.md 7, F14).
  Tested only with a fake mesh; not run on phones.
- **Bluetooth coexistence is not measured**, which is why the switch is off. An iPhone advertises
  about 28 bytes in the foreground and the TAIL token is a 128-bit service UUID (18 of them). If
  the SDK's own advertisement takes that room, iOS moves the token to the overflow area, where
  other phones' scans may not see it, and contact, and with it every lock, is lost.
- **Not yet tested outdoors.** Bluetooth range (`RSSI_MIN_DBM`), pocket mode and a full match in a
  park have not run; the indoor two-phone runs on 2026-11-12 are the only device runs so far.
- **Relay address.** Use the Mac's LAN IP (`http://<ip>:8787`). Its `.local` name can resolve to
  the USB link to a cabled phone, which drops requests when the cable moves.
