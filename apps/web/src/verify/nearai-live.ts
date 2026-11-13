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
  parseNodes,
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
      nodes.push(checkNode(a, nonce, qvl.js_verify, collateral, now));
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

// A live check fetches the report, Intel's collateral and dcap-qvl's wasm. Within one tab, a
// result stays good for a few minutes, so opening replay after replay doesn't fetch them again;
// the panel still shows when that check ran and for which nonce. Storage can be missing or
// refuse (private windows), and then every page load checks afresh.
const TTL_MS = 10 * 60_000;
const storeKey = (model: string) => `tail/nearai/${model}`;

function recall(model: string): Live | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(storeKey(model)) ?? "null") as {
      at?: unknown;
      nonce?: unknown;
      nodes?: unknown;
    } | null;
    const at = typeof raw?.at === "string" ? new Date(raw.at) : null;
    if (!at || !(Date.now() - at.getTime() < TTL_MS) || typeof raw?.nonce !== "string") return null;
    const nodes = parseNodes(raw.nodes);
    return nodes.length > 0 ? { kind: "checked", at, nonce: raw.nonce, nodes } : null;
  } catch {
    return null;
  }
}

function remember(model: string, live: Live): void {
  if (live.kind !== "checked") return;
  try {
    sessionStorage.setItem(storeKey(model), JSON.stringify({ ...live, at: live.at.toISOString() }));
  } catch {
    // No storage: the next page load checks again.
  }
}

const cache = new Map<string, Promise<Attested>>();

/** One live check per model per page load (or per few minutes in a tab), shared by every line. */
export function attestation(model: string = HANDLER_MODEL): Promise<Attested> {
  let p = cache.get(model);
  if (!p) {
    const recalled = recall(model);
    const live = recalled
      ? Promise.resolve(recalled)
      : checkLive(model).then((l) => {
          remember(model, l);
          return l;
        });
    p = Promise.all([live, loadSaved()]).then(([l, saved]) => ({ live: l, saved }));
    cache.set(model, p);
  }
  return p;
}
