// Fan-out of per-player messages to authenticated HUD sockets. A message for (match, player)
// reaches only sockets that proved that player's NEAR key (routes/hud.ts). Keys, HUDs and
// Handler lines are signed by the referee and sealed to the player's box key; the hub only
// routes them.

export type HudMessage =
  /** SignedPlayerKeys sealed to the player (openSignedPlayerKeys). */
  | { type: "keys"; match_id: string; player: number; sealed: string }
  /** SignedHud sealed to the player (openSignedHud). */
  | { type: "hud"; match_id: string; tick: number; sealed: string }
  /** The Handler's line for the player's own hint: SignedVoiceLine sealed to them (openSignedVoiceLine). */
  | { type: "handler"; match_id: string; sealed: string }
  | { type: "rejected"; match_id: string; detail: Record<string, unknown> }
  | { type: "refused"; match_id: string; detail: Record<string, unknown> }
  | { type: "over"; match_id: string };

export interface Sink {
  send(text: string): void;
}

/**
 * Authenticated HUD sockets one account may hold at once. A phone needs one; a reconnect can
 * briefly overlap the socket it replaces. A newer socket closes the oldest, so whoever proves the
 * key last always gets in.
 */
export const MAX_HUD_SOCKETS_PER_ACCOUNT = 3;
/**
 * Sockets still in their 10 s auth window, across all accounts. Anyone can open one for any
 * account, so this bound is global and does not count towards the account's own cap.
 */
export const MAX_PENDING_HUD_SOCKETS = 1_024;

export class HudHub {
  private readonly subs = new Map<string, Set<Sink>>();
  private readonly byAccount = new Map<string, (() => void)[]>();
  pending = 0;

  /**
   * Counts an authenticated socket against its account. If the account already holds the
   * maximum, the oldest is closed through its `evict`. Returns the release for the socket's close.
   */
  admit(account: string, evict: () => void): () => void {
    const list = this.byAccount.get(account) ?? [];
    // An evicted socket's close may release synchronously and drop the emptied entry; set it after.
    while (list.length >= MAX_HUD_SOCKETS_PER_ACCOUNT) list.shift()?.();
    list.push(evict);
    this.byAccount.set(account, list);
    return () => {
      const i = list.indexOf(evict);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0 && this.byAccount.get(account) === list) this.byAccount.delete(account);
    };
  }

  private key(matchId: string, player: number) {
    return `${matchId}:${player}`;
  }

  subscribe(matchId: string, player: number, sink: Sink): () => void {
    const k = this.key(matchId, player);
    let set = this.subs.get(k);
    if (!set) {
      set = new Set();
      this.subs.set(k, set);
    }
    set.add(sink);
    return () => {
      set.delete(sink);
      if (set.size === 0) this.subs.delete(k);
    };
  }

  send(matchId: string, player: number, msg: HudMessage) {
    const text = JSON.stringify(msg);
    for (const s of this.subs.get(this.key(matchId, player)) ?? []) {
      try {
        s.send(text);
      } catch {
        // A socket that closed mid-send is dropped on its own close event.
      }
    }
  }

  subscribers(matchId: string, player: number): number {
    return this.subs.get(this.key(matchId, player))?.size ?? 0;
  }
}
