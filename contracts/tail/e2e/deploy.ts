// Deploys the live contract `tail.<NEAR_RELAY_ACCOUNT>` from scratch, pinned to the real keys:
// the referee enclave's `verdicts` key (from the referee's `pubkeys` command) and OutLayer's
// testnet VRF key (checked against OutLayer's public /vrf/pubkey). Testnet only.
//
//   cd contracts/tail && cargo near build non-reproducible-wasm && cd e2e && bun run deploy.ts --fresh
//
// With --local it deploys the local test referee's contract instead: LOCAL_TAIL_CONTRACT (default
// `tail-local.<NEAR_RELAY_ACCOUNT>`), pinned to the keys the local referee binary reports
// (crates/referee-wasi README, "Local test referee"). The live contract is never touched.
//
// When the account exists, pass one of:
//   --upgrade  deploy the new code in place with the account's full-access key from .keys/; state
//              (balances, matches, pinned keys) is kept, so only use it when the state layout is
//              unchanged. Checks the on-chain code hash and that the real keys are still pinned.
//   --fresh    delete the account first (NEAR back to the parent), which wipes every balance and
//              match on it. Never run it while a match is live.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Account, type KeyPairString } from "near-api-js";
import {
  ALLOWED_TOKENS,
  createContract,
  deleteContract,
  exists,
  keysDir,
  log,
  must,
  parentId,
  provider,
  registerOnToken,
  wasm,
} from "./common.ts";

const localMode = process.argv.includes("--local");
const contractId = localMode
  ? process.env["LOCAL_TAIL_CONTRACT"] || `tail-local.${parentId}`
  : `tail.${parentId}`;
if (!localMode && process.env["TAIL_CONTRACT"] && process.env["TAIL_CONTRACT"] !== contractId) {
  log(`note: TAIL_CONTRACT in .env.local is ${process.env["TAIL_CONTRACT"]}, not ${contractId}`);
}
if (localMode && contractId === process.env["TAIL_CONTRACT"]) {
  throw new Error("LOCAL_TAIL_CONTRACT must not be the live TAIL_CONTRACT");
}

const { refereePk, vrfPk } = localMode ? await localKeys() : await outlayerKeys();
log(`referee_pk ${refereePk}`);

/** The enclave's keys, with the VRF key checked against OutLayer's own. */
async function outlayerKeys(): Promise<{ refereePk: string; vrfPk: string }> {
  const api = must("OUTLAYER_API");
  const res = await fetch(
    `${api}/call/${must("OUTLAYER_OWNER")}/${process.env["REFEREE_PROJECT"] || "tail-referee"}`,
    {
      method: "POST",
      headers: { "X-Payment-Key": must("REFEREE_PAYMENT_KEY"), "Content-Type": "application/json" },
      body: JSON.stringify({ input: { cmd: "pubkeys" } }),
    },
  );
  const out = (await res.json()) as {
    output?: { ok?: boolean; result?: { referee_pk_hex?: string; vrf_pk?: string } };
  };
  const refereePk = out.output?.result?.referee_pk_hex;
  const vrfPk = out.output?.result?.vrf_pk;
  if (!out.output?.ok || !refereePk || !vrfPk)
    throw new Error(`referee pubkeys call failed (HTTP ${res.status})`);
  const outlayerVrf = ((await (await fetch(`${api}/vrf/pubkey`)).json()) as { vrf_public_key_hex: string })
    .vrf_public_key_hex;
  if (outlayerVrf !== vrfPk) throw new Error(`referee vrf_pk ${vrfPk} is not OutLayer's ${outlayerVrf}`);
  log(`vrf_pk ${vrfPk} (matches OutLayer /vrf/pubkey)`);
  return { refereePk, vrfPk };
}

/** The local test referee's keys, from its own `pubkeys` (it creates them on first use). */
async function localKeys(): Promise<{ refereePk: string; vrfPk: string }> {
  const root = new URL("../../../", import.meta.url).pathname;
  const bin = process.env["LOCAL_REFEREE_BIN"] || `${root}crates/referee-wasi/target/release/tail-referee`;
  const dir = process.env["LOCAL_REFEREE_DIR"] || `${root}.keys/local-referee`;
  const proc = Bun.spawn([bin], {
    stdin: new TextEncoder().encode(JSON.stringify({ cmd: "pubkeys" })),
    stdout: "pipe",
    env: { PATH: process.env["PATH"] ?? "", TAIL_LOCAL_REFEREE_DIR: dir, TAIL_LOCAL_REFEREE_OWNER: parentId },
  });
  const out = JSON.parse(await new Response(proc.stdout).text()) as {
    ok?: boolean;
    result?: { referee_pk_hex?: string; vrf_pk?: string };
  };
  const k = { refereePk: out.result?.referee_pk_hex, vrfPk: out.result?.vrf_pk };
  if (!out.ok || !k.refereePk || !k.vrfPk) throw new Error("local referee pubkeys call failed");
  log(`vrf_pk ${k.vrfPk} (the local test referee's, not OutLayer's)`);
  return k as { refereePk: string; vrfPk: string };
}

if ((await exists(contractId)) && process.argv.includes("--upgrade")) {
  const key = JSON.parse(readFileSync(`${keysDir}${contractId}.json`, "utf8")).private_key as KeyPairString;
  const code = wasm();
  await new Account(contractId, provider, key).deployContract(code);
  const local = bs58(createHash("sha256").update(code).digest());
  // The view can trail the deploy by a block or two, so re-read for a few seconds.
  let onChain = { code_hash: "" };
  for (let i = 0; i < 10 && onChain.code_hash !== local; i++) {
    if (i) await Bun.sleep(1_000);
    onChain = (await provider.viewAccount({ accountId: contractId })) as unknown as { code_hash: string };
  }
  if (onChain.code_hash !== local)
    throw new Error(`code hash ${onChain.code_hash} is not the local ${local}`);
  log(`upgraded ${contractId} in place: code hash ${local} (${code.length} bytes)`);
} else {
  if (await exists(contractId)) {
    if (!process.argv.includes("--fresh")) {
      throw new Error(`${contractId} exists; pass --upgrade (keep state) or --fresh (wipe it)`);
    }
    await deleteContract(contractId);
  }
  await createContract(contractId, {
    owner: parentId,
    referee_pk: refereePk,
    vrf_pk: vrfPk,
    allowed_tokens: ALLOWED_TOKENS,
  });
  // The contract must be registered on each token before anyone can ft_transfer_call to it.
  for (const token of ALLOWED_TOKENS) await registerOnToken(token, contractId);
}
const config = (await provider.callFunction({ contractId, method: "get_config", args: {} })) as Record<
  string,
  unknown
>;
if (config["referee_pk"] !== refereePk || config["vrf_pk"] !== vrfPk) throw new Error("pinned keys differ");
log(JSON.stringify(config, null, 1));

function bs58(bytes: Uint8Array) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}
