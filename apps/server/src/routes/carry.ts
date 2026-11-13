// Mesh carry (TECHNICAL.md 7). A phone without signal seals its signed request to the relay's
// box key and hands the envelope to nearby phones; whichever reaches the relay posts it here.
//
//   GET  /carry/key → {box_pk, ack_pk} (base64)
//   POST /carry       body: the raw envelope, sealCarry(box_pk, CarryRequest), 4144 bytes
//                   → {ack: b64 borsh CarryAck, hud?: b64 sealed SignedHud}
//
// The relay opens the envelope and runs the request inside through the app exactly as if the
// phone had sent it (same routes, same signature check), so a carrier can neither read, alter
// nor forge it. Only /batch treats a carried request differently (routes/batch.ts): it may be
// dated back to the match's start, and a copy that came by another carrier is answered
// {duplicate: true}. The ack is the relay's signature over the envelope's hash, the status the
// request got and when the relay received it, so sender and carrier can prove delivery. When
// the request was a batch the relay accepted, the sender's latest sealed HUD rides back with it.

import { CARRY_PAD, encodeCarryAck, openCarry, signCarryAck } from "@tail/protocol";
import type { Hono } from "hono";
import type { CarryKeys } from "../carry.ts";
import type { Store } from "../db.ts";
import { HttpError } from "../errors.ts";
import { bodyBytes, type RequestAuth } from "./util.ts";

/** Every envelope: ephemeral key, the padded request, the AEAD tag. */
export const CARRY_ENVELOPE_BYTES = 32 + CARRY_PAD + 16;

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

export function carryRoutes(
  app: Hono,
  d: { store: Store; auth: RequestAuth; keys: CarryKeys; now: () => number },
) {
  const key = { box_pk: b64(d.keys.boxPk), ack_pk: b64(d.keys.ackPk) };
  app.get("/carry/key", (c) => c.json(key));

  app.post("/carry", async (c) => {
    const receivedMs = d.now();
    const envelope = await bodyBytes(c);
    if (envelope.length !== CARRY_ENVELOPE_BYTES)
      throw new HttpError(400, `a carry envelope is ${CARRY_ENVELOPE_BYTES} bytes`);
    let inner: ReturnType<typeof openCarry>;
    try {
      inner = openCarry(d.keys.boxSk, envelope);
    } catch {
      throw new HttpError(400, "carry envelope does not open");
    }
    // Only signed writes are worth carrying (the answer's body does not travel back), and a
    // carried request is never another carry.
    const method = inner.method.toUpperCase();
    if (method !== "POST") throw new HttpError(400, "only POST requests can be carried");
    if (!inner.path.startsWith("/") || inner.path.startsWith("//") || inner.path.startsWith("/carry"))
      throw new HttpError(400, "carried path is not a relay route");

    const req = d.auth.markCarried(
      new Request(new URL(inner.path, "http://carried.invalid").href, {
        method,
        headers: {
          "content-type": "application/json",
          "x-tail-account": inner.account,
          "x-tail-time": inner.timeMs.toString(),
          "x-tail-sig": b64(inner.sig),
        },
        body: inner.body,
      }),
    );
    const res = await app.fetch(req);
    const ack = signCarryAck(d.keys.ackSk, envelope, res.status, BigInt(receivedMs));
    const hud = res.status === 200 && inner.path === "/batch" ? senderHud(d.store, inner) : undefined;
    return c.json({ ack: b64(encodeCarryAck(ack)), ...(hud ? { hud: b64(hud) } : {}) });
  });
}

/** The latest sealed HUD of the batch's sender in the match the batch names, if the relay has one. */
function senderHud(store: Store, inner: { account: string; body: Uint8Array }): Uint8Array | undefined {
  let matchId: unknown;
  try {
    matchId = (JSON.parse(new TextDecoder().decode(inner.body)) as Record<string, unknown>)["match_id"];
  } catch {
    return undefined;
  }
  const m = typeof matchId === "string" ? store.match(matchId) : undefined;
  const player = m?.players?.indexOf(inner.account) ?? -1;
  return m && player >= 0 ? store.hud(m.match_id, player)?.sealed : undefined;
}
