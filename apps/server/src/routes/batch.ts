import { REQUEST_SKEW_MS } from "@tail/protocol";
import type { Hono } from "hono";
import type { Store } from "../db.ts";
import type { Matches } from "../matches.ts";
import { defaultWindow, field, type RequestAuth, type RequestWindow } from "./util.ts";

/** A batch is ~5 s of fixes and sightings; a few KB. Larger is not a phone's batch. */
export const MAX_SEALED_BATCH = 32 * 1024;

type Obj = Record<string, unknown>;

/**
 * A batch's request window. A batch signed by a phone without signal can reach the relay minutes
 * later through other phones (routes/carry.ts), so a carried one may be dated anywhere from the
 * match's start to now + REQUEST_SKEW_MS. Its digest, and a direct one's, is then remembered
 * until the match ends: otherwise a batch sent directly could come back through the mesh once
 * its 60 s had passed and be queued a second time.
 */
function batchWindow(store: Store, carried: boolean) {
  return (body: Obj, timeMs: number, nowMs: number): RequestWindow => {
    const direct = defaultWindow(body, timeMs, nowMs);
    const id = body["match_id"];
    const m = typeof id === "string" ? store.match(id) : undefined;
    if (!m || m.start_ms === null || m.end_ms === null) return direct;
    const keepUntilMs = Math.max(direct.keepUntilMs, m.end_ms + REQUEST_SKEW_MS);
    return carried ? { fromMs: m.start_ms, toMs: direct.toMs, keepUntilMs } : { ...direct, keepUntilMs };
  };
}

export function batchRoutes(app: Hono, d: { store: Store; auth: RequestAuth; matches: Matches }) {
  // Signed by the player. {match_id, sealed} → {queued, player}. `sealed` is
  // seal(referee_box_pk, borsh(BatchEnvelope), "tail/batch"); the relay cannot open it.
  // `queued: false` means these exact bytes are already waiting for the next tick (a retried
  // upload), which is success. Bytes the referee already saw are queued again, so a phone can
  // resend after the referee rejected a batch for a seq gap. The same signed request may arrive
  // more than once (a retry whose answer was lost, or copies through several mesh carriers):
  // every copy after the first is answered 200 {duplicate: true, code: "duplicate"}, which is
  // delivery, and none is queued again.
  app.post("/batch", async (c) => {
    const { account, body, repeat } = await d.auth.signed(c, {
      window: batchWindow(d.store, d.auth.isCarried(c)),
      onRepeat: "report",
    });
    if (repeat) return c.json({ duplicate: true, code: "duplicate" });
    const matchId = field.matchId(typeof body["match_id"] === "string" ? body["match_id"] : undefined);
    const sealed = field.bytes(body, "sealed");
    if (sealed.length > MAX_SEALED_BATCH) return c.json({ error: "batch too large" }, 413);
    return c.json(await d.matches.enqueue(matchId, account, sealed));
  });
}
