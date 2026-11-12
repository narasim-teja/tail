// Runs ghosts through a trace in real time: every second each live ghost takes a fix and hears
// the beacons of every ghost in radio range; every BATCH_MS it seals a batch and uploads it to
// the relay (in order, retrying failed uploads first, as the app does). The hunter asks the
// trace's hint and strikes once its own HUD shows a full lock.

import type { Logger } from "@tail/log";
import { BATCH_MS, LOCK_EPOCHS } from "@tail/protocol";
import type { Circle } from "../referee.ts";
import type { Ghost } from "./ghost.ts";
import { positionAt, type Trace, toLatLonE7, type Waypoint } from "./trace.ts";

type Role = "hunter" | "target" | "bystander";

export interface SquadOptions {
  ghosts: Ghost[];
  trace: Trace;
  matchId: string;
  zone: Circle;
  refereeBoxPk: Uint8Array;
  appId: string;
  log: Logger;
  now?: () => number;
}

export class Squad {
  readonly roles = new Map<Ghost, Role>();
  private readonly outbox = new Map<Ghost, Uint8Array[]>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastBatchMs = 0;
  private hinted = false;
  private struck = false;
  private busy = false;
  private readonly now: () => number;

  constructor(private readonly o: SquadOptions) {
    this.now = o.now ?? Date.now;
    const keyed = o.ghosts.map((g) => {
      if (!g.keys) throw new Error(`${g.handle} has no PlayerKeys`);
      return { g, k: g.keys };
    });
    const hunter = keyed.find((x) => x.k.player === 0);
    if (!hunter) throw new Error("no ghost is player 0");
    for (const { g } of keyed) {
      const role: Role = g === hunter.g ? "hunter" : g.accountId === hunter.k.target ? "target" : "bystander";
      this.roles.set(g, role);
      this.outbox.set(g, []);
    }
  }

  ghost(role: Role): Ghost {
    for (const [g, r] of this.roles) if (r === role) return g;
    throw new Error(`no ${role}`);
  }

  get startMs(): number {
    return Number(this.o.ghosts[0]?.keys?.startMs ?? 0n);
  }

  start() {
    this.timer = setInterval(() => void this.second(), 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private path(g: Ghost): readonly Waypoint[] {
    return this.o.trace.paths[this.roles.get(g) ?? "bystander"];
  }

  private async second() {
    if (this.busy) return; // an upload is slow; the next second catches up
    this.busy = true;
    try {
      const now = this.now();
      if (now < this.startMs) return;
      const tS = (now - this.startMs) / 1000;
      const live = this.o.ghosts.filter((g) => !g.out);
      const pos = new Map(live.map((g) => [g, positionAt(this.path(g), tS)]));
      for (const g of live) {
        const p = pos.get(g) as { east: number; north: number; speed: number };
        const ll = toLatLonE7(this.o.zone, p.east, p.north);
        g.fix({
          tMs: BigInt(now),
          ...ll,
          accM: this.o.trace.accM,
          speedCmps: Math.round(p.speed * 100),
          flags: 0,
        });
        for (const other of live) {
          if (other === g) continue;
          const q = pos.get(other) as { east: number; north: number };
          if (Math.hypot(p.east - q.east, p.north - q.north) <= this.o.trace.radioM) {
            g.hear(now, other.token(now), this.o.trace.rssi);
          }
        }
      }
      const hunter = this.ghost("hunter");
      const hint = this.o.trace.hint;
      if (hint && !this.hinted && tS >= hint.atS) {
        hunter.hint(hint.kind, hint.text);
        this.hinted = true;
        this.o.log.info({ ghost: hunter.handle, kind: hint.kind }, "ghost asks a hint");
      }
      if (this.o.trace.strikeWhenLocked && !this.struck && (hunter.huds.at(-1)?.lock ?? 0) >= LOCK_EPOCHS) {
        hunter.strike();
        this.struck = true;
        this.o.log.info({ ghost: hunter.handle, lock: hunter.huds.at(-1)?.lock }, "ghost strikes");
      }
      if (now - this.lastBatchMs >= BATCH_MS) {
        this.lastBatchMs = now;
        for (const g of live) this.outbox.get(g)?.push(g.sealedBatch(now, this.o.refereeBoxPk, this.o.appId));
        await Promise.all(live.map((g) => this.flush(g)));
      }
    } catch (e) {
      this.o.log.error({ err: (e as Error).message }, "ghost second failed");
    } finally {
      this.busy = false;
    }
  }

  private async flush(g: Ghost) {
    const box = this.outbox.get(g) ?? [];
    while (box.length) {
      try {
        await g.request("POST", "/batch", {
          match_id: this.o.matchId,
          sealed: Buffer.from(box[0] as Uint8Array).toString("base64"),
        });
        box.shift();
      } catch (e) {
        this.o.log.warn({ ghost: g.handle, err: (e as Error).message }, "batch upload failed; retrying");
        return;
      }
    }
  }
}
