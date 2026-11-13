// Leaving a running match. The rules have no quit action (TECHNICAL.md 3): a player leaves by
// going dark, and once the referee has counted DARK_FORFEIT_MS of dark time it forfeits their
// head to their hunter. So "Leave match" stops this phone reporting and keeps it listening for
// the outcome; until the referee calls the forfeit the player may change their mind and report
// again. The referee's count is not reset by coming back: dark time counted stays counted.

import { DARK_FORFEIT_MS } from "@tail/protocol";
import type { DarkInfo } from "./rules";

export interface LeaveFacts {
  /** When the player chose to leave; null while playing. */
  leftAtMs: number | null;
  /** The referee's last word on this player; null before its first HUD. */
  status: "hunting" | "out" | "won" | null;
  /** The match window has closed, or the relay said the match is over. */
  over: boolean;
}

export type LeaveChoice = { kind: "leave"; atMs: number } | { kind: "rejoin" };

/** Still in it: the referee has not put this player out, nor called the match. */
const inPlay = (f: LeaveFacts) => !f.over && (f.status === null || f.status === "hunting");

/**
 * `leftAtMs` after the player's choice. Leaving twice keeps the first time, which is when the
 * dark run began. Once the referee has called it (out, won, or the match over), neither choice
 * changes anything: a forfeit cannot be undone.
 */
export function leaveStep(f: LeaveFacts, c: LeaveChoice): number | null {
  if (!inPlay(f)) return f.leftAtMs;
  if (c.kind === "rejoin") return null;
  return f.leftAtMs ?? c.atMs;
}

/** Whether this phone reports now: in play and not leaving. */
export const reports = (f: LeaveFacts) => inPlay(f) && f.leftAtMs === null;

export interface LeaveCountdown {
  /** Whole seconds until the referee should call the forfeit, by its own count; 0 once due. */
  seconds: number;
  /** The match ends before then, and a player still in at the end keeps their head. */
  endsFirst: boolean;
}

/**
 * How long until the forfeit, from the referee's `dark_ms` (hunt.ts DarkInfo). While the referee
 * counts this player dark, its count runs on from its last HUD. Before it does (a short grace
 * after the last report, or no HUD since leaving), it will count the whole run from when this
 * phone stopped, so the count runs on from then. The first HUD after a relaunch cannot tell the
 * two apart (the count has nothing to grow from) and reads as not counting until the next one.
 */
export function leaveCountdown(
  nowMs: number,
  leftAtMs: number,
  dark: DarkInfo | null,
  endMs: number,
): LeaveCountdown {
  const counted = dark?.totalMs ?? 0;
  const from = dark?.counting ? dark.atMs : leftAtMs;
  const left = DARK_FORFEIT_MS - counted - Math.max(0, nowMs - from);
  const seconds = Math.max(0, Math.ceil(left / 1000));
  return { seconds, endsFirst: endMs <= nowMs + seconds * 1000 };
}
