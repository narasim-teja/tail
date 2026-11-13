import type { Hono } from "hono";
import type { Enrolment } from "../enroll.ts";
import type { Buckets, Clients } from "../limits.ts";
import { field, jsonBody, type RequestAuth } from "./util.ts";

type Obj = Record<string, unknown>;

/** rebind_sig is optional on enrolment and required on refresh; when present it is 64 bytes. */
const rebindSig = (b: Obj) => (b["rebind_sig"] === undefined ? undefined : field.bytes(b, "rebind_sig", 64));

export function enrollRoutes(
  app: Hono,
  d: { enrolment: Enrolment; auth: RequestAuth; clients: Clients; challenges: Buckets },
) {
  // {handle} → {challenge, account_id, expires_ms}
  app.post("/enroll/challenge", async (c) => {
    d.challenges.takeOrRefuse(d.clients.ip(c), "enrolment requests");
    const b = await jsonBody(c);
    return c.json(await d.enrolment.challenge(field.str(b, "handle", 64)));
  });

  // {challenge, key_id, attestation, player_box_pk, near_pk, rebind_sig?} → {account_id}, once the
  // referee holds the device and the account exists.
  app.post("/enroll", async (c) => {
    const b = await jsonBody(c);
    return c.json(
      await d.enrolment.enroll({
        challenge: field.bytes(b, "challenge", 32),
        keyId: field.bytes(b, "key_id", 32),
        attestation: field.bytes(b, "attestation"),
        playerBoxPk: field.bytes(b, "player_box_pk", 32),
        nearPk: field.bytes(b, "near_pk", 32),
        rebindSig: rebindSig(b),
        client: d.clients.ip(c),
      }),
    );
  });

  // Signed by the account. → {account_id, with_referee}: whether the referee the relay runs with
  // now holds this device; false means the phone should refresh.
  app.get("/enroll/status", async (c) => {
    const { account } = await d.auth.signed(c);
    return c.json(await d.enrolment.status(account));
  });

  // Signed by the account. {} → {challenge, account_id, expires_ms}
  app.post("/enroll/refresh/challenge", async (c) => {
    const { account } = await d.auth.signed(c);
    d.challenges.takeOrRefuse(d.clients.ip(c), "enrolment requests");
    return c.json(await d.enrolment.refreshChallenge(account));
  });

  // Signed by the account. {challenge, key_id, attestation, player_box_pk, rebind_sig} →
  // {account_id}, once the referee accepted the fresh attestation.
  app.post("/enroll/refresh", async (c) => {
    const { account, body: b } = await d.auth.signed(c);
    return c.json(
      await d.enrolment.refresh(account, {
        challenge: field.bytes(b, "challenge", 32),
        keyId: field.bytes(b, "key_id", 32),
        attestation: field.bytes(b, "attestation"),
        playerBoxPk: field.bytes(b, "player_box_pk", 32),
        rebindSig: field.bytes(b, "rebind_sig", 64),
      }),
    );
  });
}
