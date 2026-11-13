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
//
// A version 2 bundle also carries what a verifier needs to re-run the referee's App Attest
// checks and refusals (crates/referee-verify): each device's App Attest key as the referee
// enrolled it, each batch's assertion, the refused batches, and the App ID. Keys and assertions
// are public-key material (a public key and signatures under it), not secrets; like the trails,
// they are released only through this route, after End, to whoever may see the replay.

import {
  decodeLogEntry,
  type ReplayBundle,
  type ReplayBundleV2,
  type ReplayDevice,
  toHex,
} from "@tail/protocol";
import type { Hono } from "hono";
import { replayDigest, verifyEd25519 } from "../auth.ts";
import type { ChainView } from "../chainview.ts";
import type { MatchRow, Store } from "../db.ts";
import { HttpError } from "../errors.ts";
import type { Buckets, Clients } from "../limits.ts";
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

export function replayRoutes(
  app: Hono,
  d: { store: Store; view: ChainView; meta: ReplayMeta; clients: Clients; challenges: Buckets },
) {
  app.post("/replay/:id/challenge", async (c) => {
    const id = field.matchId(c.req.param("id"));
    d.challenges.takeOrRefuse(d.clients.ip(c), "replay requests");
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
    if (m.purged_ms !== null || !m.zone)
      throw new HttpError(410, "this match's trails were deleted after it ended");
    // Whether the replay is public is the relay's own record (the host chose it at create, and the
    // chain holds the same); only a match from before the relay kept it asks the chain first.
    // Anything else is read from the chain only once the caller may see the replay.
    const isPublic =
      m.public_replay === null ? (await d.view.getMatch(id))?.public_replay : m.public_replay === 1;
    if (isPublic === undefined) throw new HttpError(404, "match is not on chain");
    if (!isPublic) {
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
    const chain = await d.view.getMatch(id);
    if (!chain) throw new HttpError(404, "match is not on chain");
    const zone = m.zone;

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
        zone: zone.zone,
        safehouses: zone.safehouses,
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
 * so it is left out. Trails stored before assertions were kept give a bundle without
 * `assertions` and `rejected`.
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
  const rows = store.trailRows(m.match_id);
  const trails = rows.filter((t) => !t.rejected);
  const asserted = trails.every((t) => t.assertion !== null);
  const keys = enrolledKeys(m.reveal);
  return {
    version: 2,
    ...common,
    match: m.app_id === null ? common.match : { ...common.match, appId: m.app_id },
    batches: trails.map((t) => b64(t.batch)),
    ...(asserted
      ? {
          assertions: trails.map((t) => b64(t.assertion as Uint8Array)),
          rejected: rows.flatMap((t) =>
            t.rejected && t.assertion ? [{ batch: b64(t.batch), assertion: b64(t.assertion) }] : [],
          ),
        }
      : {}),
    reveal: { ...common.reveal, kM: String(m.reveal?.["k_m"] ?? "") },
    leaves: store.leaves(m.match_id).map(toHex),
    devices: common.devices.map((dev) => {
      const pk = keys.get(dev.accountId);
      return pk ? { ...dev, appAttestPk: pk } : dev;
    }),
    handler,
  };
}

/** Each player's App Attest key (hex) from the referee's declassify answer, by account. */
function enrolledKeys(reveal: Record<string, unknown> | null): Map<string, string> {
  const keys = new Map<string, string>();
  const players = reveal?.["players"];
  if (!Array.isArray(players)) return keys;
  for (const p of players as unknown[]) {
    if (typeof p !== "object" || p === null) continue;
    const pk =
      "app_attest_pk" in p && typeof p.app_attest_pk === "string"
        ? Buffer.from(p.app_attest_pk, "base64")
        : null;
    if ("account_id" in p && typeof p.account_id === "string" && pk?.length === 65)
      keys.set(p.account_id, toHex(pk));
  }
  return keys;
}
