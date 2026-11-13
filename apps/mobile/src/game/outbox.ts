// The ordered upload queue. The referee takes a player's batches only in seq order with no gap
// (crates/referee-core: Reject::Seq), so the outbox sends one batch at a time, oldest first, and
// moves on only after the relay has it. A batch stays in the outbox after the relay took it,
// until a signed HUD's `next_seq` and `chain_tip` show the referee accepted it (game/chain.ts):
// the relay taking a batch is not the referee accepting it, and a batch that never opened or
// was refused must still be there to send again, or to rebuild from.
//
// Two transports deliver the same items, HTTP and the mesh carry path (carry/mesh.ts). The
// outbox has one owner, the Uploader, and both report delivery through it by the batch hash, so a
// batch delivered both ways counts once and the HTTP path never sends what the mesh delivered.

import { equal } from "@tail/protocol";
import { RelayError } from "../relay/client";
import type { OutboxItem } from "./batch";
import { realTimers, type Timers } from "./epoch";

/** No relay contact for this long counts as offline; the mesh carry path takes over (TECHNICAL.md 7). */
export const OFFLINE_CARRY_MS = 20_000;

/** The relay's 409 for a signed request it has seen before (apps/server routes/util.ts). */
const alreadySeen = (e: RelayError) => e.status === 409 && e.detail["error"] === "request already seen";

export const backoffMs = (failures: number) => Math.min(15_000, 1_000 * 2 ** Math.max(0, failures - 1));

export class Outbox {
  private items: OutboxItem[];

  constructor(items: readonly OutboxItem[] = []) {
    const sorted = [...items].sort((a, b) => a.seq - b.seq);
    sorted.forEach((it, i) => {
      if (i > 0 && it.seq !== (sorted[i - 1] as OutboxItem).seq + 1) throw new Error("outbox has a seq gap");
    });
    this.items = sorted;
  }

  push(item: OutboxItem): void {
    const last = this.items[this.items.length - 1];
    if (last && item.seq !== last.seq + 1) throw new Error(`outbox: seq ${item.seq} after ${last.seq}`);
    this.items.push(item);
  }

  get(seq: number): OutboxItem | undefined {
    return this.items.find((it) => it.seq === seq);
  }

  byHash(hash: Uint8Array): OutboxItem | undefined {
    return this.items.find((it) => equal(it.hash, hash));
  }

  /** The oldest batch the relay does not have yet. */
  nextUnsent(): OutboxItem | undefined {
    return this.items.find((it) => it.sentMs === null);
  }

  unsent(): OutboxItem[] {
    return this.items.filter((it) => it.sentMs === null);
  }

  /** Records that the relay took this exact batch. False if it was already recorded (or is gone). */
  markSent(hash: Uint8Array, atMs: number): OutboxItem | null {
    const it = this.byHash(hash);
    if (!it || it.sentMs !== null) return null;
    it.sentMs = atMs;
    return it;
  }

  /** The referee accepted everything below `nextSeq`: those leave the outbox. */
  confirm(nextSeq: number): OutboxItem[] {
    const done = this.items.filter((it) => it.seq < nextSeq);
    this.items = this.items.filter((it) => it.seq >= nextSeq);
    return done;
  }

  /** Sends every batch from `seq` on again; the first is marked as resent. */
  resendFrom(seq: number): void {
    for (const it of this.items) {
      if (it.seq < seq) continue;
      if (it.seq === seq) it.resent = true;
      it.sentMs = null;
    }
  }

  /** Empties the outbox (the chain is being rebuilt) and returns what was in it. */
  clear(): OutboxItem[] {
    const out = this.items;
    this.items = [];
    return out;
  }

  get length(): number {
    return this.items.length;
  }

  all(): readonly OutboxItem[] {
    return this.items;
  }
}

export type UploadState =
  | { kind: "idle" }
  | { kind: "sending"; seq: number }
  | { kind: "waiting"; seq: number; retryInMs: number; error: string }
  | { kind: "stopped"; error: string };

export interface UploaderDeps {
  outbox: Outbox;
  send: (item: OutboxItem) => Promise<void>;
  /** Called once per batch the relay took, by whichever transport, so the caller can persist it. */
  onSent: (item: OutboxItem) => void;
  onChange?: () => void;
  now?: () => number;
  timers?: Timers;
}

export class Uploader {
  state: UploadState = { kind: "idle" };
  /** Last time the relay answered at all (even with a refusal). */
  lastContactMs: number;
  failures = 0;
  private timer: unknown = null;
  private readonly now: () => number;
  private readonly timers: Timers;

  constructor(private readonly d: UploaderDeps) {
    this.now = d.now ?? Date.now;
    this.timers = d.timers ?? realTimers;
    this.lastContactMs = this.now();
  }

  /** True when the relay has been unreachable for OFFLINE_CARRY_MS. */
  offline(): boolean {
    return this.failures > 0 && this.now() - this.lastContactMs >= OFFLINE_CARRY_MS;
  }

  /** Start sending if idle. Safe to call any number of times. */
  kick(): void {
    if (this.state.kind !== "idle") return;
    void this.pump();
  }

  /**
   * Another transport (the mesh carry path) got this batch to the relay. Ignored if the relay
   * already had it from either transport, or the batch has left the outbox.
   */
  delivered(hash: Uint8Array): void {
    const it = this.d.outbox.markSent(hash, this.now());
    if (!it) return;
    this.d.onSent(it);
    this.d.onChange?.();
  }

  /** Wakes a waiting retry at once, e.g. after the outbox was rebuilt. */
  restart(): void {
    if (this.state.kind === "stopped") return;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    if (this.state.kind === "waiting") this.state = { kind: "idle" };
    this.kick();
  }

  stop(error = "stopped"): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.state = { kind: "stopped", error };
    this.d.onChange?.();
  }

  private isStopped(): boolean {
    return this.state.kind === "stopped";
  }

  private set(s: UploadState) {
    this.state = s;
    this.d.onChange?.();
  }

  private async pump(): Promise<void> {
    for (;;) {
      if (this.isStopped()) return;
      const item = this.d.outbox.nextUnsent();
      if (!item) return this.set({ kind: "idle" });
      this.set({ kind: "sending", seq: item.seq });
      try {
        await this.d.send(item);
      } catch (e) {
        // stop() may have run while the upload was in flight.
        if (this.isStopped()) return;
        const err = e instanceof RelayError ? e : new RelayError(null, String((e as Error).message ?? e));
        if (!err.unreachable) this.lastContactMs = this.now();
        // The relay already holds this very request (the mesh carried a copy signed in the same
        // millisecond): the batch is there, which is all a send is for.
        if (alreadySeen(err)) {
          this.lastContactMs = this.now();
          this.failures = 0;
          const sent = this.d.outbox.markSent(item.hash, this.now());
          if (sent) this.d.onSent(sent);
          continue;
        }
        // 409: the match is not running any more; nothing later can be accepted either.
        // 413: this batch will never fit, and the ones after it chain to it, so none can land.
        if (err.status === 409 || err.status === 413) return this.stop(err.message);
        this.failures++;
        const wait = backoffMs(this.failures);
        this.set({ kind: "waiting", seq: item.seq, retryInMs: wait, error: err.message });
        this.timer = this.timers.setTimeout(() => {
          this.timer = null;
          if (this.state.kind === "waiting") {
            this.state = { kind: "idle" };
            this.kick();
          }
        }, wait);
        return;
      }
      this.lastContactMs = this.now();
      this.failures = 0;
      // The mesh may have delivered it meanwhile, or a rebuild may have dropped it.
      const sent = this.d.outbox.markSent(item.hash, this.now());
      if (sent) this.d.onSent(sent);
    }
  }
}
