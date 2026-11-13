// Opening and reading the referee's sealed messages to this phone: PlayerKeys once at start, a
// Hud every tick and the Handler's lines, each sealed to the player's box key and signed by the
// referee (packages/protocol signed.ts). Sealing alone proves nothing: anyone holding the box
// public key, the relay included, can seal to it. So each is opened with the referee key the
// contract pinned for the match, read from NEAR by the phone itself, and anything that does not
// verify is dropped. The view model turns a Hud into what the hunt screen shows; it never holds
// anyone else's position.

import {
  equal,
  type GridCell,
  type HintFact,
  HintKind,
  type Hud,
  LOCK_EPOCHS,
  openSignedHud,
  openSignedPlayerKeys,
  openSignedVoiceLine,
  type PlayerKeys,
  RejectCode,
  TargetStatus,
  type VoiceLine,
} from "@tail/protocol";

/** What the phone shows for anything sealed to it that the referee did not sign. */
export const NOT_SIGNED = "This update was not signed by the referee";

export interface Seat {
  matchId: Uint8Array;
  player: number;
}

function forSeat<T extends Seat>(v: T, seat: Seat, what: string): T {
  if (!equal(v.matchId, seat.matchId)) throw new Error(`${what} is for another match`);
  if (v.player !== seat.player) throw new Error(`${what} is for another player`);
  return v;
}

/** Opens a sealed SignedHud for this seat; throws if it does not open, verify or fit. */
export const openHud = (boxSk: Uint8Array, sealed: Uint8Array, refereePk: Uint8Array, seat: Seat): Hud =>
  forSeat(openSignedHud(boxSk, sealed, refereePk), seat, "HUD");

/** Opens this player's keys and checks they are signed by the referee, for this match and seat. */
export const openPlayerKeys = (
  boxSk: Uint8Array,
  sealed: Uint8Array,
  refereePk: Uint8Array,
  seat: Seat,
): PlayerKeys => forSeat(openSignedPlayerKeys(boxSk, sealed, refereePk), seat, "keys");

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
  head: bigint;
  status: "hunting" | "out" | "won";
  target: string;
  canStrike: boolean;
  leak: { lat: number; lon: number } | null;
  hint: { id: number; text: string } | null;
  /** Once out: the account that took your head. */
  taggedBy: string | null;
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
  };
}

/** Token amounts (USDC, 6 decimals) as "1.50". Exact: no floating point. */
export function formatAmount(units: bigint, decimals = 6): string {
  const neg = units < 0n;
  const v = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${neg ? "-" : ""}${v / base}.${frac}`;
}

/**
 * Why the referee refused a strike or a hint (referee-core `Refuse`, Debug text such as
 * `NoFix` or `Lock { lock: 2 }`), as a short line a player understands.
 */
export function describeRefusal(action: string, reason: string): string {
  const what = action ? `${action.charAt(0).toUpperCase()}${action.slice(1)} refused.` : "Refused.";
  const r = reason.toLowerCase();
  const why = r.startsWith("nofix")
    ? "No location for you or your target yet. Try again in a minute."
    : r.startsWith("lock")
      ? "Your lock isn't full."
      : r.startsWith("nocontact")
        ? "Your target wasn't in range just then."
        : r.startsWith("cooldown")
          ? "Too soon for another hint."
          : r.startsWith("insufficienthead")
            ? "Your head can't cover that hint."
            : r.startsWith("texttoolong")
              ? "Your question is too long."
              : r.startsWith("playerout")
                ? "You're out."
                : r.startsWith("timeup") || r.startsWith("matchover")
                  ? "The match is over."
                  : r.startsWith("unknownhint")
                    ? "That hint doesn't exist."
                    : reason;
  return `${what} ${why}`;
}

/**
 * Why the referee refused one of your reports (a RejectCode from the signed HUD), as a short line
 * a player understands. Null for a refusal the phone recovers from by itself (game/chain.ts), so
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
    case RejectCode.PlayerOut:
      return "already out";
    case RejectCode.WrongMatch:
    case RejectCode.UnknownPlayer:
      return "not known in this match";
    default:
      return `reason ${code}`;
  }
}

/** Every RejectCode value, for looking a refused report up in the log. */
export const REJECT_CODES: readonly number[] = Object.values(RejectCode);
