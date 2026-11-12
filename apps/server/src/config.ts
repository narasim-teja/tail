// Relay configuration from the environment, validated once at startup. A missing value or a
// placeholder copied from .env.example stops the relay with a message naming the variable, so
// it never runs half-configured against testnet.

import { existsSync, readFileSync } from "node:fs";

export type Network = "testnet";

export interface Config {
  network: Network;
  rpcUrl: string;
  relayAccount: string;
  /** `ed25519:…`; never logged. */
  relayPrivateKey: string;
  contract: string;
  /** NEP-141 token players are registered on (storage_deposit) and matches are staked in. */
  token: string;
  outlayerApi: string;
  outlayerOwner: string;
  refereeProject: string;
  /** Never logged. */
  refereePaymentKey: string;
  /** Optional wasm sha256 to pin the referee version the relay calls. */
  refereeVersion: string | undefined;
  /** App Attest App ID, `<team id>.<bundle id>`. */
  appId: string;
  appAttestEnvironment: "development" | "production";
  port: number;
  dbPath: string;
  /** True only when NEAR_NETWORK=testnet and ALLOW_GHOSTS=1 (the testing door, README). */
  allowGhosts: boolean;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

const PLACEHOLDER = /PLACEHOLDER|^your-|your-account|your-payment-key|your-key/;

/**
 * Reads the variables the relay needs from `env`. Throws ConfigError on the first missing,
 * placeholder or malformed one. Only testnet is accepted: the relay never signs on mainnet.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const need = (k: string): string => {
    const v = env[k]?.trim();
    if (!v) throw new ConfigError(`${k} is not set`);
    if (PLACEHOLDER.test(v)) throw new ConfigError(`${k} still holds the .env.example placeholder`);
    return v;
  };
  const opt = (k: string, fallback: string) => {
    const v = env[k]?.trim();
    if (v && PLACEHOLDER.test(v)) throw new ConfigError(`${k} still holds the .env.example placeholder`);
    return v || fallback;
  };

  const network = need("NEAR_NETWORK");
  if (network !== "testnet") throw new ConfigError(`NEAR_NETWORK must be testnet (got ${network})`);
  const relayAccount = need("NEAR_RELAY_ACCOUNT");
  if (!relayAccount.endsWith(".testnet"))
    throw new ConfigError("NEAR_RELAY_ACCOUNT must be a .testnet account");
  const relayPrivateKey = need("NEAR_RELAY_PRIVATE_KEY");
  if (!relayPrivateKey.startsWith("ed25519:"))
    throw new ConfigError("NEAR_RELAY_PRIVATE_KEY must be ed25519:…");
  const contract = need("TAIL_CONTRACT");
  if (!contract.endsWith(".testnet")) throw new ConfigError("TAIL_CONTRACT must be a .testnet account");

  const ghosts = env["ALLOW_GHOSTS"]?.trim();
  if (ghosts !== undefined && ghosts !== "" && ghosts !== "0" && ghosts !== "1") {
    throw new ConfigError("ALLOW_GHOSTS must be 0 or 1");
  }

  const port = Number(opt("RELAY_PORT", "8787"));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ConfigError("RELAY_PORT must be a port number");
  const environment = opt("APP_ATTEST_ENV", "development");
  if (environment !== "development" && environment !== "production") {
    throw new ConfigError("APP_ATTEST_ENV must be development or production");
  }
  const api = need("OUTLAYER_API");
  if (!api.startsWith("https://")) throw new ConfigError("OUTLAYER_API must be an https URL");
  if (!api.includes("testnet")) throw new ConfigError("OUTLAYER_API must be the testnet API");
  const version = env["REFEREE_VERSION"]?.trim();
  if (version && !/^[0-9a-f]{64}$/.test(version))
    throw new ConfigError("REFEREE_VERSION must be a wasm sha256");

  return {
    network,
    rpcUrl: opt("NEAR_RPC_URL", "https://test.rpc.fastnear.com"),
    relayAccount,
    relayPrivateKey,
    contract,
    token: opt("TAIL_TOKEN", "usdc.fakes.testnet"),
    outlayerApi: api.replace(/\/$/, ""),
    outlayerOwner: need("OUTLAYER_OWNER"),
    refereeProject: opt("REFEREE_PROJECT", "tail-referee"),
    refereePaymentKey: env["REFEREE_PAYMENT_KEY"]?.trim()
      ? need("REFEREE_PAYMENT_KEY")
      : need("OUTLAYER_PAYMENT_KEY"),
    refereeVersion: version || undefined,
    appId: `${need("APPLE_TEAM_ID")}.${need("IOS_BUNDLE_ID")}`,
    appAttestEnvironment: environment,
    port,
    dbPath: opt("RELAY_DB", new URL("../data/relay.db", import.meta.url).pathname),
    allowGhosts: network === "testnet" && ghosts === "1",
  };
}

/** What may be printed about the config: facts, never a key. */
export function describeConfig(c: Config) {
  return {
    network: c.network,
    relayAccount: c.relayAccount,
    relayKey: `present, ${c.relayPrivateKey.length} chars`,
    contract: c.contract,
    token: c.token,
    referee: `${c.outlayerOwner}/${c.refereeProject}${c.refereeVersion ? `@${c.refereeVersion.slice(0, 12)}` : ""}`,
    refereePaymentKey: `present, ${c.refereePaymentKey.length} chars`,
    appId: c.appId,
    port: c.port,
    allowGhosts: c.allowGhosts,
  };
}

/**
 * Bun loads .env files only from the working directory; the relay keeps its secrets in the
 * repo-root .env.local. Values already in the environment win.
 */
export function loadRepoEnv(env: Record<string, string | undefined> = process.env): void {
  const path = new URL("../../../.env.local", import.meta.url).pathname;
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const kv = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!kv?.[1] || env[kv[1]] !== undefined) continue;
    env[kv[1]] = (kv[2] ?? "").replace(/^(["'])(.*)\1$/, "$2");
  }
}
