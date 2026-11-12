// OutLayer keeps a public attestation record for every enclave call. Each verdict names the call
// that produced it, so the page can fetch that record and show which wasm ran. A failed fetch
// (CORS, network, 404) leaves only the link: the page never claims a record it did not read.

const UUID = /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/;

export function callUuid(callId: Uint8Array): string {
  const hex = Array.from(callId, (b) => b.toString(16).padStart(2, "0")).join("");
  return hex.replace(UUID, "$1-$2-$3-$4-$5");
}

export const attestationUrl = (api: string, callId: Uint8Array) =>
  `${api.replace(/\/+$/, "")}/attestations/by-call/${callUuid(callId)}`;

export type Attestation =
  | { kind: "found"; wasmSha256: string | null }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: string };

const cache = new Map<string, Promise<Attestation>>();

export function fetchAttestation(url: string): Promise<Attestation> {
  let p = cache.get(url);
  if (!p) {
    p = (async (): Promise<Attestation> => {
      try {
        const res = await fetch(url, { headers: { accept: "application/json" } });
        if (res.status === 404) return { kind: "missing" };
        if (!res.ok) return { kind: "unreadable", reason: `HTTP ${res.status}` };
        const body = (await res.json()) as Record<string, unknown>;
        const wasm = body["executed_wasm_sha256"] ?? body["wasm_hash"];
        return { kind: "found", wasmSha256: typeof wasm === "string" ? wasm : null };
      } catch (e) {
        return { kind: "unreadable", reason: e instanceof Error ? e.message : String(e) };
      }
    })();
    cache.set(url, p);
  }
  return p;
}
