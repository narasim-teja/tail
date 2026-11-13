// Run by shutdown.test.ts as its own process: a relay on a database file, holding the lease of
// a match, that stops the way main.ts does when it gets a signal.

import { createRelay } from "../../src/app.ts";
import { newCarryKeys } from "../../src/carry.ts";
import { Store } from "../../src/db.ts";
import { LEASE_MS } from "../../src/matches.ts";
import { stopOnSignals, stopRelay } from "../../src/shutdown.ts";
import { FakeChain, FakeReferee, quietLog } from "../fakes.ts";

const [dbPath, matchId] = process.argv.slice(2) as [string, string];
const store = new Store(dbPath);
const relay = createRelay({
  store,
  chain: new FakeChain(),
  referee: new FakeReferee(),
  log: quietLog(),
  parentAccount: "relay.testnet",
  appId: "TEAM.app",
  environment: "development",
  token: "usdc.fakes.testnet",
  carryKeys: newCarryKeys(),
  replay: {
    contract: "tail.relay.testnet",
    network: "testnet",
    refereeProject: "relay.testnet/tail-referee",
    outlayerApi: "https://testnet-api.outlayer.ai",
    refereeKind: "outlayer",
  },
  testnet: true,
  allowGhosts: false,
});
relay.retention.start();
store.holdLease(matchId, relay.matches.holder, Date.now(), LEASE_MS);
stopOnSignals(() => stopRelay({ matches: relay.matches, retention: relay.retention, store }), quietLog());
// What keeps a real relay running is its server; here an idle timer does.
setInterval(() => {}, 60_000);
process.stdout.write("ready\n");
