// The ordered upload queue. The referee takes a player's batches only in seq order with no gap
// (crates/referee-core: Reject::Seq), and the relay keeps the first copy of each upload, so the
// outbox sends one batch at a time, oldest first, and moves on only after the relay has it.
// Nothing is ever skipped: a batch the relay keeps refusing blocks the queue and says why.

import { RelayError } from "../relay/client";
import type { OutboxItem } from "./batch";
import { realTimers, type Timers } from "./epoch";

/** No relay contact for this long counts as offline; the mesh carry path takes over (TECHNICAL.md 7). */
export const OFFLINE_CARRY_MS = 20_000;

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

  head(): OutboxItem | undefined {
    return this.items[0];
  }

  /** Removes the head once the relay has it. Only the head can be acknowledged. */
  ack(seq: number): void {
    if (this.items[0]?.seq !== seq) throw new Error(`outbox: ack ${seq} is not the head`);
    this.items.shift();
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
  /** Called after every ack so the caller can persist the shorter queue. */
  onAck: (seq: number) => void;
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

  /** Something else (the mesh carry path) delivered the head; take it off the queue. */
  delivered(seq: number): void {
    if (this.d.outbox.head()?.seq !== seq) return;
    this.d.outbox.ack(seq);
    this.d.onAck(seq);
    this.d.onChange?.();
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
      const item = this.d.outbox.head();
      if (!item) return this.set({ kind: "idle" });
      this.set({ kind: "sending", seq: item.seq });
      try {
        await this.d.send(item);
      } catch (e) {
        // stop() may have run while the upload was in flight.
        if (this.isStopped()) return;
        const err = e instanceof RelayError ? e : new RelayError(null, String((e as Error).message ?? e));
        if (!err.unreachable) this.lastContactMs = this.now();
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
      // The mesh may have delivered it meanwhile.
      if (this.d.outbox.head()?.seq === item.seq) {
        this.d.outbox.ack(item.seq);
        this.d.onAck(item.seq);
      }
    }
  }
}
