// In-memory stand-ins for the chain and the referee, behind the same interfaces the relay uses
// (near.ts `Chain`, referee.ts `Referee`). They keep the rules the relay depends on: the chain
// applies verdicts only in seq order; the referee refuses a state whose seq is not last_seq, and
// reports the log size and root so the relay's copy can be checked.

import { ed25519 } from "@noble/curves/ed25519.js";
import { createLogger } from "@tail/log";
import {
  encodeLogEntry,
  encodeSignedVerdict,
  type LogEntry,
  merkleLeaf,
  merkleRoot,
  sha256,
  sortAccounts,
  type Verdict,
} from "@tail/protocol";
import type { Store } from "../src/db.ts";
import type { Chain, ChainMatch, ChainRoots, ContractConfig, MatchCfg } from "../src/near.ts";
import {
  type DeclassifyBatchesInput,
  type DeclassifyBatchesResult,
  type EndInput,
  type EndResult,
  type EnrollInput,
  type EnrollResult,
  type RawVerdict,
  type Referee,
  RefereeError,
  type RefereeKeys,
  type StartInput,
  type StartResult,
  type TickInput,
  type TickResult,
  type VoiceInput,
  type VoiceResult,
} from "../src/referee.ts";

export const quietLog = () => {
  const log = createLogger("relay-test");
  log.level = "silent";
  return log;
};

export class FakeChain implements Chain {
  matches = new Map<string, ChainMatch>();
  accounts = new Map<string, Uint8Array>();
  applied: Uint8Array[] = [];
  applyCalls = 0;
  /** Next apply throws without touching state (a refused or failed submission). */
  failNextApply = false;
  /** Next apply lands on chain but the caller sees an error (a lost RPC answer). */
  loseNextApplyAnswer = false;
  locked: string[] = [];
  /** Internal contract balances of the one test token, by account. */
  balances = new Map<string, bigint>();
  topUps: { accountId: string; amount: bigint }[] = [];
  private n = 0;

  async config(): Promise<ContractConfig> {
    return {
      owner: "relay.testnet",
      referee_pk: "00".repeat(32),
      vrf_pk: "00".repeat(32),
      allowed_tokens: ["usdc.fakes.testnet"],
      match_storage_deposit: "1",
      registration_deposit: "1",
      min_players: 3,
      max_players: 12,
      max_duration_ms: 3_600_000,
    };
  }
  async accountExists(id: string) {
    return this.accounts.has(id);
  }
  async createPlayerAccount(id: string, nearPk: Uint8Array) {
    this.accounts.set(id, nearPk);
  }
  async createMatch(cfg: MatchCfg) {
    const id = (++this.n).toString(16).padStart(32, "0");
    this.matches.set(id, {
      match_id: id,
      host: "relay.testnet",
      token: cfg.token,
      stake: cfg.stake,
      duration_ms: cfg.duration_ms,
      zone_hash: cfg.zone_hash,
      public_replay: cfg.public_replay,
      min_players: cfg.min_players,
      max_players: cfg.max_players,
      start_by_ms: cfg.start_by_ms,
      phase: "lobby",
      players: [],
      invites: cfg.invites,
      locked_until_ms: null,
      sponsor_pot: "0",
      seq: 0,
      referee_pk: "",
      vrf_pk: "",
      ring_commit: null,
      start_ms: null,
      end_ms: null,
      alpha: null,
      vrf_signature: null,
    });
    return id;
  }
  join(matchId: string, account: string) {
    const m = this.matches.get(matchId);
    if (m?.phase !== "lobby" || m.locked_until_ms !== null) throw new Error("not joinable");
    if (m.players.length >= m.max_players) throw new Error("match is full");
    m.players.push({ account_id: account, head: m.stake, out: false, paid: "0" });
    const order = sortAccounts(m.players.map((p) => p.account_id));
    m.players.sort((a, b) => order.indexOf(a.account_id) - order.indexOf(b.account_id));
  }
  /** The lobby is called off on chain (start_by passed or the host aborted); stakes go back. */
  abort(matchId: string) {
    const m = this.matches.get(matchId);
    if (m?.phase !== "lobby") throw new Error("only a lobby can be called off");
    m.phase = "aborted";
  }
  async lockLobby(matchId: string) {
    const m = this.matches.get(matchId);
    if (m?.phase !== "lobby" || m.locked_until_ms !== null) throw new Error("lobby is not open");
    m.locked_until_ms = Date.now() + 600_000;
    this.locked.push(matchId);
  }
  async getMatch(id: string) {
    const m = this.matches.get(id);
    return m ? structuredClone(m) : null;
  }
  async getRoots(): Promise<ChainRoots> {
    return { checkpoints: [], final_root: null };
  }
  async getHeads(id: string) {
    return this.matches.get(id)?.players.map((p) => p.head) ?? null;
  }
  async getBalance(accountId: string) {
    return this.balances.get(accountId) ?? 0n;
  }
  async apply(verdicts: Uint8Array[]) {
    this.applyCalls++;
    if (this.failNextApply) {
      this.failNextApply = false;
      throw new Error("apply failed");
    }
    // Every raw verdict here starts with the 16-byte match id, then u32le seq, as borsh lays it out.
    for (const raw of verdicts) {
      const id = Buffer.from(raw.slice(0, 16)).toString("hex");
      const seq = new DataView(raw.buffer, raw.byteOffset + 16, 4).getUint32(0, true);
      const m = this.matches.get(id);
      if (!m) throw new Error("no such match");
      if (seq !== m.seq + 1) throw new Error("verdict out of order");
      m.seq = seq;
      const kind = raw[36];
      if (kind === 0) m.phase = "running";
      if (kind === 5) m.phase = "ended";
      this.applied.push(raw);
    }
    if (this.loseNextApplyAnswer) {
      this.loseNextApplyAnswer = false;
      throw new Error("timeout waiting for the transaction");
    }
    return `tx${this.applyCalls}`;
  }
  async topUp(accountId: string, amount: bigint) {
    this.topUps.push({ accountId, amount });
    this.balances.set(accountId, (this.balances.get(accountId) ?? 0n) + amount);
  }
  /** As the contract's join_match: the account's own key, invites, a free seat, the stake debited. */
  async joinAsGhost(accountId: string, nearSeed: Uint8Array, matchId: string) {
    const key = this.accounts.get(accountId);
    if (!key || Buffer.compare(key, ed25519.getPublicKey(nearSeed)) !== 0) throw new Error("wrong key");
    const m = this.matches.get(matchId);
    if (!m) throw new Error("no such match");
    if (m.invites.length > 0 && !m.invites.includes(accountId)) throw new Error("not invited");
    const balance = this.balances.get(accountId) ?? 0n;
    if (balance < BigInt(m.stake)) throw new Error("balance too low");
    this.join(matchId, accountId);
    this.balances.set(accountId, balance - BigInt(m.stake));
  }
}

/** Referee whose rules are a script: `onTick` decides what each tick returns. */
export class FakeReferee implements Referee {
  calls: string[] = [];
  /** Throw a transport error on the next N tick calls. */
  failTicks = 0;
  /** Throw a transport error on the next N enroll calls (the referee not answering). */
  failEnrolls = 0;
  /** Corrupt the next tick's reported log root. */
  lieAboutLog = false;
  tickDelayMs = 0;
  inFlight = 0;
  maxInFlight = 0;
  ticksSeen: { batches: number; receipts: number }[] = [];
  /** Tick number at which the match is over. */
  overAt = 3;
  private seq = new Map<string, number>();
  private log = new Map<string, LogEntry[]>();
  private tickNo = new Map<string, number>();
  private hintAtTick = 2;

  private verdict(matchId: Uint8Array, body: Verdict): RawVerdict {
    const key = Buffer.from(matchId).toString("hex");
    const seq = (this.seq.get(key) ?? 0) + 1;
    this.seq.set(key, seq);
    const v = { matchId, seq, callId: new Uint8Array(16), body, sig: new Uint8Array(64) };
    this.addLog(key, { kind: "Verdict", seq, digest: new Uint8Array(32).fill(seq) });
    return { raw: encodeSignedVerdict(v), v };
  }
  private addLog(key: string, e: LogEntry) {
    const l = this.log.get(key) ?? [];
    l.push(e);
    this.log.set(key, l);
    return encodeLogEntry(e);
  }
  private state(key: string) {
    return new TextEncoder().encode(`state:${key}:${this.seq.get(key) ?? 0}`);
  }
  private checkState(key: string, state: Uint8Array, lastSeq: number) {
    if (new TextDecoder().decode(state) !== `state:${key}:${lastSeq}`) {
      throw new RefereeError("tick", "state seq is not last_seq", true);
    }
  }

  async pubkeys(): Promise<RefereeKeys> {
    this.calls.push("pubkeys");
    const z = new Uint8Array(32);
    return { refereePk: z, refereeBoxPk: z, boxPkSig: new Uint8Array(64), vrfPk: z };
  }
  async enroll(i: EnrollInput): Promise<EnrollResult> {
    this.calls.push("enroll");
    if (this.failEnrolls > 0) {
      this.failEnrolls--;
      throw new RefereeError("enroll", "request failed: The operation timed out.", false);
    }
    return {
      callId: "call-enroll",
      appAttestPk: i.appAttestPk,
      receipt: new Uint8Array(8),
      sig: new Uint8Array(64),
    };
  }
  async start(i: StartInput): Promise<StartResult> {
    this.calls.push("start");
    const key = Buffer.from(i.matchId).toString("hex");
    const players = sortAccounts(i.players);
    const v = this.verdict(i.matchId, {
      kind: "Start",
      playersHash: new Uint8Array(32),
      ringCommit: new Uint8Array(32),
      startMs: BigInt(i.startMs),
      endMs: BigInt(i.startMs + i.durationMs),
    });
    const log = [encodeLogEntry((this.log.get(key) ?? []).at(-1) as LogEntry)];
    return {
      callId: "call-start",
      startMs: i.startMs,
      endMs: i.startMs + i.durationMs,
      verdicts: [v],
      keys: players.map((a, player) => ({ player, accountId: a, sealed: new Uint8Array([player]) })),
      state: this.state(key),
      log,
    };
  }
  async tick(i: TickInput): Promise<TickResult> {
    this.calls.push("tick");
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.tickDelayMs) await Bun.sleep(this.tickDelayMs);
      if (this.failTicks > 0) {
        this.failTicks--;
        throw new RefereeError("tick", "request failed: timeout", false);
      }
      const key = Buffer.from(i.matchId).toString("hex");
      this.checkState(key, i.state, i.lastSeq);
      // A real referee keeps nothing from a call whose answer the relay throws away; this fake
      // remembers where it was so a discarded (lying) tick can be undone.
      const undo = {
        seq: this.seq.get(key) ?? 0,
        log: (this.log.get(key) ?? []).length,
        tick: this.tickNo.get(key) ?? 0,
      };
      this.ticksSeen.push({ batches: i.batches.length, receipts: i.receipts.length });
      const tickNo = (this.tickNo.get(key) ?? 0) + 1;
      const before = (this.log.get(key) ?? []).length;
      // The fake "opens" a sealed batch to its own bytes, so its log hash is SHA256 of them.
      for (const [k, sealed] of i.batches.entries()) {
        this.addLog(key, { kind: "Batch", player: 0, seq: k, hash: sha256(sealed) });
      }
      const verdicts: RawVerdict[] = [];
      const hints: TickResult["hints"] = [];
      if (tickNo === this.hintAtTick) {
        verdicts.push(this.verdict(i.matchId, { kind: "Hint", from: 0, to: 1, amount: 100n, hintId: 0 }));
        hints.push({ hintId: 0, from: 0, to: 1, hint: 0, value: 1, text: "close?" });
      }
      for (const _ of i.receipts) {
        this.addLog(key, {
          kind: "HintReceipt",
          hintId: 0,
          chatId: "c",
          textHash: new Uint8Array(32),
          signature: new Uint8Array(1),
          signingAddress: "0x",
        });
      }
      const all = this.log.get(key) ?? [];
      const added = all.slice(before).map(encodeLogEntry);
      this.tickNo.set(key, tickNo);
      const root = merkleRoot(all.map(merkleLeaf));
      if (this.lieAboutLog) {
        this.lieAboutLog = false;
        root[0] = (root[0] as number) ^ 1;
        this.seq.set(key, undo.seq);
        this.log.set(key, all.slice(0, undo.log));
        this.tickNo.set(key, undo.tick);
        this.ticksSeen.pop();
      }
      return {
        callId: `call-tick-${tickNo}`,
        tickNo,
        nowMs: Date.now(),
        seq: this.seq.get(key) ?? 0,
        state: this.state(key),
        verdicts,
        huds: [0, 1, 2].map((player) => ({ player, sealed: new Uint8Array([tickNo, player]) })),
        log: added,
        logSize: all.length,
        logRoot: root,
        unopened: [],
        rejected: [],
        refused: [],
        hints,
        over: tickNo >= this.overAt,
      };
    } finally {
      this.inFlight--;
    }
  }
  async voice(i: VoiceInput): Promise<VoiceResult> {
    this.calls.push("voice");
    return {
      text: `line for hint ${i.hintId}`,
      source: "template",
      receipt: new Uint8Array([1, 2, 3]),
      chatId: null,
      model: null,
    };
  }
  async end(i: EndInput): Promise<EndResult> {
    this.calls.push("end");
    const key = Buffer.from(i.matchId).toString("hex");
    this.checkState(key, i.state, i.lastSeq);
    const before = this.log.get(key) ?? [];
    const size = before.length;
    const root = merkleRoot(before.map(merkleLeaf));
    const v = this.verdict(i.matchId, {
      kind: "End",
      alpha: "vrf:1:x:y",
      vrfSignature: new Uint8Array(64),
      logSize: BigInt(size),
      root,
    });
    return {
      callId: "call-end",
      verdicts: [v],
      logSize: size,
      root,
      state: this.state(key),
      log: [encodeLogEntry((this.log.get(key) ?? []).at(-1) as LogEntry)],
    };
  }
  declassifyChunks: number[] = [];
  async declassifyBatches(i: DeclassifyBatchesInput): Promise<DeclassifyBatchesResult> {
    this.calls.push("declassify_batches");
    this.declassifyChunks.push(i.sealed.length);
    // Every sealed batch opens to its own bytes, plus one the log never accepted.
    return { batches: [...i.sealed, new Uint8Array([9, 9, 9])], refused: [] };
  }
  async declassify(): Promise<Record<string, unknown>> {
    this.calls.push("declassify");
    return { ring: ["a", "b", "c"], k_m: "00", vrf_alpha: "vrf:1:x:y", vrf_signature: "00".repeat(64) };
  }
}

/** Polls `f` until it returns a truthy value or the deadline passes. No fixed sleeps. */
export async function until<T>(f: () => T | Promise<T>, what: string, ms = 5_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

export function seedDevice(
  store: Store,
  accountId: string,
  nearPk: Uint8Array,
  kind: "phone" | "ghost" = "phone",
  /** False: enrolled here, not yet registered with the referee. */
  withReferee = true,
) {
  store.putDevice({
    account_id: accountId,
    kind,
    app_attest_pk: new Uint8Array(65),
    player_box_pk: new Uint8Array(32),
    near_pk: nearPk,
    receipt: withReferee ? new Uint8Array(1) : null,
    receipt_sig: withReferee ? new Uint8Array(64) : null,
    enroll_call_id: withReferee ? "c" : null,
    created_ms: 0,
  });
}
