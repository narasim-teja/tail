import type { Hono } from "hono";
import { parseCode, showCode } from "../codes.ts";
import type { Store } from "../db.ts";
import { HttpError } from "../errors.ts";
import type { Matches } from "../matches.ts";
import type { Chain } from "../near.ts";
import type { Circle } from "../referee.ts";
import { field, signedBody } from "./util.ts";

type Obj = Record<string, unknown>;

function circle(o: Obj, what: string): Circle {
  return {
    latE7: field.int(o, "lat_e7", -900_000_000, 900_000_000),
    lonE7: field.int(o, "lon_e7", -1_800_000_000, 1_800_000_000),
    radiusM: field.int(o, "radius_m", what === "zone" ? 50 : 5, 20_000),
  };
}

export function matchRoutes(app: Hono, d: { store: Store; chain: Chain; matches: Matches }) {
  // Signed by the host. {stake, duration_ms, zone, safehouses?, public_replay, min_players,
  // max_players, start_by_ms} → {match_id, zone_hash, code}
  app.post("/matches", async (c) => {
    const { account, body: b } = await signedBody(c, d.store);
    const now = Date.now();
    const zone = circle(field.obj(b, "zone"), "zone");
    const safehouses = field
      .list(b, "safehouses", 4)
      .map((s, i) => circle(typeof s === "object" && s !== null ? (s as Obj) : {}, `safehouses[${i}]`));
    const minPlayers = field.int(b, "min_players", 3, 12);
    const r = await d.matches.create(account, {
      stake: field.amount(b, "stake"),
      durationMs: field.int(b, "duration_ms", 60_000, 3_600_000),
      zone,
      safehouses,
      publicReplay: field.bool(b, "public_replay"),
      minPlayers,
      maxPlayers: field.int(b, "max_players", minPlayers, 12),
      startByMs: field.int(b, "start_by_ms", now + 60_000, now + 7 * 24 * 3_600_000),
      invites: field.list(b, "invites", 12).map((x, i) => {
        if (typeof x !== "string" || !x.endsWith(".testnet"))
          throw new HttpError(400, `invites[${i}]: an account id`);
        return x;
      }),
    });
    return c.json({ match_id: r.matchId, zone_hash: r.zoneHash, code: showCode(r.code) });
  });

  // Public: lobby and progress, and each player's PlayerKeys sealed to their own box key.
  app.get("/matches/:id", async (c) => {
    const id = field.matchId(c.req.param("id"));
    const m = d.store.match(id);
    if (!m) throw new HttpError(404, "no such match");
    const chain = await d.chain.getMatch(id);
    return c.json({
      match_id: id,
      code: m.code === null ? null : showCode(m.code),
      host: m.host,
      phase: m.phase,
      error: m.error,
      start_ms: m.start_ms,
      end_ms: m.end_ms,
      tick_no: m.tick_no,
      last_seq: m.last_seq,
      players: m.players,
      keys: m.keys ?? [],
      // The zone and safehouses the host chose. The chain holds only their hash; phones draw
      // them only after checking SHA256("tail/zone/v1" ‖ …) equals the chain's zone_hash.
      zone: m.zone,
      chain,
    });
  });

  // Public: a lobby code (any case, dash optional) → {match_id}. Only an open lobby resolves:
  // once the match has started here or been called off on chain, the code is spent, so a code
  // read off an old screenshot cannot send anyone into a match they can no longer join.
  app.get("/join/:code", async (c) => {
    const code = parseCode(c.req.param("code"));
    if (!code) throw new HttpError(400, "code: six characters, like K7M-4QX");
    const id = d.store.lobbyByCode(code);
    const chain = id ? await d.chain.getMatch(id) : null;
    if (!id || chain?.phase !== "lobby") throw new HttpError(404, "no open match with that code");
    return c.json({ match_id: id });
  });

  // Signed by the host. → {players, keys: [{player, account_id, sealed}], start_ms, end_ms}
  app.post("/matches/:id/start", async (c) => {
    const id = field.matchId(c.req.param("id"));
    const { account } = await signedBody(c, d.store);
    const r = await d.matches.start(id, account);
    return c.json({ players: r.players, keys: r.keys, start_ms: r.startMs, end_ms: r.endMs });
  });
}
