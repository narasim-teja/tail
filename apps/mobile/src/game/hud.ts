// Opening and reading the referee's sealed messages to this phone: PlayerKeys once at start
// ("tail/keys") and a Hud every tick ("tail/hud"), both sealed to the player's box key. The
// view model turns a Hud into what the hunt screen shows; it never holds anyone else's position.

import {
  decodeHud,
  decodePlayerKeys,
  equal,
  FixFlag,
  type GridCell,
  type HintFact,
  HintKind,
  type Hud,
  LOCK_EPOCHS,
  open,
  type PlayerKeys,
  TargetStatus,
} from "@tail/protocol";

export const SEAL_CONTEXT_HUD = "tail/hud";
export const SEAL_CONTEXT_KEYS = "tail/keys";

export const openHud = (boxSk: Uint8Array, sealed: Uint8Array): Hud =>
  decodeHud(open(boxSk, sealed, SEAL_CONTEXT_HUD));

/** Opens this player's keys and checks they are for this match and this seat. */
export function openPlayerKeys(
  boxSk: Uint8Array,
  sealed: Uint8Array,
  expect: { matchId: Uint8Array; player: number },
): PlayerKeys {
  const k = decodePlayerKeys(open(boxSk, sealed, SEAL_CONTEXT_KEYS));
  if (!equal(k.matchId, expect.matchId)) throw new Error("keys are for another match");
  if (k.player !== expect.player) throw new Error("keys are for another player");
  return k;
}

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
 * The referee's reason for rejecting a batch (Rust Debug text, e.g. `FixFlags { flags: 1 }`)
 * as a short line a player understands.
 */
export function describeRejection(reason: string): string {
  if (reason.startsWith("FixFlags")) {
    // FixFlags { flags: n }: bit 0 is software simulation, bit 1 an external accessory (4.3).
    // An accessory is a real receiver, so it is named as one, not as a fake.
    const flags = Number(/flags:\s*(\d+)/.exec(reason)?.[1] ?? Number.NaN);
    if (flags === FixFlag.ProducedByAccessory)
      return "Location came from an accessory, not this iPhone. Disconnect it. Report rejected.";
    return "Location looks simulated. Report rejected.";
  }
  if (reason.startsWith("Teleport")) return "Moved impossibly fast. Report rejected.";
  if (reason.startsWith("ClockSkew")) return "Phone clock is off. Set it to automatic.";
  if (reason.startsWith("Assertion")) return "Device check failed. Report rejected.";
  if (reason.startsWith("Seq") || reason.startsWith("Prev")) return "Report out of order.";
  if (reason.startsWith("PlayerOut")) return "You are out.";
  if (reason.startsWith("FixOrder")) return "Location fixes out of order.";
  return `Report rejected: ${reason}`;
}
