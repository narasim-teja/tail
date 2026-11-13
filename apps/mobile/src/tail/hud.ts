// Reading the referee's word to a TAIL player: the Handler's signed lines, the HUD as the hunt
// screen shows it (it never holds anyone else's position), and every refusal code in plain words.
// Opening and checking the sealed HUD itself is the proximity layer's (proximity/hud.ts).

import {
  type GridCell,
  type HintFact,
  HintKind,
  type Hud,
  hintPrice,
  LOCK_EPOCHS,
  openSignedVoiceLine,
  RefuseCode,
  RejectCode,
  TargetStatus,
  type VoiceLine,
} from "@tail/protocol";
import { forSeat, type Seat } from "../proximity/hud";

/** What the phone shows for anything sealed to it that the referee did not sign. */
export const NOT_SIGNED = "This update was not signed by the referee";

/** What the phone shows, in the hunt and on Results, once the log monitor finds a fork. */
export const LOG_FORKED = "The referee showed you a log it later changed";

/**
 * What the phone says, quietly, when the relay's log proof does not check out. That blames the
 * relay, not the referee (proximity/monitor.ts), and the phone asks again later.
 */
export const RELAY_BAD_PROOF = "The relay sent a log proof that didn't check out";

/** Opens one Handler line, signed by the referee and sealed to this player. */
export const openVoice = (
  boxSk: Uint8Array,
  sealed: Uint8Array,
  refereePk: Uint8Array,
  seat: Seat,
): VoiceLine => forSeat(openSignedVoiceLine(boxSk, sealed, refereePk), seat, "Handler line");

const BEARINGS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/** A computed hint fact as one short line. The Handler's voice comes separately. */
export function describeHintFact(f: HintFact): string {
  switch (f.hint) {
    case HintKind.Near:
      return f.value === 1 ? "Within 150 m" : "Not within 150 m";
    case HintKind.Bearing:
      return `Bearing ${BEARINGS[f.value] ?? "?"}`;
    case HintKind.Trend:
      return f.value === 1 ? "Closer" : f.value === 0 ? "Farther" : "Same distance";
    default:
      return "Unknown hint";
  }
}

export const hintLabel: Record<HintKind, string> = {
  [HintKind.Near]: "Near?",
  [HintKind.Bearing]: "Bearing",
  [HintKind.Trend]: "Warmer?",
};

export interface HudView {
  tick: number;
  /** 0..LOCK_EPOCHS, as the segmented bar shows it. */
  lock: number;
  heat: number;
  /**
   * Your head as the contract holds it. Hints about you are not in it: their price waits in the
   * match's hint pool and joins your head when you go out (and goes on with it) or survive to End.
   */
  head: bigint;
  status: "hunting" | "out" | "won";
  target: string;
  canStrike: boolean;
  leak: { lat: number; lon: number } | null;
  hint: { id: number; text: string } | null;
  /** Once out: the account that took your head. */
  taggedBy: string | null;
  /** The Handler's price board, signed with the HUD: each kind's price now, by HintKind. */
  hintPrices: readonly [bigint, bigint, bigint];
  /** Hints anyone bought in the last five minutes: the demand behind those prices. */
  hintRecent: number;
}

const cellCenter = (c: GridCell) => ({ lat: c.latE7 / 1e7, lon: c.lonE7 / 1e7 });

export function hudView(h: Hud): HudView {
  const status = h.status === TargetStatus.Out ? "out" : h.status === TargetStatus.Won ? "won" : "hunting";
  return {
    tick: h.tick,
    lock: Math.min(h.lock, LOCK_EPOCHS),
    heat: Math.min(h.heat, LOCK_EPOCHS),
    head: h.head,
    status,
    target: h.target,
    canStrike: status === "hunting" && h.lock >= LOCK_EPOCHS,
    leak: h.leak ? cellCenter(h.leak) : null,
    hint: h.hintFact ? { id: h.hintFact.hintId, text: describeHintFact(h.hintFact) } : null,
    taggedBy: h.taggedBy ?? null,
    hintPrices: h.hintPrices,
    hintRecent: h.hintRecent,
  };
}

/** Price board from a HUD: what each kind costs now, and the demand behind it. */
export type Board = Pick<HudView, "hintPrices" | "hintRecent">;

/**
 * What a hint of `kind` costs now: the last signed HUD's board, or the base price before one.
 * The referee charges at its own clock, so another hunter's hint in the same tick can still
 * raise it.
 */
export const priceNow = (stake: bigint, kind: HintKind, board: Board | null) =>
  board ? board.hintPrices[kind] : hintPrice(stake, kind, 0);

/** Token amounts (USDC, 6 decimals) as "1.50". Exact: no floating point. */
export function formatAmount(units: bigint, decimals = 6): string {
  const neg = units < 0n;
  const v = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${neg ? "-" : ""}${v / base}.${frac}`;
}

/**
 * Why the referee refused a strike or a hint (a protocol RefuseCode, as the relay forwards it),
 * as a short line a player understands.
 */
export function describeRefusal(action: string, code: number | null): string {
  const what = action ? `${action.charAt(0).toUpperCase()}${action.slice(1)} refused.` : "Refused.";
  return `${what} ${refuseWhy(code)}`;
}

function refuseWhy(code: number | null): string {
  switch (code) {
    case RefuseCode.NoFix:
      return "No location for you or your target yet. Try again in a minute.";
    case RefuseCode.Lock:
      return "Your lock isn't full.";
    case RefuseCode.NoContact:
      return "Your target wasn't in range just then.";
    case RefuseCode.Cooldown:
      return "Too soon for another hint.";
    case RefuseCode.Funds:
      return "Your head can't cover that hint.";
    case RefuseCode.HintLimit:
      return "This match has had all the hints it allows.";
    case RefuseCode.TextTooLong:
      return "Your question is too long.";
    case RefuseCode.PlayerOut:
      return "You're out.";
    case RefuseCode.TimeUp:
    case RefuseCode.MatchOver:
      return "The match is over.";
    case RefuseCode.UnknownHint:
      return "That hint doesn't exist.";
    default:
      return code === null ? "No reason given." : `Reason ${code}.`;
  }
}

/**
 * Why the referee refused one of your reports (a RejectCode from the signed HUD), as a short line
 * a player understands. Null for a refusal the phone recovers from by itself (proximity/chain.ts), so
 * there is nothing for the player to do about it.
 */
export function describeRejectCode(code: number): string | null {
  switch (code) {
    case RejectCode.Seq:
    case RejectCode.Prev:
      return null;
    case RejectCode.Assertion:
      return "Device check failed on a report. Carrying on with a new one.";
    case RejectCode.ClockSkew:
      return "Phone clock is off. Set it to automatic.";
    case RejectCode.FixFlags:
      return "Location looks simulated or came from an accessory. Report not counted.";
    case RejectCode.FixOrder:
      return "Location fixes out of order. Report not counted.";
    case RejectCode.Teleport:
      return "Moved impossibly fast. Report not counted.";
    case RejectCode.TimeOrder:
      return "A report was dated before the last one. Report not counted.";
    case RejectCode.TooOld:
      return "A report arrived too late to count.";
    case RejectCode.PlayerOut:
      return "You are out.";
    case RejectCode.WrongMatch:
    case RejectCode.UnknownPlayer:
      return "The referee doesn't know this phone in this match.";
    default:
      return `Report not counted (reason ${code}).`;
  }
}

/** The same reasons for the results screen: "refused by the referee (clock off)". */
export function rejectReason(code: number): string {
  switch (code) {
    case RejectCode.Seq:
    case RejectCode.Prev:
      return "out of order";
    case RejectCode.Assertion:
      return "device check failed";
    case RejectCode.ClockSkew:
      return "clock off";
    case RejectCode.FixFlags:
      return "location not from this iPhone";
    case RejectCode.FixOrder:
      return "fixes out of order";
    case RejectCode.Teleport:
      return "moved impossibly fast";
    case RejectCode.TimeOrder:
      return "dated before the last one";
    case RejectCode.TooOld:
      return "arrived too late";
    case RejectCode.PlayerOut:
      return "already out";
    case RejectCode.WrongMatch:
    case RejectCode.UnknownPlayer:
      return "not known in this match";
    default:
      return `reason ${code}`;
  }
}
