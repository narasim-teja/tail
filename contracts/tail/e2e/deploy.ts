// Deploys the live contract `tail.<NEAR_RELAY_ACCOUNT>` from scratch, pinned to the real keys:
// the referee enclave's `verdicts` key (from the referee's `pubkeys` command) and OutLayer's
// testnet VRF key (checked against OutLayer's public /vrf/pubkey). Testnet only.
//
//   cd contracts/tail && cargo near build non-reproducible-wasm && cd e2e && bun run deploy.ts --fresh
//
// `--fresh` is required when the account exists: it deletes it first (NEAR back to the parent),
// which wipes every balance and match on it. Never run it while a match is live.

import {
  ALLOWED_TOKENS,
  createContract,
  deleteContract,
  exists,
  log,
  must,
  parentId,
  provider,
  registerOnToken,
} from "./common.ts";

const contractId = `tail.${parentId}`;
if (process.env["TAIL_CONTRACT"] && process.env["TAIL_CONTRACT"] !== contractId) {
  log(`note: TAIL_CONTRACT in .env.local is ${process.env["TAIL_CONTRACT"]}, not ${contractId}`);
}

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

if (await exists(contractId)) {
  if (!process.argv.includes("--fresh"))
    throw new Error(`${contractId} exists; pass --fresh to delete and recreate it`);
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
const config = (await provider.callFunction({ contractId, method: "get_config", args: {} })) as Record<
  string,
  unknown
>;
if (config["referee_pk"] !== refereePk || config["vrf_pk"] !== vrfPk) throw new Error("pinned keys differ");
log(JSON.stringify(config, null, 1));
