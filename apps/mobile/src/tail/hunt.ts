// One player's TAIL hunt, from the match start to the end, on top of the proximity layer
// (proximity/client.ts), which does the radio, the batches, the outbox, the HUD socket and the
// mesh. This layer adds what makes it TAIL:
// - strikes and hints, built here and queued as opaque actions (actions.ts)
// - the signed HUD read as the hunt screen shows it: lock, heat, target, tags, being out; tags
//   and dark time come from the referee, not from the phone's guesses
// - the phone's own warnings before the referee acts: out of the zone, vehicle speed (rules.ts)
// - the Handler's signed lines, and every notice in plain words (a log fork above all)
// - the tag count and the hash of each Handler line, saved beside the proximity record so a
//   relaunch keeps them (the lines are checked against the referee's log after End: handler.ts)

import type { AnchoredRoot, HintKind, Hud, PlayerKeys } from "@tail/protocol";
import type { RadioFix } from "../../modules/tail-radio";
import {
  ProximityClient,
  type ProximityDeps,
  type ProximityNotice,
  type ProximityRecord,
  type ProximityStatus,
} from "../proximity/client";
import type { HudMessage } from "../proximity/hud";
import { TailActions } from "./actions";
import { type Circle, inCircle } from "./geo";
import { type HandlerLine, handlerLine } from "./handler";
import {
  describeRefusal,
  describeRejectCode,
  formatAmount,
  type HudView,
  hudView,
  LOG_FORKED,
  NOT_SIGNED,
  openVoice,
  priceNow,
  RELAY_BAD_PROOF,
} from "./hud";
import { type DarkInfo, VehicleWatch } from "./rules";

/** What the hunt keeps in the match file (state/persist.ts) so a relaunch carries on. */
export interface HuntRecord extends ProximityRecord {
  /** Tags this player made, as the referee's last HUD counted them. */
  tags: number;
  /** Each signed Handler line received, by hint id and text hash. */
  handler: HandlerLine[];
}

export interface TailHuntDeps extends Omit<ProximityDeps, "record" | "save"> {
  keys: PlayerKeys;
  stake: bigint;
  /** Where this match stood when the hunt last saved it (genesis for a new match). */
  record: HuntRecord;
  /** Persists the whole record at once: chain position, outbox, reports, tags, fix time, actions. */
  save: (r: HuntRecord) => void;
  /** The match zone, checked against the chain's zone hash; null when the relay sent none. */
  zone: Circle | null;
}

export interface Note {
  tMs: number;
  text: string;
  kind: "handler" | "rejected" | "refused" | "info";
}

interface TailState {
  hud: HudView | null;
  notes: Note[];
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
}

export interface HuntSnapshot extends ProximityStatus, TailState {
  /** Your lock is frozen (vehicle speed) until then; null when not frozen. */
  frozenUntilMs: number | null;
}

export class TailHunt {
  private readonly now: () => number;
  private readonly prox: ProximityClient;
  private readonly tail: TailActions;
  private readonly vehicle = new VehicleWatch();
  private listeners = new Set<() => void>();
  private ui: TailState;
  private snap: HuntSnapshot;
  /** The proximity layer's newest record, so a Handler line can be saved without waiting for it. */
  private proxRecord: ProximityRecord;
  private handler: HandlerLine[];

  constructor(private readonly d: TailHuntDeps) {
    this.now = d.now ?? Date.now;
    this.tail = new TailActions();
    this.ui = {
      hud: null,
      notes: [],
      strikeSentAtMs: null,
      landed: null,
      tags: d.record.tags,
      dark: null,
      outSinceMs: null,
    };
    this.proxRecord = d.record;
    this.handler = [...d.record.handler];
    this.prox = new ProximityClient({
      ...d,
      save: (r) => {
        this.proxRecord = r;
        this.persist();
      },
    });
    this.prox.onChange(() => this.refresh());
    this.prox.onHud((hud, before) => this.onHud(hud, before));
    this.prox.onFrame((m) => this.onFrame(m));
    this.prox.onNotice((n) => this.onNotice(n));
    this.prox.onFix((f) => this.onFix(f));
    this.snap = this.compute();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────────────────

  start(): void {
    this.prox.start(this.d.keys);
  }

  /** Stops the radio and timers. Unsent batches stay in the outbox file. */
  stop(): void {
    this.prox.stop();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): HuntSnapshot {
    return this.snap;
  }

  // ── Player actions ───────────────────────────────────────────────────────────────────────

  hint(kind: HintKind, question?: string): void {
    this.prox.queueAction(this.tail.hint(kind, question));
    const price = priceNow(this.d.stake, kind, this.snap.hud);
    this.note("info", `Hint asked: about ${formatAmount(price)} from your head.`);
  }

  strike(): void {
    this.prox.queueAction(this.tail.strike());
    this.update({ strikeSentAtMs: this.now() });
    // Sent with the very next batch instead of waiting up to BATCH_MS: the lock may not last.
    void this.prox.batchNow();
  }

  /** Anchored roots read from NEAR (Results reads End's), checked against the HUD roots. */
  checkAnchors(roots: readonly AnchoredRoot[]): Promise<void> {
    return this.prox.checkAnchors(roots);
  }

  // ── Internals ────────────────────────────────────────────────────────────────────────────

  private onFix(f: RadioFix): void {
    this.vehicle.add(f.tMs, f.speed);
    this.checkZone(f);
  }

  private onFrame(m: HudMessage): void {
    switch (m.type) {
      case "handler": {
        const seat = { matchId: this.d.keys.matchId, player: this.d.keys.player };
        let line: { hintId: number; text: string };
        try {
          line = openVoice(this.d.boxSk, m.sealed, this.d.refereePk, seat);
        } catch {
          this.note("info", `${NOT_SIGNED}.`);
          return;
        }
        // The relay sends every answered line again each time the socket authenticates: a line
        // already had is no new dispatch (no note, no haptic).
        if (this.handler.some((l) => l.hintId === line.hintId)) return;
        this.handler = [...this.handler, handlerLine(line.hintId, line.text)];
        this.persist();
        this.note("handler", line.text);
        return;
      }
      case "refused":
        this.note("refused", describeRefusal(m.action, m.reason));
        return;
      default:
        return;
    }
  }

  private onNotice(n: ProximityNotice): void {
    switch (n.kind) {
      case "unsigned":
        this.note("info", `${NOT_SIGNED}.`);
        return;
      case "build-failed":
        this.note("info", `Report not built: ${n.message}`);
        return;
      case "rejected": {
        const text = describeRejectCode(n.code);
        if (text) this.note("rejected", text);
        return;
      }
      case "rebuilt":
        this.note(
          "info",
          `${n.dropped === 1 ? "A report" : `${n.dropped} reports`} didn't reach the referee. Carrying on from report ${n.fromSeq}.`,
        );
        if (n.lost.includes("Strike"))
          this.note("info", "Your strike didn't reach the referee. Strike again if your lock is full.");
        if (n.lost.includes("Hint"))
          this.note("info", "A hint didn't reach the referee. Nothing was charged; ask again.");
        return;
      case "invisible":
        this.note(
          "info",
          `You were invisible ${n.seconds} s: the phone was locked or TAIL was in the background.`,
        );
        return;
      case "log-forked":
        this.note("info", `${LOG_FORKED}. Your phone kept the signed proof; export it from Results.`);
        return;
      case "relay-bad-proof":
        // Said once: the monitor keeps asking, and the status line shows it meanwhile.
        if (n.fault.count === 1) this.note("info", `${RELAY_BAD_PROOF}. Checking again later.`);
        return;
    }
  }

  /** A signed HUD, newer than any before (the proximity layer checked both). */
  private onHud(hud: Hud, before: Hud | null): void {
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
    // Out or won: nothing more to report, but keep the HUD for the result.
    if (view.status !== "hunting") this.prox.stopReporting();
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

  private persist(): void {
    this.d.save({ ...this.proxRecord, tags: this.ui.tags, handler: this.handler });
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

  private update(p: Partial<TailState>): void {
    this.ui = { ...this.ui, ...p };
    this.refresh();
  }

  private refresh(): void {
    this.snap = this.compute();
    for (const l of this.listeners) l();
  }

  private compute(): HuntSnapshot {
    return {
      ...this.prox.status(),
      ...this.ui,
      frozenUntilMs: this.vehicle.frozenFor(this.now()) === null ? null : this.vehicle.frozenUntilMs,
    };
  }
}
