// Wires the relay together from its parts. main.ts passes the real chain and referee; tests pass
// fakes behind the same interfaces (near.ts `Chain`, referee.ts `Referee`).

import { verifyAttestation as appleVerify, type Environment } from "@tail/appattest";
import type { Logger } from "@tail/log";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { Store } from "./db.ts";
import { Enrolment, type VerifyAttestation } from "./enroll.ts";
import { HttpError } from "./errors.ts";
import { HudHub } from "./hub.ts";
import { Matches } from "./matches.ts";
import type { Chain } from "./near.ts";
import { type Referee, RefereeError, type RefereeHealth, RefereeUnavailableError } from "./referee.ts";
import { batchRoutes } from "./routes/batch.ts";
import { ghostRoutes, topupRoutes } from "./routes/dev.ts";
import { enrollRoutes } from "./routes/enroll.ts";
import { hudRoutes } from "./routes/hud.ts";
import { matchRoutes } from "./routes/matches.ts";
import { type ReplayMeta, replayRoutes } from "./routes/replay.ts";

export interface RelayDeps {
  store: Store;
  chain: Chain;
  referee: Referee;
  log: Logger;
  parentAccount: string;
  appId: string;
  environment: Environment;
  token: string;
  /** What the replay bundle names: contract, network, referee project and API. */
  replay: ReplayMeta;
  /** NEAR_NETWORK=testnet: mounts POST /dev/topup. */
  testnet: boolean;
  /** NEAR_NETWORK=testnet and ALLOW_GHOSTS=1 (config.ts): mounts POST /dev/ghosts/enroll. */
  allowGhosts: boolean;
  verifyAttestation?: VerifyAttestation;
  /** Whether the referee is answering (referee.ts GuardedReferee); /health reports it. */
  refereeHealth?: () => RefereeHealth;
  /** Background referee registration schedule (enroll.ts); tests pass []. */
  refereeRetryMs?: readonly number[];
  now?: () => number;
  tickMs?: number;
}

export function createRelay(d: RelayDeps) {
  if (d.allowGhosts && !d.testnet) throw new Error("ghosts are testnet only");
  const hub = new HudHub();
  const enrolment = new Enrolment({
    store: d.store,
    chain: d.chain,
    referee: d.referee,
    log: d.log,
    parentAccount: d.parentAccount,
    appId: d.appId,
    environment: d.environment,
    verifyAttestation: d.verifyAttestation ?? appleVerify,
    ...(d.refereeRetryMs ? { refereeRetryMs: d.refereeRetryMs } : {}),
    ...(d.now ? { now: d.now } : {}),
  });
  const matches = new Matches({
    store: d.store,
    chain: d.chain,
    referee: d.referee,
    hub,
    log: d.log,
    appId: d.appId,
    token: d.token,
    ensureWithReferee: (accounts) => enrolment.ensureWithReferee(accounts),
    ...(d.now ? { now: d.now } : {}),
    ...(d.tickMs !== undefined ? { tickMs: d.tickMs } : {}),
  });
  const { upgradeWebSocket, websocket } = createBunWebSocket();

  const app = new Hono();
  // One line per request: what was asked, how it ended, how long it took. The phone's errors
  // are short by design, so this is where a failure is read.
  app.use("*", async (c, next) => {
    const t0 = performance.now();
    await next();
    const line = {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - t0),
    };
    if (c.req.path === "/health") d.log.debug(line, "request");
    else d.log.info(line, "request");
  });
  app.onError((e, c) => {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    // Plain sentences: the phone shows these as they are.
    if (e instanceof RefereeUnavailableError) {
      return c.json({ error: "The referee isn't answering right now. Try again in a minute." }, 503);
    }
    if (e instanceof RefereeError) {
      d.log.error({ err: e.message }, "referee call failed");
      return c.json(
        { error: e.refused ? `The referee refused: ${e.message}` : "The referee didn't answer. Try again." },
        502,
      );
    }
    d.log.error({ err: e.message, path: c.req.path }, "request failed");
    return c.json({ error: "something went wrong on the relay" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));
  // The relay is up; `referee` says whether the referee behind it is answering, and which one.
  app.get("/health", (c) => {
    const r = d.refereeHealth?.();
    return c.json({
      ok: true,
      ...(r
        ? { referee: { kind: r.kind, status: r.status, last_ok_ms: r.lastOkMs, last_error: r.lastError } }
        : {}),
    });
  });
  // The referee's public keys. Phones seal batches to referee_box_pk after checking box_pk_sig
  // against the referee_pk the contract pins (get_config), so the relay cannot swap the box key.
  let pubkeys: Promise<Record<string, string>> | undefined;
  app.get("/referee", async (c) => {
    pubkeys ??= d.referee
      .pubkeys()
      .then((k) => ({
        referee_pk: Buffer.from(k.refereePk).toString("base64"),
        referee_box_pk: Buffer.from(k.refereeBoxPk).toString("base64"),
        box_pk_sig: Buffer.from(k.boxPkSig).toString("base64"),
        vrf_pk: Buffer.from(k.vrfPk).toString("base64"),
      }))
      .catch((e: unknown) => {
        pubkeys = undefined;
        throw e;
      });
    return c.json(await pubkeys);
  });
  enrollRoutes(app, enrolment);
  matchRoutes(app, { store: d.store, chain: d.chain, matches });
  batchRoutes(app, { store: d.store, matches });
  hudRoutes(app, { store: d.store, hub, upgradeWebSocket });
  replayRoutes(app, { store: d.store, chain: d.chain, meta: d.replay });
  if (d.testnet) topupRoutes(app, { store: d.store, chain: d.chain });
  if (d.allowGhosts) ghostRoutes(app, { enrolment });

  return { app, websocket, matches, enrolment, hub };
}
