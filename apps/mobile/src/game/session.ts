// One player's hunt, from the match start to the end (TECHNICAL.md 4.2–4.7, 5.5). It owns:
// - the epoch clock: rotates the beacon token and the scan filter at every boundary
// - the radio: sightings → tag filter → per-epoch aggregates; fixes → ~1 Hz wire fixes
// - the batch loop: every BATCH_MS a chained, attested, sealed batch into the outbox
// - the outbox: ordered upload with retry, persisted so a restart loses nothing; a batch leaves
//   it only once a signed HUD shows the referee took it, and the chain is mended or rebuilt
//   from the HUD's next_seq / chain_tip when the two part (game/chain.ts)
// - the match record beside it: every report sent (for the inclusion receipts on Results), the
//   newest fix time, actions not yet in a batch
// - what hides the player: the app in the background or the phone locked (no beacon then)
// - the HUD socket: sealed HUDs signed by the referee → what the hunt screen shows (tags and
//   dark time come from the referee, not from the phone's guesses)
// - the mesh carry path, both roles, behind a setting (carry/mesh.ts): a second transport for
//   the same outbox, deduplicated by batch hash
// Everything device-specific comes in through ports, so tests drive it with fakes.

import {
  type Action,
  BATCH_MS,
  beaconTag,
  beaconToken,
  equal,
  type HintKind,
  type Hud,
  hintPrice,
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
import {
  type CarryDelivery,
  type CarryStatus,
  carryEnvelope,
  envelopeDigest,
  MeshCarry,
  type MeshLink,
} from "../carry/mesh";
import type { CarryKey, CarryReply, SignedRequest } from "../relay/client";
import type { HudMessage, SocketState } from "../relay/hud";
import { ActionQueue } from "./actions";
import { type Assert, BatchBuilder, type ChainState, type OutboxItem } from "./batch";
import { type Confirmed, planChain } from "./chain";
import { currentEpoch, EpochTimer, realTimers, type Timers } from "./epoch";
import { FIX_MAX_AGE_MS, FixCollector } from "./fixes";
import { type Circle, inCircle } from "./geo";
import {
  describeRefusal,
  describeRejectCode,
  formatAmount,
  type HudView,
  hudView,
  NOT_SIGNED,
  openHud,
  openVoice,
} from "./hud";
import { Outbox, Uploader, type UploadState } from "./outbox";
import type { Report } from "./receipts";
import { type DarkInfo, VehicleWatch } from "./rules";
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
  /** Location authorisation ("authorizedWhenInUse", "denied", …) and whether it is precise. */
  onLocationState(fn: (e: LocationStateEvent) => void): () => void;
  /** Foreground, background and device lock. */
  onAppState(fn: (e: AppStateEvent) => void): () => void;
  /** Pocket mode: whether this phone has a proximity sensor to turn the screen off. */
  onProximity(fn: (e: ProximityEvent) => void): () => void;
}

/** What the session keeps in the match file (state/persist.ts) so a relaunch carries on. */
export interface SessionRecord {
  chain: ChainState;
  /** Batches not yet confirmed by a HUD, sent or not. */
  outbox: OutboxItem[];
  /** The referee's chain position the phone last agreed with. */
  confirmed: Confirmed;
  /** Every batch the relay took, for the inclusion receipts after the match. */
  reports: Report[];
  /** The newest HUD tick taken in; an older HUD (a replay by the relay) is ignored. */
  hudTick: number;
  /** Tags this player made, as the referee's last HUD counted them. */
  tags: number;
  /** The newest fix time taken in; fixes at or before it are never sent again. */
  lastFixMs: number | null;
  /** Strikes and hints not yet inside a committed batch. */
  actions: Action[];
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

/** Your own reports offered to the mesh at once while offline, oldest first. */
const CARRY_AHEAD = 3;

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
  /** The referee key the match pinned on NEAR, read by the phone itself; it checks every HUD. */
  refereePk: Uint8Array;
  /** Where this match stood when the session last saved it (genesis for a new match). */
  record: SessionRecord;
  radio: RadioPort;
  assert: Assert;
  /** Signs `POST /batch` for one sealed batch. */
  batchRequest: (sealed: Uint8Array) => Promise<SignedRequest>;
  upload: (req: SignedRequest) => Promise<unknown>;
  /** Persists the whole record at once: chain position, outbox, reports, tags, fix time, actions. */
  save: (r: SessionRecord) => void;
  hud: (onMessage: (m: HudMessage) => void, onState: (s: SocketState) => void) => HudPort;
  carry: CarryPlan;
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
  /** Reports the relay does not have yet. */
  queued: number;
  upload: UploadState;
  offline: boolean;
  carry: CarryStatus;
  socket: SocketState;
  hud: HudView | null;
  notes: Note[];
  over: boolean;
  pendingActions: number;
  /** Set when STRIKE was pressed; cleared by the next HUD, which carries the result. */
  strikeSentAtMs: number | null;
  /** The last tag you made: when, and who your target is now. */
  landed: { atMs: number; target: string } | null;
  /** Tags you made this match, as the referee counts them. */
  tags: number;
  /** The referee's count of your dark time, from its signed HUDs; null before the first. */
  dark: DarkInfo | null;
  /** When you left the zone; null while inside (or with no zone to judge by). */
  outSinceMs: number | null;
  /** Your lock is frozen (vehicle speed) until then; null when not frozen. */
  frozenUntilMs: number | null;
  /**
   * What stops the hunt from working at all: Bluetooth or location switched off or denied, or
   * location allowed only as approximate (the referee needs metres, not kilometres).
   */
  blocked: Blocked | null;
  /** The last stretch other phones could not hear you (backgrounded or locked), once you are back. */
  invisible: { seconds: number; atMs: number } | null;
  /** This phone has no proximity sensor, so the screen cannot turn off in a pocket by itself. */
  noPocketSensor: boolean;
}

export type Blocked = "bluetooth" | "location" | "approximate";

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
  | "dark"
  | "outSinceMs"
  | "blocked"
  | "invisible"
  | "noPocketSensor"
>;

export class HuntSession {
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly startMs: number;
  private readonly endMs: number;
  private readonly fixes: FixCollector;
  private readonly sightings: SightingAggregator;
  private readonly actions: ActionQueue;
  private readonly outbox: Outbox;
  private readonly builder: BatchBuilder;
  private readonly uploader: Uploader;
  private readonly epochTimer: EpochTimer;
  private mesh: MeshCarry | null = null;
  private hudPort: HudPort | null = null;
  private confirmed: Confirmed;
  private readonly reports: Report[];
  private hudTick: number;
  private lastHud: Hud | null = null;
  // The refusal the chain was last rebuilt for, so a HUD repeating it does not rebuild again.
  private handled: { seq: number; code: number } | null = null;
  // The refusal last shown, so a HUD repeating it does not repeat the note.
  private shownRejection: string | null = null;
  private chainWork: Promise<void> = Promise.resolve();
  // Own carry envelopes by batch hash (hex), sealed once per send round, and back by digest.
  private readonly envelopes = new Map<string, Uint8Array>();
  private readonly byDigest = new Map<string, Uint8Array>();
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
    dark: null,
    outSinceMs: null,
    blocked: null,
    invisible: null,
    noPocketSensor: false,
  };
  private readonly vehicle = new VehicleWatch();
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

  constructor(private readonly d: SessionDeps) {
    this.now = d.now ?? Date.now;
    this.timers = d.timers ?? realTimers;
    this.startMs = Number(d.keys.startMs);
    this.endMs = Number(d.keys.endMs);
    const r = d.record;
    this.fixes = new FixCollector(this.now, r.lastFixMs === null ? null : BigInt(r.lastFixMs));
    this.sightings = new SightingAggregator(d.keys.kTag);
    this.actions = new ActionQueue(undefined, r.actions);
    this.ui.tags = r.tags;
    this.confirmed = r.confirmed;
    this.reports = [...r.reports];
    this.hudTick = r.hudTick;
    this.outbox = new Outbox(r.outbox);
    this.builder = new BatchBuilder({
      matchId: d.keys.matchId,
      player: d.keys.player,
      refereeBoxPk: d.refereeBoxPk,
      chain: r.chain,
      fixes: this.fixes,
      sightings: this.sightings,
      actions: this.actions,
      assert: d.assert,
      commit: (item, chain) => {
        this.outbox.push(item);
        d.save(this.record(chain));
      },
      now: this.now,
    });
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
    this.epochTimer = new EpochTimer(this.startMs, (e) => this.onEpoch(e), this.now, this.timers);
    this.snap = this.compute();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.reporting = true;
    const r = this.d.radio;
    this.unsub.push(r.onSighting((s) => this.onSighting(s)));
    this.unsub.push(
      r.onFix((f) => {
        // A cached fix (iOS hands one over first after a relaunch) says where you were, not
        // where you are: not for the batch, the zone clock or the vehicle check.
        if (f.tMs < this.now() - FIX_MAX_AGE_MS) return;
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
    this.epochTimer.start();
    this.hudPort = this.d.hud(
      (m) => this.onHud(m),
      (s) => this.update({ socket: s }),
    );
    this.hudPort.open();
    void this.mesh?.start();
    this.uploader.kick();
    this.scheduleBatch();
    this.refresh();
  }

  /** Stops the radio and timers. Unsent batches stay in the outbox file. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.reporting = false;
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
    void this.mesh?.stop();
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
    this.d.save(this.record());
    this.note("info", `Hint asked: ${formatAmount(hintPrice(this.d.stake, kind))} from your head.`);
  }

  strike(): void {
    this.actions.strike();
    this.d.save(this.record());
    this.update({ strikeSentAtMs: this.now() });
    // Sent with the very next batch instead of waiting up to BATCH_MS: the lock may not last.
    void this.batchNow();
  }

  // ── Internals ────────────────────────────────────────────────────────────────────────────

  private record(chain: ChainState = this.builder.chain): SessionRecord {
    const t = this.fixes.lastT;
    return {
      chain,
      outbox: this.outbox.all().map((it) => ({ ...it })),
      confirmed: this.confirmed,
      reports: [...this.reports],
      hudTick: this.hudTick,
      tags: this.ui.tags,
      lastFixMs: t === null ? null : Number(t),
      actions: this.builder.unsentActions(),
    };
  }

  /**
   * Backgrounded or locked, the phone stops advertising (TECHNICAL.md 4.2), so for that stretch
   * nobody could hear it: no lock on you, but no lock for you either, and the referee may count
   * you dark. Said once you are back, with how long it lasted.
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
    this.note("info", `You were invisible ${seconds} s: the phone was locked or TAIL was in the background.`);
  }

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
    if (this.uploader.offline()) await this.offerToMesh();
    if (this.now() >= this.endMs) this.update({ over: true });
    this.refresh();
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
    if (!this.reports.some((r) => equal(r.hash, item.hash)))
      this.reports.push({ seq: item.seq, hash: item.hash });
    this.dropEnvelope(item.hash);
    this.d.save(this.record());
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

  private onHud(m: HudMessage): void {
    switch (m.type) {
      case "hud":
        this.onSealedHud(m.sealed);
        return;
      case "handler": {
        try {
          this.note("handler", openVoice(this.d.boxSk, m.sealed, this.d.refereePk, this.seat()).text);
        } catch {
          this.note("info", `${NOT_SIGNED}.`);
        }
        return;
      }
      case "refused":
        this.note("refused", describeRefusal(m.action, m.reason));
        return;
      case "over":
        this.update({ over: true });
        this.stopReporting();
        return;
      default:
        return;
    }
  }

  private seat() {
    return { matchId: this.d.keys.matchId, player: this.d.keys.player };
  }

  /** A sealed SignedHud, from the socket or carried back over the mesh. */
  private onSealedHud(sealed: Uint8Array): void {
    let hud: Hud;
    try {
      hud = openHud(this.d.boxSk, sealed, this.d.refereePk, this.seat());
    } catch {
      this.note("info", `${NOT_SIGNED}.`);
      return;
    }
    // The relay could replay an older signed HUD to roll the chain back; only newer ones count.
    if (hud.tick < this.hudTick || (hud.tick === this.hudTick && this.lastHud)) return;
    this.hudTick = hud.tick;
    const before = this.lastHud;
    this.lastHud = hud;
    const view = hudView(hud);
    const prev = this.ui.hud;
    // A new target while still hunting: you inherited your old target's, by your tag or by
    // their forfeit. The referee's tag count says which.
    const newTarget =
      !!prev && prev.status === "hunting" && view.status === "hunting" && view.target !== prev.target;
    const tagged = hud.tags > this.ui.tags;
    this.update({
      hud: view,
      strikeSentAtMs: null,
      landed: tagged ? { atMs: this.now(), target: view.target } : this.ui.landed,
      tags: hud.tags,
      dark: this.darkFrom(hud, before),
    });
    if (newTarget && !tagged)
      this.note("info", "Your target forfeited. Their head is yours; you have a new target.");
    this.showRejection(hud);
    this.d.save(this.record());
    this.chainWork = this.chainWork.then(() => this.mendChain(hud)).catch(() => undefined);
    if (view.status !== "hunting") this.stopReporting();
  }

  /**
   * The referee's dark count: `dark_ms` is cumulative, so it growing between two HUDs means it
   * counts you dark now, and by how much. The banner runs on from the last HUD (rules.ts).
   */
  private darkFrom(hud: Hud, before: Hud | null): DarkInfo {
    const grew = before ? Math.max(0, hud.darkMs - before.darkMs) : 0;
    const was = this.ui.dark;
    return {
      totalMs: hud.darkMs,
      runMs: grew > 0 ? (was?.counting ? was.runMs : 0) + grew : 0,
      counting: grew > 0,
      atMs: this.now(),
    };
  }

  private showRejection(hud: Hud): void {
    const r = hud.rejected;
    if (!r) return;
    const report = [...this.reports].reverse().find((x) => x.seq === r.seq);
    if (report && report.code === undefined) report.code = r.code;
    const key = `${r.seq}:${r.code}`;
    if (key === this.shownRejection) return;
    this.shownRejection = key;
    const text = describeRejectCode(r.code);
    if (text) this.note("rejected", text);
  }

  /** Applies what the HUD says about this player's chain (game/chain.ts). */
  private async mendChain(hud: Hud): Promise<void> {
    if (!this.reporting) return;
    const plan = planChain({
      items: this.outbox.all(),
      confirmed: this.confirmed,
      builderSeq: this.builder.chain.seq,
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
        this.uploader.restart();
      }
      this.d.save(this.record());
      this.refresh();
      return;
    }
    if (plan.why === "refused" && hud.rejected) this.handled = hud.rejected;
    // Below next_seq the referee took what this phone sent, unless the chains parted there.
    if (plan.why !== "parted") this.outbox.confirm(plan.chain.seq);
    const dropped = this.outbox.clear();
    for (const it of dropped) this.dropEnvelope(it.hash);
    this.confirmed = { nextSeq: plan.chain.seq, tip: plan.chain.prev };
    await this.builder.rebase(plan.chain);
    this.d.save(this.record());
    this.uploader.restart();
    const lost = new Set(dropped.flatMap((it) => it.actions));
    if (dropped.length > 0)
      this.note(
        "info",
        `${dropped.length === 1 ? "A report" : `${dropped.length} reports`} didn't reach the referee. Carrying on from report ${plan.chain.seq}.`,
      );
    if (lost.has("Strike"))
      this.note("info", "Your strike didn't reach the referee. Strike again if your lock is full.");
    if (lost.has("Hint"))
      this.note("info", "A hint didn't reach the referee. Nothing was charged; ask again.");
    this.refresh();
  }

  /** Out or over: nothing more to report, but keep the HUD for the result. */
  private stopReporting(): void {
    if (!this.running) return;
    this.reporting = false;
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
    const { status, fullAccuracy } = this.location;
    const blocked: Blocked | null =
      bad(this.radioStates.peripheral) || bad(this.radioStates.central)
        ? "bluetooth"
        : status === "denied" || status === "restricted"
          ? "location"
          : status.startsWith("authorized") && !fullAccuracy
            ? "approximate"
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
      queued: this.outbox.unsent().length,
      upload: this.uploader.state,
      offline: this.uploader.offline(),
      carry: this.mesh?.status ?? { kind: "off", why: this.d.carry.kind === "off" ? this.d.carry.why : "" },
      pendingActions: this.builder.unsentActions().length,
      frozenUntilMs: this.vehicle.frozenFor(this.now()) === null ? null : this.vehicle.frozenUntilMs,
    };
  }
}
