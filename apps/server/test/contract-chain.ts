// A fake chain that keeps the rules of the contract's `apply` (contracts/tail `apply_one`), for a
// test against the real referee: on top of FakeChain's verdict chain (seq order, `prev`, and a
// consistency proof for every Checkpoint/End checked with verifyConsistency against the root it
// last anchored), each verdict must carry the pinned referee's signature, and it moves heads the
// way the contract does: Start against the locked player list and block time, a Hint at exactly
// its price at that moment's demand (dated inside the match, after the hints before it) into the
// hint pool, a Tag or Forfeit crediting its loser from the pool before
// the head moves, Checkpoints spaced in match time, and End only with the VRF reveal that opens
// the Start's ring commit. End then replays the match (replaySettlement): if it holds, survivors
// get their hint credit and the heads are paid; if not, every stake is refunded and the broken
// rule is kept (`settlement`).
// "Block time" is the clock the test runs the match on.

import { ed25519 } from "@noble/curves/ed25519.js";
import {
  CHECKPOINT_MS,
  decodeSignedVerdict,
  describeViolation,
  equal,
  fromHex,
  HINT_BPS,
  type HintKind,
  hintPrice,
  MAX_HINTS,
  type PlayEvent,
  playEvent,
  playersHash,
  recentHints,
  replaySettlement,
  ringCommit,
  ringOrder,
  type SignedVerdict,
  toHex,
  utf8,
  verdictDigest,
} from "@tail/protocol";
import type { ApplyProof, ChainMatch } from "../src/near.ts";
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
  /** Every applied Hint, Tag and Forfeit, for the replay at End. */
  events: PlayEvent[];
  /** Hint money paid in and not yet credited. */
  pool: bigint;
  settledAs: Settlement["settledAs"] | null;
  violation: string | null;
  alpha: string | null;
  vrfSignature: Uint8Array | null;
}

export interface Pins {
  refereePk: Uint8Array;
  vrfPk: Uint8Array;
  /** The `sender` the VRF alpha must name (the referee's caller). */
  vrfSender: string;
}

/** How a match settled, as the contract's `get_match` reports it. */
export interface Settlement {
  settledAs: "payout" | "refunded_rule_violation";
  violation: string | null;
}

interface Play {
  events: PlayEvent[];
  pool: bigint;
  settledAs: Settlement["settledAs"] | null;
  violation: string | null;
}

export class ContractChain extends FakeChain {
  private readonly plays = new Map<string, Play>();

  constructor(
    private readonly keys: Pins,
    /** Block time. */
    private readonly now: () => number,
  ) {
    super();
    // What get_config shows and create_match copies into each match.
    this.pins = { referee_pk: toHex(keys.refereePk), vrf_pk: toHex(keys.vrfPk), vrf_sender: keys.vrfSender };
  }

  /** How the match settled at End; null before. */
  settlement(matchId: string): Settlement | null {
    const p = this.plays.get(matchId);
    return p?.settledAs ? { settledAs: p.settledAs, violation: p.violation } : null;
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
      applyOne(m, d, v, now, this.keys);
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
      events: [...(this.plays.get(id)?.events ?? [])],
      pool: this.plays.get(id)?.pool ?? 0n,
      settledAs: this.plays.get(id)?.settledAs ?? null,
      violation: this.plays.get(id)?.violation ?? null,
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
    this.plays.set(id, { events: d.events, pool: d.pool, settledAs: d.settledAs, violation: d.violation });
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

/** A player who is still in. */
function live(d: Draft, p: number) {
  require(p < d.heads.length, "player index out of range");
  require(!d.out[p], "player is out");
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
      live(d, b.from);
      require(d.events.filter((e) => e.kind === "Hint").length <
        MAX_HINTS, "the match already charged MAX_HINTS hints");
      // Priced by demand (pricing.ts): the hints this match charged in the window before t_ms.
      require(b.hint in HINT_BPS, "unknown hint kind");
      const earlier = d.events.flatMap((e) => (e.kind === "Hint" ? [e.tMs] : []));
      require(d.startMs !== null &&
        d.endMs !== null &&
        b.tMs >= BigInt(d.startMs) &&
        b.tMs <= BigInt(d.endMs), "hint t_ms is outside the match");
      require(b.tMs >= (earlier.at(-1) ?? 0n), "hint t_ms is before an earlier hint");
      require(b.amount ===
        hintPrice(
          BigInt(m.stake),
          b.hint as HintKind,
          recentHints(earlier, b.tMs),
        ), "hint amount is not its price at that demand");
      require((d.heads[b.from] as bigint) >= b.amount, "hint costs more than the payer's head");
      d.heads[b.from] = (d.heads[b.from] as bigint) - b.amount;
      d.pool += b.amount;
      d.events.push(playEvent(b) as PlayEvent);
      return;
    }
    case "Tag":
    case "Forfeit": {
      const [winner, loser] = b.kind === "Tag" ? [b.hunter, b.target] : [b.to, b.player];
      livePair(d, winner, loser);
      require(b.credit <= d.pool, "credit is more than the hint pool holds");
      d.pool -= b.credit;
      d.heads[winner] = (d.heads[winner] as bigint) + (d.heads[loser] as bigint) + b.credit;
      d.heads[loser] = 0n;
      d.out[loser] = true;
      d.events.push(playEvent(b) as PlayEvent);
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
      const ring = ringOrder(
        m.players.map((p) => p.account_id),
        b.vrfSignature,
      );
      const r = replaySettlement(ring, d.events, b.hintTargets, d.pool);
      // Settle (no sponsor pot here): the heads with each survivor's hint credit, or every stake.
      if (r.ok) {
        d.paid = d.heads.map((h, i) => h + (r.owed[i] as bigint));
        d.settledAs = "payout";
      } else {
        d.paid = d.heads.map(() => BigInt(m.stake));
        d.settledAs = "refunded_rule_violation";
        d.violation = describeViolation(r.violation);
      }
      d.heads = d.heads.map(() => 0n);
      d.pool = 0n;
      d.phase = "ended";
      d.alpha = b.alpha;
      d.vrfSignature = b.vrfSignature;
      return;
    }
  }
}
