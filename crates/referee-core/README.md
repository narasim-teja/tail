# referee-core

The TAIL rules engine (TECHNICAL.md 4.3–4.11, 5.2). Pure and deterministic: no I/O, no clock, no
randomness of its own. Time arrives as `now_ms`, `K_m` and the VRF signature come from the
caller. `referee-wasi` unseals, calls, signs and seals; `referee-sim` drives it from JSON traces.

## API

```rust
init(cfg: MatchConfig, devices: Vec<Device>, k_m: &[u8; 32], vrf_signature: &[u8; 64],
     start_ms: u64, call_id: CallId) -> Result<Started, InitError>
  // Started { state, verdicts: [Start], log, keys: Vec<(u16, PlayerKeys)> }
tick(state: State, input: TickInput) -> Result<TickOutput, TickError>
  // TickInput  { tick_no, now_ms, call_id, batches: Vec<BatchEnvelope>, receipts: Vec<HintReceipt> }
  // TickOutput { state, verdicts, huds: Vec<(u16, Hud)>, log, rejected, refused, hints, over }
finish(state: State, alpha: String, vrf_signature: &[u8; 64], call_id: CallId,
       receipts: Vec<HintReceipt>) -> Result<Finished, FinishError>
  // Finished { state, verdicts: [End], log }
```

- Verdicts come out as unsigned `VerdictPayload`s with `seq` and `call_id` already set; the
  wrapper signs `verdict_digest(payload)` and submits them in order. The engine needs `call_id`
  because each verdict's log entry is that digest.
- `State` is borsh. It holds `K_tag`, every `K_p`, the VRF signature and recent positions, so it
  must only leave the enclave sealed. Its `Debug` prints none of that. A `TickError` changes
  nothing: retry with the same sealed blob.
- The engine keeps the log as a Merkle frontier, not the log itself. Every call returns its new
  `LogEntry`s; the relay appends them to the stored log for `declassify` and inclusion proofs.

## Ordering (what referee-wasi and the contract rely on)

- Player index = position of the account id in byte-sorted order (the order `players_hash`
  hashes), whatever order `devices` arrives in. `Hint`, `Tag` and `Forfeit` use these indices.
- Verdict `seq` starts at 1 (`Start`) and is contiguous across `init`, every `tick` and `finish`.
- Within one tick: `Hint`/`Tag` in action order (below), then `Forfeit`s by player index, then
  `Checkpoint` if one is due. No `Checkpoint` on the tick that ends the match.
- A tick returns `over = true` when `now_ms ≥ end_ms` or one player is left. Later ticks fail
  with `NotRunning`. Call `finish` next. It emits `End` and passes in receipts for the last
  hints first.
- `Checkpoint` and `End` carry `(log_size, root)` of the log before their own entry. That entry is
  then appended, so the final log holds `End.log_size + 1` entries.
- Log order within a tick: hint receipts, accepted batches (by player, then seq), new contacts
  (by epoch, a, b), verdicts.

## Rules as implemented

**Batches (4.3).** First, authenticity: right `match_id`, the player is still in, `seq` is the
next one, `prev` is the hash of the previous batch, and the App Attest assertion over
`SHA256("tail/batch" ‖ borsh(batch))` verifies against the enrolled key for `app_id`, with a
counter above the last one. The cheap checks run first, and nothing changes unless all of them
pass, so a batch rejected for a seq gap can be sent again in order. An authentic batch moves
the player's chain forward even if it then fails validity. The phone chains on every batch it
sends, so a single bad batch must not cut it off for good. Validity:
`|t_ms − median| ≤ CLOCK_SKEW_MS`, no `Fix.flags` bit set, fixes strictly increasing in time and
no later than `t_ms`, no teleport. Only valid batches are logged and used.

**Contact (4.5).** A sighting counts for the token's own epoch `e`. The phone's `Sighting.epoch`
must be within 1 of `e` and within 1 of the batch's epoch. That is the replay check: an old
token resolves to an old epoch. Sightings below `RSSI_MIN_DBM` are dropped. `n` is summed over
every batch that reported that token. `contact(a, b, e)` holds when each side has `n ≥ MIN_SAMPLES`
for the other's epoch-e token, both have a usable fix (`acc ≤ MAX_ACC_M`) within
`FIX_WINDOW_MS` of the epoch midpoint (the nearest one counts), the two fixes are within
`GEO_SLACK_M + acc_a + acc_b`, neither fix is inside a safehouse, and neither player is
vehicle-frozen at the midpoint. Once established, a contact is never withdrawn.

**Lock, heat, strike (4.6).** `lock(h→t, e)` = contact epochs in `(e − WINDOW_EPOCHS, e]`;
heat is the same number seen from the target. HUDs carry the count (0..8); the phone divides by
`LOCK_EPOCHS`. A strike is judged at the epoch of its batch's `t_ms`: it needs `lock ≥ LOCK_EPOCHS`
and contact in that epoch or the one before. A tag moves the target's whole head to the
hunter, puts the target out, and the hunter inherits the target's target.

**Action order and the duel.** All actions of a tick are sorted by device `t_ms`, then by
`SHA256("tail/coin" ‖ SHA256(vrf_signature) ‖ u32le(tick_no) ‖ u16le(player))` (lower first),
then player, seq and position. Earlier ticks always win because ticks run in order. The coin
is secret until `End` reveals the VRF signature; after that the replay can recompute it. An action
by a player who is already out is refused with `PlayerOut`.

**Hints (4.7).** `price = hint_price(stake, kind)`, moved from the asker's head to the target's.
A hint is refused, and costs nothing, for: an unknown kind, text over 140 characters, a
cooldown (`HINT_COOLDOWN_MS` measured on device `t_ms`), a head below the price, or no usable fix
for the asker or the target. The fact comes from the latest usable fixes. NEAR: the distance
is at most `HINT_NEAR_M` (0/1). BEARING: 8-way direction from asker to target (0 = N, clockwise).
TREND: the distance now against the distance between both players' fixes nearest `t − HINT_TREND_MS`
(each within `FIX_WINDOW_MS`): 1 closer, 0 farther, 2 same (within `TREND_SAME_M`).
`hint_id` counts up from 0 across the match. A `HintReceipt` joins the log only for a hint
this referee issued, at most once, and within `RECEIPT_WINDOW_MS`.

**Dark and the zone.** A player is _present_ at a tick when that tick brought a valid batch
whose last usable fix is inside the zone. The zone is one circle, and you are out only when
`distance − acc > radius`. Leaving the zone, GPS off and rejected batches therefore all count
as dark. Gaps are measured on the referee clock (`now_ms`). Once a gap passes `DARK_LEAK_MS`,
the hunter's HUD carries the `LEAK_CELL_M` grid cell of the target's last usable fix, on every
tick until the target is present again. Dark time accrues only once a gap exceeds
`DARK_GRACE_MS`, and then counts in full from the gap's start. Cumulative dark time of
`DARK_FORFEIT_MS` forfeits the head to the hunter, who inherits the target.

**Vehicle.** Device-reported speed above `MAX_SPEED_MPS` on consecutive usable fixes for
`VEHICLE_HOLD_MS` freezes the player. The freeze runs from the start of the run until
`VEHICLE_FREEZE_MS` after its latest fast fix, and blocks contact for that player. The lock is
not held; it drains as the window slides.

**End.** A tick ends the match at `end_ms` or when one player is left. Actions with
`t_ms ≥ end_ms` are refused with `TimeUp`. Survivors keep their heads, and their HUD status
becomes `WON`. The sum of heads is constant from `Start` to `End`, and the simulator checks
that after every tick.

## Constants

From `tail_protocol::constants` (shared with TS): `EPOCH_MS` sets the token and contact period.
`WINDOW_EPOCHS` and `LOCK_EPOCHS` set the lock window and the strike threshold.
`RSSI_MIN_DBM` and `MIN_SAMPLES` decide which sightings count. `GEO_SLACK_M`, `MAX_ACC_M` and
`FIX_WINDOW_MS` decide which fixes count and how close they must be. `MAX_SPEED_MPS`,
`VEHICLE_HOLD_MS` and `VEHICLE_FREEZE_MS` set the vehicle freeze. `TELEPORT_MPS` sets the
implied speed beyond both accuracies, over at least 1 s, that rejects a batch.
`CLOCK_SKEW_MS` sets the batch clock tolerance. `DARK_LEAK_MS`, `LEAK_CELL_M` and
`DARK_FORFEIT_MS` drive the dark rules. `HINT_*` and `hint_bps` set hint prices and facts.
`CHECKPOINT_MS` sets how often roots are anchored.

Local to the engine (`referee_core::*`):

| Constant                      | Value       | Effect                                                                          |
| ----------------------------- | ----------- | ------------------------------------------------------------------------------- |
| `MIN_PLAYERS` / `MAX_PLAYERS` | 2 / 16      | Allowed match size (the product rule is 3–12; 2 allows duel tests)              |
| `MAX_DURATION_MS`             | 24 h        | Bounds every epoch number, so no arithmetic can overflow                        |
| `DARK_GRACE_MS`               | 20 s        | Gaps up to this cost no dark time (one or two missed ticks on a flaky network)  |
| `TREND_SAME_M`                | 10 m        | TREND says "same" inside this band                                              |
| `RECEIPT_WINDOW_MS`           | 120 s       | How long a hint waits for its voice receipt                                     |
| `KEEP_EPOCHS`                 | 12          | Per-epoch evidence kept: the lock window plus skew, e−1 and the TREND look-back |
| `COIN_DOMAIN`                 | `tail/coin` | Domain of the action tie-break coin                                             |

## Choices TECHNICAL.md did not fix

1. **Contact epoch = token epoch** (above). Reading "e′ ∈ {e−1, e, e+1}" as three contact epochs
   would let one 15 s encounter count three times toward the lock.
2. **Fix order** (strictly increasing, not after the batch) is an extra validity rule. Honest
   phones always meet it, and it stops a batch from rewriting the past.
3. **Teleport**: the implied speed is measured against the last accepted usable fix, beyond
   both accuracies. "Strike logged" means the batch shows up in `TickOutput.rejected`. There is
   no other penalty, but the gap counts as dark.
4. **Median device time**: one vote per player (their newest authentic batch), and the mean of
   the middle two for an even count. A phone uploading a backlog gets no extra weight, and a
   2-player match treats both clocks alike. A lone batch is its own median.
5. **Geometry**: distances use an equirectangular plane around the zone centre, with a Taylor
   cosine computed once. It is not haversine, but only `+ − × ÷ sqrt` are involved, so native,
   wasm and the replay agree bit for bit. The error is under 0.1 % across a city zone.
6. **Leak cell**: a grid anchored at the zone centre. The HUD carries the cell centre.
7. **Hint cooldown and strike epoch** use device `t_ms` (the action's time). Dark timing uses
   `now_ms`.
8. **Zero-price hints** (stake under 50 units) are allowed and emit `Hint` with amount 0.
9. **finish** checks the VRF signature against the ring commitment. It does not check that
   `alpha` names this match; the contract must (`alpha` ends with `:` + hex(match_id)).
10. **Rejections and refusals** are not in the HUD wire format. `TickOutput.rejected` and
    `TickOutput.refused` carry them for the relay or UI (for example "simulated location rejected").
11. A device clock that jumps far ahead in a batch that is alone in its tick gets accepted.
    Its later fixes then fail the fix-order rule until the clock catches up. That costs only
    the player whose clock is wrong.
