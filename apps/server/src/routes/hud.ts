// GET /hud?match_id=…&account_id=… (WebSocket). The relay sends a fresh 32-byte challenge; the
// phone answers with its NEAR key's signature over hudDigest(nonce, match_id, account_id)
// (auth.ts). Only then does the socket receive that player's messages (hub.ts): the sealed
// PlayerKeys, the latest sealed HUD, then every new HUD, Handler lines and rejections.

import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { hudDigest, verifyEd25519 } from "../auth.ts";
import type { Store } from "../db.ts";
import { HttpError } from "../errors.ts";
import type { HudHub } from "../hub.ts";
import { field } from "./util.ts";

/** A socket that has not answered the challenge by then is closed. */
export const HUD_AUTH_TIMEOUT_MS = 10_000;

export function hudRoutes(
  app: Hono,
  d: { store: Store; hub: HudHub; upgradeWebSocket: UpgradeWebSocket<unknown> },
) {
  app.get(
    "/hud",
    async (c, next) => {
      const matchId = field.matchId(c.req.query("match_id"));
      const account = c.req.query("account_id") ?? "";
      const m = d.store.match(matchId);
      if (!m) throw new HttpError(404, "no such match");
      if (!m.players) throw new HttpError(409, "match has not started");
      if (!m.players.includes(account) || !d.store.device(account))
        throw new HttpError(403, "not a player in this match");
      await next();
    },
    d.upgradeWebSocket((c) => {
      const matchId = c.req.query("match_id") as string;
      const account = c.req.query("account_id") as string;
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      let unsubscribe: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      return {
        onOpen(_evt, ws) {
          ws.send(JSON.stringify({ type: "challenge", nonce: Buffer.from(nonce).toString("base64") }));
          timer = setTimeout(() => ws.close(4401, "auth timeout"), HUD_AUTH_TIMEOUT_MS);
        },
        onMessage(evt, ws) {
          if (unsubscribe) return; // after auth the phone has nothing to say on this socket
          let sig: Uint8Array | undefined;
          try {
            const msg = JSON.parse(String(evt.data)) as { type?: unknown; sig?: unknown };
            if (msg.type === "auth" && typeof msg.sig === "string")
              sig = new Uint8Array(Buffer.from(msg.sig, "base64"));
          } catch {
            sig = undefined;
          }
          const m = d.store.match(matchId);
          const device = d.store.device(account);
          const player = m?.players?.indexOf(account) ?? -1;
          const digest = hudDigest(nonce, Uint8Array.from(Buffer.from(matchId, "hex")), account);
          if (!sig || !device || player < 0 || !verifyEd25519(device.near_pk, digest, sig)) {
            ws.close(4401, "bad signature");
            return;
          }
          clearTimeout(timer);
          unsubscribe = d.hub.subscribe(matchId, player, { send: (t) => ws.send(t) });
          ws.send(JSON.stringify({ type: "ready", match_id: matchId, player }));
          const keys = m?.keys?.find((k) => k.player === player);
          if (keys) ws.send(JSON.stringify({ type: "keys", match_id: matchId, player, sealed: keys.sealed }));
          const hud = d.store.hud(matchId, player);
          if (hud) {
            ws.send(
              JSON.stringify({
                type: "hud",
                match_id: matchId,
                tick: hud.tick_no,
                sealed: Buffer.from(hud.sealed).toString("base64"),
              }),
            );
          }
          if (m?.phase === "ended") ws.send(JSON.stringify({ type: "over", match_id: matchId }));
        },
        onClose() {
          clearTimeout(timer);
          unsubscribe?.();
        },
      };
    }),
  );
}
