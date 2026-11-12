// Starts the relay: config from the environment (repo-root .env.local), SQLite under data/,
// the NEAR testnet chain, the OutLayer referee, and the HTTP + WebSocket server.

import { createLogger } from "@tail/log";
import { createRelay } from "./app.ts";
import { type Config, ConfigError, describeConfig, loadConfig, loadRepoEnv } from "./config.ts";
import { Store } from "./db.ts";
import { NearChain } from "./near.ts";
import { OutLayerReferee } from "./referee.ts";

const log = createLogger("relay");

/** Builds and starts a relay from a config; the ghost-match script uses this in-process. */
export function startRelay(config: Config) {
  const store = new Store(config.dbPath);
  const chain = new NearChain(config, log);
  const referee = new OutLayerReferee({
    api: config.outlayerApi,
    owner: config.outlayerOwner,
    project: config.refereeProject,
    paymentKey: config.refereePaymentKey,
    version: config.refereeVersion,
  });
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
    },
    testnet: config.network === "testnet",
    allowGhosts: config.allowGhosts,
  });
  relay.matches.resume();
  const server = Bun.serve({ port: config.port, fetch: relay.app.fetch, websocket: relay.websocket });
  log.info({ ...describeConfig(config), url: server.url.href }, "relay listening");
  if (config.allowGhosts) log.warn("ghost enrolment is open (testnet testing door, no App Attest)");
  return {
    ...relay,
    store,
    chain,
    referee,
    server,
    stop() {
      relay.matches.stop();
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
  startRelay(config);
}
