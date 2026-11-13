// Reads the contract over NEAR RPC (near-api-js, view calls only; nothing is signed). Returns a
// ChainState for anchor.ts: found, absent (the contract has no such match) or unreachable. Also
// runs the contract's own `verify_inclusion` view for a log entry, so a viewer can have NEAR,
// not this page, check a Merkle path.

import type { ChainHead, ChainMatch, ChainRoots, ChainState } from "./anchor.ts";
import { hexOrB64 } from "./bundle.ts";

export const RPC: Record<string, string> = {
  testnet: import.meta.env.VITE_NEAR_RPC_TESTNET || "https://test.rpc.fastnear.com",
  mainnet: import.meta.env.VITE_NEAR_RPC_MAINNET || "https://free.rpc.fastnear.com",
};

export function explorerTx(network: string, hash: string) {
  return network === "mainnet"
    ? `https://nearblocks.io/txns/${hash}`
    : `https://testnet.nearblocks.io/txns/${hash}`;
}

export interface TokenMeta {
  symbol: string;
  decimals: number;
}

/** What the contract's `verify_inclusion` view answered. */
export type InclusionAnswer =
  | { kind: "answered"; included: boolean }
  /** The contract has no such view (deployed before protocol v2). */
  | { kind: "no-view" }
  | { kind: "unreachable"; reason: string };

/** Arguments of `verify_inclusion(match_id, entry, index, size, path)`, bytes in base64. */
export interface InclusionArgs {
  matchId: string;
  entry: string;
  index: number;
  size: number;
  path: string[];
}

export interface ChainReader {
  read(contract: string, matchId: string): Promise<ChainState>;
  token(token: string): Promise<TokenMeta | null>;
  verifyInclusion(contract: string, args: InclusionArgs): Promise<InclusionAnswer>;
}

/** A view the contract doesn't export fails with a MethodNotFound execution error. */
const noSuchMethod = (e: unknown) =>
  /MethodNotFound|MethodResolveError/i.test(e instanceof Error ? e.message : String(e));

/**
 * The head as `get_verdict_head` returns it: a hex (or base64) digest, or an object carrying it
 * with the seq; null when the match has no verdicts. Anything else is unreadable.
 */
export function parseHead(raw: unknown): ChainHead {
  if (raw === null || raw === undefined) return { kind: "none" };
  const obj = typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const text = typeof raw === "string" ? raw : (obj?.["digest"] ?? obj?.["head"] ?? obj?.["prev"]);
  const seq = obj && typeof obj["seq"] === "number" ? obj["seq"] : null;
  try {
    const digest = typeof text === "string" ? hexOrB64(text) : null;
    if (digest?.length === 32) return { kind: "found", digest, seq };
  } catch {
    // fall through
  }
  return { kind: "unreadable", reason: "the head isn't a 32-byte digest" };
}

export function nearReader(network: string): ChainReader {
  // Loaded on first use, so the film can start before the RPC client is parsed.
  const provider = import("near-api-js").then(
    ({ JsonRpcProvider }) => new JsonRpcProvider({ url: RPC[network] ?? (RPC["testnet"] as string) }),
  );
  const view = async <T>(contractId: string, method: string, args: Record<string, unknown>) =>
    (await provider).callFunction({ contractId, method, args, blockQuery: { finality: "final" } }) as Promise<
      T | undefined
    >;
  return {
    async read(contract, matchId) {
      try {
        const [match, roots] = await Promise.all([
          view<ChainMatch | null>(contract, "get_match", { match_id: matchId }),
          view<ChainRoots | null>(contract, "get_roots", { match_id: matchId }),
        ]);
        if (!match || !roots) return { kind: "absent" };
        // Its own call: a contract deployed before the view still answers everything else.
        const head = await view<unknown>(contract, "get_verdict_head", { match_id: matchId }).then(
          parseHead,
          (e): ChainHead =>
            noSuchMethod(e)
              ? { kind: "no-view" }
              : { kind: "unreadable", reason: e instanceof Error ? e.message : String(e) },
        );
        return { kind: "found", match, roots, head };
      } catch (e) {
        return { kind: "unreachable", reason: e instanceof Error ? e.message : String(e) };
      }
    },
    async verifyInclusion(contract, a) {
      try {
        const included = await view<boolean>(contract, "verify_inclusion", {
          match_id: a.matchId,
          entry: a.entry,
          index: String(a.index),
          size: String(a.size),
          path: a.path,
        });
        return { kind: "answered", included: included === true };
      } catch (e) {
        if (noSuchMethod(e)) return { kind: "no-view" };
        return { kind: "unreachable", reason: e instanceof Error ? e.message : String(e) };
      }
    },
    async token(token) {
      try {
        const m = await view<{ symbol: string; decimals: number }>(token, "ft_metadata", {});
        return m && typeof m.decimals === "number" ? { symbol: m.symbol, decimals: m.decimals } : null;
      } catch {
        return null;
      }
    },
  };
}
