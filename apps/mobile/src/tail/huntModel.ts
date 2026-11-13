// Everything the hunt screen shows, as plain data. The live screen builds it from the session;
// the design preview builds it from fixtures. Both render the same HuntView.

import { HINT_NAME, HintKind, LOCK_EPOCHS, type PlayerKeys, priceReason } from "@tail/protocol";
import type { Blocked } from "../proximity/client";
import type { RefereeKind } from "../relay/client";
import type { LatLon } from "./geo";
import { type Board, formatAmount, LOG_FORKED, priceNow, refusalBanner } from "./hud";
import type { HuntSnapshot, Note } from "./hunt";
import { leaveCountdown } from "./leave";
import { clock, darkState, zoneState } from "./rules";
import type { Zone } from "./zone";

export type Banner =
  | { kind: "dark"; title: string; detail: string }
  | { kind: "zone"; title: string; detail: string }
  /** The referee's log roots do not fit together; it stays up for the rest of the match. */
  | { kind: "fork"; title: string; detail: string }
  /** The referee refused one of your actions just now: why, for REFUSED_SHOW_MS. */
  | { kind: "refused"; title: string; detail: string };

/** How long "You were invisible N s" stays up after you are back. */
export const INVISIBLE_SHOW_MS = 10_000;

/** How long a refused strike or hint says why on the hunt screen. */
export const REFUSED_SHOW_MS = 10_000;

export interface HintOption {
  kind: HintKind;
  name: string;
  price: string;
  /** The Handler's one line on why it costs that; null before the first HUD. */
  reason: string | null;
}

export interface Dispatch {
  atMs: number;
  text: string;
}

/** How long a fresh dispatch stays up front before folding into the log. */
export const DISPATCH_MS = 9_000;

/**
 * The dispatch card at the top of the hunt screen. Fresh, it is the Handler's newest line under
 * the Handler's name. Pulled open, it is the hunt's log: the Handler's lines and the game's own
 * notices ("Your target forfeited…"), so it is headed "Log", and only the Handler's lines are set
 * as its voice; a notice under the Handler's name would read as the Handler saying it.
 */
export interface DispatchCard {
  /** The card is up: a fresh dispatch, or the log pulled open. */
  show: boolean;
  head: "Handler" | "Log";
  rows: { key: string; text: string; voice: "handler" | "notice" }[];
  /** The pull tab under the strip, while the card is folded away and the log has entries. */
  tab: number | null;
}

export function dispatchCard(
  dispatch: Dispatch | null,
  log: Note[],
  nowMs: number,
  open: boolean,
): DispatchCard {
  const fresh = !!dispatch && nowMs - dispatch.atMs < DISPATCH_MS;
  const entries = log.slice(0, 6);
  const rows = open
    ? entries.map((n) => ({
        key: `${n.tMs}-${n.text}`,
        text: n.text,
        voice: n.kind === "handler" ? ("handler" as const) : ("notice" as const),
      }))
    : dispatch && fresh
      ? [{ key: `${dispatch.atMs}`, text: dispatch.text, voice: "handler" as const }]
      : [];
  return {
    show: open || fresh,
    head: open ? "Log" : "Handler",
    rows,
    tab: !open && !fresh && entries.length > 0 ? entries.length : null,
  };
}

/** How long until the referee should call a forfeit (leave.ts), and whether the match ends first. */
export interface LeaveTime {
  forfeitIn: string;
  /** The referee should call it at its next update. */
  due: boolean;
  endsFirst: boolean;
  endsIn: string;
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
  blocked: Blocked | null;
  /**
   * Leave match is on offer (still in the hunt, not leaving already): what leaving now would
   * cost, for the sheet that asks first. Null when it is not on offer.
   */
  leaveNow: LeaveTime | null;
  /** The player chose to leave and the referee has not called it yet. */
  leaving: LeaveTime | null;
  /** The player had chosen to leave when they went out: the out screen says so. */
  left: boolean;
}

export const money = (units: bigint) => `$${formatAmount(units)}`;

/** Test players are ghost accounts (`ghost-…`, the relay's testing door). */
export const isTestPlayer = (account: string) => account.startsWith("ghost-");

/** "maya.tail-dev.testnet" → "maya": friends know each other by handle. A ghost is "Test player". */
export const handleOf = (account: string) =>
  isTestPlayer(account) ? "Test player" : (account.split(".")[0] ?? account);

export type Outcome = "survived" | "won" | "out" | "running";

/**
 * Results' "How it's verified". The relay says which referee it runs; it is not trusted for that,
 * so its word is only used to say less: a local test referee is named as one, and an enclave is
 * only ever "the relay says", with the replay as the check.
 */
export function howVerified(referee: RefereeKind | null): string {
  const contact = "Every tag needed both phones to hear each other's one-time codes.";
  const chain =
    "The NEAR contract only moves money on the referee's signature, and the replay re-checks every signature against the chain.";
  switch (referee) {
    case "local":
      return `${contact} This match ran on a test referee on the relay's own computer, not in a hardware enclave: it checked the contact and signed each tag. ${chain}`;
    case "outlayer":
      return `${contact} The relay says its referee runs in OutLayer's hardware enclave, which checked the contact and signed each tag; the replay shows whether the enclave's attestation backs that. ${chain}`;
    default:
      return `${contact} The referee checked the contact and signed each tag. ${chain}`;
  }
}

/**
 * How the match went for you. The chain's record decides when the HUD's last word is missing (the
 * app was reopened, or the final HUD never arrived): out is out, and the only one left standing
 * at the end won.
 */
export function resultOutcome(f: {
  hudStatus: "hunting" | "out" | "won" | null;
  out: boolean;
  ended: boolean;
  standing: number;
}): Outcome {
  if (f.hudStatus === "out" || f.out) return f.ended ? "out" : "running";
  if (f.hudStatus === "won" || (f.ended && f.standing === 1)) return "won";
  return "survived";
}

/**
 * The tagged screen's lines. The HUD names who took your head; without the name (a HUD from a
 * referee older than the field) it says "your hunter" and points at the replay instead.
 */
export function taggedLines(
  taggedBy: string | null,
  head: string,
  left = false,
): { title: string; line: string; more: string | null } {
  // Out by the dark rule after Leave match: no one got you, you went.
  if (left) {
    return {
      title: "You left the match",
      line: `Your head, ${head}, went to ${taggedBy ? handleOf(taggedBy) : "your hunter"}.`,
      more: null,
    };
  }
  if (taggedBy) {
    return { title: `${handleOf(taggedBy)} got you`, line: `Your head, ${head}, is theirs now.`, more: null };
  }
  return {
    title: "Tagged",
    line: `Your head, ${head}, went to your hunter.`,
    more: "The replay shows who, once the match ends.",
  };
}

/**
 * The three hints at the prices the referee's last signed HUD shows. They move with demand: each
 * hint anyone bought in the last five minutes adds a quarter, up to 4x. Before the first HUD the
 * phone cannot know the demand, so it shows the base price and no reason.
 */
export function hintOptions(stake: bigint, board: Board | null = null): HintOption[] {
  return [HintKind.Near, HintKind.Bearing, HintKind.Trend].map((kind) => ({
    kind,
    name: HINT_NAME[kind],
    price: money(priceNow(stake, kind, board)),
    reason: board ? priceReason(kind, board.hintRecent) : null,
  }));
}

function status(s: HuntSnapshot): string {
  const parts: string[] = [];
  if (s.queued > 1) parts.push(`${s.queued - 1} waiting`);
  if (s.socket !== "live") parts.push("Reconnecting");
  if (s.carry.kind === "on") parts.push("Mesh on");
  // Soft on purpose: a bad proof convicts only the relay, and the check is asked again.
  if (s.relayFault?.outstanding && !s.logFork) parts.push("Relay proof failed, rechecking");
  return parts.join(" · ");
}

export function huntModel(
  s: HuntSnapshot,
  ctx: { keys: PlayerKeys; stake: bigint; zone: Zone | null },
  nowMs: number,
): HuntModel {
  const hud = s.hud;
  const dark = darkState(nowMs, s.dark, s.offline);
  const zone = zoneState(nowMs, s.lastFix, ctx.zone?.zone ?? null, s.outSinceMs);
  let banner: Banner | null = null;
  // Above everything: a referee that rewrote its log makes the rest of the screen untrustworthy.
  if (s.logFork) {
    banner = {
      kind: "fork",
      title: LOG_FORKED,
      detail: "Your phone kept the signed proof. Export it from Results.",
    };
  } else if (zone) {
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
        : {
            kind: "dark",
            title: `Dark ${dark.seconds} s`,
            detail: `Your area was shown. Head forfeits in ${dark.forfeitIn} s`,
          };
  } else if (s.refused && nowMs - s.refused.atMs < REFUSED_SHOW_MS) {
    banner = { kind: "refused", ...refusalBanner(s.refused.action, s.refused.code) };
  } else if (s.invisible && nowMs - s.invisible.atMs < INVISIBLE_SHOW_MS) {
    banner = {
      kind: "dark",
      title: `You were invisible ${s.invisible.seconds} s`,
      detail: "Locked or in the background, your phone can't be heard. Keep TAIL open.",
    };
  } else if (s.noPocketSensor) {
    banner = {
      kind: "dark",
      title: "No pocket sensor",
      detail: "This phone can't turn its screen off in a pocket. Don't lock it: that hides you.",
    };
  }
  const handler = s.notes.find((n) => n.kind === "handler") ?? null;
  const endMs = Number(ctx.keys.endMs);
  const inPlay = !s.over && (!hud || hud.status === "hunting");
  const leaveTime = (leftAtMs: number): LeaveTime => {
    const c = leaveCountdown(nowMs, leftAtMs, s.dark, endMs);
    return {
      forfeitIn: clock(c.seconds * 1000),
      due: c.seconds === 0,
      endsFirst: c.endsFirst,
      endsIn: clock(endMs - nowMs),
    };
  };
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
    hints: hintOptions(ctx.stake, hud),
    status: status(s),
    blocked: s.blocked,
    leaveNow: inPlay && s.leftAtMs === null ? leaveTime(nowMs) : null,
    leaving: inPlay && s.leftAtMs !== null ? leaveTime(s.leftAtMs) : null,
    left: s.leftAtMs !== null,
  };
}
