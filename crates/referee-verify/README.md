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

```text
start       3 players  log     4  root adb7269d9c09  [Start]
tick    1  +   10.0s  batches   6 (6 asserted, 0 unasserted, 0 withheld)  rejected 0  receipts 0  log    14  root f1eb01dbcd20
…
tick   13  +  130.0s  batches   6 (6 asserted, 0 unasserted, 0 withheld)  rejected 0  receipts 0  log   133  root 96a156d5fe03  [Tag bob→alice, Tag carol→bob]
end         log   134  root 0456b63b0677  [End 133 96a156d5fe03]
PASS      every verdict and log entry follows from the released inputs
```

Then forge a verdict. `--forge-tag` swaps the first Tag's hunter and target and signs it with the
referee key, so the signature is valid:

```sh
cargo run -q -p referee-verify --example demo-bundle -- --forge-tag > /tmp/forged.json
cargo run -q -p referee-verify -- /tmp/forged.json
```

```text
FAIL      tick 13: verdict seq 5: the bundle has seq 5 Tag alice→bob (…), re-execution gives seq 5 Tag bob→alice (…)
```

For a real match, save `GET /replay/:id` from the relay and run `tail-verify --strict` on that
file. `apps/server/test/replay-verify.test.ts` does that for a match judged by the local
referee. `--older-relay` makes the demo bundle look like one from a relay before it released
the fields below.

The exit status is 0 when the re-execution matches, 1 when a check fails or the re-execution
diverges, and 2 when the input is not a v2 bundle. With `--strict`, a pass that had to trust
part of the log exits 3. Pass `--app-id` when the bundle has no `match.appId`.

## What it checks

1. Every `leaves[i]` is the RFC 6962 leaf of `log[i]`.
2. Every verdict's ed25519 signature verifies against `referee.refereePk`. Signatures are not
   re-created, since the verifier has no referee key.
3. The VRF signature verifies over `vrfAlpha` against `vrfPk`, and the alpha names this match.
4. Re-execution. `init` runs from the match config, the `Enrolled` entries, `K_m`, the VRF
   signature and Start's `call_id`. Each `Tick { tick_no, now_ms, call_id }` entry then runs
   one engine tick. Its input is the receipts logged right after it, plus the batches its `Batch`
   and `Rejected` entries name, found by hash among the released batches. Last, `finish` runs
   with End's `call_id` and the receipts logged before End. Each call's new log entries must
   equal the bundle's next ones, byte for byte: salts from `K_log`, contact epochs, `Evidence`,
   every verdict digest. Each new verdict must have the same digest as the bundle's, `prev`
   included, so Checkpoint and End roots match too. The first difference stops the run and names
   the tick, the log index or verdict seq, and both versions.

When one tick holds several batches with the same (player, seq), from a resend or a duplicate,
the input order is rebuilt from the log. The batch that passed goes right before the first
`SEQ` refusal of its pair, which is the only order that gives the logged results.

## What it takes from the log, and says so

The relay's bundle (`packages/protocol` `ReplayBundleV2`) has the log, the accepted batches,
`K_m` and the VRF reveal, and since these optional fields were added, everything else the engine
read. Bundles from before lack them, and then:

| Field                   | What it is                                                                                 | Without it                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `devices[].appAttestPk` | The key the referee enrolled (`declassify`), hex. It must hash to the `Enrolled` key hash. | The key hash comes from the log, and that player's assertions cannot be checked.                                                |
| `assertions[]` (b64)    | Parallel to `batches`, as `declassify_batches` returns them.                               | App Attest outcomes come from the log (`ASSERTION` refusals). Every other check still runs.                                     |
| `rejected[]`            | `{ batch, assertion }` for each refused envelope that is not already in `batches`.         | A `Rejected` entry with no released batch is taken as given (`Withheld`). For a validity refusal, the chain must still advance. |
| `match.appId`           | The App ID the relay gave `start`.                                                         | `--app-id`, or the production App ID by default.                                                                                |

A refused batch is found by hash like an accepted one; the relay keeps them apart because the
web replay draws `batches` as trails. A batch that never opened, or opened as another match's,
is not released (`declassify_batches` refuses it), so its `Rejected` entry stays `Withheld`.

Each released batch must hash to its logged entry, and an accepted batch that is missing fails
the run. Enrolment counters default to 0, the value `start` uses.

## What it cannot check

- **On-chain state.** It does not query NEAR. The web replay compares the anchored roots, the
  contract's verdict seq and the referee and VRF keys with the chain.
- **That the referee saw every batch sent.** A batch the relay or the referee dropped before
  the tick is not in the log. Phones check their own batches with inclusion receipts.
- **Enrolment.** `Enrolled.attested` is the referee's record. The Apple attestation is not in
  the bundle.
- **HUDs, player keys and Handler lines.** They were sealed to the players. The NEAR AI
  signature in a `HintReceipt` is checked by the web replay.
- **Which code ran.** Each verdict's `call_id` names an OutLayer call whose attestation record
  gives the executed wasm hash. This tool does not fetch it.
