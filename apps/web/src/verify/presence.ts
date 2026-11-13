// Presence proofs: "the referee logged these two phones near each other", as a file anyone can check later.
//
// A proof is one Contact entry of a match log with its Merkle path to a root the contract
// anchored, and the two account ids. It holds when the path leads to NEAR's root of that size for
// that match and the accounts are the contract's players at the entry's indexes
// (verifyPresence in @tail/protocol). There is no new signature: it is as strong as the referee's
// signature on that root, which the contract checked when it stored it. The roots and the player
// list come from the pinned contract over NEAR RPC, never from the proof.
//
// JSON form (what "Make presence proof" produces and the presence page reads):
//   { "type": "tail/presence-proof", "matchId": hex, "contract": string,
//     "contact": { "a": u16, "b": u16, "epoch": u32, "salt": hex 16 }, "index": "u64", "size": "u64",
//     "path": [hex 32], "accounts": [string, string] }
// The page also reads the protocol's borsh PresenceProof, base64, and the phone's share
// (apps/mobile proximity/receipts.ts presenceJson):
//   { "kind": "tail/presence-proof/v1", "contract", "match_id": hex, "accounts": [a, b],
//     "epoch", "index", "size", "proof": base64 borsh PresenceProof, "check": how to verify }
// whose `proof` is the whole proof; the other fields only describe it, and a share whose
// description disagrees with the proof it carries is refused rather than shown as one claim
// while another is checked.

import {
  decodePresenceProof,
  fromHex,
  merkleProof,
  type PresenceProof,
  type PresenceResult,
  type AnchoredRoot as ProtocolRoot,
  toHex,
  verifyPresence,
} from "@tail/protocol";
import type { ChainState } from "./anchor.ts";
import { type DecodedBundle, fromB64 } from "./bundle.ts";
import type { AnchoredRoot } from "./history.ts";

export const PRESENCE_TYPE = "tail/presence-proof";
/** The `kind` of the phone's share. */
export const PHONE_PRESENCE_KIND = "tail/presence-proof/v1";

export interface PresenceJson {
  type: typeof PRESENCE_TYPE;
  matchId: string;
  contract: string;
  /** `salt` is the entry's own (hex): without it the leaf cannot be rebuilt. */
  contact: { a: number; b: number; epoch: number; salt: string };
  index: string;
  size: string;
  path: string[];
  accounts: [string, string];
}

export function toPresenceJson(p: PresenceProof): PresenceJson {
  if (p.entry.kind !== "Contact") throw new Error("a presence proof is for a Contact entry");
  return {
    type: PRESENCE_TYPE,
    matchId: toHex(p.matchId),
    contract: p.contract,
    contact: { a: p.entry.a, b: p.entry.b, epoch: p.entry.epoch, salt: toHex(p.entry.salt) },
    index: p.index.toString(),
    size: p.size.toString(),
    path: p.path.map(toHex),
    accounts: p.accounts,
  };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
const u = (x: unknown, max: number) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= max;
const u64 = (x: unknown) =>
  (typeof x === "string" && /^\d{1,20}$/.test(x)) ||
  (typeof x === "number" && Number.isSafeInteger(x) && x >= 0);

/**
 * Reads a proof from pasted text: the page's JSON form, the phone's share, or the borsh form in
 * base64. Throws on anything else.
 */
export function parsePresence(text: string): PresenceProof {
  const t = text.trim();
  if (!t.startsWith("{")) return decodePresenceProof(fromB64(t));
  const j: unknown = JSON.parse(t);
  if (isObj(j) && j["kind"] === PHONE_PRESENCE_KIND) return fromPhoneShare(j);
  if (!isObj(j) || j["type"] !== PRESENCE_TYPE) throw new Error("not a TAIL presence proof");
  const c = j["contact"];
  const acc = j["accounts"];
  const path = j["path"];
  if (
    typeof j["matchId"] !== "string" ||
    !/^[0-9a-f]{32}$/.test(j["matchId"]) ||
    typeof j["contract"] !== "string" ||
    !isObj(c) ||
    !u(c["a"], 0xffff) ||
    !u(c["b"], 0xffff) ||
    !u(c["epoch"], 0xffffffff) ||
    typeof c["salt"] !== "string" ||
    !/^[0-9a-f]{32}$/.test(c["salt"]) ||
    !u64(j["index"]) ||
    !u64(j["size"]) ||
    !Array.isArray(path) ||
    !path.every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) ||
    !Array.isArray(acc) ||
    acc.length !== 2 ||
    !acc.every((a) => typeof a === "string")
  )
    throw new Error("this presence proof is malformed");
  return {
    matchId: fromHex(j["matchId"]),
    contract: j["contract"],
    entry: {
      kind: "Contact",
      a: c["a"] as number,
      b: c["b"] as number,
      epoch: c["epoch"] as number,
      salt: fromHex(c["salt"] as string),
    },
    index: BigInt(j["index"] as string | number),
    size: BigInt(j["size"] as string | number),
    path: (path as string[]).map(fromHex),
    accounts: [acc[0] as string, acc[1] as string],
  };
}

function fromPhoneShare(j: Record<string, unknown>): PresenceProof {
  const raw = j["proof"];
  let p: PresenceProof;
  try {
    if (typeof raw !== "string") throw new Error("no proof");
    p = decodePresenceProof(fromB64(raw));
  } catch {
    throw new Error("its proof field isn't a presence proof");
  }
  const acc = j["accounts"];
  const agrees =
    j["contract"] === p.contract &&
    j["match_id"] === toHex(p.matchId) &&
    Array.isArray(acc) &&
    acc.length === 2 &&
    acc[0] === p.accounts[0] &&
    acc[1] === p.accounts[1] &&
    p.entry.kind === "Contact" &&
    j["epoch"] === p.entry.epoch &&
    j["index"] === Number(p.index) &&
    j["size"] === Number(p.size);
  if (!agrees) throw new Error("its fields don't match the proof it carries");
  return p;
}

/** For `/?presence=`: the JSON, base64url. */
export const presenceParam = (p: PresenceProof) =>
  btoa(JSON.stringify(toPresenceJson(p)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export function fromPresenceParam(s: string): string {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return atob(b + "=".repeat((4 - (b.length % 4)) % 4));
}

/**
 * The proof for the Contact entry at `index`, against the first anchored root that covers it,
 * with the path computed from the bundle's leaves. Null if the entry isn't a Contact or no root
 * covers it.
 */
export function presenceFor(
  d: DecodedBundle,
  index: number,
  roots: readonly AnchoredRoot[],
): PresenceProof | null {
  const entry = d.log[index]?.entry;
  const anchor = roots.find((r) => r.size > index && r.size <= d.leaves.length);
  if (entry?.kind !== "Contact" || !anchor) return null;
  const a = d.players[entry.a];
  const b = d.players[entry.b];
  if (a === undefined || b === undefined) return null;
  return {
    matchId: d.matchId,
    contract: d.raw.match.contract,
    entry,
    index: BigInt(index),
    size: BigInt(anchor.size),
    path: merkleProof(d.leaves.slice(0, anchor.size), index),
    accounts: [a, b],
  };
}

export type PresenceCheck =
  | PresenceResult
  /** The proof names another contract than the one this page is pinned to. */
  | { ok: false; why: "other-contract"; named: string }
  /** NEAR has no such match on the pinned contract. */
  | { ok: false; why: "no-match" }
  | { ok: false; why: "unreachable"; reason: string };

/**
 * Checks a proof against the pinned contract's state for its match: the anchored roots
 * (checkpoints and the final root) and the player list in index order.
 */
export function checkPresence(
  proof: PresenceProof,
  chain: ChainState,
  pinnedContract: string,
): PresenceCheck {
  if (proof.contract !== pinnedContract) return { ok: false, why: "other-contract", named: proof.contract };
  if (chain.kind === "absent") return { ok: false, why: "no-match" };
  if (chain.kind === "unreachable") return { ok: false, why: "unreachable", reason: chain.reason };
  if (chain.match.match_id !== toHex(proof.matchId)) return { ok: false, why: "no-match" };
  const all = [...chain.roots.checkpoints, ...(chain.roots.final_root ? [chain.roots.final_root] : [])];
  const roots: ProtocolRoot[] = all.flatMap((r) => {
    try {
      return [{ logSize: BigInt(r.log_size), root: fromHex(r.root) }];
    } catch {
      return [];
    }
  });
  return verifyPresence(
    proof,
    roots,
    chain.match.players.map((p) => p.account_id),
  );
}
