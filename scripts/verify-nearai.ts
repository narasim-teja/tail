// Checks that the key signing the Handler's lines is held in NEAR AI's sealed hardware, the way
// docs.near.ai/cloud/verification/model describes, and saves the result for the replay.
//
//   bun scripts/verify-nearai.ts                       the Handler model's current attestation
//   bun scripts/verify-nearai.ts <bundle.json>         and each HintReceipt's signing_address
//   bun scripts/verify-nearai.ts <match id> [--relay <url>]   the same, from the relay's /replay
//   bun scripts/verify-nearai.ts 0x<address>           and one address
//   options: --model <id> (default: the referee's), --out <path> (default:
//            apps/web/public/nearai-attestation.json), --no-save
//
// Where each check runs:
//   local    TDX quote (dcap-qvl wasm, collateral from Intel's PCS, every piece Intel-signed),
//            report data (key + nonce), container manifest hash, NRAS token signatures and claims,
//            HintReceipt address match;
//   NVIDIA   the GPU evidence itself is judged by NVIDIA's attestation service (NRAS).
// Nothing pins NEAR AI's expected image: NEAR AI publishes no MRTD, RTMRs or manifest to compare
// with, so a pass shows a genuine, non-debug TDX VM holds the key, not which code it runs.
// NEARAI_API_KEY comes from .env.local (or the environment). It is sent to NEAR AI only and never
// printed or saved.

import { collateral, quoteVerifier } from "../apps/web/scripts/qvl.ts";
import { decodeBundle } from "../apps/web/src/verify/bundle.ts";
import { checkHandler } from "../apps/web/src/verify/checks.ts";
import {
  type Check,
  checkGpu,
  checkNode,
  checkSigner,
  freshNonce,
  HANDLER_MODEL,
  INTEL_PCS,
  modelAttestations,
  NRAS_JWKS_URL,
  NRAS_URL,
  nodeOk,
  reportUrl,
  type SavedReceipt,
  type SavedResult,
} from "../apps/web/src/verify/nearai.ts";

const root = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const model = flag("--model") ?? HANDLER_MODEL;
const relay = (flag("--relay") ?? "http://localhost:8787").replace(/\/+$/, "");
const out = flag("--out") ?? `${root}apps/web/public/nearai-attestation.json`;
const save = !args.includes("--no-save");
const target = args.find((a) => !a.startsWith("--")) ?? null;

if (/^(openai|anthropic)\//i.test(model)) {
  console.error(`${model}: OpenAI and Anthropic models are not used in TAIL`);
  process.exit(2);
}

async function apiKey(): Promise<string> {
  const file = Bun.file(`${root}.env.local`);
  const text = (await file.exists()) ? await file.text() : "";
  const line = text.split("\n").find((l) => l.startsWith("NEARAI_API_KEY="));
  return (
    (line
      ?.slice("NEARAI_API_KEY=".length)
      .trim()
      .replace(/^["']|["']$/g, "") ||
      process.env["NEARAI_API_KEY"]) ??
    ""
  );
}

async function json(res: Response, what: string): Promise<unknown> {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** HintReceipts to compare: from a bundle file, a relay match id, or one address. */
async function receipts(
  t: string,
): Promise<{ hintId: number; signingAddress: string; signature: SavedReceipt["signature"] }[]> {
  if (/^0x[0-9a-f]{40}$/i.test(t))
    return [{ hintId: -1, signingAddress: t.toLowerCase(), signature: "unchecked" }];
  const raw = /^[0-9a-f]{32}$/i.test(t)
    ? await json(await fetch(`${relay}/replay/${t.toLowerCase()}`), `relay ${relay}`)
    : await Bun.file(t).json();
  const d = decodeBundle(raw);
  const sig = checkHandler(d);
  return d.log.flatMap((e) =>
    e.entry?.kind === "HintReceipt" && e.entry.signingAddress !== ""
      ? [
          {
            hintId: e.entry.hintId,
            signingAddress: e.entry.signingAddress.toLowerCase(),
            signature: sig.get(e.entry.hintId)?.signature ?? "unchecked",
          },
        ]
      : [],
  );
}

const mark = (ok: boolean) => (ok ? "PASS" : "FAIL");
const by = (c: Check) => (c.by === "nvidia" ? "NVIDIA NRAS" : "local");
const NAMES: Record<Check["id"], string> = {
  tdx: "Intel TDX quote is genuine and up to date (TD not in debug mode)",
  address: "the quote names the signing key",
  nonce: "the quote carries our fresh nonce",
  compose: "the quote measures the report's container manifest (not pinned to an expected one)",
  gpu: "GPUs attested by NVIDIA for the same nonce",
  signer: "HintReceipt signer is attested",
};
const print = (c: Check) => console.log(`  ${mark(c.ok)}  ${NAMES[c.id]} [${by(c)}]\n        ${c.detail}`);

const key = await apiKey();
console.log(`NEARAI_API_KEY: ${key ? `present (${key.length} chars)` : "absent (trying without)"}`);
console.log(`model: ${model}`);

const nonce = freshNonce();
const url = reportUrl(model, nonce);
console.log(`nonce: ${nonce} (32 random bytes, new for this run)`);
console.log(`GET ${url}`);
const report = await json(
  await fetch(url, {
    headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
  }),
  "attestation report",
);
const atts = modelAttestations(report, model);
if (atts.length === 0) {
  console.error("The report has no ECDSA model attestation for this model.");
  process.exit(1);
}
console.log(`${atts.length} model TEE node(s) serving ${model}`);

const verify = await quoteVerifier();
const jwks = await json(await fetch(NRAS_JWKS_URL), "NVIDIA JWKS");
const nodes: SavedResult["nodes"] = [];
for (const a of atts) {
  console.log(`\nnode ${a.signingAddress}`);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const node = checkNode(a, nonce, verify, await collateral(INTEL_PCS, a.quote), now);
  if (a.nvidiaPayload) {
    const nras = await json(
      await fetch(NRAS_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: a.nvidiaPayload,
      }),
      "NVIDIA NRAS",
    );
    node.checks.push(await checkGpu(nras, a.nvidiaPayload, nonce, jwks, Math.floor(Date.now() / 1000)));
  } else node.checks.push({ id: "gpu", ok: false, by: "nvidia", detail: "The report has no GPU evidence." });
  for (const c of node.checks) print(c);
  nodes.push(node);
}

const attested = nodes.filter(nodeOk).map((n) => n.signingAddress);
let saved: SavedReceipt[] | null = null;
if (target) {
  console.log(`\nHintReceipts from ${target}`);
  const rs = await receipts(target);
  if (rs.length === 0) console.log("  none with a model signature (template lines are unsigned)");
  saved = rs.map((r) => {
    const c = checkSigner(attested, r.signingAddress);
    console.log(`  hint ${r.hintId}: chat signature ${r.signature}`);
    print(c);
    return { ...r, attested: c.ok };
  });
}

const allOk = nodes.every(nodeOk) && (saved ?? []).every((r) => r.attested && r.signature !== "bad");
console.log(`\n${allOk ? "VERIFIED" : "NOT VERIFIED"}: ${attested.length}/${nodes.length} node(s) attested`);

if (save) {
  const result: SavedResult = {
    version: 1,
    tool: "scripts/verify-nearai.ts",
    checkedAt: new Date().toISOString(),
    model,
    nonce,
    report: url,
    nodes,
    source: target,
    receipts: saved,
  };
  await Bun.write(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`saved ${out.replace(root, "")}`);
}
process.exit(allOk ? 0 : 1);
