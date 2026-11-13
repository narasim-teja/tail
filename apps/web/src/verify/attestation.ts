// OutLayer keeps a public attestation record for every enclave call, and each verdict names the
// call that produced it. The verdict key survives new versions of the referee project (S2), so a
// valid signature alone does not say which code signed. The record does: it is read from the
// pinned OutLayer API (never the bundle's), it must name this verdict's call, and its
// `executed_wasm_sha256` must be one of the published builds pinned in pins.ts. Only then does
// the page say "enclave". A failed fetch (CORS, network, 404) leaves only the link.

import { toHex } from "@tail/protocol";

const UUID = /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/;

export function callUuid(callId: Uint8Array): string {
  return toHex(callId).replace(UUID, "$1-$2-$3-$4-$5");
}

export const attestationUrl = (api: string, callId: Uint8Array) =>
  `${api.replace(/\/+$/, "")}/attestations/by-call/${callUuid(callId)}`;

/**
 * published: the record names this call and ran a pinned build.
 * other-code: it names this call but ran a build that was not published.
 * other-call: the record is for a different call.
 * no-hash: the record has no `executed_wasm_sha256` (a `wasm_hash` alone is the uploaded file,
 * not what ran, so it does not count).
 */
export type RecordCheck =
  | { kind: "published"; wasm: string }
  | { kind: "other-code"; wasm: string }
  | { kind: "other-call" }
  | { kind: "no-hash" };

export function checkRecord(body: unknown, callId: Uint8Array, published: readonly string[]): RecordCheck {
  const rec = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const call = typeof rec["call_id"] === "string" ? rec["call_id"].replace(/-/g, "").toLowerCase() : "";
  if (call !== toHex(callId)) return { kind: "other-call" };
  const wasm = rec["executed_wasm_sha256"];
  if (typeof wasm !== "string" || !/^[0-9a-f]{64}$/i.test(wasm)) return { kind: "no-hash" };
  const w = wasm.toLowerCase();
  return published.includes(w) ? { kind: "published", wasm: w } : { kind: "other-code", wasm: w };
}

export type Attestation =
  | { kind: "found"; check: RecordCheck }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: string };

export const isEnclave = (a: Attestation | null | undefined) =>
  a?.kind === "found" && a.check.kind === "published";

const cache = new Map<string, Promise<Attestation>>();

export function fetchAttestation(
  api: string,
  callId: Uint8Array,
  published: readonly string[],
): Promise<Attestation> {
  const url = attestationUrl(api, callId);
  const key = `${url}#${published.join(",")}`;
  let p = cache.get(key);
  if (!p) {
    p = (async (): Promise<Attestation> => {
      try {
        const res = await fetch(url, { headers: { accept: "application/json" } });
        if (res.status === 404) return { kind: "missing" };
        if (!res.ok) return { kind: "unreadable", reason: `HTTP ${res.status}` };
        return { kind: "found", check: checkRecord(await res.json(), callId, published) };
      } catch (e) {
        return { kind: "unreadable", reason: e instanceof Error ? e.message : String(e) };
      }
    })();
    cache.set(key, p);
  }
  return p;
}
