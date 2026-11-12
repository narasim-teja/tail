// Tick state design: sealed state handed back to the relay vs OutLayer storage read + write,
// at 1 KB, 16 KB and 128 KB of state. Calls `bench_state`, which runs exactly the tick's state
// round trip (open + rollback check + reseal, or get + set). The two modes alternate call by
// call so both see the same network and worker conditions.
// Run from the repo root: `bun crates/referee-wasi/scripts/latency.ts` (N=50 per cell).
import { balance, call, pct, spend } from "./lib.ts";

const N = Number(process.env["N"] ?? 50);
const SIZES = [1024, 16 * 1024, 128 * 1024];
// Hard stop well under the $0.50 budget for this crate.
const MAX_USD = Number(process.env["MAX_USD"] ?? 0.4);

type Row = { wall: number[]; enclave: number[]; inner: number[]; inBytes: number; blobBytes: number };
const rows = new Map<string, Row>();
const row = (k: string) => {
  const r = rows.get(k) ?? { wall: [], enclave: [], inner: [], inBytes: 0, blobBytes: 0 };
  rows.set(k, r);
  return r;
};

console.log(`balance before: ${await balance()}`);
for (const size of SIZES) {
  let state: string | undefined;
  let seq = 0;
  for (let i = 0; i < N; i++) {
    for (const mode of ["sealed", "storage"] as const) {
      const input =
        mode === "sealed"
          ? { cmd: "bench_state", mode, size, state, last_seq: seq }
          : { cmd: "bench_state", mode, size };
      const c = await call(input);
      if (c.output?.ok !== true)
        throw new Error(`${mode} ${size}: ${JSON.stringify(c.output).slice(0, 300)}`);
      const r = row(`${mode} ${size}`);
      r.wall.push(c.wall);
      r.enclave.push(c.enclave);
      r.inner.push(c.output.result.enclave_ms);
      r.inBytes = Math.max(r.inBytes, JSON.stringify({ input }).length);
      r.blobBytes = c.output.result.bytes;
      if (mode === "sealed") {
        state = c.output.result.state;
        seq = c.output.result.seq;
      }
      if (spend().usd > MAX_USD) throw new Error(`spend cap $${MAX_USD} reached`);
    }
  }
  console.log(`size ${size} done (${spend().calls} calls, $${spend().usd.toFixed(4)})`);
}

console.log(
  "\n| state | mode | n | wall p50 | wall p95 | wall max | enclave p50 | state work p50 | request body |\n|---|---|---|---|---|---|---|---|---|",
);
for (const [k, r] of rows) {
  const [mode, size] = k.split(" ");
  console.log(
    `| ${Number(size) / 1024} KB | ${mode} | ${r.wall.length} | ${pct(r.wall, 0.5).toFixed(0)} ms | ${pct(r.wall, 0.95).toFixed(0)} ms | ${Math.max(...r.wall).toFixed(0)} ms | ${pct(r.enclave, 0.5)} ms | ${pct(r.inner, 0.5)} ms | ${(r.inBytes / 1024).toFixed(0)} KB |`,
  );
}
const s = spend();
console.log(`\n${s.calls} calls, $${s.usd.toFixed(4)} (compute_cost sum). balance after: ${await balance()}`);
