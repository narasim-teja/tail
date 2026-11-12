// Match lifecycle and the per-match tick loop (TECHNICAL.md 5.4).
//
//   create (relay hosts on chain) → players join with their own keys → start: lock the lobby,
//   referee `start`, apply Start, hand out sealed PlayerKeys → every TICK_MS: flush unapplied
//   verdicts, voice issued hints, referee `tick` with the queued sealed batches and receipts,
//   store everything it returned in one transaction, push HUDs, apply its verdicts → when the
//   referee says `over`: `end`, apply End, `declassify`, keep the reveal for the replay.
//
// Invariants the loop keeps:
// - At most one step per match runs at a time (OutLayer calls take 2–10 s; a second tick on the
//   same sealed state would fork it). The next step is scheduled only after the previous ends.
// - A batch leaves the queue only in the same transaction that stores the tick that consumed it,
//   so a failed or lost referee call loses nothing: the batches go again next tick.
// - A verdict is submitted only after it is stored, and only when get_match().seq says it is the
//   next one, so a lost RPC answer can never apply a verdict twice or out of order.
// - The relay ticks only when every verdict it holds is on chain: the referee refuses a sealed
//   state whose seq is ahead of `last_seq`.

import type { Logger } from "@tail/log";
import {
  decodeLogEntry,
  epochAt,
  equal,
  merkleLeaf,
  merkleRoot,
  sha256,
  TICK_MS,
  toHex,
  utf8,
  Writer,
} from "@tail/protocol";
import { mintCode } from "./codes.ts";
import type { Store, Zone } from "./db.ts";
import { HttpError } from "./errors.ts";
import type { HudHub } from "./hub.ts";
import { type Chain, MAX_VERDICTS_PER_APPLY } from "./near.ts";
import {
  type Circle,
  MAX_DECLASSIFY_BATCHES,
  type RawVerdict,
  type Referee,
  RefereeError,
} from "./referee.ts";

/** Sealed batches per tick; the referee refuses more than 256. */
export const MAX_BATCHES_PER_TICK = 256;
/** A hint not voiced within this long is dropped: the referee waits 120 s for its receipt. */
export const VOICE_WINDOW_MS = 90_000;

export interface MatchDeps {
  store: Store;
  chain: Chain;
  referee: Referee;
  hub: HudHub;
  log: Logger;
  appId: string;
  token: string;
  now?: () => number;
  /** Defaults to TICK_MS; tests shorten it. */
  tickMs?: number;
}

export interface CreateMatchInput {
  stake: bigint;
  durationMs: number;
  zone: Circle;
  safehouses: Circle[];
  publicReplay: boolean;
  minPlayers: number;
  maxPlayers: number;
  startByMs: number;
  invites: string[];
}

/**
 * The contract stores only `zone_hash`; this is what it hashes, so the replay can check the
 * zone it draws: SHA256("tail/zone/v1" ‖ borsh(zone: Circle, safehouses: Vec<Circle>)), with
 * Circle = {lat_e7 i32, lon_e7 i32, radius_m u32} as in referee-core.
 */
export function zoneHash(z: Zone): Uint8Array {
  const circle = (w: Writer, c: Circle) => w.i32(c.latE7).i32(c.lonE7).u32(c.radiusM);
  const w = new Writer().raw(utf8("tail/zone/v1"));
  circle(w, z.zone);
  return sha256(w.vec(z.safehouses, circle).bytes());
}

const hexId = (b: Uint8Array) => toHex(b);
const idBytes = (matchId: string) => Uint8Array.from(Buffer.from(matchId, "hex"));
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

export class Matches {
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Set<string>();
  private stopped = false;

  constructor(private readonly d: MatchDeps) {
    this.now = d.now ?? Date.now;
    this.tickMs = d.tickMs ?? TICK_MS;
  }

  // ── Lobby ────────────────────────────────────────────────────────────────────────

  async create(
    host: string,
    i: CreateMatchInput,
  ): Promise<{ matchId: string; zoneHash: string; code: string }> {
    const zone: Zone = { zone: i.zone, safehouses: i.safehouses };
    const zh = hexId(zoneHash(zone));
    const matchId = await this.d.chain.createMatch({
      token: this.d.token,
      stake: i.stake.toString(),
      duration_ms: i.durationMs,
      zone_hash: zh,
      public_replay: i.publicReplay,
      min_players: i.minPlayers,
      max_players: i.maxPlayers,
      start_by_ms: i.startByMs,
      invites: i.invites,
    });
    // Minted after the chain answers, with no await between the check and the insert, so two
    // creates cannot take the same code. A clash is one in hundreds of millions; redraw it.
    let code = mintCode();
    while (this.d.store.codeTaken(code)) code = mintCode();
    this.d.store.putMatch(matchId, host, zone, code, this.now());
    this.d.log.info({ matchId, host, code }, "match created");
    return { matchId, zoneHash: zh, code };
  }

  /**
   * Locks the lobby, asks the referee to start, stores what it returned, applies Start.
   * Returns the players in index order and each one's PlayerKeys sealed to their box key.
   */
  async start(matchId: string, caller: string) {
    const m = this.d.store.match(matchId);
    if (!m) throw new HttpError(404, "no such match");
    if (m.host !== caller) throw new HttpError(403, "only the host can start the match");
    if (!this.d.store.claimPhase(matchId, "lobby", "starting"))
      throw new HttpError(409, `match is ${m.phase}`);
    const progress = { refereeStarted: false };
    try {
      return await this.startClaimed(matchId, m.zone, progress);
    } catch (e) {
      // The enclave starts a match id once. After it answered (or refused), a retry cannot work,
      // and the lobby refunds through `abort`. Before that, the host may simply try again.
      const final = progress.refereeStarted || (e instanceof RefereeError && e.refused);
      this.d.store.setPhase(matchId, final ? "failed" : "lobby", (e as Error).message);
      throw e;
    }
  }

  private async startClaimed(matchId: string, zone: Zone, progress: { refereeStarted: boolean }) {
    let chain = await this.d.chain.getMatch(matchId);
    if (!chain) throw new HttpError(404, "match is not on chain");
    if (chain.phase !== "lobby") throw new HttpError(409, `match is ${chain.phase} on chain`);
    // A lock from an earlier attempt that failed before the referee answered is reused.
    if (chain.locked_until_ms === null) {
      if (chain.players.length < chain.min_players) {
        throw new HttpError(409, `need ${chain.min_players} players, have ${chain.players.length}`);
      }
      const missing = chain.players.filter((p) => !this.d.store.device(p.account_id));
      if (missing.length)
        throw new HttpError(409, `not enrolled here: ${missing.map((p) => p.account_id).join(", ")}`);
      await this.d.chain.lockLobby(matchId);
      chain = await this.d.chain.getMatch(matchId);
      if (!chain) throw new HttpError(404, "match is not on chain");
    }
    if (chain.locked_until_ms === null || chain.locked_until_ms < this.now()) {
      throw new HttpError(409, "the lobby lock ran out; players may leave or abort");
    }
    const players = chain.players.map((p) => p.account_id);

    const started = await this.d.referee.start({
      matchId: idBytes(matchId),
      players,
      // The contract wants Start's start_ms close to block time, so it is "now" and applied at once.
      startMs: this.now(),
      stake: BigInt(chain.stake),
      durationMs: chain.duration_ms,
      zone: zone.zone,
      safehouses: zone.safehouses,
      appId: this.d.appId,
    });
    progress.refereeStarted = true;
    const start = started.verdicts[0]?.v;
    if (start?.body.kind !== "Start" || start.seq !== 1)
      throw new Error("referee start returned no Start verdict");
    const keys = started.keys.map((k) => ({
      player: k.player,
      account_id: k.accountId,
      sealed: b64(k.sealed),
    }));
    if (BigInt(started.startMs) !== start.body.startMs || BigInt(started.endMs) !== start.body.endMs) {
      throw new Error("referee start times disagree with its Start verdict");
    }
    this.d.store.tx(() => {
      this.d.store.setStarted(matchId, { startMs: started.startMs, endMs: started.endMs, players, keys });
      this.d.store.setState(matchId, started.state, 0);
      this.d.store.appendLog(matchId, started.log);
      this.storeVerdicts(matchId, started.verdicts);
      this.d.store.setPhase(matchId, "running");
    });
    for (const k of keys) {
      this.d.hub.send(matchId, k.player, {
        type: "keys",
        match_id: matchId,
        player: k.player,
        sealed: k.sealed,
      });
    }
    // From here the match is running; if Start does not land now, the loop keeps trying.
    await this.flushVerdicts(matchId).catch((e: Error) =>
      this.d.log.warn({ matchId, err: e.message }, "Start not applied yet; the loop retries"),
    );
    this.schedule(matchId, 0);
    this.d.log.info({ matchId, players: players.length }, "match started");
    const row = this.d.store.match(matchId);
    return { players, keys, startMs: row?.start_ms ?? 0, endMs: row?.end_ms ?? 0 };
  }

  // ── Batches ──────────────────────────────────────────────────────────────────────

  /** Queues one sealed batch from `account`. Refuses uploads for matches not running. */
  enqueue(matchId: string, account: string, sealed: Uint8Array): { queued: boolean; player: number } {
    const m = this.d.store.match(matchId);
    if (!m) throw new HttpError(404, "no such match");
    if (m.phase !== "running" || !m.players) throw new HttpError(409, `match is ${m.phase}`);
    const player = m.players.indexOf(account);
    if (player < 0) throw new HttpError(403, "not a player in this match");
    if (this.d.store.queuedCount(matchId, player) >= 32) throw new HttpError(429, "too many batches waiting");
    const queued = this.d.store.enqueueBatch(matchId, player, sealed, sha256(sealed), this.now());
    return { queued, player };
  }

  // ── The loop ─────────────────────────────────────────────────────────────────────

  /** Restarts the loop for every match that was mid-game when the relay stopped. */
  resume() {
    for (const id of this.d.store.matchesIn(["running", "ending"])) this.schedule(id, 0);
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** True while a step is scheduled or running for this match. */
  active(matchId: string) {
    return this.timers.has(matchId) || this.running.has(matchId);
  }

  private schedule(matchId: string, delayMs: number) {
    if (this.stopped || this.timers.has(matchId) || this.running.has(matchId)) return;
    this.timers.set(
      matchId,
      setTimeout(() => {
        this.timers.delete(matchId);
        void this.run(matchId);
      }, delayMs),
    );
  }

  private async run(matchId: string) {
    this.running.add(matchId);
    const t0 = this.now();
    let again = true;
    try {
      again = await this.step(matchId);
    } catch (e) {
      this.d.log.error({ matchId, err: (e as Error).message }, "match step failed; retrying next tick");
    } finally {
      this.running.delete(matchId);
    }
    if (again) this.schedule(matchId, Math.max(0, this.tickMs - (this.now() - t0)));
  }

  /** One serialised step of a match. Returns false once the match needs no more steps. */
  async step(matchId: string): Promise<boolean> {
    const m = this.d.store.match(matchId);
    if (!m || (m.phase !== "running" && m.phase !== "ending")) return false;
    if (!(await this.flushVerdicts(matchId))) return true;
    await this.voicePending(matchId);
    if (m.phase === "running") {
      if (m.start_ms !== null && this.now() < m.start_ms) return true;
      await this.tick(matchId);
      if (this.d.store.match(matchId)?.phase !== "ending") return true;
      if (!(await this.flushVerdicts(matchId))) return true;
      await this.voicePending(matchId);
    }
    return !(await this.finish(matchId));
  }

  private async tick(matchId: string) {
    const m = this.d.store.match(matchId);
    if (!m?.state || !m.players) throw new Error("running match has no state");
    const batches = this.d.store.queuedBatches(matchId, MAX_BATCHES_PER_TICK);
    const voiced = this.d.store.hints(matchId, "voiced");
    const t0 = performance.now();
    const r = await this.d.referee.tick({
      matchId: idBytes(matchId),
      state: m.state,
      lastSeq: m.last_seq,
      batches: batches.map((b) => b.sealed),
      receipts: voiced.flatMap((h) => (h.receipt ? [h.receipt] : [])),
    });
    const wallMs = Math.round(performance.now() - t0);
    const now = this.now();
    // The relay holds the only full copy of the log; refuse to go on with a copy that differs.
    this.checkLog(matchId, r.log, r.logSize, r.logRoot);
    this.d.store.tx(() => {
      this.d.store.setState(matchId, r.state, r.tickNo);
      this.d.store.appendLog(matchId, r.log);
      this.storeVerdicts(matchId, r.verdicts);
      this.d.store.markBatchesSent(
        batches.map((b) => b.id),
        r.tickNo,
      );
      this.d.store.setHintStatus(
        matchId,
        voiced.map((h) => h.hint_id),
        "consumed",
      );
      for (const h of r.hints) {
        this.d.store.putHint(
          matchId,
          { hintId: h.hintId, asker: h.from, hint: h.hint, value: h.value, question: h.text ?? null },
          now,
        );
      }
      for (const h of r.huds) this.d.store.putHud(matchId, h.player, r.tickNo, h.sealed);
      this.d.store.putTick(matchId, {
        tick_no: r.tickNo,
        call_id: r.callId,
        at_ms: now,
        wall_ms: wallMs,
        batches: batches.length,
        verdicts: r.verdicts.map((v) => v.v.body.kind),
        rejected: r.rejected,
        refused: r.refused,
      });
      if (r.over) this.d.store.setPhase(matchId, "ending");
    });
    for (const h of r.huds) {
      this.d.hub.send(matchId, h.player, {
        type: "hud",
        match_id: matchId,
        tick: r.tickNo,
        sealed: b64(h.sealed),
      });
    }
    if (r.unopened.length) this.d.log.warn({ matchId, unopened: r.unopened }, "sealed batches did not open");
    for (const x of r.rejected) {
      if (typeof x["player"] === "number") {
        this.d.hub.send(matchId, x["player"], { type: "rejected", match_id: matchId, detail: x });
      }
    }
    for (const x of r.refused) {
      if (typeof x["player"] === "number") {
        this.d.hub.send(matchId, x["player"], { type: "refused", match_id: matchId, detail: x });
      }
    }
    this.d.log.info(
      {
        matchId,
        tick: r.tickNo,
        wallMs,
        batches: batches.length,
        verdicts: r.verdicts.map((v) => `${v.v.seq}:${v.v.body.kind}`),
        rejected: r.rejected.length,
        refused: r.refused.length,
        hints: r.hints.length,
        over: r.over,
      },
      "tick",
    );
  }

  /** End → apply → declassify. True once the reveal is stored and the match is settled. */
  private async finish(matchId: string): Promise<boolean> {
    let m = this.d.store.match(matchId);
    if (!m?.state) throw new Error("ending match has no state");
    const haveEnd = this.d.store.verdicts(matchId).some((v) => v.kind === "End");
    if (!haveEnd) {
      const voiced = this.d.store.hints(matchId, "voiced");
      const r = await this.d.referee.end({
        matchId: idBytes(matchId),
        state: m.state,
        lastSeq: m.last_seq,
        receipts: voiced.flatMap((h) => (h.receipt ? [h.receipt] : [])),
      });
      const end = r.verdicts.find((v) => v.v.body.kind === "End")?.v.body;
      if (end?.kind !== "End") throw new Error("referee end returned no End verdict");
      // End carries the log before its own entry; the entries `end` returns come after it.
      this.checkLog(matchId, [], Number(end.logSize), end.root);
      this.d.store.tx(() => {
        this.d.store.setState(matchId, r.state, m?.tick_no ?? 0);
        this.d.store.appendLog(matchId, r.log);
        this.storeVerdicts(matchId, r.verdicts);
        this.d.store.setHintStatus(
          matchId,
          voiced.map((h) => h.hint_id),
          "consumed",
        );
      });
      this.d.log.info({ matchId, verdicts: r.verdicts.map((v) => `${v.v.seq}:${v.v.body.kind}`) }, "end");
    }
    if (!(await this.flushVerdicts(matchId))) return false;
    m = this.d.store.match(matchId);
    if (!m?.reveal) {
      const reveal = await this.d.referee.declassify(idBytes(matchId));
      this.d.store.setReveal(matchId, reveal);
    }
    if (!m?.trails_done) await this.declassifyTrails(matchId);
    this.d.store.setPhase(matchId, "ended");
    for (const player of (m?.players ?? []).keys())
      this.d.hub.send(matchId, player, { type: "over", match_id: matchId });
    this.d.log.info({ matchId }, "match settled and declassified");
    return true;
  }

  /**
   * Checks that the stored log plus `added` has `size` entries and Merkle root `root`. Throws
   * before anything is stored, so the step is retried rather than building on a broken copy.
   */
  private checkLog(matchId: string, added: Uint8Array[], size: number, root: Uint8Array) {
    const entries = [...this.d.store.log(matchId), ...added];
    if (entries.length !== size)
      throw new Error(`log copy has ${entries.length} entries, referee says ${size}`);
    if (!equal(merkleRoot(entries.map((e) => merkleLeaf(decodeLogEntry(e)))), root)) {
      throw new Error("log copy does not match the referee's root");
    }
  }

  /**
   * Has the referee open every sealed batch the relay forwarded, and keeps those whose SHA256 is
   * a LogEntry::Batch of this match (the referee also returns batches it rejected during play,
   * and the replay accepts only logged ones).
   */
  private async declassifyTrails(matchId: string) {
    const m = this.d.store.match(matchId);
    if (!m?.state) throw new Error("ended match has no End state");
    const logged = new Set<string>();
    for (const e of this.d.store.log(matchId)) {
      const entry = decodeLogEntry(e);
      if (entry.kind === "Batch") logged.add(toHex(entry.hash));
    }
    const sealed = this.d.store.allBatches(matchId).map((b) => b.sealed);
    const kept: Uint8Array[] = [];
    for (let i = 0; i < sealed.length; i += MAX_DECLASSIFY_BATCHES) {
      const r = await this.d.referee.declassifyBatches({
        matchId: idBytes(matchId),
        state: m.state,
        sealed: sealed.slice(i, i + MAX_DECLASSIFY_BATCHES),
      });
      // A batch sent twice (a resend) opens twice; the trail keeps it once.
      for (const b of r.batches) if (logged.delete(toHex(sha256(b)))) kept.push(b);
    }
    this.d.store.putTrails(matchId, kept);
    this.d.log.info(
      { matchId, sent: sealed.length, kept: kept.length, notReturned: logged.size },
      "trails declassified",
    );
  }

  private storeVerdicts(matchId: string, verdicts: RawVerdict[]) {
    for (const { raw, v } of verdicts) {
      this.d.store.putVerdict(matchId, { seq: v.seq, kind: v.body.kind, raw, callId: hexId(v.callId) });
    }
  }

  /**
   * Submits stored verdicts not yet on chain, in seq order. The chain's own seq decides what is
   * left to send, so retrying after an unclear result (timeout, lost answer) is always safe.
   * Returns true when nothing is left pending.
   */
  async flushVerdicts(matchId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const pending = this.d.store.pendingVerdicts(matchId);
      if (!pending.length) return true;
      const chain = await this.d.chain.getMatch(matchId);
      if (!chain) throw new Error("match vanished from chain");
      this.d.store.markApplied(matchId, chain.seq, this.now());
      const left = pending.filter((v) => v.seq > chain.seq);
      if (!left.length) return true;
      if (left[0]?.seq !== chain.seq + 1) {
        this.d.log.error({ matchId, chainSeq: chain.seq, next: left[0]?.seq }, "verdict gap; cannot apply");
        return false;
      }
      const batch = left.slice(0, MAX_VERDICTS_PER_APPLY);
      try {
        const tx = await this.d.chain.apply(batch.map((v) => v.raw));
        this.d.store.setVerdictTx(
          matchId,
          batch.map((v) => v.seq),
          tx,
        );
        this.d.log.info({ matchId, seqs: batch.map((v) => `${v.seq}:${v.kind}`), tx }, "verdicts applied");
        await this.awaitSeq(matchId, (batch.at(-1) as { seq: number }).seq);
      } catch (e) {
        // Unclear or refused; the next pass reads the chain's seq before sending anything again.
        this.d.log.warn({ matchId, err: String((e as Error).message).slice(0, 300) }, "apply failed");
      }
    }
    return this.d.store.pendingVerdicts(matchId).length === 0;
  }

  /**
   * After a successful apply, waits (up to ~5 s) until a view shows it. RPC nodes behind a load
   * balancer can lag a block or two, and a stale seq would make the next pass resend verdicts the
   * chain already has (refused, so harmless, but it burns gas).
   */
  private async awaitSeq(matchId: string, seq: number) {
    for (let i = 0; i < 10; i++) {
      const m = await this.d.chain.getMatch(matchId);
      if (m && m.seq >= seq) return;
      await Bun.sleep(500);
    }
  }

  /** Turns issued hints into Handler lines and receipts for the next tick. */
  private async voicePending(matchId: string) {
    for (const h of this.d.store.hints(matchId, "pending")) {
      if (this.now() - h.issued_ms > VOICE_WINDOW_MS) {
        this.d.store.setHintStatus(matchId, [h.hint_id], "dropped");
        continue;
      }
      try {
        const v = await this.d.referee.voice({
          hintId: h.hint_id,
          hint: h.hint,
          value: h.value,
          ...(h.question ? { question: h.question } : {}),
        });
        this.d.store.setHintVoiced(matchId, h.hint_id, v);
        this.d.hub.send(matchId, h.asker, {
          type: "handler",
          match_id: matchId,
          hint_id: h.hint_id,
          text: v.text,
        });
      } catch (e) {
        this.d.log.warn(
          { matchId, hintId: h.hint_id, err: (e as Error).message },
          "voice failed; will retry",
        );
      }
    }
  }

  /** The current epoch of a running match, for status. */
  epoch(matchId: string): number | null {
    const m = this.d.store.match(matchId);
    if (!m?.start_ms || this.now() < m.start_ms) return null;
    return epochAt(this.now(), m.start_ms);
  }
}
