// Mints the dossier of every account this relay enrolled that has none: accounts registered
// before the contract had dossiers (src/dossiers.ts). Signed by NEAR_RELAY_ACCOUNT, their parent,
// which pays each dossier_deposit. The relay does the same at every start; this runs it on demand.
// Does nothing on a contract from before dossiers, or when every account holds one. Safe beside
// a running relay (SQLite WAL; the contract refuses a second dossier).
//
//   bun apps/server/scripts/backfill-dossiers.ts

import { createLogger } from "@tail/log";
import { loadConfig, loadRepoEnv } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { DossierBackfill } from "../src/dossiers.ts";
import { NearChain } from "../src/near.ts";

loadRepoEnv();
const config = loadConfig(process.env);
const log = createLogger("backfill-dossiers");
const store = new Store(config.dbPath);
let failed = false;
try {
  const r = await new DossierBackfill({
    store,
    chain: new NearChain(config, log),
    log,
    parentAccount: config.relayAccount,
  }).run();
  if (!r) console.log(`${config.contract} has no dossiers yet; nothing to do`);
  else {
    console.log(
      `minted ${r.minted.length}, already held ${r.held}, not registered ${r.unregistered}, ` +
        `failed ${r.failed.length}, left for another run ${r.deferred}`,
    );
    for (const a of r.minted) console.log(`  minted ${a}`);
    for (const a of r.failed) console.log(`  FAILED ${a}`);
    failed = r.failed.length > 0;
  }
} finally {
  store.close();
}
process.exit(failed ? 1 : 0);
