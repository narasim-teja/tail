// The phone's own view of three referee rules, so it can warn the player before the referee
// acts (TECHNICAL.md 3, IDEA.md 3). The referee alone decides; these mirror its constants.
//   dark:    no valid report for DARK_LEAK_MS → your hunter sees your 100 m cell; DARK_FORFEIT_MS
//            in all → your head is forfeit (the count itself comes from the referee's HUD)
//   zone:    outside the zone counts as dark
//   vehicle: faster than MAX_SPEED_MPS for VEHICLE_HOLD_MS → lock frozen VEHICLE_FREEZE_MS

import {
  DARK_FORFEIT_MS,
  DARK_LEAK_MS,
  MAX_SPEED_MPS,
  TICK_MS,
  VEHICLE_FREEZE_MS,
  VEHICLE_HOLD_MS,
} from "@tail/protocol";
import { bearingDeg, type Circle, circleCenter, compass8, distanceM, type LatLon } from "./geo";

/** The referee's dark count for you, from its signed HUDs (session.ts). */
export interface DarkInfo {
  /** Cumulative dark time at the last HUD (`dark_ms`). */
  totalMs: number;
  /** The current dark run at the last HUD; 0 when not dark. */
  runMs: number;
  /** The referee counted you dark at the last HUD (`dark_ms` grew). */
  counting: boolean;
  /** When that HUD arrived. */
  atMs: number;
}

export interface DarkState {
  /** Whole seconds of the current dark run. */
  seconds: number;
  /** Seconds until the hunter is shown your area; 0 once it has been. */
  leakIn: number;
  /** Seconds of dark left before your head is forfeit. */
  forfeitIn: number;
}

/** No HUD for this long while the relay is unreachable: the referee is not hearing you either. */
export const HUD_STALE_MS = 2 * TICK_MS;

/**
 * How dark you are, by the referee's count. Between HUDs a run it is counting goes on with the
 * clock. With no HUD for HUD_STALE_MS and no relay contact, nothing of yours is reaching the
 * referee, so the count is taken to run from the last HUD: the referee's own figure is what the
 * next HUD brings.
 */
export function darkState(nowMs: number, dark: DarkInfo | null, offline: boolean): DarkState | null {
  if (!dark) return null;
  const since = Math.max(0, nowMs - dark.atMs);
  const running = dark.counting || (offline && since >= HUD_STALE_MS);
  if (!running) return null;
  const run = dark.runMs + since;
  const total = dark.totalMs + since;
  return {
    seconds: Math.floor(run / 1000),
    leakIn: Math.max(0, Math.ceil((DARK_LEAK_MS - run) / 1000)),
    forfeitIn: Math.max(0, Math.ceil((DARK_FORFEIT_MS - total) / 1000)),
  };
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
