// Shared by smoke.ts, match.ts and latency.ts: the call to the referee, spend tracking, and the
// App Attest assertion a ghost phone signs. Two targets:
// - hosted OutLayer (default): repo-root .env.local, HTTPS. Never prints the payment key;
//   prints facts about it instead.
// - REFEREE_MODE=local: the local test referee binary (`cargo build --release` in this crate),
//   one process per call, keys in TAIL_LOCAL_REFEREE_DIR (a fresh temp dir when unset). It is
//   not an enclave; see README "Local test referee".
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// Already installed under the protocol package; imported by path rather than installed here.
import { p256 } from "../../../packages/protocol/node_modules/@noble/curves/nist.js";
import { concat, sha256, utf8 } from "../../../packages/protocol/src/index.ts";

const root = join(dirname(import.meta.path), "../../..");
export const LOCAL = process.env["REFEREE_MODE"] === "local";

/** Bun auto-loads .env only from the cwd, so the repo-root file is read explicitly. */
async function loadEnv(): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  const file = Bun.file(join(root, ".env.local"));
  if (LOCAL && !(await file.exists())) return env;
  for (const line of (await file.text()).split("\n")) {
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

/** The account the scripts' test players live under; locally also the VRF alpha's sender. */
export const OWNER = LOCAL
  ? (process.env["TAIL_LOCAL_REFEREE_OWNER"] ?? "relay.testnet")
  : need("OUTLAYER_OWNER");

/** The referee's JSON as parsed; the scripts check each field they read. */
// biome-ignore lint/suspicious/noExplicitAny: untyped JSON from the API, checked field by field by the callers
export type Json = any;

export type Call = { wall: number; enclave: number; cost: number; id: string; output: Json; status: number };

let spent = 0;
let calls = 0;
export const spend = () => ({ calls, usd: spent / 1e6 });

type Backend = { call: (input: object) => Promise<Call>; balance: () => Promise<string> };

function outlayer(): Backend {
  const API = need("OUTLAYER_API");
  // .env.local's OUTLAYER_PROJECT names the S2 spike; the referee is its own project.
  const PROJECT = process.env["REFEREE_PROJECT"] ?? "tail-referee";
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
  return {
    async call(input) {
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
      spent += Number.isFinite(cost) ? cost : 0;
      return {
        wall,
        enclave: Number(j.time_ms),
        cost,
        id: j.call_id,
        output: j.output ?? j,
        status: r.status,
      };
    },
    async balance() {
      const r = await fetch(`${API}/payment-keys/balance`, { headers: { "X-Payment-Key": paymentKey } });
      return r.ok ? JSON.stringify(await r.json()) : `HTTP ${r.status}`;
    },
  };
}

function local(): Backend {
  const bin = join(root, "crates/referee-wasi/target/release/tail-referee");
  const dir = process.env["TAIL_LOCAL_REFEREE_DIR"] ?? mkdtempSync(join(tmpdir(), "tail-local-referee-"));
  console.log(`local test referee ${bin}, keys in ${dir}, owner ${OWNER}`);
  return {
    async call(input) {
      const t0 = performance.now();
      const p = Bun.spawn([bin], {
        stdin: new TextEncoder().encode(JSON.stringify(input)),
        stdout: "pipe",
        stderr: "inherit",
        // Ghosts enrol software keys, which only a referee taking unattested devices accepts.
        env: {
          ...process.env,
          TAIL_LOCAL_REFEREE_DIR: dir,
          TAIL_LOCAL_REFEREE_OWNER: OWNER,
          ALLOW_UNATTESTED: "1",
        },
      });
      const text = await new Response(p.stdout).text();
      await p.exited;
      const wall = performance.now() - t0;
      const output = JSON.parse(text);
      // Each process draws its own call id and reports it where the command has one.
      return {
        wall,
        enclave: wall,
        cost: 0,
        id: output.result?.call_id ?? "",
        output,
        status: p.exitCode ?? 0,
      };
    },
    balance: async () => "local test referee: no payment",
  };
}

const backend = LOCAL ? local() : outlayer();

export async function call(input: object): Promise<Call> {
  calls++;
  return backend.call(input);
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

export const balance = () => backend.balance();

export const pct = (a: number[], p: number) =>
  [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] as number;

// ── App Attest assertion, byte for byte as the Secure Enclave builds it ──────────
export const APP_ID = "LKABS9RZAC.com.lkabs9rzac.tail";

const cborHead = (major: number, len: number) =>
  len < 24
    ? [(major << 5) | len]
    : len < 256
      ? [(major << 5) | 24, len]
      : [(major << 5) | 25, len >> 8, len & 0xff];
const cborBytes = (b: Uint8Array) => [...cborHead(2, b.length), ...b];
const cborText = (s: string) => [...cborHead(3, utf8(s).length), ...utf8(s)];
const u32be = (n: number) => Uint8Array.of(n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);

/** authenticatorData = SHA256(app_id) ‖ flags 0 ‖ u32be(counter); ECDSA over SHA256(SHA256(auth ‖ cdh)). */
export function assertion(sk: Uint8Array, clientDataHash: Uint8Array, counter: number): Uint8Array {
  const auth = concat(sha256(utf8(APP_ID)), Uint8Array.of(0), u32be(counter));
  const nonce = sha256(concat(auth, clientDataHash));
  // prehash: the verifier's ECDSA hashes its message (the nonce) with SHA-256 once more.
  const sig = p256.sign(nonce, sk, { prehash: true, format: "der" });
  return Uint8Array.from([
    0xa2,
    ...cborText("signature"),
    ...cborBytes(sig),
    ...cborText("authenticatorData"),
    ...cborBytes(auth),
  ]);
}

export { p256 };
