// One player's proximity reporting for one match, with no game rules in it (TECHNICAL.md 4.2–4.7,
// 5.5, 7). It owns:
// - the epoch clock: rotates the beacon token and the scan filter at every boundary
// - the radio: sightings → tag filter → per-epoch aggregates; fixes → ~1 Hz wire fixes; whether
//   Bluetooth or location is off, and when the phone could not be heard (background, locked)
// - the batch loop: every BATCH_MS a chained, attested, sealed batch into the outbox, carrying
//   the game's queued actions without reading them
// - the outbox: ordered upload with retry, persisted so a restart loses nothing; a batch leaves
//   it only once a signed HUD shows the referee took it, and the chain is mended or rebuilt from
//   the HUD's next_seq / chain_tip when the two part (chain.ts)
// - the record beside it: every report the relay took (for the inclusion receipts), the newest
//   fix time, actions not yet in a batch
// - the HUD socket: sealed HUDs, opened and checked against the referee key the match pinned,
//   handed to the game newest first; the game's own frames are passed through
// - the mesh carry path, both roles, when the plan says so (carry/mesh.ts): a second transport for
//   the same outbox, deduplicated by batch hash
// - the log monitor (monitor.ts): every signed HUD root, and every root anchored on NEAR, checked
//   to be one growing log; a fork is kept as evidence and stays in status() for good
// The game (TAIL: tail/hunt.ts) reads the HUD and decides what it means, and says when this
// player has nothing more to report. Everything device-specific comes in through ports, so tests
// drive it with fakes.

import {
  type Action,
  type AnchoredRoot,
  BATCH_MS,
  beaconTag,
  beaconToken,
  CHECKPOINT_MS,
  equal,
  type Hud,
  type PlayerKeys,
  toHex,
  tokenToUuid,
} from "@tail/protocol";
import type {
  AppStateEvent,
  LocationStateEvent,
  ProximityEvent,
  RadioFix,
  RadioSighting,
} from "../../modules/tail-radio";
import { ActionQueue } from "./actions";
import { type Assert, BatchBuilder, type ChainState, type OutboxItem } from "./batch";
import {
  type CarryDelivery,
  type CarryStatus,
  carryEnvelope,
  envelopeDigest,
  MeshCarry,
  type MeshLink,
} from "./carry/mesh";
import { type Confirmed, planChain } from "./chain";
import { currentEpoch, EpochTimer, realTimers, type Timers } from "./epoch";
import { FIX_MAX_AGE_MS, FixCollector } from "./fixes";
import { type HudMessage, openSignedHudBytes, type Seat, type SocketState } from "./hud";
import { type LogFork, LogMonitor, type MonitorRecord, type RelayFault } from "./monitor";
import { Outbox, Uploader, type UploadState } from "./outbox";
import type { Report } from "./receipts";
import type { CarryKey, CarryReply, SignedRequest } from "./relay";
import { SightingAggregator } from "./sightings";

/** The parts of the radio module (modules/tail-radio) the client drives. */
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
  /** Location authorisation ("authorizedWhenInUse", "denied", …) and whether it is precise. */
  onLocationState(fn: (e: LocationStateEvent) => void): () => void;
  /** Foreground, background and device lock. */
  onAppState(fn: (e: AppStateEvent) => void): () => void;
  /** Pocket mode: whether this phone has a proximity sensor to turn the screen off. */
  onProximity(fn: (e: ProximityEvent) => void): () => void;
}

/** What the client needs kept across a relaunch; the game saves it with its own state. */
export interface ProximityRecord {
  chain: ChainState;
  /** Batches not yet confirmed by a HUD, sent or not. */
  outbox: OutboxItem[];
  /** The referee's chain position the phone last agreed with. */
  confirmed: Confirmed;
  /** Every batch the relay took, for the inclusion receipts after the match. */
  reports: Report[];
  /** The newest HUD tick taken in; an older HUD (a replay by the relay) is ignored. */
  hudTick: number;
  /** The newest fix time taken in; fixes at or before it are never sent again. */
  lastFixMs: number | null;
  /** Game actions not yet inside a committed batch. */
  actions: Action[];
  /** Where the log monitor stands: the last verified root, and the fork once one is found. */
  monitor: MonitorRecord;
}

/** The mesh carry path: on with the relay's carry keys, or off and why. */
export type CarryPlan =
  | {
      kind: "on";
      key: CarryKey;
      link: MeshLink;
      /** POST /carry, as a forwarder. */
      forward: (envelope: Uint8Array) => Promise<CarryReply>;
    }
  | { kind: "off"; why: string };

export interface HudPort {
  open(): void;
  close(): void;
}

/** What the log monitor reads: proofs from the relay, anchored roots from NEAR. */
export interface LogPort {
  /** `GET /matches/:id/consistency`: the relay's proof, unverified. Throws when it can't be had. */
  consistency(from: number, to: number): Promise<Uint8Array[]>;
  /** The roots the contract anchored for the match, read from NEAR through the phone's own RPC. */
  anchors(): Promise<readonly AnchoredRoot[]>;
}

export interface ProximityDeps {
  /** This player's box secret key: HUDs and game lines are sealed to it. */
  boxSk: Uint8Array;
  /** The referee's box key, checked against the pinned referee key (referee.ts). */
  refereeBoxPk: Uint8Array;
  /** The referee key the match pinned on NEAR, read by the phone itself; it checks every HUD. */
  refereePk: Uint8Array;
  /** Where this match stood when it was last saved (genesis for a new match). */
  record: ProximityRecord;
  radio: RadioPort;
  assert: Assert;
  /** Signs `POST /batch` for one sealed batch. */
  batchRequest: (sealed: Uint8Array) => Promise<SignedRequest>;
  upload: (req: SignedRequest) => Promise<unknown>;
  /** Persists the whole record at once. */
  save: (r: ProximityRecord) => void;
  hud: (onMessage: (m: HudMessage) => void, onState: (s: SocketState) => void) => HudPort;
  carry: CarryPlan;
  log: LogPort;
  now?: () => number;
  timers?: Timers;
}

export type Blocked = "bluetooth" | "location" | "approximate";

export interface ProximityStatus {
  epoch: number | null;
  token: string | null;
  /** Kept sightings in the current batch window. */
  heard: number;
  fixes: number;
  /** Your own position; heading in degrees from north, null until you move. */
  lastFix: { lat: number; lon: number; acc: number; heading: number | null } | null;
  seq: number;
  /** Reports the relay does not have yet. */
  queued: number;
  upload: UploadState;
  offline: boolean;
  carry: CarryStatus;
  socket: SocketState;
  /** The match window has closed, or the relay said the match is over. */
  over: boolean;
  pendingActions: number;
  /**
   * What stops reporting from working at all: Bluetooth or location switched off or denied, or
   * location allowed only as approximate (the referee needs metres, not kilometres).
   */
  blocked: Blocked | null;
  /** The last stretch other phones could not hear you (backgrounded or locked), once you are back. */
  invisible: { seconds: number; atMs: number } | null;
  /** This phone has no proximity sensor, so the screen cannot turn off in a pocket by itself. */
  noPocketSensor: boolean;
  /** The referee committed to two logs that do not fit together; kept for good once found. */
  logFork: LogFork | null;
  /** The relay's newest consistency proof that did not verify; the monitor keeps asking. */
  relayFault: RelayFault | null;
}

/** Things the game may want to tell the player about; the words are the game's. */
export type ProximityNotice =
  /** A sealed HUD that did not open or was not signed by the match's referee; it was dropped. */
  | { kind: "unsigned" }
  | { kind: "build-failed"; message: string }
  /** A refusal of one of this phone's batches, named in a signed HUD, the first time it is seen. */
  | { kind: "rejected"; seq: number; code: number }
  /** Batches the referee never took were dropped and the chain goes on from `fromSeq`. */
  | { kind: "rebuilt"; dropped: number; fromSeq: number; lost: Action["kind"][] }
  /** Back in the foreground after `seconds` in which no one could hear this phone. */
  | { kind: "invisible"; seconds: number }
  /** The referee's log roots do not fit together (monitor.ts); `fork` is the evidence. */
  | { kind: "log-forked"; fork: LogFork }
  /** The relay sent a consistency proof that does not verify (monitor.ts); it is asked again later. */
  | { kind: "relay-bad-proof"; fault: RelayFault };

/** Your own reports offered to the mesh at once while offline, oldest first. */
const CARRY_AHEAD = 3;

/** How often the anchored roots are read from NEAR during a match: about once per checkpoint. */
export const ANCHOR_POLL_MS = CHECKPOINT_MS;

type Local = Pick<
  ProximityStatus,
  "epoch" | "token" | "socket" | "over" | "blocked" | "invisible" | "noPocketSensor"
>;

/** What exists only once the match keys are in hand. */
interface Keyed {
  keys: PlayerKeys;
  seat: Seat;
  startMs: number;
  endMs: number;
  sightings: SightingAggregator;
  builder: BatchBuilder;
  epochTimer: EpochTimer;
}

class Listeners<A extends unknown[]> {
  private readonly fns = new Set<(...a: A) => void>();
  add(fn: (...a: A) => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  emit(...a: A): void {
    for (const fn of this.fns) fn(...a);
  }
}

export class ProximityClient {
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly fixes: FixCollector;
  private readonly actions: ActionQueue;
  private readonly outbox: Outbox;
  private readonly uploader: Uploader;
  private readonly monitor: LogMonitor;
  private k: Keyed | null = null;
  private mesh: MeshCarry | null = null;
  private hudPort: HudPort | null = null;
  private confirmed: Confirmed;
  private readonly reports: Report[];
  private hudTick: number;
  private lastHud: Hud | null = null;
  // The refusal the chain was last rebuilt for, so a HUD repeating it does not rebuild again.
  private handled: { seq: number; code: number } | null = null;
  // The refusal last announced, so a HUD repeating it does not announce it again.
  private shownRejection: string | null = null;
  private chainWork: Promise<void> = Promise.resolve();
  // Own carry envelopes by batch hash (hex), sealed once per send round, and back by digest.
  private readonly envelopes = new Map<string, Uint8Array>();
  private readonly byDigest = new Map<string, Uint8Array>();
  private unsub: (() => void)[] = [];
  private batchTimer: unknown = null;
  private anchorTimer: unknown = null;
  private local: Local = {
    epoch: null,
    token: null,
    socket: "closed",
    over: false,
    blocked: null,
    invisible: null,
    noPocketSensor: false,
  };
  private radioStates: Record<"peripheral" | "central", string> = {
    peripheral: "unknown",
    central: "unknown",
  };
  private location: { status: string; fullAccuracy: boolean } = { status: "unknown", fullAccuracy: true };
  // When the app left the foreground or the phone locked: iOS stops the beacon then (F17).
  private hiddenSinceMs: number | null = null;
  private reporting = false;
  private fixCount = 0;
  // iOS reports no course while standing still; the marker keeps pointing the last way you went.
  private heading: number | null = null;
  private heard = 0;
  private running = false;
  private readonly on = {
    hud: new Listeners<[hud: Hud, previous: Hud | null]>(),
    receipt: new Listeners<[report: Report]>(),
    frame: new Listeners<[message: HudMessage]>(),
    notice: new Listeners<[notice: ProximityNotice]>(),
    fix: new Listeners<[fix: RadioFix]>(),
    change: new Listeners<[]>(),
  };

  constructor(private readonly d: ProximityDeps) {
    this.now = d.now ?? Date.now;
    this.timers = d.timers ?? realTimers;
    const r = d.record;
    this.fixes = new FixCollector(this.now, r.lastFixMs === null ? null : BigInt(r.lastFixMs));
    this.actions = new ActionQueue(r.actions);
    this.confirmed = r.confirmed;
    this.reports = [...r.reports];
    this.hudTick = r.hudTick;
    this.outbox = new Outbox(r.outbox);
    this.uploader = new Uploader({
      outbox: this.outbox,
      send: async (item) => {
        await d.upload(await d.batchRequest(item.sealed));
      },
      onSent: (item) => this.onSent(item),
      onChange: () => this.refresh(),
      now: this.now,
      timers: this.timers,
    });
    this.monitor = new LogMonitor(
      {
        consistency: (from, to) => d.log.consistency(from, to),
        changed: () => {
          this.save();
          this.refresh();
        },
        onFork: (fork) => this.on.notice.emit({ kind: "log-forked", fork }),
        onRelayFault: (fault) => this.on.notice.emit({ kind: "relay-bad-proof", fault }),
        now: this.now,
        timers: this.timers,
      },
      r.monitor,
    );
    if (d.carry.kind === "on") {
      const c = d.carry;
      this.mesh = new MeshCarry({
        link: c.link,
        key: c.key,
        online: () => !this.uploader.offline(),
        forward: c.forward,
        delivered: (x) => this.onCarried(x),
        onChange: () => this.refresh(),
      });
    }
  }

  // ── Interface ────────────────────────────────────────────────────────────────────────────

  /**
   * Starts the radio, the epoch clock, the batch loop, the HUD socket and the mesh for the match
   * these keys are for. One client serves one match: a later start must bring the same keys.
   */
  start(keys: PlayerKeys): void {
    if (this.running) return;
    const k = this.keyed(keys);
    this.running = true;
    this.reporting = true;
    const r = this.d.radio;
    this.unsub.push(r.onSighting((s) => this.onSighting(s)));
    this.unsub.push(
      r.onFix((f) => {
        // A cached fix (iOS hands one over first after a relaunch) says where you were, not
        // where you are: not for the batch, nor for the game.
        if (f.tMs < this.now() - FIX_MAX_AGE_MS) return;
        this.fixes.add(f);
        this.fixCount++;
        if (f.course >= 0) this.heading = f.course;
        this.on.fix.emit(f);
      }),
    );
    this.unsub.push(
      r.onRadioState((role, state) => {
        this.radioStates[role] = state;
        this.updateBlocked();
      }),
    );
    this.unsub.push(
      r.onLocationState((e) => {
        this.location = { status: e.status, fullAccuracy: e.fullAccuracy };
        this.updateBlocked();
      }),
    );
    this.unsub.push(r.onAppState((e) => this.onAppState(e)));
    this.unsub.push(
      r.onProximity((e) => {
        // Only the answer to turning pocket mode on says whether the sensor exists.
        if (e.pocketMode === true && e.proximitySupported === false) this.update({ noPocketSensor: true });
      }),
    );
    r.setPocketMode(true);
    r.startLocation();
    r.startBeacon();
    r.startScan();
    k.epochTimer.start();
    this.hudPort = this.d.hud(
      (m) => this.onMessage(m),
      (s) => this.update({ socket: s }),
    );
    this.hudPort.open();
    void this.mesh?.start();
    this.uploader.kick();
    this.monitor.resume();
    this.scheduleBatch();
    this.scheduleAnchors();
    this.refresh();
  }

  /** Stops the radio and timers. Unsent batches stay in the saved outbox. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.reporting = false;
    this.k?.epochTimer.stop();
    if (this.batchTimer !== null) this.timers.clearTimeout(this.batchTimer);
    this.batchTimer = null;
    if (this.anchorTimer !== null) this.timers.clearTimeout(this.anchorTimer);
    this.anchorTimer = null;
    this.monitor.stop();
    for (const u of this.unsub) u();
    this.unsub = [];
    this.stopRadio();
    this.hudPort?.close();
    void this.mesh?.stop();
    this.uploader.stop("Hunt stopped.");
    this.refresh();
  }

  /**
   * This player has nothing more to report (out, or the game is over for them): the radio and
   * the batch loop stop, the HUD socket stays open for the result.
   */
  stopReporting(): void {
    if (!this.running) return;
    this.reporting = false;
    this.k?.epochTimer.stop();
    if (this.batchTimer !== null) this.timers.clearTimeout(this.batchTimer);
    this.batchTimer = null;
    this.stopRadio();
    this.refresh();
  }

  /** Queues a game action for the next batch and saves it; `batchNow` sends it without waiting. */
  queueAction(a: Action): void {
    this.actions.push(a);
    this.save();
  }

  /** Builds one batch now (if the match has started) and pushes the outbox along. */
  async batchNow(): Promise<void> {
    const k = this.k;
    if (!k || !this.running || this.now() < k.startMs || this.local.over) return;
    try {
      await k.builder.build();
      this.heard = 0;
    } catch (e) {
      this.on.notice.emit({ kind: "build-failed", message: (e as Error).message });
    }
    this.uploader.kick();
    if (this.uploader.offline()) await this.offerToMesh();
    if (this.now() >= k.endMs) this.update({ over: true });
    this.refresh();
  }

  /**
   * Checks anchored roots the game read from NEAR itself (Results reads End's) against the
   * signed HUD roots; resolves once checked, or once the relay could not be reached.
   */
  checkAnchors(roots: readonly AnchoredRoot[]): Promise<void> {
    return this.monitor.checkAnchors(roots);
  }

  /** Each signed HUD newer than any before, with the one before it. */
  onHud(fn: (hud: Hud, previous: Hud | null) => void): () => void {
    return this.on.hud.add(fn);
  }

  /** Each batch the relay took, once, by HTTP or carried. */
  onReceipt(fn: (report: Report) => void): () => void {
    return this.on.receipt.add(fn);
  }

  /** Socket frames that are the game's: sealed game lines, refusals of actions. */
  onFrame(fn: (message: HudMessage) => void): () => void {
    return this.on.frame.add(fn);
  }

  onNotice(fn: (notice: ProximityNotice) => void): () => void {
    return this.on.notice.add(fn);
  }

  /** Each fresh location fix (cached ones are dropped first). */
  onFix(fn: (fix: RadioFix) => void): () => void {
    return this.on.fix.add(fn);
  }

  /** Anything in `status()` may have changed. */
  onChange(fn: () => void): () => void {
    return this.on.change.add(fn);
  }

  /** Where reporting stands now (a new object each call). */
  status(): ProximityStatus {
    const f = this.fixes.latest;
    return {
      ...this.local,
      heard: this.heard,
      fixes: this.fixCount,
      lastFix: f ? { lat: f.latE7 / 1e7, lon: f.lonE7 / 1e7, acc: f.accM, heading: this.heading } : null,
      seq: this.chain().seq,
      queued: this.outbox.unsent().length,
      upload: this.uploader.state,
      offline: this.uploader.offline(),
      carry: this.mesh?.status ?? { kind: "off", why: this.d.carry.kind === "off" ? this.d.carry.why : "" },
      pendingActions: this.unsentActions().length,
      logFork: this.monitor.fork,
      relayFault: this.monitor.relayFault,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────────────────────

  private keyed(keys: PlayerKeys): Keyed {
    if (this.k) {
      if (!equal(this.k.keys.matchId, keys.matchId) || this.k.keys.player !== keys.player)
        throw new Error("This client is for another match.");
      return this.k;
    }
    const startMs = Number(keys.startMs);
    const sightings = new SightingAggregator(keys.kTag);
    this.k = {
      keys,
      seat: { matchId: keys.matchId, player: keys.player },
      startMs,
      endMs: Number(keys.endMs),
      sightings,
      builder: new BatchBuilder({
        matchId: keys.matchId,
        player: keys.player,
        refereeBoxPk: this.d.refereeBoxPk,
        chain: this.d.record.chain,
        fixes: this.fixes,
        sightings,
        actions: this.actions,
        assert: this.d.assert,
        commit: (item, chain) => {
          this.outbox.push(item);
          this.save(chain);
        },
        now: this.now,
      }),
      epochTimer: new EpochTimer(startMs, (e) => this.onEpoch(e), this.now, this.timers),
    };
    return this.k;
  }

  private chain(): ChainState {
    return this.k?.builder.chain ?? this.d.record.chain;
  }

  private unsentActions(): Action[] {
    return this.k ? this.k.builder.unsentActions() : [...this.actions.peek()];
  }

  private save(chain: ChainState = this.chain()): void {
    const t = this.fixes.lastT;
    this.d.save({
      chain,
      outbox: this.outbox.all().map((it) => ({ ...it })),
      confirmed: this.confirmed,
      reports: [...this.reports],
      hudTick: this.hudTick,
      lastFixMs: t === null ? null : Number(t),
      actions: this.unsentActions(),
      monitor: this.monitor.record(),
    });
  }

  private stopRadio(): void {
    const r = this.d.radio;
    r.stopScan();
    r.stopBeacon();
    r.stopLocation();
    r.setPocketMode(false);
  }

  /**
   * Backgrounded or locked, the phone stops advertising (TECHNICAL.md 4.2), so for that stretch
   * nobody could hear it. Said once you are back, with how long it lasted.
   */
  private onAppState(e: AppStateEvent): void {
    if (!this.reporting) return;
    if (e.state === "background" || e.event === "protectedDataWillBecomeUnavailable") {
      this.hiddenSinceMs ??= e.tMs;
      return;
    }
    if (e.state !== "active" || this.hiddenSinceMs === null) return;
    const seconds = Math.max(1, Math.round((e.tMs - this.hiddenSinceMs) / 1_000));
    this.hiddenSinceMs = null;
    this.update({ invisible: { seconds, atMs: this.now() } });
    this.on.notice.emit({ kind: "invisible", seconds });
  }

  private onEpoch(e: number): void {
    const k = this.k?.keys;
    if (!k) return;
    const token = tokenToUuid(beaconToken(k.kTag, k.kPlayer, e));
    this.d.radio.setToken(token);
    this.d.radio.setScanFilter(
      [e - 1, e, e + 1].filter((x) => x >= 0).map((x) => toHex(beaconTag(k.kTag, x))),
    );
    this.update({ epoch: e, token });
    if (this.now() >= Number(k.endMs)) this.update({ over: true });
  }

  private onSighting(s: RadioSighting): void {
    const k = this.k;
    if (!k) return;
    const e = currentEpoch(this.now(), k.startMs);
    if (e === null) return;
    if (k.sightings.add(e, s.uuid, s.rssi)) this.heard++;
  }

  private scheduleBatch(): void {
    if (!this.running) return;
    this.batchTimer = this.timers.setTimeout(() => {
      this.batchTimer = null;
      void this.batchNow().finally(() => this.scheduleBatch());
    }, BATCH_MS);
  }

  /** Reads the anchored roots from NEAR about once per checkpoint, for the log monitor. */
  private scheduleAnchors(): void {
    if (!this.running) return;
    this.anchorTimer = this.timers.setTimeout(() => {
      this.anchorTimer = null;
      void this.d.log
        .anchors()
        .then((roots) => this.monitor.checkAnchors(roots))
        // NEAR unreachable: the next round reads them again.
        .catch(() => undefined)
        .finally(() => this.scheduleAnchors());
    }, ANCHOR_POLL_MS);
  }

  /** Offline: hand the oldest reports the relay lacks to the mesh, sealed for the relay. */
  private async offerToMesh(): Promise<void> {
    const mesh = this.mesh;
    if (mesh?.status.kind !== "on" || this.d.carry.kind !== "on") return;
    const key = this.d.carry.key;
    for (const item of this.outbox.unsent().slice(0, CARRY_AHEAD)) {
      const id = toHex(item.hash);
      let env = this.envelopes.get(id);
      if (!env) {
        try {
          env = carryEnvelope(key.boxPk, await this.d.batchRequest(item.sealed));
        } catch {
          // Signing needs the relay's contract id, read once while online; without it, wait.
          return;
        }
        this.envelopes.set(id, env);
        this.byDigest.set(toHex(envelopeDigest(env)), item.hash);
      }
      mesh.send(env);
    }
  }

  /** The relay took a batch, by HTTP or carried: record it as a report, once. */
  private onSent(item: OutboxItem): void {
    let fresh: Report | null = null;
    if (!this.reports.some((r) => equal(r.hash, item.hash))) {
      fresh = { seq: item.seq, hash: item.hash };
      this.reports.push(fresh);
    }
    this.dropEnvelope(item.hash);
    this.save();
    if (fresh) this.on.receipt.emit(fresh);
  }

  private dropEnvelope(hash: Uint8Array): void {
    const id = toHex(hash);
    const env = this.envelopes.get(id);
    if (!env) return;
    this.envelopes.delete(id);
    this.byDigest.delete(toHex(envelopeDigest(env)));
    this.mesh?.forget(env);
  }

  /** A receipt for one of our envelopes, already verified under the relay's ack key. */
  private onCarried(x: CarryDelivery): void {
    const hash = this.byDigest.get(toHex(x.digest));
    if (hash && x.ack.status >= 200 && x.ack.status < 300) this.uploader.delivered(hash);
    else if (hash && x.ack.status === 409) this.uploader.stop("The match is not running any more.");
    if (x.hud) this.onSealedHud(x.hud);
  }

  private onMessage(m: HudMessage): void {
    switch (m.type) {
      case "hud":
        this.onSealedHud(m.sealed);
        return;
      case "over":
        this.update({ over: true });
        this.stopReporting();
        return;
      default:
        this.on.frame.emit(m);
        return;
    }
  }

  /** A sealed SignedHud, from the socket or carried back over the mesh. */
  private onSealedHud(sealed: Uint8Array): void {
    const k = this.k;
    if (!k) return;
    let hud: Hud;
    let signed: Uint8Array;
    try {
      ({ hud, signed } = openSignedHudBytes(this.d.boxSk, sealed, this.d.refereePk, k.seat));
    } catch {
      this.on.notice.emit({ kind: "unsigned" });
      return;
    }
    // The relay could replay an older signed HUD to roll the chain back; only newer ones count.
    if (hud.tick < this.hudTick || (hud.tick === this.hudTick && this.lastHud)) return;
    this.hudTick = hud.tick;
    const before = this.lastHud;
    this.lastHud = hud;
    this.on.hud.emit(hud, before);
    this.noteRejection(hud);
    this.monitor.onHud(hud, signed);
    this.save();
    this.chainWork = this.chainWork.then(() => this.mendChain(hud)).catch(() => undefined);
  }

  /** Keeps the refusal code on the report it names (for the receipts) and announces it once. */
  private noteRejection(hud: Hud): void {
    const r = hud.rejected;
    if (!r) return;
    const report = [...this.reports].reverse().find((x) => x.seq === r.seq);
    if (report && report.code === undefined) report.code = r.code;
    const key = `${r.seq}:${r.code}`;
    if (key === this.shownRejection) return;
    this.shownRejection = key;
    this.on.notice.emit({ kind: "rejected", seq: r.seq, code: r.code });
  }

  /**
   * Applies what the HUD says about this player's chain (chain.ts). The plan is made and carried
   * out between two builds, so it sees every batch committed so far and no build commits while
   * the outbox is rebuilt.
   */
  private async mendChain(hud: Hud): Promise<void> {
    const k = this.k;
    if (!this.reporting || !k) return;
    const done = await k.builder.between(() => this.applyChainPlan(k.builder, hud));
    this.save();
    if (done.kind !== "confirm") this.uploader.restart();
    if (done.kind === "rebuild" && done.dropped.length > 0)
      this.on.notice.emit({
        kind: "rebuilt",
        dropped: done.dropped.length,
        fromSeq: done.fromSeq,
        lost: done.dropped.flatMap((it) => it.actions),
      });
    this.refresh();
  }

  /** Carries out the chain plan for this HUD; says what it did, and what a rebuild dropped. */
  private applyChainPlan(
    builder: BatchBuilder,
    hud: Hud,
  ): { kind: "confirm" | "resend" } | { kind: "rebuild"; dropped: OutboxItem[]; fromSeq: number } {
    const plan = planChain({
      items: this.outbox.all(),
      confirmed: this.confirmed,
      builderSeq: builder.chain.seq,
      hud,
      handled: this.handled,
      nowMs: this.now(),
    });
    if (plan.kind !== "rebuild") {
      this.outbox.confirm(plan.nextSeq);
      this.confirmed = { nextSeq: plan.nextSeq, tip: plan.tip };
      if (plan.kind === "resend") {
        for (const it of this.outbox.all()) if (it.seq >= plan.from) this.dropEnvelope(it.hash);
        this.outbox.resendFrom(plan.from);
      }
      return { kind: plan.kind };
    }
    if (plan.why === "refused" && hud.rejected) this.handled = hud.rejected;
    // Below next_seq the referee took what this phone sent, unless the chains parted there.
    if (plan.why !== "parted") this.outbox.confirm(plan.chain.seq);
    const dropped = this.outbox.clear();
    for (const it of dropped) this.dropEnvelope(it.hash);
    this.confirmed = { nextSeq: plan.chain.seq, tip: plan.chain.prev };
    builder.rebase(plan.chain);
    return { kind: "rebuild", dropped, fromSeq: plan.chain.seq };
  }

  private updateBlocked(): void {
    const bad = (s: string) => s === "unauthorized" || s === "poweredOff" || s === "unsupported";
    const { status, fullAccuracy } = this.location;
    const blocked: Blocked | null =
      bad(this.radioStates.peripheral) || bad(this.radioStates.central)
        ? "bluetooth"
        : status === "denied" || status === "restricted"
          ? "location"
          : status.startsWith("authorized") && !fullAccuracy
            ? "approximate"
            : null;
    if (blocked !== this.local.blocked) this.update({ blocked });
  }

  private update(p: Partial<Local>): void {
    this.local = { ...this.local, ...p };
    this.refresh();
  }

  private refresh(): void {
    this.on.change.emit();
  }
}
