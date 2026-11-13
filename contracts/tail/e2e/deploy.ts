// Deploys the live contract `tail.<NEAR_RELAY_ACCOUNT>` from scratch, pinned to the real keys:
// the referee enclave's `verdicts` key (from the referee's `pubkeys` command) and OutLayer's
// testnet VRF key (checked against OutLayer's public /vrf/pubkey). Testnet only.
//
//   cd contracts/tail && cargo near build non-reproducible-wasm && cd e2e && bun run deploy.ts --fresh
//
// When the account exists, pass one of:
//   --upgrade  deploy the new code in place with the account's full-access key from .keys/; state
//              (balances, matches, pinned keys) is kept, so only use it when the state layout is
//              unchanged. Checks the on-chain code hash and that the keys pinned before (enclave
//              or local test referee) are still pinned; it makes no referee call.
//   --upgrade --migrate
//              the same, for code whose state layout changed: the deploy and the contract's
//              `migrate(vrf_sender)` go in one transaction signed by the contract account, so no
//              call ever meets new code over old state, and a failed migration undoes the deploy.
//   --fresh    delete the account first (NEAR back to the parent), which wipes every balance and
//              match on it. Never run it while a match is live.
//
// The VRF alpha's `sender` (the account OutLayer names in `vrf:{request_id}:{sender}:{seed}`, the
// referee's OutLayer caller) is pinned too: `--vrf-sender=<account>`, default OUTLAYER_OWNER.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Account, actions, type KeyPairString, teraToGas } from "near-api-js";
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

const contractId = `tail.${parentId}`;
if (process.env["TAIL_CONTRACT"] && process.env["TAIL_CONTRACT"] !== contractId) {
  log(`note: TAIL_CONTRACT in .env.local is ${process.env["TAIL_CONTRACT"]}, not ${contractId}`);
}

const vrfSender =
  process.argv.find((a) => a.startsWith("--vrf-sender="))?.slice("--vrf-sender=".length) ||
  must("OUTLAYER_OWNER");
log(`vrf_sender ${vrfSender}`);

type Config = Record<string, unknown>;
const getConfig = async () =>
  (await provider.callFunction({ contractId, method: "get_config", args: {} })) as Config;

/** The live enclave's keys: its `verdicts` key from `pubkeys`, its VRF key checked against OutLayer. */
async function enclaveKeys() {
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
  log(`referee_pk ${refereePk}`);
  log(`vrf_pk ${vrfPk} (matches OutLayer /vrf/pubkey)`);
  return { refereePk, vrfPk };
}

// What must be pinned afterwards. An upgrade keeps whichever referee is pinned (the enclave or the
// local test referee; `apps/server/scripts/pin-referee.ts` switches between them), so it needs no
// referee call; a fresh deploy pins the enclave.
let want: { refereePk: string; vrfPk: string };
if ((await exists(contractId)) && process.argv.includes("--upgrade")) {
  const before = await getConfig();
  want = { refereePk: String(before["referee_pk"]), vrfPk: String(before["vrf_pk"]) };
  log(`keeping referee_pk ${want.refereePk}, vrf_pk ${want.vrfPk}`);
  const key = JSON.parse(readFileSync(`${keysDir}${contractId}.json`, "utf8")).private_key as KeyPairString;
  const code = wasm();
  const self = new Account(contractId, provider, key);
  if (process.argv.includes("--migrate")) {
    await self.signAndSendTransaction({
      receiverId: contractId,
      actions: [
        actions.deployContract(code),
        actions.functionCall("migrate", { vrf_sender: vrfSender }, teraToGas("100"), 0n),
      ],
    });
  } else {
    await self.deployContract(code);
  }
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
  want = await enclaveKeys();
  await createContract(contractId, {
    owner: parentId,
    referee_pk: want.refereePk,
    vrf_pk: want.vrfPk,
    vrf_sender: vrfSender,
    allowed_tokens: ALLOWED_TOKENS,
  });
  // The contract must be registered on each token before anyone can ft_transfer_call to it.
  for (const token of ALLOWED_TOKENS) await registerOnToken(token, contractId);
}
const config = await getConfig();
if (config["referee_pk"] !== want.refereePk || config["vrf_pk"] !== want.vrfPk)
  throw new Error("pinned keys differ");
if (config["vrf_sender"] !== vrfSender) throw new Error(`pinned vrf_sender is ${config["vrf_sender"]}`);
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
