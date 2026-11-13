// Relay configuration from the environment, validated once at startup. A missing value or a
// placeholder copied from .env.example stops the relay with a message naming the variable, so
// it never runs half-configured against testnet.

import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_ENROL_CAPS, type EnrolCaps } from "./limits.ts";
import { DEFAULT_RETENTION_HOURS } from "./retention.ts";

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
  /**
   * `outlayer` (default): the referee in OutLayer's enclave. `local`: the same referee code run
   * natively on this machine, a test referee for when OutLayer is unavailable. Both play on
   * TAIL_CONTRACT: a player's key can call only the contract it was made for, so a second contract
   * would lock every enrolled player out. The contract pins one referee's keys at a time
   * (scripts/pin-referee.ts), and main.ts refuses to start when they are not this referee's.
   */
  refereeMode: "outlayer" | "local";
  /** Set in local mode: the native referee binary and the directory holding its keys. */
  localReferee: { bin: string; dir: string } | null;
  /**
   * The account the referee's VRF alpha names as its caller, which the contract pins as
   * `vrf_sender`: the OutLayer project owner, or for the local test referee the relay account.
   */
  vrfSender: string;
  /** How long after End a private match's sealed batches and trails are kept (retention.ts). */
  retentionMs: number;
  /** Where the relay's own mesh carry keys live (carry.ts); generated there on first start. */
  keysDir: string;
  /**
   * The header a reverse proxy in front of the relay sets to the client's address, lowercase
   * (limits.ts). Undefined: the relay faces clients directly and uses the TCP peer.
   */
  clientIpHeader: string | undefined;
  /** Caps on new phone enrolments per rolling day, in all and per client address (enroll.ts). */
  enrolCaps: EnrolCaps;
  /**
   * The web replay (apps/web) that GET /health names, so phones link to it without a setting of
   * their own. An http(s) origin and path, no trailing slash: the phone appends `/?match=<id>`.
   */
  replayUrl: string | undefined;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

const PLACEHOLDER = /PLACEHOLDER|^your-|your-account|your-payment-key|your-key/;

// The phone appends `/?match=<id>` (or `/dossier/<account>`), so a query, a fragment or a
// trailing slash would make a broken link. The phone checks the same shape again (it trusts no
// relay).
const REPLAY_URL = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~%-]+)*$/;

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
  const mode = opt("REFEREE_MODE", "outlayer");
  if (mode !== "outlayer" && mode !== "local")
    throw new ConfigError("REFEREE_MODE must be outlayer or local");
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
  const retentionHours = Number(opt("RELAY_RETENTION_HOURS", String(DEFAULT_RETENTION_HOURS)));
  if (!Number.isInteger(retentionHours) || retentionHours < 1 || retentionHours > 8_760) {
    throw new ConfigError("RELAY_RETENTION_HOURS must be a whole number of hours from 1 to 8760");
  }
  const count = (k: string, fallback: number) => {
    const v = Number(opt(k, String(fallback)));
    if (!Number.isInteger(v) || v < 1 || v > 100_000)
      throw new ConfigError(`${k} must be a whole number from 1 to 100000`);
    return v;
  };
  const enrolCaps: EnrolCaps = {
    perDay: count("RELAY_ENROLS_PER_DAY", DEFAULT_ENROL_CAPS.perDay),
    perIpPerDay: count("RELAY_ENROLS_PER_IP_PER_DAY", DEFAULT_ENROL_CAPS.perIpPerDay),
  };
  const ipHeader = env["RELAY_CLIENT_IP_HEADER"]?.trim().toLowerCase();
  if (ipHeader && !/^[a-z0-9-]+$/.test(ipHeader))
    throw new ConfigError("RELAY_CLIENT_IP_HEADER must be a header name, like cf-connecting-ip");
  const replayUrl = env["RELAY_REPLAY_URL"]?.trim();
  if (replayUrl && !REPLAY_URL.test(replayUrl))
    throw new ConfigError(
      "RELAY_REPLAY_URL must be an http(s) address without a trailing slash, query or fragment, like https://replay.example",
    );
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
    refereeMode: mode,
    vrfSender: mode === "local" ? relayAccount : need("OUTLAYER_OWNER"),
    localReferee:
      mode === "local"
        ? {
            bin: opt(
              "LOCAL_REFEREE_BIN",
              new URL("../../../crates/referee-wasi/target/release/tail-referee", import.meta.url).pathname,
            ),
            // Private keys: under the repo's ignored .keys/, never next to the relay's data.
            dir: opt("LOCAL_REFEREE_DIR", new URL("../../../.keys/local-referee", import.meta.url).pathname),
          }
        : null,
    retentionMs: retentionHours * 3_600_000,
    // Private keys: under the repo's ignored .keys/, never next to the relay's data.
    keysDir: opt("RELAY_KEYS_DIR", new URL("../../../.keys/relay", import.meta.url).pathname),
    clientIpHeader: ipHeader || undefined,
    enrolCaps,
    replayUrl: replayUrl || undefined,
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
    referee:
      c.refereeMode === "local"
        ? "local test referee (not an enclave)"
        : `${c.outlayerOwner}/${c.refereeProject}${c.refereeVersion ? `@${c.refereeVersion.slice(0, 12)}` : ""}`,
    refereePaymentKey: `present, ${c.refereePaymentKey.length} chars`,
    appId: c.appId,
    port: c.port,
    allowGhosts: c.allowGhosts,
    retentionHours: c.retentionMs / 3_600_000,
    keysDir: c.keysDir,
    clientIp: c.clientIpHeader ? `header ${c.clientIpHeader}` : "TCP peer",
    enrolCaps: c.enrolCaps,
    replayUrl: c.replayUrl ?? null,
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
