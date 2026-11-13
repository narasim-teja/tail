// Testnet-only conveniences. app.ts mounts these only when the config says NEAR_NETWORK=testnet
// (top-up) and additionally ALLOW_GHOSTS=1 (test players, the testing door in the README).
// There is no HTTP route that enrols a ghost: ghosts enrol in-process (ghosts/fill.ts,
// scripts/ghost-match.ts), so no client can enrol a device without an attestation.

import type { Hono } from "hono";
import type { Store } from "../db.ts";
import { HttpError } from "../errors.ts";
import type { GhostFiller } from "../ghosts/fill.ts";
import type { Chain } from "../near.ts";
import { cappedTopUp, MAX_TOPUP } from "../topup.ts";
import { field, type RequestAuth } from "./util.ts";

export function topupRoutes(
  app: Hono,
  d: { store: Store; auth: RequestAuth; chain: Chain; now: () => number },
) {
  // Signed by an enrolled account. {account_id, amount} → {account_id, credited}
  app.post("/dev/topup", async (c) => {
    const { account, body } = await d.auth.signed(c);
    const target = field.str(body, "account_id", 64);
    const amount = field.amount(body, "amount");
    if (amount === 0n || amount > MAX_TOPUP) throw new HttpError(400, `amount: 1 to ${MAX_TOPUP}`);
    if (!d.store.device(target)) throw new HttpError(404, "account not enrolled here");
    await cappedTopUp(d, account, target, amount, d.now());
    return c.json({ account_id: target, credited: amount.toString() });
  });
}

export function ghostRoutes(app: Hono, d: { auth: RequestAuth; filler: GhostFiller }) {
  // Signed by the lobby's host. {match_id} → {account_id} of the test player now in the lobby.
  app.post("/dev/ghosts/fill", async (c) => {
    const { account, body } = await d.auth.signed(c);
    return c.json(await d.filler.fill(field.matchId(field.str(body, "match_id", 32)), account));
  });
}
