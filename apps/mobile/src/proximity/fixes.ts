// Location fixes for the batch (TECHNICAL.md 4.3): about 1 Hz, strictly increasing t_ms (the
// referee rejects a batch whose fixes go backwards or repeat, `FixOrder`), never later than the
// batch's own t_ms. The order holds across relaunches: the newest fix time is saved with the
// match, and fixes at or before it are dropped. iOS also hands a cached fix first after a
// relaunch, often minutes old; one of those would sit before fixes the referee already has, so
// fixes older than FIX_MAX_AGE_MS are dropped too.

import { type Fix, FixFlag } from "@tail/protocol";
import type { RadioFix } from "../../modules/tail-radio";

/** Fixes closer together than this are dropped: ~1 Hz is all the referee needs. */
export const FIX_MIN_GAP_MS = 900;
/** A fix older than this when it arrives is a cached one, not where the player is now. */
export const FIX_MAX_AGE_MS = 10_000;

/** Whether a fix taken at `tMs` says where the phone is at `nowMs`, not where it was. */
export const currentFix = (tMs: number, nowMs: number) => tMs >= nowMs - FIX_MAX_AGE_MS;

const u16 = (n: number) => Math.max(0, Math.min(0xffff, Math.round(n)));

/** CoreLocation fix → wire Fix, or null when it is unusable (no accuracy, bad coordinates). */
export function toWireFix(f: RadioFix): Fix | null {
  if (!(f.acc >= 0) || !Number.isFinite(f.lat) || !Number.isFinite(f.lon)) return null;
  if (Math.abs(f.lat) > 90 || Math.abs(f.lon) > 180) return null;
  return {
    tMs: BigInt(Math.round(f.tMs)),
    latE7: Math.round(f.lat * 1e7),
    lonE7: Math.round(f.lon * 1e7),
    // Rounded up: the referee adds accuracies to distances, so rounding down would overclaim.
    accM: u16(Math.ceil(f.acc)),
    speedCmps: f.speed > 0 ? u16(f.speed * 100) : 0,
    // iOS reports nothing (null) for an ordinary fix on an unmodified device.
    flags: (f.simulated ? FixFlag.SimulatedBySoftware : 0) | (f.accessory ? FixFlag.ProducedByAccessory : 0),
  };
}

export class FixCollector {
  private pending: Fix[] = [];
  /** The newest fix time taken in, saved with the match (client.ts) so a relaunch keeps order. */
  lastT: bigint | null;
  /** The newest usable fix, for the map and for zones. */
  latest: Fix | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    lastT: bigint | null = null,
  ) {
    this.lastT = lastT;
  }

  /** Whether the fix was kept for the next batch. */
  add(f: RadioFix): boolean {
    const w = toWireFix(f);
    if (!w) return false;
    if (!currentFix(f.tMs, this.now())) return false;
    if (this.lastT !== null && w.tMs < this.lastT + BigInt(FIX_MIN_GAP_MS)) return false;
    this.lastT = w.tMs;
    this.pending.push(w);
    this.latest = w;
    return true;
  }

  /** Fixes up to and including `uptoMs`, oldest first; later ones wait for the next batch. */
  take(uptoMs: bigint): Fix[] {
    const out = this.pending.filter((f) => f.tMs <= uptoMs);
    this.pending = this.pending.filter((f) => f.tMs > uptoMs);
    return out;
  }
}
