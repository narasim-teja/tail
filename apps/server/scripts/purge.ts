// Deletes sealed batches and declassified trails from the relay's database (src/retention.ts).
// With no argument: every private match whose End is older than RELAY_RETENTION_HOURS (default
// 24), as the running relay does each hour. With match ids: those matches now, public or private,
// as long as they have ended. Reads the chain only (get_match, for matches from before the relay
// kept public_replay); sends no transaction. Safe beside a running relay (SQLite WAL).
//
//   bun apps/server/scripts/purge.ts
//   bun apps/server/scripts/purge.ts 0123456789abcdef0123456789abcdef

import { createLogger } from "@tail/log";
import { loadConfig, loadRepoEnv } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { NearChain } from "../src/near.ts";
import { Retention } from "../src/retention.ts";

loadRepoEnv();
const config = loadConfig(process.env);
const log = createLogger("purge");
const ids = process.argv.slice(2);
const bad = ids.filter((id) => !/^[0-9a-f]{32}$/.test(id));
if (bad.length) {
  console.error(`not a match id: ${bad.join(", ")}`);
  process.exit(2);
}

const store = new Store(config.dbPath);
const retention = new Retention({
  store,
  chain: new NearChain(config, log),
  log,
  windowMs: config.retentionMs,
});
let failed = false;
try {
  if (ids.length === 0) {
    const purged = await retention.sweep();
    console.log(
      `purged ${purged.length} private match(es) ended over ${config.retentionMs / 3_600_000} h ago`,
    );
    for (const id of purged) console.log(`  ${id}`);
  } else {
    for (const id of ids) {
      try {
        const n = retention.purge(id);
        console.log(`${id}: deleted ${n.batches} sealed batches and ${n.trails} trails`);
      } catch (e) {
        failed = true;
        console.error(`${id}: ${(e as Error).message}`);
      }
    }
  }
} finally {
  store.close();
}
process.exit(failed ? 1 : 0);
