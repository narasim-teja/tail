// The HUD socket (GET /hud, apps/server/src/routes/hud.ts) and opening what comes over it. The
// relay sends a 32-byte challenge; the phone answers with its NEAR key's signature over
// hudDigest(nonce, match_id, account_id). Only then does it receive this player's messages: the
// sealed PlayerKeys, the latest sealed HUD, every new HUD, sealed game lines (TAIL's Handler),
// refusals and "over".
//
// What the referee says arrives sealed to the player's box key and signed by the referee
// (packages/protocol signed.ts). Sealing alone proves nothing: anyone holding the box public key,
// the relay included, can seal to it. So each is opened with the referee key the contract pinned
// for the match, read from NEAR by the phone itself, and anything that does not verify is
// dropped. The relay's own frames are not trusted for anything that matters: a `rejected` frame is
// dropped, because the signed HUD carries the referee's latest refusal; a Handler line in plain
// text is dropped, because only a sealed, signed line can be the referee's.

import { equal, type Hud, openSignedHud, openSignedPlayerKeys, type PlayerKeys } from "@tail/protocol";
import { fromB64, toB64 } from "../lib/b64";
import { hudDigest, type Signer } from "./auth";

/** Which match and player a sealed message must be for. */
export interface Seat {
  matchId: Uint8Array;
  player: number;
}

/** `v` if it names this seat; throws otherwise. */
export function forSeat<T extends Seat>(v: T, seat: Seat, what: string): T {
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

export type HudMessage =
  | { type: "challenge"; nonce: Uint8Array }
  | { type: "ready"; player: number }
  | { type: "keys"; player: number; sealed: Uint8Array }
  | { type: "hud"; tick: number; sealed: Uint8Array }
  /** A game line sealed to this player (TAIL: a SignedVoiceLine from the Handler). */
  | { type: "handler"; sealed: Uint8Array }
  /** `reason` is a protocol RefuseCode (null if the relay sent none). */
  | { type: "refused"; nonce: number | null; action: string; reason: number | null }
  | { type: "over" };

const num = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** One socket frame → a message, or null for anything malformed or unknown. */
export function parseHudMessage(text: string): HudMessage | null {
  let m: Record<string, unknown>;
  try {
    const v = JSON.parse(text) as unknown;
    if (typeof v !== "object" || v === null) return null;
    m = v as Record<string, unknown>;
  } catch {
    return null;
  }
  const detail = (typeof m["detail"] === "object" && m["detail"] !== null ? m["detail"] : {}) as Record<
    string,
    unknown
  >;
  try {
    switch (m["type"]) {
      case "challenge":
        return { type: "challenge", nonce: fromB64(str(m["nonce"])) };
      case "ready":
        return { type: "ready", player: num(m["player"]) ?? -1 };
      case "keys":
        return { type: "keys", player: num(m["player"]) ?? -1, sealed: fromB64(str(m["sealed"])) };
      case "hud":
        return { type: "hud", tick: num(m["tick"]) ?? 0, sealed: fromB64(str(m["sealed"])) };
      case "handler":
        return typeof m["sealed"] === "string" ? { type: "handler", sealed: fromB64(m["sealed"]) } : null;
      case "refused":
        return {
          type: "refused",
          nonce: num(detail["nonce"]),
          action: str(detail["action"]),
          reason: num(detail["reason"]),
        };
      case "over":
        return { type: "over" };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** The answer to a challenge. */
export const hudAuthFrame = (signer: Signer, nonce: Uint8Array, matchId: Uint8Array) =>
  JSON.stringify({ type: "auth", sig: toB64(signer.sign(hudDigest(nonce, matchId, signer.accountId))) });

export type SocketState = "connecting" | "authenticating" | "live" | "closed";

interface WsLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface HudSocketDeps {
  url: string;
  signer: Signer;
  matchId: Uint8Array;
  onMessage: (m: HudMessage) => void;
  onState: (s: SocketState) => void;
  connect?: (url: string) => WsLike;
}

/** Keeps one authenticated HUD socket open, reconnecting with backoff, until close(). */
export class HudSocket {
  private ws: WsLike | null = null;
  private closed = false;
  private attempts = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly d: HudSocketDeps) {}

  open(): void {
    if (this.closed || this.ws) return;
    this.d.onState("connecting");
    const ws = (this.d.connect ?? ((u) => new WebSocket(u) as unknown as WsLike))(this.d.url);
    this.ws = ws;
    ws.onmessage = (ev) => {
      const m = parseHudMessage(String(ev.data));
      if (!m) return;
      if (m.type === "challenge") {
        this.d.onState("authenticating");
        ws.send(hudAuthFrame(this.d.signer, m.nonce, this.d.matchId));
        return;
      }
      if (m.type === "ready") {
        this.attempts = 0;
        this.d.onState("live");
      }
      this.d.onMessage(m);
    };
    ws.onclose = () => {
      this.ws = null;
      this.d.onState("closed");
      if (this.closed) return;
      this.attempts++;
      this.retry = setTimeout(() => this.open(), Math.min(10_000, 500 * 2 ** this.attempts));
    };
    ws.onerror = () => {
      // onclose follows and schedules the retry.
    };
  }

  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
    this.ws = null;
  }
}
