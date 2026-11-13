// dcap-qvl (Phala's Rust TDX/SGX quote verifier, as wasm) for Bun: scripts/verify-nearai.ts and
// the tests. The browser loads the same package through Vite (src/verify/nearai-live.ts). The
// package lives in apps/web's node_modules, so this file is what the root script imports.

import { initSync, js_get_collateral, js_verify } from "@phala/dcap-qvl-web";
import type { QuoteVerifier } from "../src/verify/nearai.ts";

let ready = false;

async function init(): Promise<void> {
  if (ready) return;
  const wasm = Bun.resolveSync("@phala/dcap-qvl-web/dcap-qvl-web_bg.wasm", import.meta.dir);
  initSync({ module: await Bun.file(wasm).arrayBuffer() });
  ready = true;
}

export async function quoteVerifier(): Promise<QuoteVerifier> {
  await init();
  return (quote, collateral, now) => js_verify(quote, collateral, now);
}

/** The PCK CRLs, TCB info and QE identity for this quote's platform, each signed by Intel. */
export async function collateral(pccsUrl: string, quote: Uint8Array): Promise<unknown> {
  await init();
  return js_get_collateral(pccsUrl, quote);
}
