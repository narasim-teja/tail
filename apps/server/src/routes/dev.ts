// Testnet-only conveniences. app.ts mounts these only when the config says NEAR_NETWORK=testnet
// (top-up) and additionally ALLOW_GHOSTS=1 (ghost enrolment, the testing door in the README).

import type { Hono } from "hono";
import type { Store } from "../db.ts";
import type { Enrolment } from "../enroll.ts";
import { HttpError } from "../errors.ts";
import type { Chain } from "../near.ts";
import { field, jsonBody, signedBody } from "./util.ts";

/** 100 USDC.e (6 decimals); enough for any test stake, small enough to bound a mistake. */
export const MAX_TOPUP = 100_000_000n;

export function topupRoutes(app: Hono, d: { store: Store; chain: Chain }) {
  // Signed by an enrolled account. {account_id, amount} → {account_id, balance}
  app.post("/dev/topup", async (c) => {
    const { body } = await signedBody(c, d.store);
    const target = field.str(body, "account_id", 64);
    const amount = field.amount(body, "amount");
    if (amount === 0n || amount > MAX_TOPUP) throw new HttpError(400, `amount: 1 to ${MAX_TOPUP}`);
    if (!d.store.device(target)) throw new HttpError(404, "account not enrolled here");
    await d.chain.topUp(target, amount);
    return c.json({ account_id: target, credited: amount.toString() });
  });
}

export function ghostRoutes(app: Hono, d: { enrolment: Enrolment }) {
  // {handle: "ghost-…", app_attest_pk (65 B), player_box_pk, near_pk} → Enrolled. No attestation.
  app.post("/dev/ghosts/enroll", async (c) => {
    const b = await jsonBody(c);
    return c.json(
      await d.enrolment.enrollGhost({
        handle: field.str(b, "handle", 64),
        appAttestPk: field.bytes(b, "app_attest_pk", 65),
        playerBoxPk: field.bytes(b, "player_box_pk", 32),
        nearPk: field.bytes(b, "near_pk", 32),
      }),
    );
  });
}
