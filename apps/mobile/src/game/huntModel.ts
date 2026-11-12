// Everything the hunt screen shows, as plain data. The live screen builds it from the session;
// the design preview builds it from fixtures. Both render the same HuntView.

import { HintKind, hintPrice, LOCK_EPOCHS, type PlayerKeys } from "@tail/protocol";
import type { LatLon } from "./geo";
import { formatAmount } from "./hud";
import { clock, darkState, zoneState } from "./rules";
import type { Note, SessionSnapshot } from "./session";
import type { Zone } from "./zone";

export type Banner =
  | { kind: "dark"; title: string; detail: string }
  | { kind: "zone"; title: string; detail: string };

export interface HintOption {
  kind: HintKind;
  name: string;
  price: string;
}

export interface Dispatch {
  atMs: number;
  text: string;
}

export interface HuntModel {
  target: string;
  timeLeft: string;
  lock: number;
  heat: number;
  max: number;
  head: string;
  canStrike: boolean;
  strikeSent: boolean;
  /** "1:45" while a vehicle speed has frozen your lock. */
  frozenFor: string | null;
  /** Changes identity when a strike lands, so the view can play the landing once. */
  landedAtMs: number | null;
  tags: number;
  tagged: boolean;
  /** Once tagged: the account that took your head, when the referee's HUD names it. */
  taggedBy: string | null;
  /** No HUD yet: the referee has not ticked since you started. */
  waiting: boolean;
  banner: Banner | null;
  me: (LatLon & { heading: number | null }) | null;
  zone: Zone | null;
  leak: LatLon | null;
  /** Newest Handler line, shown at the top as it arrives. */
  dispatch: Dispatch | null;
  /** Handler lines and game notices, newest first, for the pull-down log. */
  log: Note[];
  hints: HintOption[];
  status: string;
  blocked: "bluetooth" | "location" | null;
}

export const money = (units: bigint) => `$${formatAmount(units)}`;

/** "maya.tail-dev.testnet" → "maya": friends know each other by handle. */
export const handleOf = (account: string) => account.split(".")[0] ?? account;

/**
 * The tagged screen's lines. The HUD names who took your head; without the name (a HUD from a
 * referee older than the field) it says "your hunter" and points at the replay instead.
 */
export function taggedLines(
  taggedBy: string | null,
  head: string,
): { title: string; line: string; more: string | null } {
  if (taggedBy) {
    return { title: `${handleOf(taggedBy)} got you`, line: `Your head, ${head}, is theirs now.`, more: null };
  }
  return {
    title: "Tagged",
    line: `Your head, ${head}, went to your hunter.`,
    more: "The replay shows who, once the match ends.",
  };
}

export function hintOptions(stake: bigint): HintOption[] {
  return [
    { kind: HintKind.Near, name: "Near", price: money(hintPrice(stake, HintKind.Near)) },
    { kind: HintKind.Bearing, name: "Bearing", price: money(hintPrice(stake, HintKind.Bearing)) },
    { kind: HintKind.Trend, name: "Warmer", price: money(hintPrice(stake, HintKind.Trend)) },
  ];
}

function status(s: SessionSnapshot): string {
  const parts: string[] = [];
  if (s.queued > 1) parts.push(`${s.queued - 1} waiting`);
  if (s.socket !== "live") parts.push("Reconnecting");
  if (s.carry.kind === "carrying") parts.push("Mesh on");
  return parts.join(" · ");
}

export function huntModel(
  s: SessionSnapshot,
  ctx: { keys: PlayerKeys; stake: bigint; zone: Zone | null },
  nowMs: number,
): HuntModel {
  const hud = s.hud;
  const dark = darkState(nowMs, s.darkSinceMs);
  const zone = zoneState(nowMs, s.lastFix, ctx.zone?.zone ?? null, s.outSinceMs);
  let banner: Banner | null = null;
  if (zone) {
    banner =
      zone.leakIn > 0
        ? {
            kind: "zone",
            title: `Out of zone. Back ${zone.direction}, ${zone.distanceM} m`,
            detail: `Back in ${zone.leakIn} s or your area shows`,
          }
        : {
            kind: "zone",
            title: `Out of zone. Back ${zone.direction}, ${zone.distanceM} m`,
            detail: `Back in ${zone.forfeitIn} s or lose your head`,
          };
  } else if (dark) {
    banner =
      dark.leakIn > 0
        ? { kind: "dark", title: `Dark ${dark.seconds} s`, detail: `Your area shows in ${dark.leakIn} s` }
        : { kind: "dark", title: `Dark ${dark.seconds} s`, detail: "Your area was shown to your hunter" };
  }
  const handler = s.notes.find((n) => n.kind === "handler") ?? null;
  return {
    target: hud?.target ?? ctx.keys.target,
    timeLeft: `${clock(Number(ctx.keys.endMs) - nowMs)} left`,
    lock: hud?.lock ?? 0,
    heat: hud?.heat ?? 0,
    max: LOCK_EPOCHS,
    head: hud ? money(hud.head) : money(ctx.stake),
    canStrike: !!hud?.canStrike,
    strikeSent: s.strikeSentAtMs !== null,
    frozenFor: s.frozenUntilMs !== null && s.frozenUntilMs > nowMs ? clock(s.frozenUntilMs - nowMs) : null,
    landedAtMs: s.landed?.atMs ?? null,
    tags: s.tags,
    tagged: hud?.status === "out",
    taggedBy: hud?.taggedBy ?? null,
    waiting: hud === null,
    banner,
    me: s.lastFix ? { lat: s.lastFix.lat, lon: s.lastFix.lon, heading: s.lastFix.heading } : null,
    zone: ctx.zone,
    leak: hud?.leak ?? null,
    dispatch: handler ? { atMs: handler.tMs, text: handler.text } : null,
    log: s.notes,
    hints: hintOptions(ctx.stake),
    status: status(s),
    blocked: s.blocked,
  };
}
