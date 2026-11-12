import type { Hono } from "hono";
import type { Enrolment } from "../enroll.ts";
import { field, jsonBody } from "./util.ts";

export function enrollRoutes(app: Hono, enrolment: Enrolment) {
  // {handle} → {challenge, account_id, expires_ms}
  app.post("/enroll/challenge", async (c) => {
    const b = await jsonBody(c);
    return c.json(await enrolment.challenge(field.str(b, "handle", 64)));
  });

  // {challenge, key_id, attestation, player_box_pk, near_pk} → Enrolled
  app.post("/enroll", async (c) => {
    const b = await jsonBody(c);
    return c.json(
      await enrolment.enroll({
        challenge: field.bytes(b, "challenge", 32),
        keyId: field.bytes(b, "key_id", 32),
        attestation: field.bytes(b, "attestation"),
        playerBoxPk: field.bytes(b, "player_box_pk", 32),
        nearPk: field.bytes(b, "near_pk", 32),
      }),
    );
  });
}
