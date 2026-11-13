// A fake chain that keeps the rules of the contract's `apply` (contracts/tail `apply_one`), for a
// test against the real referee: on top of FakeChain's verdict chain (seq order, `prev`, and a
// consistency proof for every Checkpoint/End checked with verifyConsistency against the root it
// last anchored), each verdict must carry the pinned referee's signature, and it moves heads the
// way the contract does: Start against the locked player list and block time, a Hint at exactly
// its kind's price, a Tag or Forfeit along the ring, Checkpoints spaced in match time, and End
// only with the VRF reveal that opens the Start's ring commit, then settled into balances.
// "Block time" is the clock the test runs the match on.

import { ed25519 } from "@noble/curves/ed25519.js";
import {
  buildRing,
  CHECKPOINT_MS,
  decodeSignedVerdict,
  equal,
  fromHex,
  type HintKind,
  hintPrice,
  playersHash,
  ringCommit,
  type SignedVerdict,
  toHex,
  utf8,
  verdictDigest,
} from "@tail/protocol";
import type { ApplyProof, ChainMatch, ContractConfig } from "../src/near.ts";
import { FakeChain } from "./fakes.ts";

/** contracts/tail lib.rs: the k-th Checkpoint needs k × CHECKPOINT_MS / 2 of match time. */
const CHECKPOINT_SPACING_MS = CHECKPOINT_MS / 2;
/** contracts/tail lib.rs: Start's start_ms may be this far from block time. */
const START_SKEW_MS = 300_000;
/** contracts/tail lib.rs: no head moves after end_ms + this. */
const VERDICT_GRACE_MS = 300_000;

/** What `apply` changes in one match, worked on as a copy so a refused call changes nothing. */
interface Draft {
  phase: ChainMatch["phase"];
  heads: bigint[];
  out: boolean[];
  paid: bigint[];
  ringCommit: Uint8Array | null;
  startMs: number | null;
  endMs: number | null;
  checkpoints: number[];
  /** [winner, loser] per Tag or Forfeit, for the ring check at End. */
  eliminations: [number, number][];
  alpha: string | null;
  vrfSignature: Uint8Array | null;
}

export interface Pins {
  refereePk: Uint8Array;
  vrfPk: Uint8Array;
  /** The `sender` the VRF alpha must name (the referee's caller). */
  vrfSender: string;
}

export class ContractChain extends FakeChain {
  private readonly eliminations = new Map<string, [number, number][]>();

  constructor(
    private readonly pins: Pins,
    /** Block time. */
    private readonly now: () => number,
  ) {
    super();
  }

  override async config(): Promise<ContractConfig> {
    return {
      ...(await super.config()),
      referee_pk: toHex(this.pins.refereePk),
      vrf_pk: toHex(this.pins.vrfPk),
    };
  }

  override async createMatch(cfg: Parameters<FakeChain["createMatch"]>[0]) {
    const id = await super.createMatch(cfg);
    const m = this.matches.get(id) as ChainMatch;
    m.referee_pk = toHex(this.pins.refereePk);
    m.vrf_pk = toHex(this.pins.vrfPk);
    return id;
  }

  /** The digest of the last verdict applied for the match (`get_verdict_head`). */
  head(matchId: string): Uint8Array | null {
    for (let i = this.applied.length - 1; i >= 0; i--) {
      const v = decodeSignedVerdict(this.applied[i] as Uint8Array);
      if (toHex(v.matchId) === matchId) return verdictDigest(v);
    }
    return null;
  }

  override async apply(verdicts: Uint8Array[], proofs: ApplyProof[]) {
    const now = this.now();
    const drafts = new Map<string, Draft>();
    for (const raw of verdicts) {
      const v = decodeSignedVerdict(raw);
      const id = toHex(v.matchId);
      const m = this.matches.get(id);
      if (!m) throw new Error("no such match");
      const d = drafts.get(id) ?? this.draft(id, m);
      drafts.set(id, d);
      applyOne(m, d, v, now, this.pins);
    }
    // Seq order, `prev` and the consistency proofs; all or nothing, like ours.
    const tx = await super.apply(verdicts, proofs);
    for (const [id, d] of drafts) this.commit(id, d);
    return tx;
  }

  private draft(id: string, m: ChainMatch): Draft {
    return {
      phase: m.phase,
      heads: m.players.map((p) => BigInt(p.head)),
      out: m.players.map((p) => p.out),
      paid: m.players.map((p) => BigInt(p.paid)),
      ringCommit: m.ring_commit === null ? null : fromHex(m.ring_commit),
      startMs: m.start_ms,
      endMs: m.end_ms,
      checkpoints: this.checkpointSizes(id),
      eliminations: [...(this.eliminations.get(id) ?? [])],
      alpha: m.alpha,
      vrfSignature: m.vrf_signature === null ? null : fromHex(m.vrf_signature),
    };
  }

  private checkpointSizes(id: string): number[] {
    const sizes: number[] = [];
    for (const raw of this.applied) {
      const v = decodeSignedVerdict(raw);
      if (toHex(v.matchId) === id && v.body.kind === "Checkpoint") sizes.push(Number(v.body.logSize));
    }
    return sizes;
  }

  private commit(id: string, d: Draft) {
    const m = this.matches.get(id) as ChainMatch;
    m.players.forEach((p, i) => {
      p.head = String(d.heads[i]);
      p.out = d.out[i] as boolean;
      p.paid = String(d.paid[i]);
    });
    m.ring_commit = d.ringCommit && toHex(d.ringCommit);
    m.start_ms = d.startMs;
    m.end_ms = d.endMs;
    m.alpha = d.alpha;
    m.vrf_signature = d.vrfSignature && toHex(d.vrfSignature);
    this.eliminations.set(id, d.eliminations);
    if (d.phase === "ended" && m.phase === "ended") {
      m.players.forEach((p, i) => {
        this.balances.set(p.account_id, (this.balances.get(p.account_id) ?? 0n) + (d.paid[i] as bigint));
      });
    }
  }
}

function require(cond: unknown, why: string): asserts cond {
  if (!cond) throw new Error(`contract refused: ${why}`);
}

/** Two distinct players who are both still in. */
function livePair(d: Draft, a: number, b: number) {
  require(a < d.heads.length && b < d.heads.length, "player index out of range");
  require(a !== b, "players must differ");
  require(!d.out[a] && !d.out[b], "player is out");
}

function applyOne(m: ChainMatch, d: Draft, v: SignedVerdict, now: number, pins: Pins) {
  require(ed25519.verify(v.sig, verdictDigest(v), pins.refereePk), "bad referee signature");
  const b = v.body;
  if (b.kind !== "Start") require(d.phase === "running", "match not running");
  if (b.kind === "Hint" || b.kind === "Tag" || b.kind === "Forfeit")
    require(now <=
      (d.endMs ?? 0) + VERDICT_GRACE_MS, "the match is over: no heads move after end_ms + grace");
  switch (b.kind) {
    case "Start": {
      require(d.phase === "lobby", "match already started");
      require(now <= m.start_by_ms, "start deadline passed");
      require(m.locked_until_ms !== null && now < m.locked_until_ms, "lobby is not locked");
      require(m.min_players <= m.players.length &&
        m.players.length <= m.max_players, "player count out of range");
      require(equal(
        b.playersHash,
        playersHash(m.players.map((p) => p.account_id)),
      ), "players_hash does not match the joined players");
      require(Math.abs(now - Number(b.startMs)) <= START_SKEW_MS, "start_ms is too far from block time");
      require(b.endMs - b.startMs === BigInt(m.duration_ms), "end_ms - start_ms must equal duration_ms");
      d.phase = "running";
      d.ringCommit = b.ringCommit;
      d.startMs = Number(b.startMs);
      d.endMs = Number(b.endMs);
      return;
    }
    case "Hint": {
      livePair(d, b.from, b.to);
      require(b.amount ===
        hintPrice(BigInt(m.stake), b.hint as HintKind), "hint amount is not the price of its kind");
      require((d.heads[b.from] as bigint) >= b.amount, "hint costs more than the payer's head");
      d.heads[b.from] = (d.heads[b.from] as bigint) - b.amount;
      d.heads[b.to] = (d.heads[b.to] as bigint) + b.amount;
      return;
    }
    case "Tag":
    case "Forfeit": {
      const [winner, loser] = b.kind === "Tag" ? [b.hunter, b.target] : [b.to, b.player];
      livePair(d, winner, loser);
      d.heads[winner] = (d.heads[winner] as bigint) + (d.heads[loser] as bigint);
      d.heads[loser] = 0n;
      d.out[loser] = true;
      d.eliminations.push([winner, loser]);
      return;
    }
    case "Checkpoint": {
      const start = d.startMs ?? 0;
      const nth = d.checkpoints.length + 1;
      require(nth * CHECKPOINT_SPACING_MS <=
        Math.min(now, d.endMs ?? 0) -
          start, "checkpoint too early: at most one per checkpoint_spacing_ms of match time");
      const size = Number(b.logSize);
      require(size > (d.checkpoints.at(-1) ?? -1), "checkpoint log_size must grow");
      d.checkpoints.push(size);
      return;
    }
    case "End": {
      require(d.ringCommit !== null &&
        equal(d.ringCommit, ringCommit(b.vrfSignature)), "vrf_signature does not match ring_commit");
      const parts = b.alpha.split(":");
      require(parts.length === 4 &&
        parts[0] === "vrf" &&
        parts[1] !== "", "alpha must be vrf:{request_id}:{sender}:{seed}");
      require(parts[3] === m.match_id, "alpha seed is not this match id");
      require(parts[2] === pins.vrfSender, "alpha sender is not the pinned vrf_sender");
      require(ed25519.verify(b.vrfSignature, utf8(b.alpha), pins.vrfPk), "bad VRF signature");
      const survivors = d.out.filter((o) => !o).length;
      require(now >= (d.endMs ?? 0) || survivors === 1, "End before end_ms needs exactly one survivor");
      require(Number(b.logSize) >=
        (d.checkpoints.at(-1) ?? 0), "End log_size is below the last checkpoint's");
      checkRing(
        m.players.map((p) => p.account_id),
        b.vrfSignature,
        d.eliminations,
      );
      // Settle: every head to its player (no sponsor pot here).
      d.paid = [...d.heads];
      d.heads = d.heads.map(() => 0n);
      d.phase = "ended";
      d.alpha = b.alpha;
      d.vrfSignature = b.vrfSignature;
      return;
    }
  }
}

/** Each winner was hunting the loser when it won, along the ring the VRF output rebuilds. */
function checkRing(players: string[], vrfSignature: Uint8Array, eliminations: [number, number][]) {
  const ring = buildRing(players, vrfSignature);
  const target: (number | null)[] = players.map(() => null);
  ring.forEach((hunter, k) => {
    target[players.indexOf(hunter)] = players.indexOf(ring[(k + 1) % ring.length] as string);
  });
  for (const [w, l] of eliminations) {
    require(target[w] === l, "a Tag did not follow the ring");
    const next = target[l] ?? null;
    target[l] = null;
    target[w] = next === w ? null : next;
  }
}
