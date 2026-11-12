# TAIL iPhone app (`apps/mobile`)

Expo SDK 58 dev-client app, TypeScript strict, iOS only, new architecture. It enrols the phone,
runs the lobby, and during the hunt broadcasts rotating beacon tokens, listens for other players,
and sends sealed, App Attest-signed reports to the referee through the relay.

**Status.** Unit and integration tests pass without a phone (below). The app bundles, prebuilds
and compiles for the iOS simulator. It has **not run on a phone yet**. The native modules are the
ones the device spike proved on two iPhones (`spikes/device`), cleaned up.

## Layout

| Path                      | What                                                                                                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modules/tail-radio`      | Swift: advertise one 128-bit UUID, scan with duplicates (only UUIDs whose first 4 bytes match this match's tags reach JS), location with the `CLLocationSourceInformation` flags, pocket mode, app-state and proximity events |
| `modules/tail-attest`     | Swift: App Attest over a raw 32-byte clientDataHash (the S3 spike's chosen path)                                                                                                                                              |
| `src/relay/`              | **Every relay call** (`client.ts`), the request and HUD signatures (`auth.ts`), the HUD socket (`hud.ts`), the referee box-key check (`referee.ts`)                                                                           |
| `src/near/`               | NEAR transactions for the player's function-call key (`join_match`, `leave_lobby`) and views                                                                                                                                  |
| `src/identity/`           | Keys in the Keychain and enrolment (TECHNICAL.md 4.4)                                                                                                                                                                         |
| `src/game/`               | The hunt: epoch timer, sighting aggregation, fixes, actions, batch builder and hash chain, ordered outbox, HUD view model, and `session.ts`, which wires them                                                                 |
| `src/carry/mesh.ts`       | Offline Protocol carry path (off until the relay has a mesh node)                                                                                                                                                             |
| `src/state/`              | App model (`app.ts`), device adapters, file persistence                                                                                                                                                                       |
| `src/screens/`, `src/ui/` | Screens; `ui/theme.ts` (every colour, size and font), `ui/brand.tsx` (mark, icons)                                                                                                                                            |
| `test/`                   | Test helpers: fake clock, minimal CBOR, App Attest assertions in Apple's format                                                                                                                                               |

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

| Screen   | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enrol    | Trail mark, one field (handle), Join; states: checking this phone, handle taken, no App Attest                                                                                                                                                                                                                                                                                                                                                          |
| Primer   | Three cards (Lock, Heat, Strike), once, skippable                                                                                                                                                                                                                                                                                                                                                                                                       |
| Home     | Trail mark and handle; balance and Withdraw; Create a match and Scan to join; code entry; recent matches                                                                                                                                                                                                                                                                                                                                                |
| Create   | Stake, minutes, players, zone radius (centred on you), public replay                                                                                                                                                                                                                                                                                                                                                                                    |
| Scan     | Camera reads a lobby QR (`tail://join/<id>`); permission asked or Open Settings                                                                                                                                                                                                                                                                                                                                                                         |
| Lobby    | Big QR first, code and Share, stake, length, players as initials; waiting, ready, starting, failed (retry), called off; Join, Start (host), Leave                                                                                                                                                                                                                                                                                                       |
| Briefing | The target's handle fills the screen; your head and the start countdown                                                                                                                                                                                                                                                                                                                                                                                 |
| Hunt     | Target and time left; LOCK arc with its numeral, HEAD, HEAT bar with its numeral; live map (you as the Trail mark, zone edge dotted, safehouses, leaked cell); Handler at thumb reach. Lock full floods persimmon and STRIKE replaces the map; strike sent; landed (flash, new target slides in); dark and out-of-zone banners with countdowns; vehicle freeze; Handler dispatch and pull-down log; hint sheet; tagged (ink); Bluetooth or location off |
| Results  | Survived, out or last one standing; final head; tags; Watch the replay (Safari); How it's verified                                                                                                                                                                                                                                                                                                                                                      |

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
- **Reduce Motion** (`src/ui/motion.ts`): the lock-full flood, the landing flash, banners and the
  hint sheet become instant changes; the heat bar does not pulse.
- **Brand assets**: the Trail mark (enrol, home, primer, splash, your map marker) and the game
  icons (lock, heat, head, strike, near, bearing, trend, handler, safehouse, zone, dark,
  verified) all render from `@tail/brand` strings with react-native-svg. No other icon set.
- **Design preview** (`src/preview/Preview.tsx`, development builds only, behind `__DEV__`):
  every screen and every state from the brief, rendered through the live views with fixture
  data. Open `tail://preview` (list) or `tail://preview/<state>`, add `?frame=small` for a 375 ×
  667 pt frame. Screenshots of each state are in `screenshots/`.

## Install (standalone, outside the root workspace)

`package.json` has **no `name` on purpose**: Bun only treats a folder matched by the root
`workspaces` glob (`apps/*`) as a member if it has a name. Without one, `bun install` here keeps
its own `bun.lock` and `node_modules`, and a root install ignores this folder. (A
`"!apps/mobile"` entry in the root `workspaces` would say the same thing explicitly.)

```sh
cd apps/mobile
bun install
```

## Checks without a phone

```sh
cd apps/mobile
bun test                                   # 103 tests
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

- **Batch path end to end** (`src/game/batch.test.ts`): batches built by the real builder with a
  test P-256 key signing in Apple's assertion format open with the referee's box key
  (`"tail/batch"`), decode as `BatchEnvelope`, chain by `batchHash`, and pass the referee's
  checks from `crates/appattest` (signature over the nonce, rpIdHash, increasing counter). The
  same verifier accepts the two **real iPhone assertions** from the S3 spike
  (`crates/appattest/tests/data/s3-tail-attest.json`).
- **Session** (`src/game/session.test.ts`): with a fake radio and clock, the token and scan filter
  rotate each epoch, a batch goes out every 5 s with that window's fixes and sightings, STRIKE goes
  out at once, a sealed HUD drives lock/heat/STRIKE, rejections show up, being out stops the radio,
  and 20 s without the relay switches to the carry path.
- **Outbox** order, retry and offline rules; **sighting** aggregation and tag filter; **epoch**
  timer; **HUD** decode and view; **NEAR** transactions byte-equal to `near-api-js`; relay request
  and HUD signatures byte-equal to `apps/relay/src/auth.ts`; the referee box-key check.

## Build onto a phone

`bunx expo run:ios --device` does **not** pass `-allowProvisioningUpdates`, so Xcode falls back
to the wildcard team profile, which cannot carry the App Attest entitlement, and the build fails.
Use xcodebuild directly (the route that worked in the device spike on 2026-11-12).

1. Repo-root `.env.local` holds `APPLE_TEAM_ID`, `IOS_BUNDLE_ID` (and `TAIL_CONTRACT`, read as
   the default contract). `app.config.ts` reads only these public names.
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

1. Run the relay (`apps/relay`). On the first screen tap **Settings** and enter the relay
   address (`http://<Mac LAN IP>:8787` works: local networking is allowed for development) and
   check the contract. **Save**.
2. Enter a handle, **Join**. The phone generates its keys, App Attest attests them over the
   relay's challenge, and the relay creates `<handle>.<relay account>` with only this phone's
   function-call key.
3. Host: fill **New match** and **Create** (the zone is centred on you). **Share link** sends
   `tail://join/<code>`; others open it or paste the code into **Match code**.
4. Everyone: **Top up 10** (testnet: the relay credits test USDC), then **Join** (a NEAR
   `join_match` signed on the phone). Host: **Start** once enough players joined.
5. Briefing shows your target. **Hunt** starts beacon, scan, location and pocket mode. Keep the
   app in front; put the phone in a pocket screen-in (the proximity sensor turns the screen off).
   Do not press the side button: that locks the phone and stops the game.
6. Lock fills when you are near your target; heat when your hunter is near you. **STRIKE**
   appears at a full lock. **Handler** sells three hints with an optional question.
7. When you are out or the match ends: your head and **Replay data** (the relay's
   `GET /replay/:id`).

## What the relay must provide (assumed here)

| Need                  | Shape the app uses                                                                                                                                                                                                                                                                                                                                                                                                                   | State                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| The referee's box key | `GET /referee` → `{referee_pk, referee_box_pk, box_pk_sig}` (base64, the referee's `pubkeys` output). The app checks `box_pk_sig` = ed25519 over `SHA256("tail/referee-box/v1" ‖ box_pk)` under the `referee_pk` the match pinned on chain (`get_match`), and refuses to seal otherwise.                                                                                                                                             | **Not served yet.** Without it the briefing stops with the relay's 404 and no batch can be sealed. |
| Lobby and keys        | `GET /matches/:id` with `chain.players[].{account_id, head, out}`, `chain.referee_pk` (hex), `chain.stake`, `chain.token`, `keys[]`                                                                                                                                                                                                                                                                                                  | Served                                                                                             |
| Everything else       | `POST /enroll/challenge`, `POST /enroll`, `POST /matches`, `POST /matches/:id/start`, `POST /batch`, `GET /hud` (WebSocket), `POST /dev/topup`, `GET /replay/:id` as in `apps/relay/src/routes`                                                                                                                                                                                                                                      | Served                                                                                             |
| Mesh node             | An Offline Protocol node whose `off1…` address goes in Settings. It receives `{v: 1, type: "tail/batch", path, account, time_ms, sig, body}`: the exact signed `POST /batch` request, to replay into the relay. Two relay changes needed: accept a carried batch's signature older than the 60 s request window (the batch digest dedupe already stops replays), and enqueue before the SDK's delivery receipt matters for ordering. | **No node yet**                                                                                    |

Two more gaps the design pass needs filled:

- **Zone in `GET /matches/:id`.** The relay stores the zone and safehouses but does not return
  them. The app accepts `zone: {zone: {latE7, lonE7, radiusM}, safehouses: [...]}` (the shape
  `GET /replay/:id` already returns), draws it only if it hashes to the chain's `zone_hash`, and
  uses it for the out-of-zone banner. Until then: no zone edge, no safehouses, no zone banner.
- **Who tagged you.** The HUD has no field for it (a `@tail/protocol` change), so the tagged
  screen says your head went to your hunter and the replay shows who.

One relay behaviour to look at: the relay keeps the first copy of each sealed batch by digest
and answers a repeat with `queued: false`. If the referee ever rejects a batch for a seq gap, the
phone's resend of that same batch is then dropped as a duplicate, and that player's chain is stuck.
The phone avoids gaps (one upload at a time, in order), but the relay should allow re-queueing a
batch the referee rejected for `Seq`.

## Behind settings or not done

- **Mesh carry is off.** The relay has no mesh node, so Settings > Relay mesh node is empty and
  the hunt screen says "No signal" without claiming delivery. With an address set, after 20 s
  without the relay the phone starts the Offline Protocol SDK (`profile` = match id), sends the
  oldest sealed batch to that node, waits for the SDK's delivery receipt, then the next. Not
  exercised against a real node. Carrying for others while you have signal is not built: in Hunt
  mode the mesh runs only while you are dark (TECHNICAL.md 7).
- **Withdraw** is not in the app (the contract allows it from the player key); heads settle into
  the contract balance.
- **Replay** links to the relay's JSON (`GET /replay/:id`), not to the web replay app.
- **Splash mark**: the launch screen is the paper colour; the Trail mark appears on it once
  `packages/brand` writes `assets/splash-mark-512.png` (`app.config.ts` picks it up when present).
