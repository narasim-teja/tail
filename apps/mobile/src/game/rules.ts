// The phone's own view of three referee rules, so it can warn the player before the referee
// acts (TECHNICAL.md 3, IDEA.md 3). The referee alone decides; these mirror its constants.
//   dark:    no valid report for DARK_LEAK_MS → your hunter sees your 100 m cell
//   zone:    outside the zone counts as dark
//   vehicle: faster than MAX_SPEED_MPS for VEHICLE_HOLD_MS → lock frozen VEHICLE_FREEZE_MS

import {
  DARK_FORFEIT_MS,
  DARK_LEAK_MS,
  MAX_SPEED_MPS,
  VEHICLE_FREEZE_MS,
  VEHICLE_HOLD_MS,
} from "@tail/protocol";
import { bearingDeg, type Circle, circleCenter, compass8, distanceM, type LatLon } from "./geo";

export interface DarkState {
  /** Whole seconds since the relay last heard from this phone. */
  seconds: number;
  /** Seconds until the hunter is shown your area; 0 once it has been. */
  leakIn: number;
}

export function darkState(nowMs: number, sinceMs: number | null): DarkState | null {
  if (sinceMs === null) return null;
  const ms = Math.max(0, nowMs - sinceMs);
  return { seconds: Math.floor(ms / 1000), leakIn: Math.max(0, Math.ceil((DARK_LEAK_MS - ms) / 1000)) };
}

export interface ZoneState {
  /** Which way and how far the zone edge is. */
  direction: string;
  distanceM: number;
  /** Seconds until your area is shown, then until your head is forfeit (local estimate). */
  leakIn: number;
  forfeitIn: number;
}

/** Null while inside the zone (or with no zone or fix to judge by). */
export function zoneState(
  nowMs: number,
  me: LatLon | null,
  zone: Circle | null,
  outSinceMs: number | null,
): ZoneState | null {
  if (!me || !zone || outSinceMs === null) return null;
  const centre = circleCenter(zone);
  const ms = Math.max(0, nowMs - outSinceMs);
  return {
    direction: compass8(bearingDeg(me, centre)),
    distanceM: Math.max(0, Math.round(distanceM(me, centre) - zone.radiusM)),
    leakIn: Math.max(0, Math.ceil((DARK_LEAK_MS - ms) / 1000)),
    forfeitIn: Math.max(0, Math.ceil((DARK_FORFEIT_MS - ms) / 1000)),
  };
}

/** Tracks a run of fast fixes; returns until when the lock is frozen. */
export class VehicleWatch {
  private fastSince: number | null = null;
  frozenUntilMs: number | null = null;

  add(tMs: number, speedMps: number): void {
    if (!(speedMps > MAX_SPEED_MPS)) {
      this.fastSince = null;
      return;
    }
    this.fastSince ??= tMs;
    if (tMs - this.fastSince >= VEHICLE_HOLD_MS) this.frozenUntilMs = tMs + VEHICLE_FREEZE_MS;
  }

  /** Whole seconds of frozen lock left, or null when not frozen. */
  frozenFor(nowMs: number): number | null {
    return this.frozenUntilMs !== null && nowMs < this.frozenUntilMs
      ? Math.ceil((this.frozenUntilMs - nowMs) / 1000)
      : null;
  }
}

/** "12:40" from milliseconds; never negative. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
