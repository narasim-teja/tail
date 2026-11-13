// A short cache of `get_match` for the public views (GET /matches/:id, GET /join/:code). Phones
// poll the lobby every few seconds; without it each poll by anyone is one NEAR RPC call made on
// the relay's behalf. Reads that decide something (start, fill, the verdict flush) go to the
// chain directly; only views read through here. Concurrent reads of one match share one call.

import type { Chain, ChainMatch } from "./near.ts";

/** How long a view may be stale. A lobby changes when someone joins, which a phone shows anyway. */
export const CHAIN_VIEW_MS = 3_000;
/** Entries kept; the oldest go first. Callers only ask for matches the relay holds. */
const MAX_ENTRIES = 1_000;

export class ChainView {
  private readonly entries = new Map<string, { at: number; value: Promise<ChainMatch | null> }>();

  constructor(
    private readonly chain: Chain,
    private readonly now: () => number,
    private readonly ttlMs = CHAIN_VIEW_MS,
  ) {}

  /** The match as the chain had it at most `ttlMs` ago; `fresh` skips the cache. */
  getMatch(matchId: string, fresh = false): Promise<ChainMatch | null> {
    const hit = this.entries.get(matchId);
    if (!fresh && hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const value = this.chain.getMatch(matchId);
    this.entries.delete(matchId);
    this.entries.set(matchId, { at: this.now(), value });
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
