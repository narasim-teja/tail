// Shared by e2e.ts and deploy.ts: testnet-only setup, the parent account, contract create/delete.
// Prints facts about keys (present, public half), never a secret.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  Account,
  actions,
  JsonRpcProvider,
  KeyPair,
  type KeyPairString,
  nearToYocto,
  teraToGas,
} from "near-api-js";

export const repo = new URL("../../../", import.meta.url).pathname;
// Bun only auto-loads .env files from the working directory, and these scripts run from e2e/.
loadEnv(`${repo}.env.local`);

export const TOKEN = "usdc.fakes.testnet";
export const CIRCLE_USDC_TESTNET = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
export const ALLOWED_TOKENS = [TOKEN, CIRCLE_USDC_TESTNET];
// NEAR for a contract account: ~3.9 for the 391 KB wasm, the rest for state.
export const CONTRACT_FUNDING = "4.5";

if ((process.env["NEAR_NETWORK"] ?? "testnet") !== "testnet") throw new Error("testnet only");
export const parentId = must("NEAR_RELAY_ACCOUNT");
if (!parentId.endsWith(".testnet")) throw new Error("NEAR_RELAY_ACCOUNT must be a .testnet account");
export const provider = new JsonRpcProvider({
  url: process.env["NEAR_RPC_URL"] ?? "https://test.rpc.fastnear.com",
});
export const parent = new Account(parentId, provider, must("NEAR_RELAY_PRIVATE_KEY") as KeyPairString);
export const keysDir = `${repo}.keys/`;
mkdirSync(keysDir, { recursive: true });

export const log = (s: string) => process.stdout.write(`${s}\n`);

export function wasm() {
  return readFileSync(new URL("../target/near/tail_contract.wasm", import.meta.url));
}

/** Creates `accountId` under the parent, deploys the wasm and calls `new` in one transaction, so
 *  nobody can initialise it in between. Its full-access key goes to .keys/<account>.json. */
export async function createContract(accountId: string, init: Record<string, unknown>) {
  const key = KeyPair.fromRandom("ed25519");
  writeFileSync(
    `${keysDir}${accountId}.json`,
    JSON.stringify({ account_id: accountId, private_key: key.toString() }),
    {
      mode: 0o600,
    },
  );
  const code = wasm();
  await parent.signAndSendTransaction({
    receiverId: accountId,
    actions: [
      actions.createAccount(),
      actions.transfer(nearToYocto(CONTRACT_FUNDING)),
      actions.addFullAccessKey(key.getPublicKey()),
      actions.deployContract(code),
      actions.functionCall("new", init, teraToGas("30"), 0n),
    ],
  });
  log(
    `created ${accountId}: ${code.length} bytes of wasm, full-access key present in .keys/, public ${key.getPublicKey()}`,
  );
}

/** Deletes a contract account with its stored key; its NEAR goes back to the parent. */
export async function deleteContract(accountId: string) {
  const key = JSON.parse(readFileSync(`${keysDir}${accountId}.json`, "utf8")).private_key as KeyPairString;
  await new Account(accountId, provider, key).deleteAccount(parentId);
  log(`deleted ${accountId}, NEAR returned to ${parentId}`);
}

export async function exists(id: string) {
  try {
    await provider.viewAccount({ accountId: id });
    return true;
  } catch {
    return false;
  }
}

export function loadEnv(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const kv = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!kv?.[1] || process.env[kv[1]] !== undefined) continue;
    process.env[kv[1]] = (kv[2] ?? "").replace(/^(["'])(.*)\1$/, "$2");
  }
}

export function must(k: string) {
  const v = process.env[k];
  if (!v || v.includes("PLACEHOLDER") || v.startsWith("your-")) throw new Error(`${k} missing in .env.local`);
  return v;
}

export function hex(u: Uint8Array) {
  return Buffer.from(u).toString("hex");
}
export function unhex(s: string) {
  return Uint8Array.from(Buffer.from(s, "hex"));
}

/** NEP-145 registration on a token, paid by the parent, so the account can receive it. */
export async function registerOnToken(token: string, id: string) {
  const reg = await provider.callFunction({
    contractId: token,
    method: "storage_balance_of",
    args: { account_id: id },
  });
  if (reg) return;
  const bounds = (await provider.callFunction({
    contractId: token,
    method: "storage_balance_bounds",
    args: {},
  })) as {
    min: string;
  };
  await parent.callFunction({
    contractId: token,
    methodName: "storage_deposit",
    args: { account_id: id, registration_only: true },
    gas: teraToGas("30"),
    deposit: BigInt(bounds.min),
  });
  log(`registered ${id} on ${token}`);
}
