// What the phone reads about a match from NEAR itself, through its own RPC, never through the
// relay: the referee key the match pinned (it checks every HUD, key and Handler line sealed to
// this phone), the players in index order, and the log roots the contract anchored (they check
// the relay's inclusion proofs). The relay's chain view is only for the lobby screens.

import { type AnchoredRoot, fromHex } from "@tail/protocol";
import type { NearRpc } from "./rpc";

export interface ChainFacts {
  /** ed25519 key copied into the match at create_match; a later rotation does not change it. */
  refereePk: Uint8Array;
  /** Account ids in player-index order (the contract keeps them sorted). */
  players: string[];
  phase: string;
}

export interface Roots {
  /** Every anchored (log_size, root): the checkpoints, then End's. */
  all: AnchoredRoot[];
  /** End's root, once the match has ended. */
  final: AnchoredRoot | null;
}

type Obj = Record<string, unknown>;

const hex32 = (v: unknown, what: string): Uint8Array => {
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v))
    throw new Error(`NEAR: ${what} is not 32 hex bytes`);
  return fromHex(v);
};

export function parseMatchFacts(v: unknown): ChainFacts | null {
  if (v === null || v === undefined) return null;
  const m = v as Obj;
  const players = m["players"];
  if (!Array.isArray(players)) throw new Error("NEAR: match has no player list");
  return {
    refereePk: hex32(m["referee_pk"], "referee_pk"),
    players: players.map((p) => {
      const id = (p as Obj)["account_id"];
      if (typeof id !== "string") throw new Error("NEAR: player without an account");
      return id;
    }),
    phase: String(m["phase"]),
  };
}

function parseRoot(v: unknown): AnchoredRoot {
  const r = v as Obj;
  const size = r["log_size"];
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)
    throw new Error("NEAR: log_size is not a size");
  return { logSize: BigInt(size), root: hex32(r["root"], "root") };
}

export function parseRoots(v: unknown): Roots {
  if (v === null || v === undefined) return { all: [], final: null };
  const o = v as Obj;
  const checkpoints = Array.isArray(o["checkpoints"]) ? o["checkpoints"].map(parseRoot) : [];
  const final = o["final_root"] === null || o["final_root"] === undefined ? null : parseRoot(o["final_root"]);
  return { all: final ? [...checkpoints, final] : checkpoints, final };
}

export const matchFacts = async (rpc: NearRpc, contract: string, matchId: string) =>
  parseMatchFacts(await rpc.view<unknown>(contract, "get_match", { match_id: matchId }));

export const anchoredRoots = async (rpc: NearRpc, contract: string, matchId: string) =>
  parseRoots(await rpc.view<unknown>(contract, "get_roots", { match_id: matchId }));
