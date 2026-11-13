// The batch path (TECHNICAL.md 4.3): every BATCH_MS the phone builds a Batch, links it to the
// previous one by hash, has App Attest sign SHA256("tail/batch" ‖ borsh(Batch)), and seals
// borsh(BatchEnvelope) to the referee's box key with context "tail/batch". Only the enclave can
// open it. The referee accepts a player's batches only with contiguous seqs and matching
// `prev`, so a seq is consumed only once its sealed batch is safely in the outbox. When the
// referee's chain and the phone's part (game/chain.ts), the builder is moved to the referee's
// position with `rebase`.

import {
  type Action,
  type Batch,
  batchClientDataHash,
  batchHash,
  encodeBatchEnvelope,
  type Fix,
  SealContext,
  type Sighting,
  seal,
} from "@tail/protocol";
import type { ActionQueue } from "./actions";
import type { FixCollector } from "./fixes";
import type { SightingAggregator } from "./sightings";

export interface ChainState {
  /** The seq the next batch gets. */
  seq: number;
  /** SHA256(borsh(previous batch)); zeros before seq 0. */
  prev: Uint8Array;
}

export const genesis = (): ChainState => ({ seq: 0, prev: new Uint8Array(32) });

export interface OutboxItem {
  seq: number;
  sealed: Uint8Array;
  /** batchHash: the referee's chain link and the batch's id in its log. */
  hash: Uint8Array;
  /** What the batch asked for, so a batch the referee never took can say what was lost. */
  actions: Action["kind"][];
  /** When the relay first took it (over HTTP or carried); null until then. */
  sentMs: number | null;
  /** Sent a second time after the referee's chain stalled on it (game/chain.ts). */
  resent: boolean;
}

/** Signs a clientDataHash with the device's App Attest key; returns the raw assertion bytes. */
export type Assert = (clientDataHash: Uint8Array) => Promise<Uint8Array>;

export interface BatchParts {
  fixes: Fix[];
  sightings: Sighting[];
  actions: Action[];
}

export function buildBatch(
  ids: { matchId: Uint8Array; player: number },
  chain: ChainState,
  tMs: bigint,
  parts: BatchParts,
): Batch {
  return { matchId: ids.matchId, player: ids.player, seq: chain.seq, prev: chain.prev, tMs, ...parts };
}

/** Assertion over the batch, then seal(referee_box_pk, borsh(BatchEnvelope), "tail/batch"). */
export async function sealBatch(batch: Batch, assert: Assert, refereeBoxPk: Uint8Array): Promise<Uint8Array> {
  const assertion = await assert(batchClientDataHash(batch));
  return seal(refereeBoxPk, encodeBatchEnvelope({ batch, assertion }), SealContext.batch);
}

export const nextChain = (batch: Batch): ChainState => ({ seq: batch.seq + 1, prev: batchHash(batch) });

export interface BuilderDeps {
  matchId: Uint8Array;
  player: number;
  refereeBoxPk: Uint8Array;
  chain: ChainState;
  fixes: FixCollector;
  sightings: SightingAggregator;
  actions: ActionQueue;
  assert: Assert;
  /** Stores the sealed batch and the advanced chain together, before anything is sent. */
  commit: (item: OutboxItem, chain: ChainState) => void;
  now?: () => number;
}

export class BatchBuilder {
  chain: ChainState;
  private busy: Promise<OutboxItem | null> = Promise.resolve(null);
  // What a failed build took from the collectors; the next build sends it with the new data.
  private carry: BatchParts = { fixes: [], sightings: [], actions: [] };
  private readonly now: () => number;

  constructor(private readonly d: BuilderDeps) {
    this.chain = d.chain;
    this.now = d.now ?? Date.now;
  }

  /** Builds, signs, seals and commits one batch. Calls are serialised: one seq at a time. */
  build(): Promise<OutboxItem | null> {
    const run = this.busy.then(
      () => this.buildOnce(),
      () => this.buildOnce(),
    );
    this.busy = run.catch(() => null);
    return run;
  }

  /**
   * Continues the chain from `chain` (the referee's next seq and tip) once any build in flight
   * has committed, so no batch is ever built on the abandoned position.
   */
  rebase(chain: ChainState): Promise<void> {
    const run = this.busy.then(
      () => {
        this.chain = chain;
      },
      () => {
        this.chain = chain;
      },
    );
    this.busy = run.then(() => null);
    return run;
  }

  private async buildOnce(): Promise<OutboxItem> {
    const tMs = BigInt(this.now());
    const parts: BatchParts = {
      fixes: [...this.carry.fixes, ...this.d.fixes.take(tMs)],
      sightings: [...this.carry.sightings, ...this.d.sightings.drain()],
      actions: [...this.carry.actions, ...this.d.actions.drain()],
    };
    this.carry = parts;
    const batch = buildBatch({ matchId: this.d.matchId, player: this.d.player }, this.chain, tMs, parts);
    const sealed = await sealBatch(batch, this.d.assert, this.d.refereeBoxPk);
    const chain = nextChain(batch);
    const item: OutboxItem = {
      seq: batch.seq,
      sealed,
      hash: chain.prev,
      actions: parts.actions.map((a) => a.kind),
      sentMs: null,
      resent: false,
    };
    // Cleared before the commit, so what the commit saves as unsent (unsentActions) no longer
    // holds the actions inside this batch: a relaunch must not send a hint twice. A commit that
    // throws puts them back for the next build.
    this.carry = { fixes: [], sightings: [], actions: [] };
    try {
      this.d.commit(item, chain);
    } catch (e) {
      this.carry = parts;
      throw e;
    }
    this.chain = chain;
    return item;
  }

  /**
   * Actions not yet inside a committed batch: what a failed build kept, then the queue. The
   * session saves these with the match, so a strike or hint survives a failed build and a relaunch.
   */
  unsentActions(): Action[] {
    return [...this.carry.actions, ...this.d.actions.peek()];
  }
}
