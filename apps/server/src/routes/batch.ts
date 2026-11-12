import type { Hono } from "hono";
import type { Store } from "../db.ts";
import type { Matches } from "../matches.ts";
import { field, signedBody } from "./util.ts";

/** A batch is ~5 s of fixes and sightings; a few KB. Larger is not a phone's batch. */
export const MAX_SEALED_BATCH = 32 * 1024;

export function batchRoutes(app: Hono, d: { store: Store; matches: Matches }) {
  // Signed by the player. {match_id, sealed} → {queued, player}. `sealed` is
  // seal(referee_box_pk, borsh(BatchEnvelope), "tail/batch"); the relay cannot open it.
  // `queued: false` means these exact bytes are already waiting for the next tick (a retried
  // upload), which is success. Bytes the referee already saw are queued again, so a phone can
  // resend after the referee rejected a batch for a seq gap.
  app.post("/batch", async (c) => {
    const { account, body } = await signedBody(c, d.store);
    const matchId = field.matchId(typeof body["match_id"] === "string" ? body["match_id"] : undefined);
    const sealed = field.bytes(body, "sealed");
    if (sealed.length > MAX_SEALED_BATCH) return c.json({ error: "batch too large" }, 413);
    return c.json(d.matches.enqueue(matchId, account, sealed));
  });
}
