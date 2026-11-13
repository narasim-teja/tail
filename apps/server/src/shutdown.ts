// Stopping the relay on SIGINT or SIGTERM. Each match's lease (matches.ts) names this process,
// so a relay that just exits leaves every match it was stepping to wait out LEASE_MS before
// another process may step it. Stopping lets the steps in flight finish, hands the leases back
// and closes the database.

import type { Logger } from "@tail/log";
import type { Store } from "./db.ts";
import type { Matches } from "./matches.ts";
import type { Retention } from "./retention.ts";

/** Long enough for a step in flight to finish: a referee call's deadline and a NEAR call or two. */
export const DRAIN_MS = 75_000;

export interface Running {
  matches: Matches;
  retention: Retention;
  store: Store;
  server?: { stop(closeActiveConnections?: boolean): unknown };
}

/** Takes no new requests or steps, lets those in flight finish, then closes everything. */
export async function stopRelay(r: Running, drainMs = DRAIN_MS) {
  // Graceful first: requests already in (a Start) are tracked by `drain`.
  void r.server?.stop();
  r.retention.stop();
  await r.matches.drain(drainMs);
  void r.server?.stop(true);
  r.store.close();
}

/** Stops cleanly on the first SIGINT or SIGTERM; a second one exits at once. */
export function stopOnSignals(stop: () => Promise<void>, log: Logger) {
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) {
        log.warn({ signal }, "stopping now, without waiting for the steps in flight");
        process.exit(1);
      }
      stopping = true;
      log.info({ signal }, "stopping: letting the steps in flight finish, then handing back the leases");
      stop().then(
        () => process.exit(0),
        (e: unknown) => {
          log.error({ err: (e as Error).message }, "stopping failed");
          process.exit(1);
        },
      );
    });
  }
}
