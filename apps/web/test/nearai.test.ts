// NEAR AI attestation checks on a recorded, public report (test/data/nearai-attestation.json):
// one model TEE of the Handler's model, its Intel TDX quote with the Intel collateral fetched at
// the time, and the claims NVIDIA's attestation service returned for its GPUs. Runs offline:
// the quote is verified at the recorded time. NVIDIA's tokens are re-signed here with a test key
// (only their claims are recorded), so the GPU check is exercised against that key's JWKS.

import { describe, expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { toHex, utf8 } from "@tail/protocol";
import { quoteVerifier } from "../scripts/qvl.ts";
import {
  checkCompose,
  checkGpu,
  checkNode,
  checkReportData,
  checkSigner,
  checkTdx,
  type ModelAttestation,
  modelAttestations,
  nodeOk,
  parseSaved,
} from "../src/verify/nearai.ts";
import rec from "./data/nearai-attestation.json";

const verify = await quoteVerifier();
const now = BigInt(rec.recordedAt);
const [att] = modelAttestations(rec.report, rec.model) as [ModelAttestation];
const ADDRESS = "0xfe0071895500a9755c18044948ab4f4e1a7f337e";

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** An NRAS-shaped answer, its tokens signed by a fresh P-384 key, and that key's JWKS. */
async function nras(edit: (c: typeof rec.nrasClaims) => void = () => {}) {
  const claims = structuredClone(rec.nrasClaims);
  edit(claims);
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, ["sign"]);
  const kid = "test-key";
  const sign = async (body: object) => {
    const head = `${b64url(utf8(JSON.stringify({ kid, alg: "ES384" })))}.${b64url(utf8(JSON.stringify(body)))}`;
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-384" },
      pair.privateKey,
      utf8(head) as Uint8Array<ArrayBuffer>,
    );
    return `${head}.${b64url(new Uint8Array(sig))}`;
  };
  const gpus: Record<string, string> = {};
  for (const [name, c] of Object.entries(claims.gpus)) gpus[name] = await sign(c);
  const submods = Object.fromEntries(
    Object.entries(gpus).map(([name, t]) => [name, ["DIGEST", ["SHA-256", toHex(sha256(utf8(t)))]]]),
  );
  const answer = [["JWT", await sign({ ...claims.overall, submods })], gpus];
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { answer, jwks: { keys: [{ ...jwk, kid }] } };
}

describe("the recorded report", () => {
  test("parses one ECDSA model TEE of the Handler's model", () => {
    expect(att.signingAddress).toBe(ADDRESS);
    expect(att.requestNonce).toBe(rec.nonce);
    expect(modelAttestations(rec.report, "some/other-model")).toEqual([]);
  });

  test("passes every check for its own nonce and key", async () => {
    const node = checkNode(att, rec.nonce, verify, rec.collateral, now);
    expect(node.tdxStatus).toBe("UpToDate");
    expect(node.checks.map((c) => [c.id, c.ok])).toEqual([
      ["tdx", true],
      ["address", true],
      ["nonce", true],
      ["compose", true],
    ]);
    expect(nodeOk(node)).toBe(true);
    const { answer, jwks } = await nras();
    const gpu = await checkGpu(answer, att.nvidiaPayload, rec.nonce, jwks, rec.recordedAt);
    expect(gpu).toMatchObject({ id: "gpu", ok: true, by: "nvidia" });
    expect(checkSigner([node.signingAddress], ADDRESS.toUpperCase().replace("0X", "0x")).ok).toBe(true);
  });
});

describe("fails", () => {
  test("a different nonce: the quote was made for someone else's check", () => {
    const other = "00".repeat(32);
    const node = checkNode(att, other, verify, rec.collateral, now);
    expect(node.checks.find((c) => c.id === "nonce")?.ok).toBe(false);
    expect(node.checks.find((c) => c.id === "tdx")?.ok).toBe(true);
    expect(nodeOk(node)).toBe(false);
  });

  test("a different signing address", () => {
    const tdx = checkTdx(verify, att.quote, rec.collateral, now);
    const [address] = checkReportData(tdx.reportData, `0x${"11".repeat(20)}`, rec.nonce);
    expect(address?.ok).toBe(false);
    expect(checkSigner([ADDRESS], `0x${"11".repeat(20)}`).ok).toBe(false);
  });

  test("a tampered quote: one bit of the report data flipped", () => {
    const quote = att.quote.slice();
    quote[48 + 520] = (quote[48 + 520] ?? 0) ^ 1; // first byte of report_data in a v4 TDX quote
    const node = checkNode({ ...att, quote }, rec.nonce, verify, rec.collateral, now);
    expect(node.checks.map((c) => [c.id, c.ok])).toEqual([
      ["tdx", false],
      ["address", false],
      ["nonce", false],
      ["compose", false],
    ]);
  });

  test("a quote checked after its collateral expired", () => {
    const later = now + 400n * 86_400n;
    expect(checkTdx(verify, att.quote, rec.collateral, later).check.ok).toBe(false);
  });

  test("a container manifest that isn't the measured one", () => {
    const tdx = checkTdx(verify, att.quote, rec.collateral, now);
    expect(checkCompose(`${att.appCompose} `, tdx.mrConfigId).ok).toBe(false);
  });

  test("GPU: another nonce, a debug GPU, a false verdict, a bad signature, an expired token", async () => {
    const good = await nras();
    const at = rec.recordedAt;
    const gpu = (n: unknown, jwks: unknown, payload = att.nvidiaPayload, t = at, nonce = rec.nonce) =>
      checkGpu(n, payload, nonce, jwks, t).then((c) => c.ok);
    expect(await gpu(good.answer, good.jwks, att.nvidiaPayload, at, "00".repeat(32))).toBe(false);
    expect(await gpu(good.answer, good.jwks, JSON.stringify({ nonce: "00".repeat(32) }))).toBe(false);
    expect(await gpu(good.answer, good.jwks, att.nvidiaPayload, at + 2 * 3600)).toBe(false);
    const debug = await nras((c) => {
      c.gpus["GPU-3"].dbgstat = "enabled";
    });
    expect(await gpu(debug.answer, debug.jwks)).toBe(false);
    const verdict = await nras((c) => {
      c.overall["x-nvidia-overall-att-result"] = false;
    });
    expect(await gpu(verdict.answer, verdict.jwks)).toBe(false);
    // Signed by one key, checked against another key's JWKS.
    expect(await gpu(good.answer, (await nras()).jwks)).toBe(false);
  });
});

test("the saved result round-trips and rejects other shapes", () => {
  const node = checkNode(att, rec.nonce, verify, rec.collateral, now);
  const saved = {
    version: 1,
    tool: "scripts/verify-nearai.ts",
    checkedAt: "2026-11-13T05:20:40.000Z",
    model: rec.model,
    nonce: rec.nonce,
    report: "https://cloud-api.near.ai/v1/attestation/report",
    nodes: [node],
    source: ADDRESS,
    receipts: [{ hintId: -1, signingAddress: ADDRESS, signature: "unchecked", attested: true }],
  };
  expect(parseSaved(JSON.parse(JSON.stringify(saved)))).toEqual(saved as never);
  expect(parseSaved({ ...saved, tool: "something else" })).toBeNull();
  expect(parseSaved({ ...saved, nodes: [{ ...node, checks: [{ id: "tdx", ok: "yes" }] }] })?.nodes).toEqual(
    [],
  );
});
