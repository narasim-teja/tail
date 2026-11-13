// GET /replay/:id serves the match as a `ReplayBundle` (@tail/protocol replay.ts): everything the
// replay app needs to re-verify it on its own. Only after the match ended: during play the log
// would reveal who met whom. A match without public_replay is served only to its players, who
// prove it like on the HUD socket: POST /replay/:id/challenge {account_id} → {nonce}, then
// GET /replay/:id?account_id=…&nonce=…&sig=… with sig = ed25519 by the NEAR key over
// replayDigest(nonce, match_id, account_id) (auth.ts). A nonce works once, for 2 minutes.
// A private match's trails are deleted a while after End (retention.ts); its replay then
// answers 410 rather than a bundle that silently lacks them.
//
// A match judged under protocol v2 is served as a version 2 bundle: the leaves the relay held
// during play, the log the referee declassified after End, and for each Handler line only the
// public message its model signature covers (the words were sealed to the asker). A match from
// before is served as the version 1 bundle it always was.

import {
  decodeLogEntry,
  type ReplayBundle,
  type ReplayBundleV2,
  type ReplayDevice,
  toHex,
} from "@tail/protocol";
import type { Hono } from "hono";
import { replayDigest, verifyEd25519 } from "../auth.ts";
import type { MatchRow, Store } from "../db.ts";
import { HttpError } from "../errors.ts";
import type { Chain } from "../near.ts";
import { field, jsonBody } from "./util.ts";

export const REPLAY_CHALLENGE_TTL_MS = 120_000;
/** Unanswered replay challenges kept, in all and per (match, account): asking is free. */
export const MAX_REPLAY_CHALLENGES = 1_000;
export const MAX_REPLAY_CHALLENGES_PER_PLAYER = 4;

export interface ReplayMeta {
  contract: string;
  network: "testnet";
  /** OutLayer project `owner/name`. */
  refereeProject: string;
  outlayerApi: string;
  /** Which referee judged: OutLayer's enclave, or the local test referee (REFEREE_MODE=local). */
  refereeKind: "outlayer" | "local";
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

export function replayRoutes(app: Hono, d: { store: Store; chain: Chain; meta: ReplayMeta }) {
  app.post("/replay/:id/challenge", async (c) => {
    const id = field.matchId(c.req.param("id"));
    const account = field.str(await jsonBody(c), "account_id", 64);
    if (!d.store.match(id)?.players?.includes(account))
      throw new HttpError(403, "not a player in this match");
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const now = Date.now();
    const stored = d.store.putReplayChallenge(nonce, id, account, now + REPLAY_CHALLENGE_TTL_MS, now, {
      total: MAX_REPLAY_CHALLENGES,
      perAccount: MAX_REPLAY_CHALLENGES_PER_PLAYER,
    });
    if (!stored) throw new HttpError(429, "too many replay requests waiting; try again in a minute");
    return c.json({ nonce: b64(nonce) });
  });

  app.get("/replay/:id", async (c) => {
    const id = field.matchId(c.req.param("id"));
    const m = d.store.match(id);
    if (!m) throw new HttpError(404, "no such match");
    if (
      m.phase !== "ended" ||
      !m.reveal ||
      !m.trails_done ||
      !m.players ||
      m.start_ms === null ||
      m.end_ms === null
    ) {
      throw new HttpError(409, "the replay opens when the match has ended");
    }
    if (m.purged_ms !== null) throw new HttpError(410, "this match's trails were deleted after it ended");
    const chain = await d.chain.getMatch(id);
    if (!chain) throw new HttpError(404, "match is not on chain");
    if (!chain.public_replay) {
      const account = c.req.query("account_id") ?? "";
      const nonce = new Uint8Array(Buffer.from(c.req.query("nonce") ?? "", "base64"));
      const sig = new Uint8Array(Buffer.from(c.req.query("sig") ?? "", "base64"));
      const ch = nonce.length === 32 ? d.store.takeReplayChallenge(nonce) : undefined;
      const device = d.store.device(account);
      if (
        !ch ||
        ch.match_id !== id ||
        ch.account_id !== account ||
        ch.expires_ms < Date.now() ||
        !device ||
        !m.players.includes(account) ||
        !verifyEd25519(
          device.near_pk,
          replayDigest(nonce, Uint8Array.from(Buffer.from(id, "hex")), account),
          sig,
        )
      ) {
        throw new HttpError(403, "this replay is for the match's players");
      }
    }

    const reveal = m.reveal;
    const ring = Array.isArray(reveal["ring"]) ? (reveal["ring"] as unknown[]).map(String) : [];
    const common = {
      match: {
        id,
        contract: d.meta.contract,
        network: d.meta.network,
        token: chain.token,
        stake: chain.stake,
        startMs: m.start_ms,
        endMs: m.end_ms,
        zone: m.zone.zone,
        safehouses: m.zone.safehouses,
        publicReplay: chain.public_replay,
        players: m.players,
      },
      referee: {
        project: d.meta.refereeProject,
        api: d.meta.outlayerApi,
        refereePk: chain.referee_pk,
        vrfPk: chain.vrf_pk,
        kind: d.meta.refereeKind,
      },
      verdicts: d.store.verdicts(id).map((v) => ({ signed: b64(v.raw), txHash: v.tx_hash })),
      log: d.store.log(id).map(b64),
      // Opened by the referee after End (declassify_batches); only batches the log holds.
      batches: d.store.trails(id).map(b64),
      reveal: {
        vrfAlpha: String(reveal["vrf_alpha"] ?? ""),
        vrfSignature: String(reveal["vrf_signature"] ?? ""),
        ring,
      },
      // Per player, in index order: what kind of device it was and whether the referee itself
      // checked its Apple attestation. The replay labels unattested players with it.
      devices: m.players.map((accountId): ReplayDevice => {
        const dev = d.store.device(accountId);
        return {
          accountId,
          kind: dev?.kind ?? null,
          attested: dev?.attested === null || dev?.attested === undefined ? null : dev.attested === 1,
        };
      }),
    };
    if (m.protocol === 2) return c.json(bundleV2(d.store, m, common));
    const bundle: ReplayBundle & { devices: ReplayDevice[] } = {
      version: 1,
      ...common,
      handler: d.store.voicedHints(id).map((h) => ({
        hintId: h.hint_id,
        text: h.text ?? "",
        chatId: h.chat_id ?? "",
        model: h.model ?? "",
      })),
    };
    return c.json(bundle);
  });
}

/**
 * Version 2: the leaves beside the declassified log, K_m (released with it, so the replay can
 * check every log salt), and each answered hint by its id, with the text NEAR AI signed. A line
 * whose receipt the referee did not log (it came too late) has nothing to be checked against,
 * so it is left out.
 */
function bundleV2(
  store: Store,
  m: MatchRow,
  common: Omit<ReplayBundleV2, "version" | "leaves" | "handler" | "reveal"> & {
    reveal: ReplayBundle["reveal"];
  },
): ReplayBundleV2 {
  const logged = new Set(
    store.log(m.match_id).flatMap((e) => {
      const entry = decodeLogEntry(e);
      return entry.kind === "HintReceipt" ? [entry.hintId] : [];
    }),
  );
  const handler: ReplayBundleV2["handler"] = store
    .voiceHints(m.match_id, "answered")
    .flatMap((h) =>
      h.hint_id !== null && logged.has(h.hint_id) ? [{ hintId: h.hint_id, signedText: h.signed_text }] : [],
    );
  return {
    version: 2,
    ...common,
    reveal: { ...common.reveal, kM: String(m.reveal?.["k_m"] ?? "") },
    leaves: store.leaves(m.match_id).map(toHex),
    handler,
  };
}
