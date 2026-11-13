# `src/proximity`: the game-agnostic part of the hunt

Everything a phone does to prove, round after round, who it was near and where it was, with no
game rules in it. TAIL (`src/tail/`) is one game built on it; a different location game can reuse
it without TAIL's hunt.

It does:

- **Beacon and scan**: a rotating 128-bit token per epoch (`epoch.ts`), a scan filter for this
  match's tags only, and per-epoch sighting aggregates (`sightings.ts`).
- **Fixes**: CoreLocation fixes to ~1 Hz wire fixes, in strict time order across relaunches
  (`fixes.ts`).
- **Batches**: every `BATCH_MS` a hash-chained batch, signed by App Attest and sealed to the
  referee (`batch.ts`), carrying whatever actions the game queued, unread (`actions.ts`).
- **Outbox**: ordered upload with retry, kept until a signed HUD confirms it (`outbox.ts`), and the
  chain mended or rebuilt from the referee's `next_seq` / `chain_tip` (`chain.ts`).
- **HUD transport**: the authenticated HUD socket, and opening each sealed HUD only if the
  match's pinned referee key signed it, for this seat (`hud.ts`, `referee.ts`).
- **Mesh carry**: reports reach the relay through nearby phones while this one is offline
  (`carry/`). Off by default: on two iPhones it delivered reports, but with it on each phone heard
  the other's beacon in only 1 epoch of 8 (the app's README has the numbers).
- **Receipts**: after the match, every report checked against the log root anchored on NEAR, and
  presence proofs ("these two phones met") from the replay log (`receipts.ts`).
- **Log monitor**: every signed HUD root, and every root anchored on NEAR, checked with consistency
  proofs to be one growing log; a fork (two committed roots that contradict by themselves) is kept
  with both signed HUDs as evidence, and a relay proof that does not verify is kept as a relay
  fault and asked again with a growing wait (`monitor.ts`).
- **Request signing**: relay requests signed with the player's NEAR key (`auth.ts`, `relay.ts`).

`client.ts` wires all of it into one `ProximityClient`.

## Interface

```ts
const client = new ProximityClient(deps); // deps: ProximityDeps (ports and the saved record)
client.start(keys); // PlayerKeys from the referee; one client per match
client.start(keys, { reporting: false }); // socket, outbox and monitor only; the radio stays off
client.stop(); // radio and timers off; the outbox stays saved
client.stopReporting(); // the game says this player is done; socket stays open, no batch is built
client.resumeReporting(); // the radio and the batch loop again, while the match runs
client.queueAction(action); // a wire Action, carried in the next batch unread
await client.batchNow(); // send now instead of waiting for the next round
await client.checkAnchors(roots); // anchored roots read from NEAR, checked against the HUD roots
client.status(); // ProximityStatus: epoch, token, seq, queued, upload, socket, over, blocked, logFork, relayFault, …
client.onHud((hud, previous) => {}); // each verified HUD newer than the last
client.onReceipt((report) => {}); // each batch the relay took, once (HTTP or carried)
client.onFrame((message) => {}); // the game's socket frames: sealed lines, refusals
client.onNotice((notice) => {}); // unsigned, build-failed, rejected, rebuilt, invisible, log-forked, relay-bad-proof
client.onFix((fix) => {}); // each fresh location fix
client.onChange(() => {}); // status() may have changed
```

Every `on…` returns an unsubscribe function. `deps` brings the device and relay in as ports
(`RadioPort`, `assert`, `batchRequest`, `upload`, `hud`, `carry`, `log`, `save`), so tests drive it
with fakes (`client.test.ts`). `log` brings consistency proofs from the relay and anchored roots
from NEAR. `save` receives a `ProximityRecord` (chain, outbox, confirmed position, reports, HUD
tick, last fix time, unsent actions, the log monitor's place, any fork and relay fault); the game stores it
beside its own state.

The notices carry facts, not words: the game decides what to tell the player.

## Example: check-in at a landmark, with a witness

A player must reach a landmark while another player is in Bluetooth range; the referee sees both
in the batches (the fix, and the witness's token in the sightings) and says so in the HUD.

```ts
const client = new ProximityClient({ ...ports, record, carry: { kind: "off", why: "not used" } });
const checkIns = new Set<number>();
client.onFix((f) => {
  if (distanceM(f, LANDMARK) > 30 || checkIns.has(LANDMARK.id)) return;
  checkIns.add(LANDMARK.id);
  client.queueAction({ kind: "CheckIn", landmark: LANDMARK.id, nonce: nonce() });
  void client.batchNow();
});
client.onHud((hud) => show(hud.witnessed ? "Checked in, witnessed." : "Find a witness."));
client.start(keys);
```

This is a sketch, not code that runs today: `CheckIn` and `hud.witnessed` are not in the wire
format. The `Action` and `Hud` types are `@tail/protocol`'s, which today define TAIL's actions
(Hint, Strike) and TAIL's HUD fields. A new game adds its own action variants to `packages/protocol` (and the Rust twin)
and its rules to the referee; nothing in this folder changes.

## What stays the same for every game

- The wire constants (`EPOCH_MS`, `BATCH_MS`, the token and tag derivation) and the seal and
  signature domains come from `@tail/protocol`.
- The mesh SDK app id is `"tail"` (`carry/mesh.ts`), shared by every app on this protocol.

## Boundary

Nothing here imports from `src/tail/`, `src/screens/`, `src/ui/`, `src/relay/` (TAIL's own relay
calls) or `src/state/app.ts`. `boundary.test.ts` scans every import in this folder and fails if
one leaves it for anywhere but `src/lib`, `modules/`, `test/` or (in tests) the relay's source.

## Status

The same as the app's: these paths pass their tests here (`bun test`). On 2026-11-13 the beacon
and scan, batches, signed HUDs, the log monitor's consistency checks and the receipts ran on two
iPhones in a protocol v2 match, indoors, and mesh carry delivered reports between them in another
match while crowding out the beacon. Chain recovery (no report was refused), the monitor's fork
and relay-fault paths, presence proofs shared from a phone, and Leave match's `stopReporting`
mid-hunt with `resumeReporting` after it have not run on a phone yet.
