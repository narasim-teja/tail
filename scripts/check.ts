// The gate: run before every commit. `bun run check` runs everything; `bun run check rust ts`
// runs only the named steps. Each step prints one line and the first failure stops the run.

import { existsSync, readdirSync } from "node:fs";
import { $ } from "bun";

type Step = { name: string; group: string; run: () => Promise<unknown> };

const root = new URL("..", import.meta.url).pathname;
$.cwd(root);

const dirsWith = (parent: string, file: string) =>
  existsSync(`${root}${parent}`)
    ? readdirSync(`${root}${parent}`)
        .map((d) => `${parent}/${d}`)
        .filter((d) => existsSync(`${root}${d}/${file}`))
    : [];

const contracts = dirsWith("contracts", "Cargo.toml");
const swiftDirs = ["apps/mobile/modules"].filter((d) => existsSync(`${root}${d}`));

const steps: Step[] = [
  { name: "biome (format + lint)", group: "ts", run: () => $`bunx biome ci .`.quiet() },
  { name: "typecheck", group: "ts", run: () => $`bun run --filter '*' typecheck`.quiet() },
  { name: "bun test", group: "ts", run: () => $`bun test`.quiet() },
  { name: "cargo fmt", group: "rust", run: () => $`cargo fmt --all --check`.quiet() },
  {
    name: "cargo clippy",
    group: "rust",
    run: () => $`cargo clippy --workspace --all-targets --locked -- -D warnings`.quiet(),
  },
  { name: "cargo test", group: "rust", run: () => $`cargo test --workspace --locked`.quiet() },
  ...contracts.flatMap((c): Step[] => [
    { name: `${c}: fmt`, group: "contract", run: () => $`cargo fmt --check`.cwd(`${root}${c}`).quiet() },
    {
      name: `${c}: clippy`,
      group: "contract",
      run: () => $`cargo clippy --all-targets --locked -- -D warnings`.cwd(`${root}${c}`).quiet(),
    },
    { name: `${c}: test`, group: "contract", run: () => $`cargo test --locked`.cwd(`${root}${c}`).quiet() },
  ]),
  // The referee is its own workspace, built for wasm32-wasip2 (OutLayer) and natively (the local
  // test referee, whose host and HTTPS backends only the native build compiles).
  ...(existsSync(`${root}crates/referee-wasi/Cargo.toml`)
    ? (["fmt", "clippy wasm32-wasip2", "clippy native"] as const).map(
        (kind): Step => ({
          name: `crates/referee-wasi: ${kind}`,
          group: "referee",
          run: () =>
            (kind === "fmt"
              ? $`cargo fmt --check`
              : kind === "clippy native"
                ? $`cargo clippy --all-targets --locked -- -D warnings`
                : $`cargo clippy --target wasm32-wasip2 --all-targets --locked -- -D warnings`
            )
              .cwd(`${root}crates/referee-wasi`)
              .quiet(),
        }),
      )
    : []),
  ...swiftDirs.map(
    (d): Step => ({
      name: `swift-format ${d}`,
      group: "swift",
      run: () => $`xcrun swift-format lint --strict --recursive ${d}`.quiet(),
    }),
  ),
  // Scans what is staged for the next commit; ignored files (.env, .keys/) are never staged.
  {
    name: "secrets (gitleaks, staged)",
    group: "secrets",
    run: () => $`gitleaks git --staged --no-banner --redact`.quiet(),
  },
];

const only = process.argv.slice(2);
const selected = only.length ? steps.filter((s) => only.includes(s.group)) : steps;

for (const step of selected) {
  const t0 = performance.now();
  try {
    await step.run();
    console.log(`ok    ${step.name}  (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    console.log(`FAIL  ${step.name}`);
    process.stdout.write(err.stdout?.toString() ?? "");
    process.stderr.write(err.stderr?.toString() ?? String(e));
    process.exit(1);
  }
}
console.log(`\nall ${selected.length} steps passed`);
