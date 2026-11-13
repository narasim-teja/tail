// The epoch clock (TECHNICAL.md 4.2): e = floor((now − start_ms) / EPOCH_MS). Each boundary
// rotates the beacon token. Timers drift and JS stalls, so every fire recomputes the epoch from
// the wall clock instead of counting ticks, and a late fire never skips the current epoch.

import { EPOCH_MS, epochAt } from "@tail/protocol";

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** The current epoch, or null before the match starts. */
export const currentEpoch = (nowMs: number, startMs: number) =>
  nowMs < startMs ? null : epochAt(nowMs, startMs);

/** Milliseconds until the next epoch boundary (or until the start, before it). */
export function msToNextEpoch(nowMs: number, startMs: number): number {
  if (nowMs < startMs) return startMs - nowMs;
  return EPOCH_MS - ((nowMs - startMs) % EPOCH_MS);
}

/** Calls `onEpoch(e)` once per epoch from the match start on, at each boundary. */
export class EpochTimer {
  private handle: unknown = null;
  private last: number | null = null;
  private running = false;

  constructor(
    private readonly startMs: number,
    private readonly onEpoch: (epoch: number) => void,
    private readonly now: () => number = Date.now,
    private readonly timers: Timers = realTimers,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.fire();
  }

  /** Stops the clock; a later start announces the current epoch again (the radio needs its token). */
  stop(): void {
    this.running = false;
    this.last = null;
    if (this.handle !== null) this.timers.clearTimeout(this.handle);
    this.handle = null;
  }

  private fire = (): void => {
    if (!this.running) return;
    const now = this.now();
    const e = currentEpoch(now, this.startMs);
    if (e !== null && e !== this.last) {
      this.last = e;
      this.onEpoch(e);
    }
    // A few ms past the boundary so integer division lands in the new epoch.
    this.handle = this.timers.setTimeout(this.fire, msToNextEpoch(this.now(), this.startMs) + 5);
  };
}
