// The HUD socket (GET /hud, apps/relay/src/routes/hud.ts). The relay sends a 32-byte challenge;
// the phone answers with its NEAR key's signature over hudDigest(nonce, match_id, account_id).
// Only then does it receive this player's messages: the sealed PlayerKeys, the latest sealed
// HUD, every new HUD, Handler lines, rejections, refusals and "over".

import { fromB64, toB64 } from "../lib/b64";
import { hudDigest, type Signer } from "./auth";

export type HudMessage =
  | { type: "challenge"; nonce: Uint8Array }
  | { type: "ready"; player: number }
  | { type: "keys"; player: number; sealed: Uint8Array }
  | { type: "hud"; tick: number; sealed: Uint8Array }
  | { type: "handler"; hintId: number; text: string }
  | { type: "rejected"; seq: number | null; reason: string }
  | { type: "refused"; nonce: number | null; action: string; reason: string }
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
        return { type: "handler", hintId: num(m["hint_id"]) ?? -1, text: str(m["text"]) };
      case "rejected":
        return { type: "rejected", seq: num(detail["seq"]), reason: str(detail["reason"]) };
      case "refused":
        return {
          type: "refused",
          nonce: num(detail["nonce"]),
          action: str(detail["action"]),
          reason: str(detail["reason"]),
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
