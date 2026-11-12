// Reads the contract over NEAR RPC (near-api-js, view calls only; nothing is signed). Returns a
// ChainState for anchor.ts: found, absent (the contract has no such match) or unreachable.

import type { ChainMatch, ChainRoots, ChainState } from "./anchor.ts";

const RPC: Record<string, string> = {
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

export interface ChainReader {
  read(contract: string, matchId: string): Promise<ChainState>;
  token(token: string): Promise<TokenMeta | null>;
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
        return { kind: "found", match, roots };
      } catch (e) {
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
