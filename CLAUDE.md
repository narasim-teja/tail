# TAIL

Instructions for anyone changing this repo, people and coding agents alike. `AGENTS.md` is a
symlink to this file. The game is in [docs/IDEA.md](docs/IDEA.md); the build spec, constants and
wire formats are in [docs/TECHNICAL.md](docs/TECHNICAL.md), which wins on mechanics.

## Layout

```
packages/protocol/   TS wire formats + crypto; vectors/ are the golden test vectors
packages/log/        pino logger with secret redaction (every TS service logs through it)
crates/tail-protocol Rust twin of packages/protocol (features: beacon, seal)
crates/appattest     App Attest assertion verification (p256)
crates/referee-core  pure, deterministic rules engine
crates/referee-sim   scripted matches through referee-core
crates/referee-wasi  OutLayer enclave wrapper (own workspace, wasm32-wasip2)
contracts/tail/      NEAR contract (own workspace, cargo near)
apps/relay/          Bun + Hono relay (untrusted: liveness only)
apps/mobile/         Expo dev-client iOS app (+ modules/tail-radio, Swift)
apps/replay/         web replay + verifier
docs/, spikes/       local only (gitignored): design docs and throwaway spikes
vendor/, .keys/      local only: cloned reference repos, generated keys
```

## Commands

```sh
bun install                         # root workspace (packages/*, apps/*)
bun run check                       # the gate: biome, typecheck, bun test, cargo fmt/clippy/test,
                                    # contract, referee-wasi, swift-format, gitleaks (staged)
bun run check rust contract         # only some groups: ts, rust, contract, referee, swift, secrets
bun run fix                         # biome --write + cargo fmt
bun run --cwd packages/protocol vectors   # regenerate golden vectors (wire-format change only)
cargo near build non-reproducible-wasm    # in contracts/tail
OUTLAYER_NETWORK=testnet outlayer upload <wasm> && outlayer deploy <name> <url>
```

Toolchains: Rust pinned by `rust-toolchain.toml` (1.100.0, with wasm32-unknown-unknown and
wasm32-wasip2), except `crates/referee-wasi`, which pins 1.94.1: OutLayer's worker (wasmtime 36)
serves WASI up to 0.2.6, and newer Rust std imports 0.2.12 ("Failed to instantiate component").
Check `wasm-tools component wit <wasm> | grep import` before moving that pin, Bun 1.4, TypeScript 7, Biome 2.6, gitleaks. Lints: Biome (TS), clippy pedantic
with `-D warnings` (Rust), swift-format `--strict` (Swift).

`docs/` and `spikes/` are local working material and are gitignored, never published. Anything
from them that belongs in the public repo goes into `README.md` or `ARCHITECTURE.md`.

## Rules

- **Never without Teja's explicit yes:** pushing or making the repo public, any mainnet
  transaction, spending real tokens, posting on X, sending the submission, committing secrets.
  Testnet transactions and `usdc.fakes.testnet` are fine.
- **Spikes first.** Don't build on anything marked ASSUMED in TECHNICAL.md until its spike passes.
  When a spike fails, take the listed fallback and update TECHNICAL.md.
- **One wire format.** `packages/protocol` (TS) and `crates/referee-core` (Rust) agree byte for
  byte, pinned by `packages/protocol/vectors/*.json`.
- **Claim only what runs.** The README is screened by an AI judge. Anything stubbed says so.
- **Secrets.** Real values live in `.env`, `.env.local` and `.keys/` (all ignored). Every new
  variable gets a placeholder in `.env.example` in the same change. Never print a private key,
  payment key or API key to the terminal; print a fact about it (present, length, prefix).
- **Stack.** TypeScript on Bun (Hono for HTTP) everywhere, except the contract and referee (Rust)
  and the radio module (Swift). Pin exact versions (`bunfig.toml` sets `exact = true`).
- **Logging.** TS services log through `@tail/log` (pino, secrets redacted); never `console.log`
  outside scripts and tests (Biome enforces it).
- **LLMs.** Only cheap NEAR-hosted open-weight models (`owned_by: "nearai"`); never OpenAI or
  Anthropic models.
- **Root causes.** Fix the design that allowed a problem. No special cases, no loosened tests,
  no TODO stubs.
- **Parallel agents.** Each one owns disjoint folders; no git commands that change files; no
  installs except in a folder outside the root workspace that the agent owns.
- Comments explain why. User-facing text is short and plain.

## Commits

- Conventional prefixes (`feat:`, `fix:`, `test:`, `docs:`, `chore:`), optionally scoped
  (`feat(contract):`). One change per commit.
- No `Co-Authored-By` lines.
- Commit finished, gated work in small logical batches as it lands (the main session commits;
  agents never do). Never push unless Teja says so.
