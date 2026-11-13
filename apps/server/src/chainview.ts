// A short cache of `get_match` for reads anyone can trigger (GET /matches/:id, GET /join/:code,
// the zone view's membership check, GET /replay/:id). Phones poll the lobby every few seconds;
// without it each poll by anyone is one NEAR RPC call made on the relay's behalf. Reads that
// decide something with money behind it (start, fill, the verdict flush) go to the chain
// directly; only views read through here. Concurrent reads of one match share one call. A read
// that asks for fresh data (someone who just joined) skips a cached view, but shares another
// fresh read made within the last FRESH_MS, so asking for fresh data cannot multiply RPC calls.

import type { Chain, ChainMatch } from "./near.ts";

/** How long a view may be stale. A lobby changes when someone joins, which a phone shows anyway. */
export const CHAIN_VIEW_MS = 3_000;
/** How old a "fresh" read may be: at most one RPC call per match per this long, however many ask. */
export const FRESH_MS = 1_000;
/** Entries kept; the oldest go first. Callers only ask for matches the relay holds. */
const MAX_ENTRIES = 1_000;

export class ChainView {
  private readonly entries = new Map<
    string,
    { at: number; fresh: boolean; value: Promise<ChainMatch | null> }
  >();

  constructor(
    private readonly chain: Chain,
    private readonly now: () => number,
    private readonly ttlMs = CHAIN_VIEW_MS,
  ) {}

  /**
   * The match as the chain had it at most `ttlMs` ago. With `fresh`: as read for a fresh request
   * at most FRESH_MS ago, or read now.
   */
  getMatch(matchId: string, fresh = false): Promise<ChainMatch | null> {
    const hit = this.entries.get(matchId);
    const age = hit ? this.now() - hit.at : Number.POSITIVE_INFINITY;
    if (hit && (fresh ? hit.fresh && age < Math.min(FRESH_MS, this.ttlMs) : age < this.ttlMs))
      return hit.value;
    const value = this.chain.getMatch(matchId);
    this.entries.delete(matchId);
    this.entries.set(matchId, { at: this.now(), fresh, value });
    // A failed read is not kept: the next caller tries again.
    value.catch(() => {
      if (this.entries.get(matchId)?.value === value) this.entries.delete(matchId);
    });
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return value;
  }
}
