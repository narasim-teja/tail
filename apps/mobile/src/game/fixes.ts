// Location fixes for the batch (TECHNICAL.md 4.3): about 1 Hz, strictly increasing t_ms (the
// referee rejects a batch whose fixes go backwards or repeat, `FixOrder`), never later than the
// batch's own t_ms.

import { type Fix, FixFlag } from "@tail/protocol";
import type { RadioFix } from "../../modules/tail-radio";

/** Fixes closer together than this are dropped: ~1 Hz is all the referee needs. */
export const FIX_MIN_GAP_MS = 900;

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
  private lastT: bigint | null = null;
  /** The newest usable fix, for the map and for zones. */
  latest: Fix | null = null;

  add(f: RadioFix): void {
    const w = toWireFix(f);
    if (!w) return;
    if (this.lastT !== null && w.tMs < this.lastT + BigInt(FIX_MIN_GAP_MS)) return;
    this.lastT = w.tMs;
    this.pending.push(w);
    this.latest = w;
  }

  /** Fixes up to and including `uptoMs`, oldest first; later ones wait for the next batch. */
  take(uptoMs: bigint): Fix[] {
    const out = this.pending.filter((f) => f.tMs <= uptoMs);
    this.pending = this.pending.filter((f) => f.tMs > uptoMs);
    return out;
  }
}
