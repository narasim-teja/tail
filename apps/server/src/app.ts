// Wires the relay together from its parts. main.ts passes the real chain and referee; tests pass
// fakes behind the same interfaces (near.ts `Chain`, referee.ts `Referee`).

import { verifyAttestation as appleVerify, type Environment } from "@tail/appattest";
import type { Logger } from "@tail/log";
import { toHex } from "@tail/protocol";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { CarryKeys } from "./carry.ts";
import { ChainView } from "./chainview.ts";
import type { Store } from "./db.ts";
import { Enrolment, type VerifyAttestation } from "./enroll.ts";
import { HttpError } from "./errors.ts";
import { GhostFiller } from "./ghosts/fill.ts";
import { HudHub } from "./hub.ts";
import { Buckets, Clients, type EnrolCaps, RATES } from "./limits.ts";
import { Matches } from "./matches.ts";
import type { Chain } from "./near.ts";
import { type Referee, RefereeError, type RefereeHealth, RefereeUnavailableError } from "./referee.ts";
import { DEFAULT_RETENTION_HOURS, Retention } from "./retention.ts";
import { batchRoutes } from "./routes/batch.ts";
import { carryRoutes } from "./routes/carry.ts";
import { ghostRoutes, topupRoutes } from "./routes/dev.ts";
import { enrollRoutes } from "./routes/enroll.ts";
import { hudRoutes } from "./routes/hud.ts";
import { matchRoutes } from "./routes/matches.ts";
import { proofRoutes } from "./routes/proofs.ts";
import { type ReplayMeta, replayRoutes } from "./routes/replay.ts";
import { RequestAuth } from "./routes/util.ts";

export interface RelayDeps {
  store: Store;
  chain: Chain;
  referee: Referee;
  log: Logger;
  parentAccount: string;
  appId: string;
  environment: Environment;
  token: string;
  /** The caller the referee's VRF alpha names (config.ts `vrfSender`); every lobby must pin it. */
  vrfSender: string;
  /**
   * What the replay bundle names: contract, network, referee project and API. `contract` is also
   * what every signed request names (auth.ts), and what GET /health tells the phone.
   */
  replay: ReplayMeta;
  /** The relay's mesh carry keys (carry.ts): box key for envelopes, ed25519 key for receipts. */
  carryKeys: CarryKeys;
  /** NEAR_NETWORK=testnet: mounts POST /dev/topup. */
  testnet: boolean;
  /**
   * NEAR_NETWORK=testnet and ALLOW_GHOSTS=1 (config.ts): mounts POST /dev/ghosts/fill, and
   * /health says `test_players: true`. Ghosts enrol in-process only; no route enrols one.
   */
  allowGhosts: boolean;
  /** How long after End a private match's trails are kept (RELAY_RETENTION_HOURS). */
  retentionMs?: number;
  /** How long the public match views may be stale (chainview.ts); tests shorten it. */
  chainViewMs?: number;
  verifyAttestation?: VerifyAttestation;
  /** Whether the referee is answering (referee.ts GuardedReferee); /health reports it. */
  refereeHealth?: () => RefereeHealth;
  /**
   * The header a trusted reverse proxy sets to the client's address (RELAY_CLIENT_IP_HEADER);
   * unset, the TCP peer is the client (limits.ts).
   */
  clientIpHeader?: string | undefined;
  /** Caps on new phone enrolments (RELAY_ENROLS_PER_DAY, RELAY_ENROLS_PER_IP_PER_DAY). */
  enrolCaps?: EnrolCaps;
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
    ...(d.enrolCaps ? { caps: d.enrolCaps } : {}),
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
    pins: async () => {
      const k = await enrolment.refereeKeys();
      return { refereePk: toHex(k.refereePk), vrfPk: toHex(k.vrfPk), vrfSender: d.vrfSender };
    },
    ...(d.now ? { now: d.now } : {}),
    ...(d.tickMs !== undefined ? { tickMs: d.tickMs } : {}),
  });
  const { upgradeWebSocket, websocket } = createBunWebSocket();
  const now = d.now ?? Date.now;
  // Request freshness is wall-clock time, like the phone's signature on it, not the loop's clock.
  const auth = new RequestAuth(d.store, d.replay.contract);
  const view = new ChainView(d.chain, now, d.chainViewMs);
  const clients = new Clients(d.clientIpHeader);
  const retention = new Retention({
    store: d.store,
    chain: d.chain,
    log: d.log,
    windowMs: d.retentionMs ?? DEFAULT_RETENTION_HOURS * 3_600_000,
    now,
  });

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
    if (e instanceof HttpError) return c.json({ ...e.extra, error: e.message }, e.status);
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
  // `test_players` tells the app whether to offer "Add a test player" (POST /dev/ghosts/fill).
  app.get("/health", (c) => {
    const r = d.refereeHealth?.();
    return c.json({
      ok: true,
      // The contract this relay plays on, which every signed request names. Phones keep their own
      // setting as the trust anchor and only use this to notice a mismatch (and offer to
      // switch), never to adopt it silently.
      contract: d.replay.contract,
      test_players: d.allowGhosts,
      ...(r
        ? { referee: { kind: r.kind, status: r.status, last_ok_ms: r.lastOkMs, last_error: r.lastError } }
        : {}),
    });
  });
  // The referee's public keys. Phones seal batches to referee_box_pk after checking box_pk_sig
  // against the referee_pk the contract pins (get_config), so the relay cannot swap the box key.
  // vrf_pk is hex, as the referee, the contract and the replay write it.
  app.get("/referee", async (c) => {
    const k = await enrolment.refereeKeys();
    return c.json({
      referee_pk: Buffer.from(k.refereePk).toString("base64"),
      referee_box_pk: Buffer.from(k.refereeBoxPk).toString("base64"),
      box_pk_sig: Buffer.from(k.boxPkSig).toString("base64"),
      vrf_pk: toHex(k.vrfPk),
    });
  });
  enrollRoutes(app, {
    enrolment,
    auth,
    clients,
    challenges: new Buckets(RATES.enrolChallenge, now),
  });
  matchRoutes(app, { store: d.store, auth, chain: d.chain, view, matches });
  proofRoutes(app, { store: d.store });
  batchRoutes(app, { store: d.store, auth, matches });
  carryRoutes(app, { store: d.store, auth, keys: d.carryKeys, clients, now });
  hudRoutes(app, {
    store: d.store,
    hub,
    upgradeWebSocket,
    clients,
    sockets: new Buckets(RATES.hudSocket, now),
  });
  replayRoutes(app, {
    store: d.store,
    view,
    meta: d.replay,
    clients,
    challenges: new Buckets(RATES.replayChallenge, now),
  });
  if (d.testnet) topupRoutes(app, { store: d.store, auth, chain: d.chain, now });
  if (d.allowGhosts) {
    const filler = new GhostFiller({
      store: d.store,
      chain: d.chain,
      enrolment,
      log: d.log,
      token: d.token,
      ...(d.now ? { now: d.now } : {}),
    });
    ghostRoutes(app, { auth, filler });
  }

  return { app, websocket, matches, enrolment, hub, retention };
}
