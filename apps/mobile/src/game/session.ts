// One player's hunt, from the match start to the end (TECHNICAL.md 4.2–4.7, 5.5). It owns:
// - the epoch clock: rotates the beacon token and the scan filter at every boundary
// - the radio: sightings → tag filter → per-epoch aggregates; fixes → ~1 Hz wire fixes
// - the batch loop: every BATCH_MS a chained, attested, sealed batch into the outbox
// - the outbox: ordered upload with retry, persisted so a restart loses nothing
// - the HUD socket: sealed HUDs → what the hunt screen shows
// - the mesh carry path when the relay is unreachable (behind a setting, carry/mesh.ts)
// Everything device-specific comes in through ports, so tests drive it with fakes.

import {
  BATCH_MS,
  beaconTag,
  beaconToken,
  type HintKind,
  hintPrice,
  type PlayerKeys,
  toHex,
  tokenToUuid,
} from "@tail/protocol";
import type { RadioFix, RadioSighting } from "../../modules/tail-radio";
import type { CarryConfig, CarryStatus } from "../carry/mesh";
import type { SignedRequest } from "../relay/client";
import type { HudMessage, SocketState } from "../relay/hud";
import { ActionQueue } from "./actions";
import { type Assert, BatchBuilder, type ChainState, type OutboxItem } from "./batch";
import { currentEpoch, EpochTimer, realTimers, type Timers } from "./epoch";
import { FixCollector } from "./fixes";
import { type Circle, inCircle } from "./geo";
import { describeRejection, formatAmount, type HudView, hudView, openHud } from "./hud";
import { Outbox, Uploader, type UploadState } from "./outbox";
import { VehicleWatch } from "./rules";
import { SightingAggregator } from "./sightings";

/** The parts of tail-radio the session drives. */
export interface RadioPort {
  startBeacon(): void;
  setToken(uuid: string): void;
  stopBeacon(): void;
  setScanFilter(prefixes: string[]): void;
  startScan(): void;
  stopScan(): void;
  startLocation(): void;
  stopLocation(): void;
  setPocketMode(on: boolean): void;
  onSighting(fn: (s: RadioSighting) => void): () => void;
  onFix(fn: (f: RadioFix) => void): () => void;
  /** Bluetooth manager state per role ("poweredOn", "unauthorized", "poweredOff", …). */
  onRadioState(fn: (role: "peripheral" | "central", state: string) => void): () => void;
  /** Location authorisation ("authorizedWhenInUse", "denied", …). */
  onLocationState(fn: (status: string) => void): () => void;
}

export interface CarryPort {
  status: CarryStatus;
  update(offline: boolean): Promise<void>;
  shutdown(): Promise<void>;
}

export interface HudPort {
  open(): void;
  close(): void;
}

export interface SessionDeps {
  matchIdHex: string;
  keys: PlayerKeys;
  stake: bigint;
  boxSk: Uint8Array;
  refereeBoxPk: Uint8Array;
  chain: ChainState;
  outbox: OutboxItem[];
  radio: RadioPort;
  assert: Assert;
  /** Signs `POST /batch` for one sealed batch. */
  batchRequest: (sealed: Uint8Array) => SignedRequest;
  upload: (req: SignedRequest) => Promise<unknown>;
  /** Persists the chain position and the outbox together. */
  save: (chain: ChainState, outbox: readonly OutboxItem[]) => void;
  hud: (onMessage: (m: HudMessage) => void, onState: (s: SocketState) => void) => HudPort;
  carry:
    | ((d: {
        head: () => { item: OutboxItem; req: SignedRequest } | null;
        delivered: (seq: number) => void;
        onChange: () => void;
      }) => CarryPort)
    | null;
  carryConfig: CarryConfig;
  /** The match zone, checked against the chain's zone hash; null when the relay sent none. */
  zone: Circle | null;
  now?: () => number;
  timers?: Timers;
}

export interface Note {
  tMs: number;
  text: string;
  kind: "handler" | "rejected" | "refused" | "info";
}

export interface SessionSnapshot {
  epoch: number | null;
  token: string | null;
  /** Kept sightings in the current batch window. */
  heard: number;
  fixes: number;
  /** Your own position for the map; heading in degrees from north, null until you move. */
  lastFix: { lat: number; lon: number; acc: number; heading: number | null } | null;
  seq: number;
  queued: number;
  upload: UploadState;
  offline: boolean;
  carry: CarryStatus | { kind: "off"; why: string };
  socket: SocketState;
  hud: HudView | null;
  notes: Note[];
  over: boolean;
  pendingActions: number;
  /** Set when STRIKE was pressed; cleared by the next HUD, which carries the result. */
  strikeSentAtMs: number | null;
  /** The last tag you made: when, and who your target is now. */
  landed: { atMs: number; target: string } | null;
  /** Tags you made this match. */
  tags: number;
  /** When the relay last heard from you, while it has not for OFFLINE_CARRY_MS; else null. */
  darkSinceMs: number | null;
  /** When you left the zone; null while inside (or with no zone to judge by). */
  outSinceMs: number | null;
  /** Your lock is frozen (vehicle speed) until then; null when not frozen. */
  frozenUntilMs: number | null;
  /** What stops the hunt from working at all: Bluetooth or location switched off or denied. */
  blocked: "bluetooth" | "location" | null;
}

type UiState = Pick<
  SessionSnapshot,
  | "epoch"
  | "token"
  | "socket"
  | "hud"
  | "notes"
  | "over"
  | "strikeSentAtMs"
  | "landed"
  | "tags"
  | "outSinceMs"
  | "blocked"
>;

export class HuntSession {
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly startMs: number;
  private readonly endMs: number;
  private readonly fixes = new FixCollector();
  private readonly sightings: SightingAggregator;
  private readonly actions = new ActionQueue();
  private readonly outbox: Outbox;
  private readonly builder: BatchBuilder;
  private readonly uploader: Uploader;
  private readonly epochTimer: EpochTimer;
  private carry: CarryPort | null = null;
  private hudPort: HudPort | null = null;
  private unsub: (() => void)[] = [];
  private batchTimer: unknown = null;
  private listeners = new Set<() => void>();
  private snap: SessionSnapshot;
  private ui: UiState = {
    epoch: null,
    token: null,
    socket: "closed",
    hud: null,
    notes: [],
    over: false,
    strikeSentAtMs: null,
    landed: null,
    tags: 0,
    outSinceMs: null,
    blocked: null,
  };
  private readonly vehicle = new VehicleWatch();
  private radioStates: Record<"peripheral" | "central", string> = {
    peripheral: "unknown",
    central: "unknown",
  };
  private locationStatus = "unknown";
  private fixCount = 0;
  // iOS reports no course while standing still; the marker keeps pointing the last way you went.
  private heading: number | null = null;
  private heard = 0;
  private running = false;

  constructor(private readonly d: SessionDeps) {
    this.now = d.now ?? Date.now;
    this.timers = d.timers ?? realTimers;
    this.startMs = Number(d.keys.startMs);
    this.endMs = Number(d.keys.endMs);
    this.sightings = new SightingAggregator(d.keys.kTag);
    this.outbox = new Outbox(d.outbox);
    this.builder = new BatchBuilder({
      matchId: d.keys.matchId,
      player: d.keys.player,
      refereeBoxPk: d.refereeBoxPk,
      chain: d.chain,
      fixes: this.fixes,
      sightings: this.sightings,
      actions: this.actions,
      assert: d.assert,
      commit: (item, chain) => {
        this.outbox.push(item);
        d.save(chain, this.outbox.all());
      },
      now: this.now,
    });
    this.uploader = new Uploader({
      outbox: this.outbox,
      send: (item) => d.upload(d.batchRequest(item.sealed)).then(() => undefined),
      onAck: () => d.save(this.builder.chain, this.outbox.all()),
      onChange: () => this.refresh(),
      now: this.now,
      timers: this.timers,
    });
    this.epochTimer = new EpochTimer(this.startMs, (e) => this.onEpoch(e), this.now, this.timers);
    this.snap = this.compute();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    const r = this.d.radio;
    this.unsub.push(r.onSighting((s) => this.onSighting(s)));
    this.unsub.push(
      r.onFix((f) => {
        this.fixes.add(f);
        this.fixCount++;
        if (f.course >= 0) this.heading = f.course;
        this.vehicle.add(f.tMs, f.speed);
        this.checkZone(f);
      }),
    );
    this.unsub.push(
      r.onRadioState((role, state) => {
        this.radioStates[role] = state;
        this.updateBlocked();
      }),
    );
    this.unsub.push(
      r.onLocationState((status) => {
        this.locationStatus = status;
        this.updateBlocked();
      }),
    );
    r.setPocketMode(true);
    r.startLocation();
    r.startBeacon();
    r.startScan();
    this.epochTimer.start();
    this.hudPort = this.d.hud(
      (m) => this.onHud(m),
      (s) => this.update({ socket: s }),
    );
    this.hudPort.open();
    if (this.d.carry && this.d.carryConfig.nodeAddress.trim()) {
      this.carry = this.d.carry({
        head: () => {
          const item = this.outbox.head();
          return item ? { item, req: this.d.batchRequest(item.sealed) } : null;
        },
        delivered: (seq) => this.uploader.delivered(seq),
        onChange: () => this.refresh(),
      });
    }
    this.uploader.kick();
    this.scheduleBatch();
    this.refresh();
  }

  /** Stops the radio and timers. Unsent batches stay in the outbox file. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.epochTimer.stop();
    if (this.batchTimer !== null) this.timers.clearTimeout(this.batchTimer);
    this.batchTimer = null;
    for (const u of this.unsub) u();
    this.unsub = [];
    const r = this.d.radio;
    r.stopScan();
    r.stopBeacon();
    r.stopLocation();
    r.setPocketMode(false);
    this.hudPort?.close();
    void this.carry?.shutdown();
    this.uploader.stop("Hunt stopped.");
    this.refresh();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): SessionSnapshot {
    return this.snap;
  }

  // ── Player actions ───────────────────────────────────────────────────────────────────────

  hint(kind: HintKind, question?: string): void {
    this.actions.hint(kind, question);
    this.note("info", `Hint asked: ${formatAmount(hintPrice(this.d.stake, kind))} from your head.`);
  }

  strike(): void {
    this.actions.strike();
    this.update({ strikeSentAtMs: this.now() });
    // Sent with the very next batch instead of waiting up to BATCH_MS: the lock may not last.
    void this.batchNow();
  }

  // ── Internals ────────────────────────────────────────────────────────────────────────────

  private onEpoch(e: number): void {
    const k = this.d.keys;
    const token = tokenToUuid(beaconToken(k.kTag, k.kPlayer, e));
    this.d.radio.setToken(token);
    this.d.radio.setScanFilter(
      [e - 1, e, e + 1].filter((x) => x >= 0).map((x) => toHex(beaconTag(k.kTag, x))),
    );
    this.update({ epoch: e, token });
    if (this.now() >= this.endMs) this.update({ over: true });
  }

  private onSighting(s: RadioSighting): void {
    const e = currentEpoch(this.now(), this.startMs);
    if (e === null) return;
    if (this.sightings.add(e, s.uuid, s.rssi)) this.heard++;
  }

  private scheduleBatch(): void {
    if (!this.running) return;
    this.batchTimer = this.timers.setTimeout(() => {
      this.batchTimer = null;
      void this.batchNow().finally(() => this.scheduleBatch());
    }, BATCH_MS);
  }

  /** Builds one batch now (if the match has started) and pushes the outbox along. */
  async batchNow(): Promise<void> {
    if (!this.running || this.now() < this.startMs || this.ui.over) return;
    try {
      await this.builder.build();
      this.heard = 0;
    } catch (e) {
      this.note("info", `Report not built: ${(e as Error).message}`);
    }
    this.uploader.kick();
    await this.carry?.update(this.uploader.offline());
    if (this.now() >= this.endMs) this.update({ over: true });
    this.refresh();
  }

  private onHud(m: HudMessage): void {
    switch (m.type) {
      case "hud": {
        try {
          const view = hudView(openHud(this.d.boxSk, m.sealed));
          const prev = this.ui.hud;
          // A new target while still hunting means your strike landed and you inherited theirs.
          const landed =
            prev && prev.status === "hunting" && view.status === "hunting" && view.target !== prev.target
              ? { atMs: this.now(), target: view.target }
              : this.ui.landed;
          this.update({
            hud: view,
            strikeSentAtMs: null,
            landed,
            tags: landed !== this.ui.landed ? this.ui.tags + 1 : this.ui.tags,
          });
          if (view.status !== "hunting") this.stopReporting();
        } catch {
          this.note("info", "A HUD update did not open.");
        }
        return;
      }
      case "handler":
        this.note("handler", m.text);
        return;
      case "rejected":
        this.note("rejected", describeRejection(m.reason));
        return;
      case "refused":
        this.note("refused", `${m.action || "Action"} refused: ${m.reason}`);
        return;
      case "over":
        this.update({ over: true });
        this.stopReporting();
        return;
      default:
        return;
    }
  }

  /** Out or over: nothing more to report, but keep the HUD for the result. */
  private stopReporting(): void {
    if (!this.running) return;
    this.epochTimer.stop();
    if (this.batchTimer !== null) this.timers.clearTimeout(this.batchTimer);
    this.batchTimer = null;
    const r = this.d.radio;
    r.stopScan();
    r.stopBeacon();
    r.stopLocation();
    r.setPocketMode(false);
    this.refresh();
  }

  private note(kind: Note["kind"], text: string): void {
    this.update({ notes: [{ tMs: this.now(), text, kind }, ...this.ui.notes].slice(0, 20) });
  }

  private checkZone(f: RadioFix): void {
    const zone = this.d.zone;
    if (!zone || !(f.acc >= 0)) return;
    const inside = inCircle({ lat: f.lat, lon: f.lon }, zone);
    if (inside && this.ui.outSinceMs !== null) this.update({ outSinceMs: null });
    if (!inside && this.ui.outSinceMs === null) this.update({ outSinceMs: f.tMs });
  }

  private updateBlocked(): void {
    const bad = (s: string) => s === "unauthorized" || s === "poweredOff" || s === "unsupported";
    const blocked =
      bad(this.radioStates.peripheral) || bad(this.radioStates.central)
        ? "bluetooth"
        : this.locationStatus === "denied" || this.locationStatus === "restricted"
          ? "location"
          : null;
    if (blocked !== this.ui.blocked) this.update({ blocked });
  }

  private update(p: Partial<UiState>): void {
    this.ui = { ...this.ui, ...p };
    this.refresh();
  }

  private refresh(): void {
    this.snap = this.compute();
    for (const l of this.listeners) l();
  }

  private compute(): SessionSnapshot {
    const f = this.fixes.latest;
    return {
      ...this.ui,
      heard: this.heard,
      fixes: this.fixCount,
      lastFix: f ? { lat: f.latE7 / 1e7, lon: f.lonE7 / 1e7, acc: f.accM, heading: this.heading } : null,
      seq: this.builder.chain.seq,
      queued: this.outbox.length,
      upload: this.uploader.state,
      offline: this.uploader.offline(),
      carry: this.carry?.status ?? {
        kind: "off",
        why: this.d.carryConfig.nodeAddress.trim()
          ? "Mesh carry is not available."
          : "Relay has no mesh node yet.",
      },
      pendingActions: this.actions.size,
      darkSinceMs: this.uploader.offline() ? this.uploader.lastContactMs : null,
      frozenUntilMs: this.vehicle.frozenFor(this.now()) === null ? null : this.vehicle.frozenUntilMs,
    };
  }
}
