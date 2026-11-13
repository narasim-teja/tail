// Starts the relay: config from the environment (repo-root .env.local), SQLite under data/,
// the NEAR testnet chain, the referee (OutLayer's enclave, or the local test referee with
// REFEREE_MODE=local), and the HTTP + WebSocket server.

import { createLogger } from "@tail/log";
import { toHex } from "@tail/protocol";
import { createRelay } from "./app.ts";
import { loadCarryKeys } from "./carry.ts";
import { type Config, ConfigError, describeConfig, loadConfig, loadRepoEnv } from "./config.ts";
import { Store } from "./db.ts";
import { DossierBackfill } from "./dossiers.ts";
import { proxyHeaderWarning } from "./limits.ts";
import { NearChain } from "./near.ts";
import { GuardedReferee, makeReferee } from "./referee.ts";
import { MAX_BODY } from "./routes/util.ts";
import { stopOnSignals, stopRelay } from "./shutdown.ts";

const log = createLogger("relay");

/** Builds and starts a relay from a config; the ghost-match script uses this in-process. */
export function startRelay(config: Config) {
  const store = new Store(config.dbPath);
  const chain = new NearChain(config, log);
  // The client keeps call stats and spend; the guard in front of it is what the relay calls.
  const refereeClient = makeReferee(config);
  const referee = new GuardedReferee(refereeClient, config.refereeMode);
  const carry = loadCarryKeys(config.keysDir);
  if (carry.created) log.info({ dir: config.keysDir }, "made new mesh carry keys");
  const relay = createRelay({
    store,
    chain,
    referee,
    log,
    parentAccount: config.relayAccount,
    appId: config.appId,
    environment: config.appAttestEnvironment,
    token: config.token,
    replay: {
      contract: config.contract,
      network: config.network,
      refereeProject: `${config.outlayerOwner}/${config.refereeProject}`,
      outlayerApi: config.outlayerApi,
      refereeKind: config.refereeMode,
    },
    carryKeys: carry.keys,
    refereeHealth: () => referee.health(),
    testnet: config.network === "testnet",
    allowGhosts: config.allowGhosts,
    retentionMs: config.retentionMs,
    clientIpHeader: config.clientIpHeader,
    enrolCaps: config.enrolCaps,
  });
  relay.matches.resume();
  relay.retention.start();
  // Accounts registered before the contract had dossiers get theirs; a no-op on older contracts.
  void new DossierBackfill({ store, chain, log, parentAccount: config.relayAccount })
    .run()
    .catch((e: unknown) =>
      log.warn({ err: (e as Error).message }, "dossier backfill failed; it runs again on the next start"),
    );
  // Bun refuses a larger body before the app sees it; routes/util.ts caps the streamed read too.
  const server = Bun.serve({
    port: config.port,
    fetch: relay.app.fetch,
    websocket: relay.websocket,
    maxRequestBodySize: MAX_BODY,
  });
  log.info({ ...describeConfig(config), url: server.url.href }, "relay listening");
  const shared = proxyHeaderWarning(config.clientIpHeader, server.hostname);
  if (shared) log.warn({ hostname: server.hostname }, shared);
  if (config.allowGhosts) log.warn("test players are on (testnet testing door, no App Attest)");
  return {
    ...relay,
    store,
    chain,
    referee,
    refereeClient,
    server,
    stop: () => stopRelay({ matches: relay.matches, retention: relay.retention, store, server }),
  };
}

if (import.meta.main) {
  loadRepoEnv();
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      log.fatal(e.message);
      process.exit(1);
    }
    throw e;
  }
  await checkPins(config);
  stopOnSignals(startRelay(config).stop, log);
}

/**
 * The contract pins one referee's keys at a time, and every verdict is checked against them, so
 * the relay refuses to run beside a referee the contract does not pin: every verdict would be
 * refused mid-match. Checked once, before serving. A referee that does not answer cannot be
 * checked; the relay starts anyway and the guard reports it down.
 */
async function checkPins(config: Config) {
  const pinned = await new NearChain(config, log).config();
  const keys = await makeReferee(config)
    .pubkeys()
    .catch((e: unknown) => {
      log.warn({ err: (e as Error).message }, "could not check the contract's pinned referee keys");
      return null;
    });
  if (keys && (pinned.referee_pk !== toHex(keys.refereePk) || pinned.vrf_pk !== toHex(keys.vrfPk))) {
    log.fatal(
      { contract: config.contract, mode: config.refereeMode },
      `the contract pins another referee's keys; run REFEREE_MODE=${config.refereeMode} bun apps/server/scripts/pin-referee.ts`,
    );
    process.exit(1);
  }
  if (config.refereeMode === "local") {
    log.warn(
      { contract: config.contract },
      "local test referee: verdicts are signed on this machine, not in an enclave",
    );
  }
}
