// Retention: where a private match was played stays private. Its sealed batches (the referee could
// open them again) and its declassified trails (every player's fixes, in the clear) are deleted a
// window after End: long enough for the players to watch the replay, short enough that the relay
// does not keep a record of where people walked. Public matches keep their trails: their replay
// is public by the host's choice. scripts/purge.ts runs the same purge by hand, or for one match.

import type { Logger } from "@tail/log";
import type { Store } from "./db.ts";
import type { Chain } from "./near.ts";

/** RELAY_RETENTION_HOURS defaults to this. */
export const DEFAULT_RETENTION_HOURS = 24;
/** How often the relay looks for matches due. */
export const PURGE_EVERY_MS = 3_600_000;

export interface RetentionDeps {
  store: Store;
  /** Asked only for matches from before the relay kept `public_replay` itself. */
  chain: Pick<Chain, "getMatch">;
  log: Logger;
  windowMs: number;
  now?: () => number;
}

export class Retention {
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly d: RetentionDeps) {
    this.now = d.now ?? Date.now;
  }

  /** Purges every private match whose End is older than the window. Returns the match ids. */
  async sweep(): Promise<string[]> {
    const purged: string[] = [];
    for (const c of this.d.store.purgeCandidates(this.now() - this.d.windowMs)) {
      if (c.public_replay === null) {
        const chain = await this.d.chain.getMatch(c.match_id);
        // Unknown on chain: keep it, and ask again next sweep rather than guess.
        if (!chain) continue;
        this.d.store.setPublicReplay(c.match_id, chain.public_replay);
        if (chain.public_replay) continue;
      }
      this.purge(c.match_id);
      purged.push(c.match_id);
    }
    return purged;
  }

  /**
   * Deletes one match's sealed batches and trails now, public or not. Refused while the match is
   * still being played or declassified: its batches are needed until the trails are stored.
   */
  purge(matchId: string): { batches: number; trails: number } {
    const m = this.d.store.match(matchId);
    if (!m) throw new Error(`no match ${matchId} here`);
    if (m.phase !== "ended" && m.phase !== "failed") throw new Error(`match ${matchId} is ${m.phase}`);
    const n = this.d.store.purgeMatch(matchId, this.now());
    this.d.log.info({ matchId, ...n }, "purged sealed batches and trails");
    return n;
  }

  /** Sweeps now and then every PURGE_EVERY_MS until stop(). */
  start() {
    const run = () =>
      this.sweep().catch((e: unknown) => this.d.log.warn({ err: (e as Error).message }, "purge failed"));
    void run();
    this.timer = setInterval(run, PURGE_EVERY_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }
}
