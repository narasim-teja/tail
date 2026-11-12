// Compares a bundle with what the NEAR contract holds (`get_match`, `get_roots`) and decides,
// per verdict, whether NEAR vouches for it. Pure: the chain data is passed in.
//
// A verdict is anchored when the first root NEAR stored after its log entry equals the root of
// the bundle's log at that size (that root covers the verdict's digest), and the match NEAR
// knows uses the same referee key, VRF key and players. End is anchored by NEAR's final root and
// VRF reveal; Start also by its ring commit and times.

import { equal, fromHex, type SignedVerdict, toHex } from "@tail/protocol";
import type { DecodedBundle } from "./bundle.ts";
import type { LocalContext } from "./checks.ts";

export interface ChainPlayer {
  account_id: string;
  head: string;
  out: boolean;
  paid: string;
}

/** The parts of the contract's MatchView the replay reads. */
export interface ChainMatch {
  match_id: string;
  token: string;
  stake: string;
  phase: "lobby" | "running" | "ended" | "aborted";
  players: ChainPlayer[];
  sponsors: { account_id: string; amount: string }[];
  seq: number;
  referee_pk: string;
  vrf_pk: string;
  ring_commit: string | null;
  start_ms: number | null;
  end_ms: number | null;
  alpha: string | null;
  vrf_signature: string | null;
  public_replay: boolean;
}

export interface ChainRoots {
  checkpoints: { log_size: number; root: string }[];
  final_root: { log_size: number; root: string } | null;
}

export type ChainState =
  | { kind: "found"; match: ChainMatch; roots: ChainRoots }
  /** NEAR answered: no such match (a fixture, or the wrong network). */
  | { kind: "absent" }
  /** NEAR could not be reached; nothing was checked. */
  | { kind: "unreachable"; reason: string };

export type Anchor = "match" | "mismatch" | "absent" | "unknown";

export interface MatchLevel {
  /** Referee key, VRF key, players, token and stake agree with the contract. */
  identity: boolean;
  /** Expected payouts from replaying the verdicts equal what the contract paid. */
  payouts: boolean | null;
  ended: boolean;
}

export function matchLevel(
  d: DecodedBundle,
  chain: ChainMatch,
  verdicts: (SignedVerdict | null)[],
): MatchLevel {
  const identity =
    chain.referee_pk.toLowerCase() === toHex(d.refereePk) &&
    chain.vrf_pk.toLowerCase() === toHex(d.vrfPk) &&
    chain.players.length === d.players.length &&
    chain.players.every((p, i) => p.account_id === d.players[i]) &&
    chain.token === d.raw.match.token &&
    chain.stake === d.raw.match.stake;
  const ended = chain.phase === "ended";
  return { identity, ended, payouts: ended ? payoutsMatch(d, chain, verdicts) : null };
}

/** Replays heads like the contract's apply_one and settle_end, and compares with `paid`. */
export function expectedPayouts(d: DecodedBundle, verdicts: (SignedVerdict | null)[], pot: bigint): bigint[] {
  const heads = d.players.map(() => d.stake);
  const out = d.players.map(() => false);
  for (const v of verdicts) {
    const b = v?.body;
    if (!b) continue;
    if (b.kind === "Hint") {
      heads[b.from] = (heads[b.from] ?? 0n) - b.amount;
      heads[b.to] = (heads[b.to] ?? 0n) + b.amount;
    } else if (b.kind === "Tag" || b.kind === "Forfeit") {
      const [loser, winner] = b.kind === "Tag" ? [b.target, b.hunter] : [b.player, b.to];
      heads[winner] = (heads[winner] ?? 0n) + (heads[loser] ?? 0n);
      heads[loser] = 0n;
      out[loser] = true;
    }
  }
  const survivors = BigInt(out.filter((o) => !o).length);
  if (survivors === 0n) return heads;
  const share = pot / survivors;
  let extra = pot % survivors;
  return heads.map((h, i) => {
    if (out[i]) return h;
    let paid = h + share;
    if (extra > 0n) {
      paid += 1n;
      extra -= 1n;
    }
    return paid;
  });
}

function payoutsMatch(d: DecodedBundle, chain: ChainMatch, verdicts: (SignedVerdict | null)[]): boolean {
  const pot = chain.sponsors.reduce((s, x) => s + BigInt(x.amount), 0n);
  const want = expectedPayouts(d, verdicts, pot);
  return chain.players.every((p, i) => BigInt(p.paid) === want[i]);
}

/**
 * Anchors every verdict against the chain. `local[i]` is the verdict at bundle position i (or
 * null if undecodable) with its log index. Order of Checkpoint verdicts = order of NEAR's list.
 */
export function anchorVerdicts(
  d: DecodedBundle,
  ctx: LocalContext,
  local: { v: SignedVerdict | null; logIndex: number | null }[],
  state: ChainState,
): Anchor[] {
  if (state.kind === "absent") return local.map(() => "absent");
  if (state.kind === "unreachable") return local.map(() => "unknown");
  const { match, roots } = state;
  const level = matchLevel(
    d,
    match,
    local.map((l) => l.v),
  );
  if (!level.identity) return local.map(() => "mismatch");

  // Roots NEAR stored, in log order, each with whether the bundle's log agrees.
  const anchors: { size: number; ok: boolean }[] = [];
  let k = 0;
  for (const l of local) {
    const b = l.v?.body;
    if (b?.kind !== "Checkpoint") continue;
    const onChain = roots.checkpoints[k++];
    const size = Number(b.logSize);
    const mine = ctx.roots.get(size);
    anchors.push({
      size,
      ok: !!onChain && onChain.log_size === size && !!mine && equal(mine, safeHex(onChain.root)),
    });
  }
  const end = local.find((l) => l.v?.body.kind === "End")?.v ?? null;
  let endOk = false;
  if (end?.body.kind === "End" && roots.final_root) {
    const size = Number(end.body.logSize);
    const mine = ctx.roots.get(size);
    endOk =
      roots.final_root.log_size === size &&
      !!mine &&
      equal(mine, safeHex(roots.final_root.root)) &&
      equal(end.body.root, mine) &&
      match.alpha === end.body.alpha &&
      (match.vrf_signature ?? "").toLowerCase() === toHex(end.body.vrfSignature) &&
      match.seq === end.seq &&
      level.ended;
    anchors.push({ size, ok: endOk });
  }
  anchors.sort((a, b) => a.size - b.size);

  return local.map(({ v, logIndex }) => {
    if (!v) return "mismatch";
    if (v.seq > match.seq) return "mismatch";
    if (v.body.kind === "End") return endOk ? "match" : "mismatch";
    if (logIndex === null) return "mismatch";
    const cover = anchors.find((a) => a.size > logIndex);
    if (!cover) return "unknown";
    if (!cover.ok) return "mismatch";
    if (v.body.kind === "Start") {
      const b = v.body;
      const same =
        (match.ring_commit ?? "").toLowerCase() === toHex(b.ringCommit) &&
        match.start_ms === Number(b.startMs) &&
        match.end_ms === Number(b.endMs);
      return same ? "match" : "mismatch";
    }
    return "match";
  });
}

function safeHex(s: string): Uint8Array {
  try {
    return fromHex(s);
  } catch {
    return new Uint8Array(0);
  }
}
