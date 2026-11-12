// Shared by smoke.ts and latency.ts: repo-root .env.local, the HTTPS call, spend tracking.
// Never prints the payment key; prints facts about it instead.
import { dirname, join } from "node:path";

const root = join(dirname(import.meta.path), "../../..");

/** Bun auto-loads .env only from the cwd, so the repo-root file is read explicitly. */
async function loadEnv(): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  const text = await Bun.file(join(root, ".env.local")).text();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    env[m[1] as string] = (m[2] as string).replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

const env = await loadEnv();
const need = (k: string) => {
  const v = process.env[k] ?? env[k];
  if (!v || v.startsWith("your-")) throw new Error(`${k} is missing from .env.local`);
  return v;
};

export const API = need("OUTLAYER_API");
export const OWNER = need("OUTLAYER_OWNER");
// .env.local's OUTLAYER_PROJECT names the S2 spike; the referee is its own project.
export const PROJECT = process.env["REFEREE_PROJECT"] ?? "tail-referee";
// A payment key is scoped to projects at creation and the scope cannot change later, so the
// referee may need a key of its own: REFEREE_PAYMENT_KEY wins over OUTLAYER_PAYMENT_KEY.
const paymentKey =
  process.env["REFEREE_PAYMENT_KEY"] ?? env["REFEREE_PAYMENT_KEY"] ?? need("OUTLAYER_PAYMENT_KEY");
// Pins a deployed version (its wasm sha256) instead of the active one, so a new build can be
// tried while another script still runs against the active version.
const VERSION = process.env["REFEREE_VERSION"];
console.log(
  `${VERSION ? `version ${VERSION.slice(0, 12)}…; ` : ""}payment key: present, ${paymentKey.length} chars, owner ${paymentKey.split(":")[0]}; project ${OWNER}/${PROJECT}`,
);

/** The referee's JSON as parsed; the scripts check each field they read. */
// biome-ignore lint/suspicious/noExplicitAny: untyped JSON from the API, checked field by field by the callers
export type Json = any;

export type Call = { wall: number; enclave: number; cost: number; id: string; output: Json; status: number };

let spent = 0;
let calls = 0;
export const spend = () => ({ calls, usd: spent / 1e6 });

export async function call(input: object): Promise<Call> {
  const t0 = performance.now();
  const r = await fetch(`${API}/call/${OWNER}/${PROJECT}`, {
    method: "POST",
    headers: { "X-Payment-Key": paymentKey, "Content-Type": "application/json" },
    body: JSON.stringify(VERSION ? { input, version_key: VERSION } : { input }),
  });
  const wall = performance.now() - t0;
  const text = await r.text();
  let j: Json;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  const cost = Number(j.compute_cost ?? 0);
  calls++;
  spent += Number.isFinite(cost) ? cost : 0;
  return { wall, enclave: Number(j.time_ms), cost, id: j.call_id, output: j.output ?? j, status: r.status };
}

/** Calls a command and returns its `result`, or throws with the referee's error. */
export async function ok(cmd: string, args: object = {}): Promise<{ result: Json; call: Call }> {
  const c = await call({ cmd, ...args });
  if (c.output?.ok !== true) throw new Error(`${cmd}: ${JSON.stringify(c.output).slice(0, 500)}`);
  return { result: c.output.result, call: c };
}

/** Calls a command that must fail, and returns its error text. */
export async function refused(cmd: string, args: object = {}): Promise<string> {
  const c = await call({ cmd, ...args });
  if (c.output?.ok !== false)
    throw new Error(`${cmd} should have been refused: ${JSON.stringify(c.output).slice(0, 300)}`);
  return String(c.output.error);
}

export async function balance(): Promise<string> {
  const r = await fetch(`${API}/payment-keys/balance`, { headers: { "X-Payment-Key": paymentKey } });
  return r.ok ? JSON.stringify(await r.json()) : `HTTP ${r.status}`;
}

export const pct = (a: number[], p: number) =>
  [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] as number;
