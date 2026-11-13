// Match lifecycle and the per-match tick loop (TECHNICAL.md 5.4).
//
//   create (relay hosts on chain) → players join with their own keys → start: lock the lobby,
//   referee `start`, apply Start, hand out sealed PlayerKeys → every TICK_MS: flush unapplied
//   verdicts, voice issued hints (each sealed line to its asker only), referee `tick` with the
//   queued sealed batches and the voice receipts, store everything it returned in one
//   transaction, push HUDs, apply its verdicts with their consistency proofs → when the referee
//   says `over`: `end`, apply End, `declassify` the sealed log, keep it and the reveal for the
//   replay.
//
// Protocol v2: the relay never sees a log entry during play. It keeps the leaf hashes (which
// reveal nothing, and serve inclusion and consistency proofs) and the referee's sealed copy of
// the entries, and checks every root the referee reports, and every consistency proof it hands
// over for the contract, against those leaves before storing anything.
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
// - Across processes on one database, a match is stepped only by the holder of its lease row
//   (db.ts `holdLease`), and every write of new state re-checks the lease in its transaction, so
//   a second relay on the same file cannot fork a match either.

import type { Logger } from "@tail/log";
import {
  decodeLogEntry,
  decodeSignedVerdict,
  epochAt,
  equal,
  merkleLeaf,
  merkleRoot,
  sha256,
  TICK_MS,
  toHex,
  utf8,
  verifyConsistency,
  Writer,
} from "@tail/protocol";
import { mintCode } from "./codes.ts";
import type { Store, Trail, Zone } from "./db.ts";
import { HttpError } from "./errors.ts";
import type { HudHub } from "./hub.ts";
import { type Chain, MAX_VERDICTS_PER_APPLY } from "./near.ts";
import {
  type Circle,
  MAX_DECLASSIFY_BATCHES,
  type RawVerdict,
  type Referee,
  RefereeError,
  refuseName,
  rejectName,
  type VerdictProof,
} from "./referee.ts";

/** Sealed batches per tick; the referee refuses more than 256. */
export const MAX_BATCHES_PER_TICK = 256;
/** A hint not voiced within this long is dropped: the referee waits 120 s for its receipt. */
export const VOICE_WINDOW_MS = 90_000;
/**
 * How long a lease on a match lasts without renewal. Each step renews it, and so does each write;
 * a process that dies leaves the match to another after this long.
 */
export const LEASE_MS = 120_000;

/** Thrown inside a write when another process took the match's lease: nothing is stored. */
class LeaseLostError extends Error {
  override name = "LeaseLostError";
}

export interface MatchDeps {
  store: Store;
  chain: Chain;
  referee: Referee;
  hub: HudHub;
  log: Logger;
  appId: string;
  token: string;
  /**
   * Makes sure the referee holds each player's device key before the match starts (enroll.ts
   * registers devices in the background; this waits for any still missing).
   */
  ensureWithReferee: (accountIds: string[]) => Promise<void>;
  /** What a lobby must pin for this relay's referee to start it: its keys (hex) and VRF caller. */
  pins: () => Promise<{ refereePk: string; vrfPk: string; vrfSender: string }>;
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
  /** Steps and Starts in flight, for `drain`. */
  private readonly busy = new Set<Promise<unknown>>();
  /** The next look at interrupted Starts another process held the lease of (`reopenStarts`). */
  private startsTimer: ReturnType<typeof setTimeout> | undefined;
  /** Hosts with a create in flight: one open lobby per host, and the check spans an await. */
  private readonly creating = new Set<string>();
  /** This process's name on lease rows. */
  readonly holder = `${process.pid}-${toHex(crypto.getRandomValues(new Uint8Array(6)))}`;
  private stopped = false;

  constructor(private readonly d: MatchDeps) {
    this.now = d.now ?? Date.now;
    this.tickMs = d.tickMs ?? TICK_MS;
  }

  /** Takes or renews this process's lease on the match; false while another process holds it. */
  private lease(matchId: string): boolean {
    return this.d.store.holdLease(matchId, this.holder, this.now(), LEASE_MS);
  }

  /** Runs `f` in one transaction that first renews the lease, and stores nothing without it. */
  private leasedTx(matchId: string, f: () => void) {
    this.d.store.tx(() => {
      if (!this.lease(matchId)) throw new LeaseLostError("another relay process holds this match");
      f();
    });
  }

  // ── Lobby ────────────────────────────────────────────────────────────────────────

  async create(
    host: string,
    i: CreateMatchInput,
  ): Promise<{ matchId: string; zoneHash: string; code: string }> {
    // The referee refuses to start a match with no stake (ZeroStake); say so before anyone joins.
    if (i.stake <= 0n) throw new HttpError(400, "stake must be more than 0");
    // Each lobby is opened with the relay's NEAR (the match deposit), so a host holds one at a time.
    if (this.creating.has(host)) throw new HttpError(409, "a lobby is already being made for you");
    this.creating.add(host);
    try {
      await this.closeStaleLobbies(host);
      return await this.createFor(host, i);
    } finally {
      this.creating.delete(host);
    }
  }

  /**
   * Refuses while the host has a lobby that can still start; a lobby the chain called off, or
   * whose start time passed, is closed here (failed, with why) so it no longer counts.
   */
  private async closeStaleLobbies(host: string) {
    for (const id of this.d.store.openLobbiesOf(host)) {
      const m = this.d.store.match(id);
      const chain = await this.d.chain.getMatch(id);
      // Not on chain yet means just created (the RPC view can lag): still open.
      const open =
        m?.phase === "starting" || !chain || (chain.phase === "lobby" && chain.start_by_ms > this.now());
      if (open) {
        throw new HttpError(409, "you already have an open lobby; start it or let it lapse first", {
          match_id: id,
        });
      }
      const why =
        chain.phase === "lobby" ? "the lobby's start time passed" : `the lobby was ${chain.phase} on chain`;
      if (this.d.store.claimPhase(id, "lobby", "failed")) this.d.store.setPhase(id, "failed", why);
    }
  }

  private async createFor(
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
    this.d.store.putMatch(matchId, host, zone, code, this.now(), i.publicReplay);
    this.d.log.info({ matchId, host, code }, "match created");
    return { matchId, zoneHash: zh, code };
  }

  /**
   * Locks the lobby, asks the referee to start, stores what it returned, applies Start.
   * Returns the players in index order and the caller's own PlayerKeys sealed to its box key (the
   * host is a player). Every other player's keys reach only that player: on its HUD socket and in
   * its signed zone view.
   */
  start(matchId: string, caller: string) {
    return this.track(this.startNow(matchId, caller));
  }

  private async startNow(matchId: string, caller: string) {
    const m = this.d.store.match(matchId);
    if (!m) throw new HttpError(404, "no such match");
    if (m.host !== caller) throw new HttpError(403, "only the host can start the match");
    if (!this.d.store.claimPhase(matchId, "lobby", "starting"))
      throw new HttpError(409, `match is ${m.phase}`);
    // The lease marks this start as live, so a relay booting meanwhile does not reopen the lobby.
    if (!this.lease(matchId)) {
      this.d.store.setPhase(matchId, "lobby", m.error);
      throw new HttpError(409, "another relay process holds this match");
    }
    const progress = { refereeStarted: false };
    try {
      if (!m.zone) throw new HttpError(409, "this match's zone was deleted");
      return await this.startClaimed(matchId, m.zone, caller, progress);
    } catch (e) {
      // The enclave starts a match id once. After it answered (or refused), a retry cannot work,
      // and the lobby refunds through `abort`. Before that, the host may simply try again.
      const final = progress.refereeStarted || (e instanceof RefereeError && e.refused);
      this.d.store.setPhase(matchId, final ? "failed" : "lobby", (e as Error).message);
      this.d.store.releaseLease(matchId, this.holder);
      throw e;
    }
  }

  private async startClaimed(
    matchId: string,
    zone: Zone,
    caller: string,
    progress: { refereeStarted: boolean },
  ) {
    let chain = await this.d.chain.getMatch(matchId);
    if (!chain) throw new HttpError(404, "match is not on chain");
    if (chain.phase !== "lobby") throw new HttpError(409, `match is ${chain.phase} on chain`);
    // A lobby keeps the referee keys the contract pinned when it was made. Under any others the
    // contract would refuse the Start verdict, after the referee had used up the match id.
    const want = await this.d.pins();
    if (
      chain.referee_pk !== want.refereePk ||
      chain.vrf_pk !== want.vrfPk ||
      chain.vrf_sender !== want.vrfSender
    )
      throw new HttpError(
        409,
        "this lobby was made for another referee than the one this relay runs; make a new one",
      );
    // A lock from an earlier attempt that failed before the referee answered is reused.
    if (chain.locked_until_ms === null) {
      if (chain.players.length < chain.min_players) {
        throw new HttpError(409, `need ${chain.min_players} players, have ${chain.players.length}`);
      }
      // Before the lock: if the referee cannot take a device now, the lobby stays open and the
      // host can simply press Start again.
      await this.ready(chain.players.map((p) => p.account_id));
      await this.d.chain.lockLobby(matchId);
      chain = await this.d.chain.getMatch(matchId);
      if (!chain) throw new HttpError(404, "match is not on chain");
    }
    if (chain.locked_until_ms === null || chain.locked_until_ms < this.now()) {
      throw new HttpError(409, "the lobby lock ran out; players may leave or abort");
    }
    const players = chain.players.map((p) => p.account_id);
    // Again on the list the lock froze: a player (or a test player, ghosts/fill.ts) can join
    // between the check above and the lock, and a reused lock skipped that check. For players
    // already registered this reads only the store.
    await this.ready(players);

    const started = await this.d.referee.start({
      matchId: idBytes(matchId),
      players,
      // The contract wants Start's start_ms close to block time, so it is "now" and applied at once.
      startMs: this.now(),
      stake: BigInt(chain.stake),
      durationMs: chain.duration_ms,
      zone: zone.zone,
      safehouses: zone.safehouses,
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
    this.leasedTx(matchId, () => {
      this.d.store.setStarted(matchId, {
        startMs: started.startMs,
        endMs: started.endMs,
        players,
        keys,
        // The App ID the referee checks assertions against is pinned in its code; the relay's
        // APPLE_TEAM_ID.IOS_BUNDLE_ID names the same app, and the replay re-checks against it.
        appId: this.d.appId,
      });
      this.d.store.setState(matchId, started.state, 0);
      this.d.store.appendLog(matchId, started);
      this.storeVerdicts(matchId, started.verdicts, []);
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
    return {
      players,
      keys: keys.filter((k) => k.account_id === caller),
      startMs: row?.start_ms ?? 0,
      endMs: row?.end_ms ?? 0,
    };
  }

  /** Every player is enrolled here and its device is with the referee, or this throws. */
  private async ready(accounts: string[]) {
    const missing = accounts.filter((a) => !this.d.store.device(a));
    if (missing.length) throw new HttpError(409, `not enrolled here: ${missing.join(", ")}`);
    await this.d.ensureWithReferee(accounts);
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

  /**
   * On boot: reopens lobbies whose Start the last run left unfinished (no state stored, so the
   * referee's answer never landed here; db.ts `reopenInterruptedStarts`), and restarts the loop
   * of every match that was mid-game.
   */
  resume() {
    this.reopenStarts();
    for (const id of this.d.store.matchesIn(["running", "ending"])) this.schedule(id, 0);
  }

  /**
   * An interrupted Start whose lease has not run out (a restart within LEASE_MS of the crash)
   * may still be another live process's, so it is left alone, and looked at again once the lease
   * runs out: without that, a lobby a dead process held stays `starting` for good. Only the
   * matches found at boot are looked at again; this process's own Starts are none of them.
   */
  private reopenStarts(only?: string[]) {
    const now = this.now();
    const reopened = this.d.store.reopenInterruptedStarts(now, only);
    if (reopened.length) this.d.log.warn({ matches: reopened }, "Start was interrupted; lobbies open again");
    const leased = this.d.store.interruptedStartLeases(now, only);
    if (this.stopped || !leased.length) return;
    const at = Math.min(...leased.map((l) => l.expires_ms));
    this.startsTimer = setTimeout(
      () => {
        this.startsTimer = undefined;
        this.reopenStarts(leased.map((l) => l.match_id));
      },
      Math.max(0, at - now) + 1,
    );
  }

  /** Stops the loop and hands back this process's leases, so another relay can go on at once. */
  stop() {
    this.stopped = true;
    clearTimeout(this.startsTimer);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const id of this.d.store.matchesIn(["starting", "running", "ending"]))
      if (!this.running.has(id)) this.d.store.releaseLease(id, this.holder);
  }

  /**
   * Stops the loop, waits up to `ms` for the steps and Starts in flight (a referee answer they
   * are waiting for would otherwise be lost with the process), then hands back every lease this
   * process holds, so another relay can step its matches at once rather than LEASE_MS later. A
   * step still running after `ms` is abandoned with the process.
   */
  async drain(ms: number) {
    this.stop();
    const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined };
    await Promise.race([
      Promise.allSettled([...this.busy]),
      new Promise((done) => {
        timer.id = setTimeout(done, ms);
      }),
    ]);
    clearTimeout(timer.id);
    this.d.store.releaseLeasesOf(this.holder);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.busy.add(p);
    const done = () => this.busy.delete(p);
    p.then(done, done);
    return p;
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
        void this.track(this.run(matchId));
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
    // Stopped mid-step: hand the match over now rather than when the lease runs out.
    if (this.stopped) this.d.store.releaseLease(matchId, this.holder);
    if (again) this.schedule(matchId, Math.max(0, this.tickMs - (this.now() - t0)));
  }

  /** One serialised step of a match. Returns false once the match needs no more steps. */
  async step(matchId: string): Promise<boolean> {
    const m = this.d.store.match(matchId);
    if (!m || (m.phase !== "running" && m.phase !== "ending")) {
      this.d.store.releaseLease(matchId, this.holder);
      return false;
    }
    // Another process is stepping this match; look again next tick, and take over if it stops.
    if (!this.lease(matchId)) return true;
    if (!(await this.flushVerdicts(matchId))) return true;
    await this.voicePending(matchId);
    if (m.phase === "running") {
      if (m.start_ms !== null && this.now() < m.start_ms) return true;
      await this.tick(matchId);
      // The tick's verdicts go on chain now, not a tick later: a Tag or a Forfeit moves money.
      const flushed = await this.flushVerdicts(matchId);
      if (this.d.store.match(matchId)?.phase !== "ending" || !flushed) return true;
    }
    const done = await this.finish(matchId);
    if (done) this.d.store.releaseLease(matchId, this.holder);
    return !done;
  }

  private async tick(matchId: string) {
    const m = this.d.store.match(matchId);
    if (!m?.state || !m.players) throw new Error("running match has no state");
    const batches = this.d.store.queuedBatches(matchId, MAX_BATCHES_PER_TICK);
    const voiced = this.d.store.voiceHints(matchId, "voiced");
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
    // The relay holds the only full copy of the leaves; refuse to go on with a copy that differs.
    this.checkLog(matchId, r.leaves, r.verdicts, r.proofs, { size: r.logSize, root: r.logRoot });
    this.leasedTx(matchId, () => {
      this.d.store.setState(matchId, r.state, r.tickNo);
      this.d.store.appendLog(matchId, r);
      this.storeVerdicts(matchId, r.verdicts, r.proofs);
      this.d.store.markBatchesSent(
        batches.map((b) => b.id),
        r.tickNo,
      );
      this.d.store.setVoiceStatus(
        voiced.map((h) => h.id),
        "consumed",
      );
      for (const h of r.hints) this.d.store.putVoiceHint(matchId, h.player, h.blob, now);
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
    for (const x of r.rejected)
      this.d.hub.send(matchId, x.player, { type: "rejected", match_id: matchId, detail: x });
    for (const x of r.refused)
      this.d.hub.send(matchId, x.player, { type: "refused", match_id: matchId, detail: x });
    this.d.log.info(
      {
        matchId,
        tick: r.tickNo,
        wallMs,
        batches: batches.length,
        verdicts: r.verdicts.map((v) => `${v.v.seq}:${v.v.body.kind}`),
        rejected: r.rejected.map((x) => `${x.player}:${rejectName(x.reason)}`),
        refused: r.refused.map((x) => `${x.player}:${refuseName(x.reason)}`),
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
      // The hints of the last tick get their lines now, while `end` can still log the receipts.
      // One the Handler could not voice is dropped before `end` is asked: voiced after End, its
      // line would have no receipt in the log. Dropped first, so `end` asked again (its answer
      // lost) is passed the same receipts, and answers with the End it recorded.
      await this.voicePending(matchId);
      const unvoiced = this.d.store.voiceHints(matchId, "pending").map((h) => h.id);
      if (unvoiced.length) {
        this.leasedTx(matchId, () => this.d.store.setVoiceStatus(unvoiced, "dropped"));
        this.d.log.warn({ matchId, hints: unvoiced.length }, "hints not voiced before End are dropped");
      }
      const voiced = this.d.store.voiceHints(matchId, "voiced");
      const r = await this.d.referee.end({
        matchId: idBytes(matchId),
        state: m.state,
        lastSeq: m.last_seq,
        receipts: voiced.flatMap((h) => (h.receipt ? [h.receipt] : [])),
      });
      const end = r.verdicts.find((v) => v.v.body.kind === "End")?.v.body;
      if (end?.kind !== "End") throw new Error("referee end returned no End verdict");
      // End anchors the log up to its own entry: the receipts `end` logs come before it, the
      // End verdict's own entry after. The anchor check covers exactly that prefix.
      this.checkLog(matchId, r.leaves, r.verdicts, r.proofs);
      this.leasedTx(matchId, () => {
        this.d.store.setState(matchId, r.state, m?.tick_no ?? 0);
        this.d.store.appendLog(matchId, r);
        this.storeVerdicts(matchId, r.verdicts, r.proofs);
        this.d.store.setVoiceStatus(
          voiced.map((h) => h.id),
          "consumed",
        );
      });
      this.d.log.info({ matchId, verdicts: r.verdicts.map((v) => `${v.v.seq}:${v.v.body.kind}`) }, "end");
    }
    if (!(await this.flushVerdicts(matchId))) return false;
    // The match's secrets are released only once End is final on chain: until then the block
    // holding it could be dropped, and End would have to go again.
    if (this.d.store.pendingVerdicts(matchId).length) return false;
    m = this.d.store.match(matchId);
    if (!m?.reveal) {
      const d = await this.d.referee.declassify(idBytes(matchId), this.d.store.logSealed(matchId));
      this.checkDeclassified(matchId, d.log);
      this.d.store.tx(() => {
        this.d.store.putLog(matchId, d.log);
        this.d.store.setReveal(matchId, d.reveal);
      });
    }
    if (!m?.trails_done) await this.declassifyTrails(matchId);
    this.d.store.setPhase(matchId, "ended");
    for (const player of (m?.players ?? []).keys())
      this.d.hub.send(matchId, player, { type: "over", match_id: matchId });
    this.d.log.info({ matchId }, "match settled and declassified");
    return true;
  }

  /**
   * Checks the stored leaves plus `added`: that they number `whole.size` and have Merkle root
   * `whole.root` when the referee reports the whole log (a tick does), and that every
   * Checkpoint/End in `verdicts` anchors a prefix of them with a consistency proof the contract
   * will accept. Throws before anything is stored, so the step is retried rather than building on
   * a broken copy, and a verdict the contract would refuse never stalls the match.
   */
  private checkLog(
    matchId: string,
    added: Uint8Array[],
    verdicts: RawVerdict[],
    proofs: VerdictProof[],
    whole?: { size: number; root: Uint8Array },
  ) {
    const leaves = [...this.d.store.leaves(matchId), ...added];
    if (whole && leaves.length !== whole.size)
      throw new Error(`log copy has ${leaves.length} leaves, referee says ${whole.size}`);
    if (whole && !equal(merkleRoot(leaves), whole.root))
      throw new Error("log copy does not match the referee's root");
    let from = this.anchoredSize(matchId);
    const anchors = verdicts.flatMap(({ v }) =>
      v.body.kind === "Checkpoint" || v.body.kind === "End"
        ? [{ seq: v.seq, size: Number(v.body.logSize), root: v.body.root }]
        : [],
    );
    for (const a of anchors) {
      const p = proofs.filter((x) => x.seq === a.seq);
      if (p.length !== 1 || !p[0]) throw new Error(`verdict ${a.seq} has ${p.length} consistency proofs`);
      if (p[0].fromSize !== from)
        throw new Error(`verdict ${a.seq}'s proof starts at ${p[0].fromSize}, the chain anchored ${from}`);
      if (a.size > leaves.length || !equal(merkleRoot(leaves.slice(0, a.size)), a.root))
        throw new Error(`verdict ${a.seq} anchors a root that is not the relay's log`);
      if (!verifyConsistency(from, a.size, merkleRoot(leaves.slice(0, from)), a.root, p[0].path))
        throw new Error(`verdict ${a.seq}'s consistency proof does not verify`);
      from = a.size;
    }
    if (proofs.length !== anchors.length) throw new Error("a consistency proof names no Checkpoint or End");
  }

  /** The log size of the match's last stored Checkpoint/End (what the contract anchors), or 0. */
  private anchoredSize(matchId: string): number {
    let size = 0;
    for (const v of this.d.store.verdicts(matchId)) {
      if (v.kind !== "Checkpoint" && v.kind !== "End") continue;
      const body = decodeSignedVerdict(v.raw).body;
      if (body.kind === "Checkpoint" || body.kind === "End") size = Number(body.logSize);
    }
    return size;
  }

  /** The declassified log must be exactly the entries behind the leaves the relay kept. */
  private checkDeclassified(matchId: string, log: Uint8Array[]) {
    const leaves = this.d.store.leaves(matchId);
    if (log.length !== leaves.length)
      throw new Error(`declassified log has ${log.length} entries, the relay holds ${leaves.length} leaves`);
    for (const [i, e] of log.entries()) {
      if (!equal(merkleLeaf(decodeLogEntry(e)), leaves[i] as Uint8Array))
        throw new Error(`declassified entry ${i} does not hash to its leaf`);
    }
  }

  /**
   * Has the referee open every sealed batch the relay forwarded, and keeps, with the assertion
   * each arrived with, those the log names: each LogEntry::Batch once (the trails), and each
   * distinct envelope a LogEntry::Rejected names, so a verifier can recompute the refusal. An
   * envelope the log does not name (bytes that never opened into this match's batch) is dropped.
   */
  private async declassifyTrails(matchId: string) {
    const m = this.d.store.match(matchId);
    if (!m?.state) throw new Error("ended match has no End state");
    const accepted = new Set<string>();
    const rejected = new Set<string>();
    for (const e of this.d.store.log(matchId)) {
      const entry = decodeLogEntry(e);
      if (entry.kind === "Batch") accepted.add(toHex(entry.hash));
      if (entry.kind === "Rejected") rejected.add(toHex(entry.hash));
    }
    const sealed = this.d.store.allBatches(matchId).map((b) => b.sealed);
    const kept: Trail[] = [];
    const trailed = new Set<string>();
    const envelopes = new Set<string>();
    for (let i = 0; i < sealed.length; i += MAX_DECLASSIFY_BATCHES) {
      const r = await this.d.referee.declassifyBatches({
        matchId: idBytes(matchId),
        state: m.state,
        sealed: sealed.slice(i, i + MAX_DECLASSIFY_BATCHES),
      });
      for (const [k, batch] of r.batches.entries()) {
        const hash = toHex(sha256(batch));
        const assertion = r.assertions?.[k] ?? null;
        // A batch sent twice (a resend) opens twice: the trail keeps it once, and a verifier
        // needs another copy only when it came with a different assertion.
        const envelope = `${hash}:${assertion ? toHex(assertion) : ""}`;
        if (envelopes.has(envelope)) continue;
        if (accepted.has(hash) && !trailed.has(hash)) {
          trailed.add(hash);
          envelopes.add(envelope);
          kept.push({ batch, assertion, rejected: false });
        } else if (rejected.has(hash) && assertion) {
          envelopes.add(envelope);
          kept.push({ batch, assertion, rejected: true });
        }
      }
    }
    this.d.store.putTrails(matchId, kept);
    this.d.log.info(
      {
        matchId,
        sent: sealed.length,
        kept: trailed.size,
        refused: kept.length - trailed.size,
        notReturned: accepted.size - trailed.size,
      },
      "trails declassified",
    );
  }

  private storeVerdicts(matchId: string, verdicts: RawVerdict[], proofs: VerdictProof[]) {
    for (const { raw, v } of verdicts) {
      const proof = proofs.find((p) => p.seq === v.seq) ?? null;
      this.d.store.putVerdict(matchId, {
        seq: v.seq,
        kind: v.body.kind,
        raw,
        callId: hexId(v.callId),
        proof,
      });
    }
  }

  /**
   * Submits stored verdicts not yet on chain, in seq order. The chain's own seq decides what is
   * left to send, so retrying after an unclear result (timeout, lost answer) is always safe.
   * Returns true when nothing is left to send. A verdict counts as applied (no longer pending)
   * only once a `final` read shows it; until then each flush checks it again, so one in an
   * optimistic block that was dropped is sent again rather than leaving a gap.
   */
  async flushVerdicts(matchId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const pending = this.d.store.pendingVerdicts(matchId);
      if (!pending.length) return true;
      const chain = await this.d.chain.getMatch(matchId);
      if (!chain) throw new Error("match vanished from chain");
      this.d.store.setLastSeq(matchId, chain.seq);
      const left = pending.filter((v) => v.seq > chain.seq);
      if (!left.length) {
        const final = await this.d.chain.getMatch(matchId, "final");
        if (final) this.d.store.markApplied(matchId, final.seq, this.now());
        return true;
      }
      if (left[0]?.seq !== chain.seq + 1) {
        this.d.log.error({ matchId, chainSeq: chain.seq, next: left[0]?.seq }, "verdict gap; cannot apply");
        return false;
      }
      const batch = left.slice(0, MAX_VERDICTS_PER_APPLY);
      try {
        const tx = await this.d.chain.apply(
          batch.map((v) => v.raw),
          batch.flatMap((v) =>
            v.proof ? [{ seq: v.seq, from_size: String(v.proof.fromSize), path: v.proof.path.map(b64) }] : [],
          ),
        );
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

  /**
   * Has the referee voice each issued hint. The line comes back sealed and signed for the asker,
   * so it goes to the asker's HUD sockets only; its receipt goes into the next tick.
   */
  private async voicePending(matchId: string) {
    for (const h of this.d.store.voiceHints(matchId, "pending")) {
      if (this.now() - h.issued_ms > VOICE_WINDOW_MS) {
        this.d.store.setVoiceStatus([h.id], "dropped");
        continue;
      }
      const state = this.d.store.match(matchId)?.state;
      if (!state) return;
      try {
        const v = await this.d.referee.voice({ state, blob: h.blob });
        if (v.player !== h.asker) {
          this.d.log.error({ matchId, asker: h.asker, player: v.player }, "voice answered another player");
          this.d.store.setVoiceStatus([h.id], "dropped");
          continue;
        }
        this.d.store.setVoiced(h.id, {
          sealed: v.sealed,
          signedText: v.signedText,
          hintId: v.hintId,
          receipt: v.receipt,
        });
        this.d.hub.send(matchId, h.asker, { type: "handler", match_id: matchId, sealed: b64(v.sealed) });
      } catch (e) {
        this.d.log.warn({ matchId, hint: h.id, err: (e as Error).message }, "voice failed; will retry");
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
