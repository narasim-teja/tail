// Starts the relay: config from the environment (repo-root .env.local), SQLite under data/,
// the NEAR testnet chain, the referee (OutLayer's enclave, or the local test referee with
// REFEREE_MODE=local), and the HTTP + WebSocket server.

import { createLogger } from "@tail/log";
import { createRelay } from "./app.ts";
import { loadCarryKeys } from "./carry.ts";
import { type Config, ConfigError, describeConfig, loadConfig, loadRepoEnv } from "./config.ts";
import { Store } from "./db.ts";
import { DossierBackfill } from "./dossiers.ts";
import { proxyHeaderWarning } from "./limits.ts";
import { NearChain } from "./near.ts";
import { pinProblem } from "./pins.ts";
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
    vrfSender: config.vrfSender,
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
 * Checked once, before serving: the relay refuses to run beside a referee the contract does not
 * pin, or a local test referee that does not answer (pins.ts).
 */
async function checkPins(config: Config) {
  const pinned = await new NearChain(config, log).config();
  const keys = await makeReferee(config)
    .pubkeys()
    .catch((e: unknown) => e as Error);
  const problem = pinProblem(config, pinned, keys);
  if (problem) {
    log.fatal({ contract: config.contract, mode: config.refereeMode }, problem);
    process.exit(1);
  }
  if (keys instanceof Error)
    log.warn({ err: keys.message }, "could not check the contract's pinned referee keys; starting anyway");
  else if (keys.appId === null)
    log.warn({ appId: config.appId }, "this referee build does not name its App ID; it is not checked");
  if (config.refereeMode === "local") {
    log.warn(
      { contract: config.contract },
      "local test referee: verdicts are signed on this machine, not in an enclave",
    );
  }
}
