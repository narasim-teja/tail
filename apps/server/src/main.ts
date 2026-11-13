// Starts the relay: config from the environment (repo-root .env.local), SQLite under data/,
// the NEAR testnet chain, the referee (OutLayer's enclave, or the local test referee with
// REFEREE_MODE=local), and the HTTP + WebSocket server.

import { createLogger } from "@tail/log";
import { toHex } from "@tail/protocol";
import { createRelay } from "./app.ts";
import { type Config, ConfigError, describeConfig, loadConfig, loadRepoEnv } from "./config.ts";
import { Store } from "./db.ts";
import { NearChain } from "./near.ts";
import { GuardedReferee, makeReferee } from "./referee.ts";

const log = createLogger("relay");

/** Builds and starts a relay from a config; the ghost-match script uses this in-process. */
export function startRelay(config: Config) {
  const store = new Store(config.dbPath);
  const chain = new NearChain(config, log);
  // The client keeps call stats and spend; the guard in front of it is what the relay calls.
  const refereeClient = makeReferee(config);
  const referee = new GuardedReferee(refereeClient, config.refereeMode);
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
    refereeHealth: () => referee.health(),
    testnet: config.network === "testnet",
    allowGhosts: config.allowGhosts,
  });
  relay.matches.resume();
  relay.enrolment.resumePending();
  const server = Bun.serve({ port: config.port, fetch: relay.app.fetch, websocket: relay.websocket });
  log.info({ ...describeConfig(config), url: server.url.href }, "relay listening");
  if (config.allowGhosts) log.warn("ghost enrolment is open (testnet testing door, no App Attest)");
  return {
    ...relay,
    store,
    chain,
    referee,
    refereeClient,
    server,
    stop() {
      relay.matches.stop();
      relay.enrolment.stop();
      server.stop(true);
      store.close();
    },
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
  if (config.refereeMode === "local") await checkLocalPins(config);
  startRelay(config);
}

/**
 * The local test referee signs with its own keys, so its contract must pin them, or every
 * verdict would be refused on chain mid-match. Checked once, before serving.
 */
async function checkLocalPins(config: Config) {
  const [keys, pinned] = await Promise.all([
    makeReferee(config).pubkeys(),
    new NearChain(config, log).config(),
  ]);
  if (pinned.referee_pk !== toHex(keys.refereePk) || pinned.vrf_pk !== toHex(keys.vrfPk)) {
    log.fatal(
      { contract: config.contract },
      "the contract does not pin the local referee's keys; run apps/server/scripts/pin-referee.ts with REFEREE_MODE=local",
    );
    process.exit(1);
  }
  log.warn(
    { contract: config.contract },
    "local test referee: verdicts are signed on this machine, not in an enclave",
  );
}
