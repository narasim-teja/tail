# referee-verify

`tail-verify` re-runs a finished match from its replay bundle and checks that every verdict and
every log entry the referee produced follows from the inputs it logged. Like a fraud proof, it
does not take the referee's word for anything it can recompute. It runs
[`referee-core`](../referee-core/README.md), the same rules engine the referee runs, natively.

## Try it

```sh
cargo run -q -p referee-verify --example demo-bundle > /tmp/match.json
cargo run -q -p referee-verify -- /tmp/match.json
```

The output looks like this. The roots and keys shown are illustrative: they change whenever
the scripted match or the engine does.

```text
start       3 players  log     4  root adb7269d9c09  [Start]
tick    1  +   10.0s  batches   6 (6 asserted, 0 unasserted, 0 withheld)  rejected 0  receipts 0  log    14  root f1eb01dbcd20
…
tick   13  +  130.0s  batches   6 (6 asserted, 0 unasserted, 0 withheld)  rejected 0  receipts 0  log   133  root 16a4e82dbbe3  [Tag bob→alice, Tag carol→bob]
end         log   134  root 83d7706b7b5f  [End 133 16a4e82dbbe3]

input     referee_pk d04ab232… from the bundle, not pinned: pass --referee-pk with the contract's get_match value
input     vrf_pk a09aa5f4… from the bundle, not pinned: pass --vrf-pk with the contract's get_match value
input     app id SIMTEAM.dev.tail.sim from the bundle's match.appId
input     App Attest keys of 3 of 3 players from the bundle's devices[]; re-execution checks each against its Enrolled entry's key hash
input     players, start and end times from the bundle's match, bound by Start's signed players_hash and times
input     each Enrolled entry's attested flag is the referee's own record: Apple's attestation is not in the bundle
input     stake 1000000, zone and 0 safehouses from the bundle's match; not compared with NEAR
warning   the bundle's app id SIMTEAM.dev.tail.sim is not the expected LKABS9RZAC.com.lkabs9rzac.tail (--app-id): App Attest assertions were checked against the bundle's
checked   7 verdict signatures verify against referee_pk d04ab232742b
checked   VRF signature verifies over alpha; the ring and the action coin derive from it
checked   re-executed 134 log entries and 7 verdicts: all identical; final root 83d7706b…
checked   81 batch occurrences re-checked with App Attest against the device keys (app id SIMTEAM.dev.tail.sim)
PASS      every verdict and log entry follows from the inputs above, under the bundle's own referee and VRF keys, not pinned
```

A pass says the verdicts follow from the `input` lines. It does not say those inputs are the
match NEAR holds: a bundle made up under its own keys re-executes just as cleanly. Pin the keys
to the contract's `get_match` values (`--referee-pk`, `--vrf-pk`) and the App ID (`--app-id`)
to rule that out; the web replay compares the rest with NEAR.

Then forge a verdict. `--forge-tag` swaps the first Tag's hunter and target and signs it with the
referee key, so the signature is valid:

```sh
cargo run -q -p referee-verify --example demo-bundle -- --forge-tag > /tmp/forged.json
cargo run -q -p referee-verify -- /tmp/forged.json
```

```text
FAIL      tick 13: verdict seq 5: the bundle has seq 5 Tag alice→bob (…), re-execution gives seq 5 Tag bob→alice (…)
```

For a real match, save `GET /replay/:id` from the relay and run `tail-verify` on that file with
the keys pinned. `apps/server/test/replay-verify.test.ts` does that for a match judged by the
local referee. `--older-relay` makes the demo bundle look like one from a relay before it
released the fields below.

`cargo run -q -p referee-verify --example economy-bundle > economy.json` plays a 12-player,
60-minute match with scripted walkers that buy demand-priced hints in waves and tag along the
ring, and prints its bundle (`--summary` prints what happened instead); it is the web replay's
`boston-common-economy` fixture, and `tail-verify` passes it with nothing trusted.

| Flag               | Effect                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `--referee-pk HEX` | The bundle's `referee.refereePk` must be this key, or the run fails (`pins`).                                                            |
| `--vrf-pk HEX`     | The bundle's `referee.vrfPk` must be this key, or the run fails (`pins`).                                                                |
| `--app-id ID`      | The App ID expected. Used when the bundle names none; a bundle naming another one gets a `warning` line. Default: the production App ID. |
| `--allow-trusted`  | Exit 0 even when something was taken from the log (`trusted` lines).                                                                     |
| `--strict`         | The default; accepted for older callers.                                                                                                 |

| Exit | Meaning                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------- |
| 0    | The re-execution matches, and nothing was trusted (or `--allow-trusted` accepted it).                          |
| 1    | A check failed, a pinned key differs, or the re-execution diverged. The report names the first tick and entry. |
| 2    | The input is not a v2 bundle, or the arguments are wrong.                                                      |
| 3    | The re-execution matches, but only with items taken from the log; each is printed as a `trusted` line.         |

## What it checks

1. With `--referee-pk` or `--vrf-pk`, the bundle's keys are the pinned ones.
2. Every `leaves[i]` is the RFC 6962 leaf of `log[i]`.
3. Every verdict's ed25519 signature verifies against `referee.refereePk`. Signatures are not
   re-created, since the verifier has no referee key.
4. The VRF signature verifies over `vrfAlpha` against `vrfPk`, and the alpha names this match.
5. Re-execution. `init` runs from the match config, the `Enrolled` entries, `K_m`, the VRF
   signature and Start's `call_id`. Each `Tick { tick_no, now_ms, call_id }` entry then runs
   one engine tick. Its input is the receipts logged right after it, plus the batches its `Batch`
   and `Rejected` entries name, found by hash among the released batches. Last, `finish` runs
   with End's `call_id` and the receipts logged before End. Each call's new log entries must
   equal the bundle's next ones, byte for byte: salts from `K_log`, contact epochs, `Evidence`,
   every verdict digest. Each new verdict must have the same digest as the bundle's, `prev`
   included, so Checkpoint and End roots match too. The first difference stops the run and names
   the tick, the log index or verdict seq, and both versions. After End, the bundle may hold
   no further log entry or verdict.

When one tick holds several batches with the same (player, seq), from a resend or a duplicate,
the input order is rebuilt from the log. The batch that passed goes right before the first
`SEQ` refusal of its pair, which is the only order that gives the logged results.

## What it takes from the log, and says so

The relay's bundle (`packages/protocol` `ReplayBundleV2`) has the log, the accepted batches,
`K_m` and the VRF reveal, and since these optional fields were added, everything else the engine
read. Bundles from before lack them, and then:

| Field                   | What it is                                                                                              | Without it                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `devices[].appAttestPk` | The key the referee enrolled (`declassify`), hex. It must hash to the `Enrolled` key hash.              | The key hash comes from the log, and that player's assertions cannot be checked.                                                |
| `assertions[]` (b64)    | Parallel to `batches`, as `declassify_batches` returns them.                                            | App Attest outcomes come from the log (`ASSERTION` refusals). Every other check still runs.                                     |
| `rejected[]`            | `{ batch, assertion }` for each refused envelope that is not already in `batches`.                      | A `Rejected` entry with no released batch is taken as given (`Withheld`). For a validity refusal, the chain must still advance. |
| `match.appId`           | The App ID the relay gave `start`. A value other than `--app-id` (default: production) is warned about. | `--app-id`, or the production App ID by default.                                                                                |

A refused batch is found by hash like an accepted one; the relay keeps them apart because the
web replay draws `batches` as trails. A batch that never opened, or opened as another match's,
is not released (`declassify_batches` refuses it), so its `Rejected` entry stays `Withheld`.

Each released batch must hash to its logged entry, and an accepted batch that is missing fails
the run. Enrolment counters default to 0, the value `start` uses.

## What it cannot check

- **On-chain state.** It does not query NEAR. Without `--referee-pk` and `--vrf-pk` it checks
  signatures against the bundle's own keys. The web replay compares the anchored roots, the
  contract's verdict seq and the referee and VRF keys with the chain. Stake, zone and
  safehouses are the bundle's.
- **That the referee saw every batch sent.** A batch the relay or the referee dropped before
  the tick is not in the log. Phones check their own batches with inclusion receipts.
- **Enrolment.** `Enrolled.attested` is the referee's record. The Apple attestation is not in
  the bundle.
- **HUDs, player keys and Handler lines.** They were sealed to the players. The NEAR AI
  signature in a `HintReceipt` is checked by the web replay.
- **Which code ran.** Each verdict's `call_id` names an OutLayer call whose attestation record
  gives the executed wasm hash. This tool does not fetch it.
