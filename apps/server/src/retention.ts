// Retention: a private match's record of where and how it was played goes a window after End
// (RELAY_RETENTION_HOURS, default 24): long enough for the players to watch the replay, short
// enough that the relay does not keep a record of where people walked. The purge deletes the
// sealed batches and state (the referee could open them again), the declassified trails and log,
// the log's sealed copies, the zone and safehouses, the sealed HUDs and the Handler's lines
// (db.ts purgeMatch). A failed match goes the same window after its end (or its creation, if it
// never started), public or not, since it has no replay. What stays is public anyway or reveals nothing: verdicts (on
// chain), leaf hashes, tick timings and reason codes, the sealed PlayerKeys, the reveal.
//
// Not covered: a public match keeps everything (its replay is public by the host's choice); a
// lobby that never started keeps its zone; the relay's logs and backups are the operator's; and
// the referee keeps its own match and device records in its storage. scripts/purge.ts runs
// the same purge by hand, or for one match.

import type { Logger } from "@tail/log";
import type { PurgeCounts, Store } from "./db.ts";
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

  /** Purges every match due (purgeCandidates). Returns the match ids. */
  async sweep(): Promise<string[]> {
    const purged: string[] = [];
    for (const c of this.d.store.purgeCandidates(this.now() - this.d.windowMs)) {
      if (c.phase === "ended" && c.public_replay === null) {
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
   * Purges one match now, public or not. Refused while the match is still being played or
   * declassified: its batches are needed until the trails are stored.
   */
  purge(matchId: string): PurgeCounts {
    const m = this.d.store.match(matchId);
    if (!m) throw new Error(`no match ${matchId} here`);
    if (m.phase !== "ended" && m.phase !== "failed") throw new Error(`match ${matchId} is ${m.phase}`);
    const n = this.d.store.purgeMatch(matchId, this.now());
    this.d.log.info({ matchId, ...n }, "purged where and how the match was played");
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
