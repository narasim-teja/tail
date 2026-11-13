// NEAR AI's attestation, checked from the browser. NEAR AI's report endpoint answers browsers
// without an API key (CORS open), and Phala's collateral cache does too, so the TDX quote, the key
// and the fresh nonce in its report data, and the container manifest are checked here, live, with
// dcap-qvl's wasm. NVIDIA's attestation service refuses browsers (CORS), so the GPU verdict comes
// from the result scripts/verify-nearai.ts saved (public/nearai-attestation.json), and says so.

import wasmUrl from "@phala/dcap-qvl-web/dcap-qvl-web_bg.wasm?url";
import {
  checkNode,
  freshNonce,
  HANDLER_MODEL,
  modelAttestations,
  type NodeResult,
  PHALA_PCCS,
  parseSaved,
  reportUrl,
  SAVED_PATH,
  type SavedResult,
} from "./nearai.ts";

export type Live =
  | { kind: "checked"; at: Date; nonce: string; nodes: NodeResult[] }
  | { kind: "unreachable"; reason: string };

export interface Attested {
  live: Live;
  saved: SavedResult | null;
}

async function checkLive(model: string): Promise<Live> {
  try {
    const nonce = freshNonce();
    const res = await fetch(reportUrl(model, nonce), { headers: { accept: "application/json" } });
    if (!res.ok) return { kind: "unreachable", reason: `NEAR AI answered ${res.status}` };
    const atts = modelAttestations(await res.json(), model);
    if (atts.length === 0) return { kind: "unreachable", reason: "the report has no model TEE" };
    const qvl = await import("@phala/dcap-qvl-web");
    await qvl.default({ module_or_path: wasmUrl });
    const nodes: NodeResult[] = [];
    for (const a of atts) {
      const collateral = await qvl.js_get_collateral(PHALA_PCCS, a.quote);
      const now = BigInt(Math.floor(Date.now() / 1000));
      const node = checkNode(a, nonce, qvl.js_verify, collateral, now);
      if (a.requestNonce !== nonce)
        node.checks.push({
          id: "nonce",
          ok: false,
          by: "local",
          detail: "The report answers another nonce.",
        });
      nodes.push(node);
    }
    return { kind: "checked", at: new Date(), nonce, nodes };
  } catch (e) {
    return { kind: "unreachable", reason: e instanceof Error ? e.message : String(e) };
  }
}

async function loadSaved(): Promise<SavedResult | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}${SAVED_PATH}`, {
      headers: { accept: "application/json" },
    });
    return res.ok ? parseSaved(await res.json()) : null;
  } catch {
    return null;
  }
}

const cache = new Map<string, Promise<Attested>>();

/** One live check per model per page load, shared by every Handler line. */
export function attestation(model: string = HANDLER_MODEL): Promise<Attested> {
  let p = cache.get(model);
  if (!p) {
    p = Promise.all([checkLive(model), loadSaved()]).then(([live, saved]) => ({ live, saved }));
    cache.set(model, p);
  }
  return p;
}
