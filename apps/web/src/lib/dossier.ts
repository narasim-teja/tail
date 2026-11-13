// Reads a player's Dossier (the contract's soulbound NEP-171 token) over NEAR RPC: the record from
// `get_dossier` and the token itself from `nft_token`, both at one final block so they describe
// the same record, the facts of each match it lists from `get_match`, and each token's decimals.
// View calls only; nothing is signed. The token's card (`metadata.media`) is compared byte for
// byte with the one `@tail/brand` draws from the record here (compareCard). `rootOnNear` asks the
// contract's `get_roots` whether an entry's root is one the match anchored.

import { type DossierEntry, type DossierView, dossierSvg } from "@tail/brand";
import { equal, utf8 } from "@tail/protocol";
import { fromB64 } from "../verify/bundle.ts";
import { RPC, type TokenMeta } from "../verify/chain.ts";

export interface EntryFacts {
  token: string;
  endMs: number | null;
  publicReplay: boolean;
}

/**
 * The contract's own card against the one drawn here from the same record.
 * same: `nft_token`'s media is that SVG, byte for byte; `media` is the contract's data URI.
 * differs: it isn't, or the token has no SVG media (`media` null), or there is no token.
 * unread: `nft_token` couldn't be read, so only the card drawn here is shown.
 */
export type CardCheck =
  | { kind: "same"; media: string }
  | { kind: "differs"; media: string | null }
  | { kind: "unread" };

/** The contract writes the card as `data:image/svg+xml;base64,` (contracts/tail dossier.rs). */
const SVG_URI = "data:image/svg+xml;base64,";

export function compareCard(token: unknown, view: DossierView): CardCheck {
  const metadata = (token as { metadata?: { media?: unknown } } | null)?.metadata;
  const media = typeof metadata?.media === "string" ? metadata.media : null;
  if (!media?.startsWith(SVG_URI)) return { kind: "differs", media: null };
  let bytes: Uint8Array;
  try {
    bytes = fromB64(media.slice(SVG_URI.length));
  } catch {
    return { kind: "differs", media: null };
  }
  return equal(bytes, utf8(dossierSvg(view))) ? { kind: "same", media } : { kind: "differs", media };
}

export type DossierRead =
  | {
      kind: "found";
      view: DossierView;
      card: CardCheck;
      /** By match id; missing when NEAR did not return the match. */
      matches: Record<string, EntryFacts>;
      /** By token account. */
      tokens: Record<string, TokenMeta>;
    }
  | { kind: "absent" }
  /** The contract has no `get_dossier` (deployed before dossiers). */
  | { kind: "no-view" }
  | { kind: "unreachable"; reason: string };

/** no-checkpoint: the match was called off before its first checkpoint, so it anchored no root. */
export type RootAnswer = "held" | "not-held" | "unreachable" | "no-checkpoint";

/**
 * An entry for a match aborted before its first checkpoint carries log_size 0 and the empty log's
 * root (SHA-256 of nothing): no root was ever anchored, so get_roots rightly lists none.
 */
export const beforeAnyCheckpoint = (e: DossierEntry) => e.log_size === "0";

/** near-api-js reports a missing view as "Contract method is not found" (ContractMethodNotFoundError). */
const noSuchMethod = (e: unknown) =>
  /MethodNotFound|MethodResolveError|method is not found/i.test(
    `${e instanceof Error ? `${e.name} ${e.constructor.name} ${e.message}` : String(e)}`,
  );

function viewer(network: string) {
  const provider = import("near-api-js").then(
    ({ JsonRpcProvider }) => new JsonRpcProvider({ url: RPC[network] ?? (RPC["testnet"] as string) }),
  );
  const call = async <T>(
    contractId: string,
    method: string,
    args: Record<string, unknown>,
    blockQuery: { finality: "final" } | { blockId: number } = { finality: "final" },
  ) => (await provider).callFunction({ contractId, method, args, blockQuery }) as Promise<T | undefined>;
  /** The latest final block's height, to read several views of one state. */
  const finalHeight = async () => (await (await provider).viewBlock({ finality: "final" })).header.height;
  return Object.assign(call, { finalHeight });
}

export async function readDossier(network: string, contract: string, account: string): Promise<DossierRead> {
  const view = viewer(network);
  let dossier: DossierView | null | undefined;
  let at: { blockId: number };
  try {
    at = { blockId: await view.finalHeight() };
    dossier = await view<DossierView | null>(contract, "get_dossier", { account_id: account }, at);
  } catch (e) {
    if (noSuchMethod(e)) return { kind: "no-view" };
    // An id NEAR cannot parse is an account that has no dossier.
    if (/account|AccountId/i.test(String(e)) && /invalid|parse/i.test(String(e))) return { kind: "absent" };
    return { kind: "unreachable", reason: e instanceof Error ? e.message : String(e) };
  }
  if (!dossier) return { kind: "absent" };
  const record = dossier;
  const card = await view<unknown>(contract, "nft_token", { token_id: account }, at).then(
    (t): CardCheck => compareCard(t, record),
    (): CardCheck => ({ kind: "unread" }),
  );
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
  return { kind: "found", view: dossier, card, matches, tokens };
}

/** Whether `get_roots(match_id)` lists the entry's root at its log size (a checkpoint or End). */
export async function rootOnNear(network: string, contract: string, e: DossierEntry): Promise<RootAnswer> {
  if (beforeAnyCheckpoint(e)) return "no-checkpoint";
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
