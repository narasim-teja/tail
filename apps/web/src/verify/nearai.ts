// NEAR AI Cloud's attestation for the Handler's model (docs.near.ai/cloud/verification/model).
// A Handler line is signed by an Ethereum key (checks.ts recovers it). This file shows that key is
// one NEAR AI's sealed hardware holds:
//
//   tdx      the Intel TDX quote verifies (dcap-qvl, against Intel-signed collateral);
//   address  the quote's report_data[0..32] is that key, zero-padded;
//   nonce    report_data[32..64] is the fresh nonce we sent, so the quote is not a replay;
//   compose  mr_config_id is 0x01 ‖ sha256(app_compose): the container manifest that ran;
//   gpu      NVIDIA's attestation service (NRAS) passed the GPUs for the same nonce, and its
//            ES384 tokens verify against NVIDIA's published keys;
//   signer   the line's signer is one of the attested keys.
//
// The checks are pure: the quote verifier and the network are passed in, so the same code runs in
// scripts/verify-nearai.ts (Bun) and in the replay (browser), and the tests run it offline.

import { sha256 } from "@noble/hashes/sha2.js";
import { fromHex, toHex, utf8 } from "@tail/protocol";

/** The referee's default Handler model (crates/referee-wasi/src/cmd/voice.rs, DEFAULT_MODEL). */
export const HANDLER_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
export const NEARAI_API = "https://cloud-api.near.ai/v1";
export const NRAS_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu";
export const NRAS_JWKS_URL = "https://nras.attestation.nvidia.com/.well-known/jwks.json";
/** Intel's own collateral service (the script's). */
export const INTEL_PCS = "https://api.trustedservices.intel.com/tdx/certification/v4";
/**
 * Phala's cache of the same Intel-signed collateral. Intel's service sends no CORS headers and
 * this one does; dcap-qvl checks the collateral's Intel signatures either way.
 */
export const PHALA_PCCS = "https://pccs.phala.network/tdx/certification/v4";
/** Where the replay finds the script's last result (apps/web/public). */
export const SAVED_PATH = "nearai-attestation.json";

export const reportUrl = (model: string, nonce: string) =>
  `${NEARAI_API}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`;

/** 32 random bytes as hex, a new one for every report. */
export function freshNonce(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export type CheckId = "tdx" | "address" | "nonce" | "compose" | "gpu" | "signer";

/**
 * by: who did the work. "local" ran here (dcap-qvl, hashes, WebCrypto); "nvidia" is NRAS's
 * verdict on the GPU evidence, of which only the token signature and claims are checked here.
 */
export interface Check {
  id: CheckId;
  ok: boolean;
  by: "local" | "nvidia";
  detail: string;
}

export interface ModelAttestation {
  model: string | null;
  /** Lowercase 0x address. */
  signingAddress: string;
  requestNonce: string;
  quote: Uint8Array;
  /** The JSON NEAR AI hands over for NRAS, as sent. */
  nvidiaPayload: string | null;
  appCompose: string | null;
}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const HEX = /^(?:[0-9a-f]{2})*$/i;

/** The report's model TEEs (one per node serving the model), ECDSA only. */
export function modelAttestations(report: unknown, model: string): ModelAttestation[] {
  const list = obj(report)["model_attestations"];
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw): ModelAttestation[] => {
    const a = obj(raw);
    const addr = str(a["signing_address"])?.toLowerCase() ?? "";
    const quote = str(a["intel_quote"]) ?? "";
    const name = str(a["model_name"]);
    if (!/^0x[0-9a-f]{40}$/.test(addr) || str(a["signing_algo"]) !== "ecdsa") return [];
    if (!HEX.test(quote) || quote.length === 0 || (name !== null && name !== model)) return [];
    const tcb = obj(a["info"])["tcb_info"];
    const tcbObj = typeof tcb === "string" ? obj(safeJson(tcb)) : obj(tcb);
    const payload = a["nvidia_payload"];
    return [
      {
        model: name,
        signingAddress: addr,
        requestNonce: str(a["request_nonce"])?.toLowerCase() ?? "",
        quote: fromHex(quote),
        nvidiaPayload: typeof payload === "string" ? payload : payload ? JSON.stringify(payload) : null,
        appCompose: str(tcbObj["app_compose"]),
      },
    ];
  });
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ── Intel TDX ────────────────────────────────────────────────────────────────────────

/** dcap-qvl's `js_verify`: throws when the quote or its collateral does not verify. */
export type QuoteVerifier = (quote: Uint8Array, collateral: unknown, now: bigint) => unknown;

/**
 * Intel's TCB levels the reference verifier (nearai-cloud-verifier) accepts: OutOfDate means the
 * platform is behind Intel's latest advisory baseline, not that the quote is forged.
 */
const TDX_OK = new Set(["UpToDate", "OutOfDate"]);

export interface Tdx {
  check: Check;
  status: string | null;
  /** From the verified quote only; null when it did not verify. */
  reportData: Uint8Array | null;
  mrConfigId: string | null;
}

export function checkTdx(verify: QuoteVerifier, quote: Uint8Array, collateral: unknown, now: bigint): Tdx {
  let out: unknown;
  try {
    out = verify(quote, collateral, now);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { check: tdxCheck(false, `The quote did not verify: ${why}.`), status: null, ...none };
  }
  const r = obj(out);
  const status = str(r["status"]);
  const report = obj(r["report"]);
  const td = obj(report["TD10"] ?? report["TD15"]);
  const rd = str(td["report_data"]) ?? "";
  const mr = str(td["mr_config_id"]);
  if (!HEX.test(rd) || rd.length !== 128)
    return { check: tdxCheck(false, "The quote is not a TDX quote."), status, ...none };
  const ok = status !== null && TDX_OK.has(status);
  const adv = Array.isArray(r["advisory_ids"]) && r["advisory_ids"].length > 0;
  return {
    check: tdxCheck(
      ok,
      ok
        ? `Signed by an Intel TDX CPU; dcap-qvl checked the chain to Intel's root and the TCB level (${status}${adv ? ", with advisories" : ""}).`
        : `The quote verified, but Intel rates this platform ${status ?? "unknown"}.`,
    ),
    status,
    reportData: ok ? fromHex(rd) : null,
    mrConfigId: mr,
  };
}

const none = { reportData: null, mrConfigId: null };
const tdxCheck = (ok: boolean, detail: string): Check => ({ id: "tdx", ok, by: "local", detail });

/** report_data = signing address zero-padded to 32 bytes ‖ the 32-byte request nonce. */
export function checkReportData(reportData: Uint8Array | null, address: string, nonce: string): Check[] {
  if (!reportData)
    return [
      { id: "address", ok: false, by: "local", detail: "No verified quote to read the key from." },
      { id: "nonce", ok: false, by: "local", detail: "No verified quote to read the nonce from." },
    ];
  const want = new Uint8Array(32);
  want.set(fromHex(address.replace(/^0x/i, "")));
  const addrOk = toHex(reportData.slice(0, 32)) === toHex(want);
  const nonceOk = /^[0-9a-f]{64}$/i.test(nonce) && toHex(reportData.slice(32, 64)) === nonce.toLowerCase();
  return [
    {
      id: "address",
      ok: addrOk,
      by: "local",
      detail: addrOk
        ? `The quote's report data names the key ${address}, so the key was made inside that TEE.`
        : "The quote's report data names a different key.",
    },
    {
      id: "nonce",
      ok: nonceOk,
      by: "local",
      detail: nonceOk
        ? `The quote's report data carries the fresh nonce ${nonce.slice(0, 12)}…, so it was made for this check.`
        : "The quote's report data carries a different nonce: it could be a replay.",
    },
  ];
}

/** mr_config_id = 0x01 ‖ sha256(app_compose) ‖ zero padding (dstack). */
export function checkCompose(appCompose: string | null, mrConfigId: string | null): Check {
  const hash = appCompose === null ? null : toHex(sha256(utf8(appCompose)));
  const ok = hash !== null && mrConfigId?.toLowerCase().startsWith(`01${hash}`) === true;
  return {
    id: "compose",
    ok,
    by: "local",
    detail: ok
      ? `The container manifest NEAR AI publishes hashes to the quote's mr_config_id (${(hash ?? "").slice(0, 12)}…).`
      : "The published container manifest does not match the quote's mr_config_id.",
  };
}

// ── NVIDIA GPU (NRAS) ────────────────────────────────────────────────────────────────

const NRAS_ISS = "https://nras.attestation.nvidia.com";

interface Jwt {
  token: string;
  kid: string;
  claims: Record<string, unknown>;
}

function decodeJwt(token: unknown): Jwt | null {
  if (typeof token !== "string") return null;
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  const header = obj(safeJson(b64urlText(h)));
  if (header["alg"] !== "ES384" || typeof header["kid"] !== "string") return null;
  return { token, kid: header["kid"], claims: obj(safeJson(b64urlText(p))) };
}

function b64url(s: string): Uint8Array {
  const b = atob(
    s
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(s.length / 4) * 4, "="),
  );
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
const b64urlText = (s: string) => {
  try {
    return new TextDecoder().decode(b64url(s));
  } catch {
    return "";
  }
};

async function jwtSigned(jwt: Jwt, keys: Map<string, JsonWebKey>): Promise<boolean> {
  const jwk = keys.get(jwt.kid);
  if (!jwk) return false;
  try {
    const data: JsonWebKey = { kty: "EC", crv: "P-384", x: jwk.x ?? "", y: jwk.y ?? "" };
    const key = await crypto.subtle.importKey("jwk", data, { name: "ECDSA", namedCurve: "P-384" }, false, [
      "verify",
    ]);
    const [h, p, s] = jwt.token.split(".") as [string, string, string];
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-384" },
      key,
      b64url(s) as Uint8Array<ArrayBuffer>,
      utf8(`${h}.${p}`) as Uint8Array<ArrayBuffer>,
    );
  } catch {
    return false;
  }
}

/** NVIDIA's JWKS as kid → key (P-384 only). */
export function nrasKeys(jwks: unknown): Map<string, JsonWebKey> {
  const keys = obj(jwks)["keys"];
  const out = new Map<string, JsonWebKey>();
  if (!Array.isArray(keys)) return out;
  for (const k of keys) {
    const j = obj(k);
    if (j["kty"] === "EC" && j["crv"] === "P-384" && typeof j["kid"] === "string")
      out.set(j["kid"], j as JsonWebKey);
  }
  return out;
}

/** The per-GPU claims docs.near.ai lists, besides every boolean `x-nvidia-*` claim being true. */
function gpuProblem(name: string, c: Record<string, unknown>, nonce: string): string | null {
  if (str(c["eat_nonce"])?.toLowerCase() !== nonce) return `${name} answers another nonce`;
  if (c["secboot"] !== true) return `${name} has secure boot off`;
  if (c["dbgstat"] !== "disabled") return `${name} is in debug mode`;
  if (c["measres"] !== "success") return `${name} failed its measurements`;
  if (c["x-nvidia-attestation-warning"] != null) return `${name} carries a warning`;
  for (const [k, v] of Object.entries(c))
    if (k.startsWith("x-nvidia-") && typeof v === "boolean" && !v) return `${name}: ${k} is false`;
  return null;
}

/**
 * NRAS answers `[["JWT", overall], {"GPU-0": token, …}]`. Passes when every token is signed by a
 * key in NVIDIA's JWKS, the overall result is true, each GPU token is the one the overall token's
 * `submods` digest names, every token and the payload NEAR AI handed over carry our nonce, and
 * the tokens were valid at `at` (unix seconds).
 */
export async function checkGpu(
  nras: unknown,
  payload: string | null,
  nonce: string,
  jwks: unknown,
  at: number,
): Promise<Check> {
  const fail = (detail: string): Check => ({ id: "gpu", ok: false, by: "nvidia", detail });
  const n = nonce.toLowerCase();
  if (str(obj(safeJson(payload ?? ""))["nonce"])?.toLowerCase() !== n)
    return fail("The GPU evidence NEAR AI handed over is for another nonce.");
  if (!Array.isArray(nras) || !Array.isArray(nras[0]) || nras[0][0] !== "JWT")
    return fail("NVIDIA's answer is not an attestation result.");
  const overall = decodeJwt(nras[0][1]);
  if (!overall) return fail("NVIDIA's overall token is unreadable.");
  const gpus = Object.entries(obj(nras[1])).map(([name, t]) => [name, decodeJwt(t)] as const);
  if (gpus.length === 0) return fail("NVIDIA's answer covers no GPU.");
  const keys = nrasKeys(jwks);
  for (const jwt of [overall, ...gpus.map(([, j]) => j)]) {
    if (!jwt || !(await jwtSigned(jwt, keys)))
      return fail("A token isn't signed by NVIDIA's published keys.");
    const c = jwt.claims;
    if (c["iss"] !== NRAS_ISS) return fail("A token comes from another issuer.");
    const exp = typeof c["exp"] === "number" ? c["exp"] : 0;
    const nbf = typeof c["nbf"] === "number" ? c["nbf"] : Number(c["iat"] ?? Infinity);
    if (at < nbf - 60 || at > exp) return fail("A token was not valid at the time of the check.");
  }
  const oc = overall.claims;
  if (oc["x-nvidia-overall-att-result"] !== true) return fail("NVIDIA's overall verdict is false.");
  if (str(oc["eat_nonce"])?.toLowerCase() !== n) return fail("NVIDIA's verdict is for another nonce.");
  const submods = obj(oc["submods"]);
  for (const [name, jwt] of gpus) {
    const digest = (submods[name] as unknown[] | undefined)?.[1] as unknown[] | undefined;
    if (!jwt || digest?.[0] !== "SHA-256" || digest[1] !== toHex(sha256(utf8(jwt.token))))
      return fail(`${name}'s token isn't the one the overall verdict names.`);
    const why = gpuProblem(name, jwt.claims, n);
    if (why) return fail(`${why}.`);
  }
  const model = str(gpus[0]?.[1]?.claims["hwmodel"]) ?? "GPU";
  return {
    id: "gpu",
    ok: true,
    by: "nvidia",
    detail: `NVIDIA's attestation service passed ${gpus.length} ${model} GPU${gpus.length === 1 ? "" : "s"} in confidential mode (secure boot on, debug off, measurements matched) for the same nonce; its tokens verify against NVIDIA's published keys.`,
  };
}

// ── The Handler line's key ───────────────────────────────────────────────────────────

export function checkSigner(attested: readonly string[], signer: string): Check {
  const s = signer.toLowerCase();
  const ok = attested.some((a) => a.toLowerCase() === s);
  return {
    id: "signer",
    ok,
    by: "local",
    detail: ok
      ? `The key that signed this line, ${s}, is the key the attested TEE holds.`
      : `The key that signed this line, ${s}, isn't in NEAR AI's report (it holds ${attested.join(", ") || "none"}). Keys change when a node restarts, so an older line can fall out.`,
  };
}

// ── One node, and the script's saved result ──────────────────────────────────────────

export interface NodeResult {
  signingAddress: string;
  tdxStatus: string | null;
  checks: Check[];
}

/** tdx, address, nonce and compose for one model TEE (the parts that need no NVIDIA call). */
export function checkNode(
  a: ModelAttestation,
  nonce: string,
  verify: QuoteVerifier,
  collateral: unknown,
  now: bigint,
): NodeResult {
  const tdx = checkTdx(verify, a.quote, collateral, now);
  return {
    signingAddress: a.signingAddress,
    tdxStatus: tdx.status,
    checks: [
      tdx.check,
      ...checkReportData(tdx.reportData, a.signingAddress, nonce),
      checkCompose(a.appCompose, tdx.mrConfigId),
    ],
  };
}

export interface SavedReceipt {
  hintId: number;
  signingAddress: string;
  /** checks.ts: the receipt's signature recovers to that address over the signed text. */
  signature: "signed" | "bad" | "unsigned" | "unchecked";
  attested: boolean;
}

/** What scripts/verify-nearai.ts writes for the replay. No secrets: the API key is never in it. */
export interface SavedResult {
  version: 1;
  tool: "scripts/verify-nearai.ts";
  checkedAt: string;
  model: string;
  nonce: string;
  /** The report URL (no key; the nonce is in it). */
  report: string;
  nodes: NodeResult[];
  /** The bundle or match the script compared against, if any. */
  source: string | null;
  receipts: SavedReceipt[] | null;
}

const CHECK_IDS = new Set<string>(["tdx", "address", "nonce", "compose", "gpu", "signer"]);

function parseCheck(v: unknown): Check | null {
  const c = obj(v);
  const id = str(c["id"]);
  const by = c["by"];
  if (!id || !CHECK_IDS.has(id) || typeof c["ok"] !== "boolean" || (by !== "local" && by !== "nvidia"))
    return null;
  return { id: id as CheckId, ok: c["ok"], by, detail: str(c["detail"]) ?? "" };
}

const SIGNATURES = new Set<string>(["signed", "bad", "unsigned", "unchecked"]);

function parseReceipt(v: unknown): SavedReceipt[] {
  const o = obj(v);
  const addr = str(o["signingAddress"]);
  const sig = str(o["signature"]);
  if (
    typeof o["hintId"] !== "number" ||
    !addr ||
    !sig ||
    !SIGNATURES.has(sig) ||
    typeof o["attested"] !== "boolean"
  )
    return [];
  return [
    {
      hintId: o["hintId"],
      signingAddress: addr,
      signature: sig as SavedReceipt["signature"],
      attested: o["attested"],
    },
  ];
}

export function parseSaved(json: unknown): SavedResult | null {
  const r = obj(json);
  if (r["version"] !== 1 || r["tool"] !== "scripts/verify-nearai.ts") return null;
  const checkedAt = str(r["checkedAt"]);
  const model = str(r["model"]);
  const nonce = str(r["nonce"]);
  if (!checkedAt || Number.isNaN(Date.parse(checkedAt)) || !model || !nonce) return null;
  const nodes = Array.isArray(r["nodes"])
    ? r["nodes"].flatMap((n) => {
        const o = obj(n);
        const addr = str(o["signingAddress"]);
        const checks = Array.isArray(o["checks"]) ? o["checks"].map(parseCheck) : [];
        if (!addr || checks.some((c) => c === null)) return [];
        return [
          {
            signingAddress: addr.toLowerCase(),
            tdxStatus: str(o["tdxStatus"]),
            checks: checks as Check[],
          },
        ];
      })
    : [];
  return {
    version: 1,
    tool: "scripts/verify-nearai.ts",
    checkedAt,
    model,
    nonce,
    report: str(r["report"]) ?? "",
    nodes,
    source: str(r["source"]),
    receipts: Array.isArray(r["receipts"]) ? r["receipts"].flatMap(parseReceipt) : null,
  };
}

/** Every check of a node passed (signer is per line, so it isn't part of a node). */
export const nodeOk = (n: NodeResult) => n.checks.length > 0 && n.checks.every((c) => c.ok);
