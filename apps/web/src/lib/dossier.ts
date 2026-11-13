// Reads a player's Dossier (the contract's soulbound NEP-171 token) over NEAR RPC: the record from
// `get_dossier`, the facts of each match it lists from `get_match`, and each token's decimals.
// View calls only; nothing is signed. `rootOnNear` asks the contract's `get_roots` whether an
// entry's root is one the match anchored.

import type { DossierEntry, DossierView } from "@tail/brand";
import { RPC, type TokenMeta } from "../verify/chain.ts";

export interface EntryFacts {
  token: string;
  endMs: number | null;
  publicReplay: boolean;
}

export type DossierRead =
  | {
      kind: "found";
      view: DossierView;
      /** By match id; missing when NEAR did not return the match. */
      matches: Record<string, EntryFacts>;
      /** By token account. */
      tokens: Record<string, TokenMeta>;
    }
  | { kind: "absent" }
  /** The contract has no `get_dossier` (deployed before dossiers). */
  | { kind: "no-view" }
  | { kind: "unreachable"; reason: string };

export type RootAnswer = "held" | "not-held" | "unreachable";

/** near-api-js reports a missing view as "Contract method is not found" (ContractMethodNotFoundError). */
const noSuchMethod = (e: unknown) =>
  /MethodNotFound|MethodResolveError|method is not found/i.test(
    `${e instanceof Error ? `${e.name} ${e.constructor.name} ${e.message}` : String(e)}`,
  );

function viewer(network: string) {
  const provider = import("near-api-js").then(
    ({ JsonRpcProvider }) => new JsonRpcProvider({ url: RPC[network] ?? (RPC["testnet"] as string) }),
  );
  return async <T>(contractId: string, method: string, args: Record<string, unknown>) =>
    (await provider).callFunction({ contractId, method, args, blockQuery: { finality: "final" } }) as Promise<
      T | undefined
    >;
}

export async function readDossier(network: string, contract: string, account: string): Promise<DossierRead> {
  const view = viewer(network);
  let dossier: DossierView | null | undefined;
  try {
    dossier = await view<DossierView | null>(contract, "get_dossier", { account_id: account });
  } catch (e) {
    if (noSuchMethod(e)) return { kind: "no-view" };
    // An id NEAR cannot parse is an account that has no dossier.
    if (/account|AccountId/i.test(String(e)) && /invalid|parse/i.test(String(e))) return { kind: "absent" };
    return { kind: "unreachable", reason: e instanceof Error ? e.message : String(e) };
  }
  if (!dossier) return { kind: "absent" };
  const matches: Record<string, EntryFacts> = {};
  await Promise.all(
    dossier.entries.map(async (e) => {
      const m = await view<{ token: string; end_ms: number | null; public_replay: boolean } | null>(
        contract,
        "get_match",
        { match_id: e.match_id },
      ).catch(() => null);
      if (m) matches[e.match_id] = { token: m.token, endMs: m.end_ms, publicReplay: m.public_replay };
    }),
  );
  const tokens: Record<string, TokenMeta> = {};
  await Promise.all(
    [...new Set(Object.values(matches).map((m) => m.token))].map(async (t) => {
      const meta = await view<{ symbol: string; decimals: number }>(t, "ft_metadata", {}).catch(() => null);
      if (meta && typeof meta.decimals === "number")
        tokens[t] = { symbol: meta.symbol, decimals: meta.decimals };
    }),
  );
  return { kind: "found", view: dossier, matches, tokens };
}

/** Whether `get_roots(match_id)` lists the entry's root at its log size (a checkpoint or End). */
export async function rootOnNear(network: string, contract: string, e: DossierEntry): Promise<RootAnswer> {
  try {
    const roots = await viewer(network)<{
      checkpoints: { log_size: number; root: string }[];
      final_root: { log_size: number; root: string } | null;
    } | null>(contract, "get_roots", { match_id: e.match_id });
    if (!roots) return "not-held";
    const all = [...roots.checkpoints, ...(roots.final_root ? [roots.final_root] : [])];
    return all.some((r) => String(r.log_size) === e.log_size && r.root === e.root) ? "held" : "not-held";
  } catch {
    return "unreachable";
  }
}
