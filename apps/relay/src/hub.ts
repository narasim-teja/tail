// Fan-out of per-player messages to authenticated HUD sockets. A message for (match, player)
// reaches only sockets that proved that player's NEAR key (routes/hud.ts). HUDs are sealed to
// the player's box key; the hub only routes them.

export type HudMessage =
  | { type: "keys"; match_id: string; player: number; sealed: string }
  | { type: "hud"; match_id: string; tick: number; sealed: string }
  | { type: "handler"; match_id: string; hint_id: number; text: string }
  | { type: "rejected"; match_id: string; detail: Record<string, unknown> }
  | { type: "refused"; match_id: string; detail: Record<string, unknown> }
  | { type: "over"; match_id: string };

export interface Sink {
  send(text: string): void;
}

export class HudHub {
  private readonly subs = new Map<string, Set<Sink>>();

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
