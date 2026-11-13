// In-memory stand-ins for the chain and the referee, behind the same interfaces the relay uses
// (near.ts `Chain`, referee.ts `Referee`). They keep the rules the relay depends on, in protocol
// v2 shapes: the chain applies verdicts only in seq order, each chained to the one before by
// `prev`, and each Checkpoint/End only with a consistency proof from the root it last anchored;
// the referee refuses a state whose seq is not last_seq, signs what it seals to phones, hands
// out the log as leaf hashes plus entries sealed to itself, and reports the log size and root so
// the relay's leaves can be checked.

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { createLogger } from "@tail/log";
import {
  type Batch,
  batchHash,
  concat,
  consistencyProof,
  decodeBatchEnvelope,
  decodeSignedVerdict,
  deriveLogKey,
  derivePlayerKey,
  deriveTagKey,
  encodeBatch,
  encodeLogEntry,
  encodeSignedVerdict,
  equal,
  fromHex,
  type Hud,
  type LogEntry,
  logEntrySalt,
  logSalt,
  merkleLeaf,
  merkleRoot,
  open,
  Reader,
  readLogEntry,
  rebindDigest,
  SealContext,
  seal,
  sealSignedHud,
  sealSignedPlayerKeys,
  sealSignedVoiceLine,
  sha256,
  signHud,
  signPlayerKeys,
  signVerdict,
  signVoiceLine,
  sortAccounts,
  toHex,
  utf8,
  type Verdict,
  verdictDigest,
  verifyConsistency,
  Writer,
  writeLogEntry,
} from "@tail/protocol";
import type { Store } from "../src/db.ts";
import type {
  ApplyProof,
  Chain,
  ChainMatch,
  ChainRoots,
  ContractConfig,
  Finality,
  MatchCfg,
} from "../src/near.ts";
import {
  type DeclassifyBatchesInput,
  type DeclassifyBatchesResult,
  type DeclassifyResult,
  type EndInput,
  type EndResult,
  type EnrollInput,
  type EnrollResult,
  type HeldDevice,
  type LogAppend,
  type RawVerdict,
  type Referee,
  RefereeError,
  type RefereeKeys,
  type StartInput,
  type StartResult,
  type TickInput,
  type TickResult,
  type VerdictProof,
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
  /** The proofs each apply call carried, in call order. */
  proofs: ApplyProof[][] = [];
  applyCalls = 0;
  /** Next apply throws without touching state (a refused or failed submission). */
  failNextApply = false;
  /** Next apply lands on chain but the caller sees an error (a lost RPC answer). */
  loseNextApplyAnswer = false;
  locked: string[] = [];
  /** Internal contract balances of the one test token, by account. */
  balances = new Map<string, bigint>();
  topUps: { accountId: string; amount: bigint }[] = [];
  /**
   * What `mint_dossier` costs; null for a contract from before dossiers, whose get_config has no
   * dossier_deposit and which has no dossier methods.
   */
  dossierDeposit: string | null = null;
  /**
   * What the contract pins now and copies into each match at `create_match`: the referee keys
   * (hex) and the VRF caller. The harness pins the referee of the relay it sets up.
   */
  pins = { referee_pk: "00".repeat(32), vrf_pk: "00".repeat(32), vrf_sender: "relay.testnet" };
  /** Accounts holding their dossier. Registration mints one once the contract has dossiers. */
  dossiers = new Set<string>();
  /** Each mint_dossier call that landed, in order. */
  minted: string[] = [];
  /** Per match, as the contract keeps it: the last verdict's digest and the last anchored log. */
  private chainTip = new Map<string, { digest: Uint8Array; size: number; root: Uint8Array }>();
  private roots = new Map<string, ChainRoots>();
  private n = 0;

  async config(): Promise<ContractConfig> {
    return {
      owner: "relay.testnet",
      ...this.pins,
      allowed_tokens: ["usdc.fakes.testnet"],
      match_storage_deposit: "1",
      registration_deposit: "1",
      min_players: 3,
      max_players: 12,
      max_duration_ms: 3_600_000,
      ...(this.dossierDeposit === null ? {} : { dossier_deposit: this.dossierDeposit }),
    };
  }
  async accountExists(id: string) {
    return this.accounts.has(id);
  }
  async createPlayerAccount(id: string, nearPk: Uint8Array) {
    this.accounts.set(id, nearPk);
    // As register_for on a contract with dossiers.
    if (this.dossierDeposit !== null) this.dossiers.add(id);
  }
  private dossierMethod(name: string) {
    if (this.dossierDeposit === null) throw new Error(`MethodNotFound: ${name}`);
    return BigInt(this.dossierDeposit);
  }
  async dossierStatus(id: string) {
    this.dossierMethod("get_dossier");
    if (!this.accounts.has(id)) return "unregistered" as const;
    return this.dossiers.has(id) ? ("held" as const) : ("missing" as const);
  }
  /** As the contract's mint_dossier, called by the relay (owner "relay.testnet"). */
  async mintDossier(id: string, deposit: bigint) {
    if (deposit !== this.dossierMethod("mint_dossier"))
      throw new Error("attach exactly dossier_deposit (see get_config)");
    const handle = id.endsWith(".relay.testnet") ? id.slice(0, -".relay.testnet".length) : "";
    if (!handle || handle.includes("."))
      throw new Error("only the account or its parent can mint its dossier");
    if (!this.accounts.has(id)) throw new Error("account not registered");
    if (this.dossiers.has(id)) throw new Error("this account already has a dossier");
    this.dossiers.add(id);
    this.minted.push(id);
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
      ...this.pins,
      ring_commit: null,
      start_ms: null,
      end_ms: null,
      alpha: null,
      vrf_signature: null,
      requires: cfg.requires ?? null,
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
  async getMatch(id: string, finality: Finality = "optimistic") {
    if (finality === "final" && this.unfinal?.id === id) return structuredClone(this.unfinal.match);
    const m = this.matches.get(id);
    return m ? structuredClone(m) : null;
  }
  /**
   * The next apply lands only in an optimistic block: `optimistic` reads show it, `final` reads
   * do not, and `dropUnfinal()` drops it as a fork would.
   */
  nextApplyUnfinal = false;
  private unfinal: {
    id: string;
    match: ChainMatch;
    tip: { digest: Uint8Array; size: number; root: Uint8Array } | undefined;
    roots: ChainRoots | undefined;
    applied: number;
  } | null = null;
  /** The optimistic block of the last unfinal apply is dropped: the chain is as before it. */
  dropUnfinal() {
    const u = this.unfinal;
    if (!u) throw new Error("no unfinal apply to drop");
    this.matches.set(u.id, u.match);
    if (u.tip) this.chainTip.set(u.id, u.tip);
    else this.chainTip.delete(u.id);
    if (u.roots) this.roots.set(u.id, u.roots);
    else this.roots.delete(u.id);
    this.applied.length = u.applied;
    this.unfinal = null;
  }
  async getRoots(id: string): Promise<ChainRoots> {
    return structuredClone(this.roots.get(id) ?? { checkpoints: [], final_root: null });
  }
  async getHeads(id: string) {
    return this.matches.get(id)?.players.map((p) => p.head) ?? null;
  }
  async getBalance(accountId: string) {
    return this.balances.get(accountId) ?? 0n;
  }
  /**
   * As the contract's `apply`: all or nothing. Each verdict must be the match's next seq and name
   * the previous verdict's digest as `prev`; each Checkpoint/End must come with a consistency
   * proof from the last anchored (size, root), size 0 and the empty root for the first.
   */
  async apply(verdicts: Uint8Array[], proofs: ApplyProof[]) {
    this.applyCalls++;
    if (this.failNextApply) {
      this.failNextApply = false;
      throw new Error("apply failed");
    }
    const tips = new Map(this.chainTip);
    const seqs = new Map<string, number>();
    const decoded = verdicts.map((raw) => ({ raw, v: decodeSignedVerdict(raw) }));
    for (const { v } of decoded) {
      const id = toHex(v.matchId);
      const m = this.matches.get(id);
      if (!m) throw new Error("no such match");
      const seq = seqs.get(id) ?? m.seq;
      if (v.seq !== seq + 1) throw new Error("verdict out of order");
      const tip = tips.get(id) ?? { digest: new Uint8Array(32), size: 0, root: merkleRoot([]) };
      if (!equal(v.prev, tip.digest)) throw new Error("verdict does not chain to the last one");
      let next = { ...tip, digest: verdictDigest(v) };
      if (v.body.kind === "Checkpoint" || v.body.kind === "End") {
        const p = proofs.find((x) => x.seq === v.seq);
        const size = Number(v.body.logSize);
        const path = (p?.path ?? []).map((h) => new Uint8Array(Buffer.from(h, "base64")));
        if (
          !p ||
          Number(p.from_size) !== tip.size ||
          !verifyConsistency(tip.size, size, tip.root, v.body.root, path)
        )
          throw new Error(`verdict ${v.seq}: missing or bad consistency proof`);
        next = { ...next, size, root: v.body.root };
      }
      tips.set(id, next);
      seqs.set(id, v.seq);
    }
    this.proofs.push(proofs);
    if (this.nextApplyUnfinal) {
      this.nextApplyUnfinal = false;
      const id = toHex((decoded[0] as { v: { matchId: Uint8Array } }).v.matchId);
      this.unfinal = {
        id,
        match: structuredClone(this.matches.get(id) as ChainMatch),
        tip: this.chainTip.get(id),
        roots: structuredClone(this.roots.get(id)),
        applied: this.applied.length,
      };
    }
    for (const { raw, v } of decoded) {
      const id = toHex(v.matchId);
      const m = this.matches.get(id) as ChainMatch;
      m.seq = v.seq;
      if (v.body.kind === "Start") m.phase = "running";
      const r = this.roots.get(id) ?? { checkpoints: [], final_root: null };
      if (v.body.kind === "Checkpoint")
        r.checkpoints.push({ log_size: Number(v.body.logSize), root: toHex(v.body.root) });
      if (v.body.kind === "End") {
        m.phase = "ended";
        r.final_root = { log_size: Number(v.body.logSize), root: toHex(v.body.root) };
      }
      this.roots.set(id, r);
      this.applied.push(raw);
    }
    for (const [id, t] of tips) this.chainTip.set(id, t);
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

/** The fake referee's own seal contexts: what it seals to itself, opaque to the relay. */
const FAKE_LOG = "fake-referee/log";
const FAKE_HINT = "fake-referee/hint";
/** What the fake referee charges for any hint, and shows on every HUD's price board. */
const FAKE_HINT_PRICE = 100n;

/** The device record the referee keeps per account (crates/referee-wasi records.rs `Device`). */
export interface FakeDevice {
  appAttestPk: Uint8Array;
  playerBoxPk: Uint8Array;
  nearPk: Uint8Array;
  attested: boolean;
  receipt: Uint8Array;
}

interface FakeMatch {
  matchId: Uint8Array;
  players: string[];
  km: Uint8Array;
  startMs: number;
  seq: number;
  prev: Uint8Array;
  leaves: Uint8Array[];
  /** Log size and root of the last Checkpoint/End. */
  anchored: number;
  tickNo: number;
  nextSeq: number[];
  chainTip: Uint8Array[];
  nextHintId: number;
  /** Whom each hint was about, in order: End's hintTargets. */
  hintTargets: number[];
}

/**
 * Referee whose rules are a script: `onTick` decides what each tick returns. A sealed batch that
 * opens with its box key (what ghosts send) is logged as the batch it is, and its Hint actions
 * are charged; bytes that do not open (what queue tests send) stand in for a batch whose hash is
 * SHA256 of the bytes, and declassify back to themselves.
 */
export class FakeReferee implements Referee {
  readonly sk = ed25519.utils.randomSecretKey();
  readonly pk = ed25519.getPublicKey(this.sk);
  readonly boxSk = x25519.utils.randomSecretKey();
  readonly boxPk = x25519.getPublicKey(this.boxSk);
  /** Each account's box key, as the real referee has it from enrolment; the harness reads the store. */
  boxPkOf: (account: string) => Uint8Array | undefined = () => undefined;
  calls: string[] = [];
  /** Every enroll input, as the relay sent it. */
  enrolls: EnrollInput[] = [];
  /** Throw a transport error on the next N tick calls. */
  failTicks = 0;
  /** Throw a transport error on the next N enroll calls (the referee not answering). */
  failEnrolls = 0;
  /** Throw a transport error on the next N voice calls (the Handler not answering in time). */
  failVoices = 0;
  /** The next `end` is recorded, as the referee records it, but its answer is lost on the way. */
  loseNextEndAnswer = false;
  /** Per match, the End recorded and the input it was made from: a repeat gets it back. */
  private ended = new Map<string, { input: string; result: EndResult }>();
  /** Refuse `start`, as the referee refuses a match id it started before. */
  refuseStart = false;
  /** Refuse the next N enroll calls, as the referee refuses an attestation it does not accept. */
  refuseEnrolls = 0;
  /** Corrupt the next tick's reported log root. */
  lieAboutLog = false;
  /** Hand out a bad consistency proof with the next Checkpoint/End. */
  lieAboutProof = false;
  tickDelayMs = 0;
  inFlight = 0;
  maxInFlight = 0;
  ticksSeen: { batches: number; receipts: number }[] = [];
  /** The `log_sealed` blobs the last declassify was given. */
  declassified: Uint8Array[] = [];
  /** Tick number at which the match is over. */
  overAt = 3;
  /** Tick number that issues a Hint verdict for player 0 (0: none). */
  hintAtTick = 2;
  /** Tick number that anchors a Checkpoint (0: none). */
  checkpointAtTick = 0;
  /**
   * The device each account is enrolled with here. `enroll` admits by the referee's rule
   * (crates/referee-wasi cmd/enroll.rs `admit`): with no record, the new one is stored and a
   * rebind_sig is ignored; the same keys get the stored record back (replaced only when now
   * attested); other keys need a rebind_sig by the stored near_pk over the new keys.
   */
  records = new Map<string, FakeDevice>();
  /**
   * Accounts whose stored record no longer decodes (a layout an older referee wrote): `start`
   * refuses them, `devices` names no receipt, and an enrolment replaces the record.
   */
  unreadable = new Set<string>();
  private matches = new Map<string, FakeMatch>();
  /** Set when this call handed out a bad proof, so the tick is undone like a lying one. */
  private lied = false;

  private m(matchId: Uint8Array): FakeMatch {
    const m = this.matches.get(toHex(matchId));
    if (!m) throw new RefereeError("tick", "no such match", true);
    return m;
  }
  private boxOf(m: FakeMatch, player: number): Uint8Array {
    const pk = this.boxPkOf(m.players[player] ?? "");
    if (!pk) throw new RefereeError("start", `no device for player ${player}`, true);
    return pk;
  }
  private sealLog(entries: LogEntry[]): Uint8Array {
    return seal(this.boxPk, new Writer().vec(entries, writeLogEntry).bytes(), FAKE_LOG);
  }
  private openLog(blob: Uint8Array): LogEntry[] {
    const r = new Reader(open(this.boxSk, blob, FAKE_LOG));
    const v = r.vec(readLogEntry);
    r.done();
    return v;
  }
  /**
   * Appends entries to the match log; returns what the relay gets for them. As the referee does,
   * each salted entry gets the salt of the index it lands at.
   */
  private log(m: FakeMatch, entries: LogEntry[], into: LogEntry[]) {
    for (const e of entries) {
      const at = logEntrySalt(e) ? { ...e, salt: logSalt(deriveLogKey(m.km), m.leaves.length) } : e;
      m.leaves.push(merkleLeaf(at));
      into.push(at);
    }
  }
  private verdict(m: FakeMatch, body: Verdict, log: LogEntry[]): RawVerdict {
    m.seq += 1;
    const v = signVerdict(
      { matchId: m.matchId, seq: m.seq, prev: m.prev, callId: new Uint8Array(16), body },
      this.sk,
    );
    m.prev = verdictDigest(v);
    this.log(m, [{ kind: "Verdict", seq: v.seq, digest: m.prev }], log);
    return { raw: encodeSignedVerdict(v), v };
  }
  /** A Checkpoint/End body over the log so far, with its proof from the last anchor. */
  private anchor(m: FakeMatch, seq: number): { size: bigint; root: Uint8Array; proof: VerdictProof } {
    const size = m.leaves.length;
    const path = consistencyProof(m.leaves, m.anchored);
    if (this.lieAboutProof) {
      this.lieAboutProof = false;
      this.lied = true;
      path.push(new Uint8Array(32));
    }
    const proof = { seq, fromSize: m.anchored, path };
    m.anchored = size;
    return { size: BigInt(size), root: merkleRoot(m.leaves), proof };
  }
  private state(m: FakeMatch) {
    return new TextEncoder().encode(`state:${toHex(m.matchId)}:${m.seq}`);
  }
  private checkState(m: FakeMatch, state: Uint8Array, lastSeq: number) {
    if (new TextDecoder().decode(state) !== `state:${toHex(m.matchId)}:${lastSeq}` || lastSeq !== m.seq) {
      throw new RefereeError("tick", "state seq is not last_seq", true);
    }
  }
  private appended(m: FakeMatch, from: number, entries: LogEntry[]): LogAppend {
    return { leaves: m.leaves.slice(from), logSealed: this.sealLog(entries) };
  }
  private hintBlob(m: FakeMatch, asker: number): Uint8Array {
    const id = m.nextHintId++;
    return seal(this.boxPk, utf8(JSON.stringify({ match: toHex(m.matchId), hintId: id, asker })), FAKE_HINT);
  }

  /** As the referee signs an enrolment receipt (enroll.ts receiptSignedBy). */
  signReceipt(receipt: Uint8Array): Uint8Array {
    return ed25519.sign(sha256(concat(utf8("tail/enroll-receipt/v1"), receipt)), this.sk);
  }
  async pubkeys(): Promise<RefereeKeys> {
    this.calls.push("pubkeys");
    return {
      refereePk: this.pk,
      refereeBoxPk: this.boxPk,
      boxPkSig: new Uint8Array(64),
      vrfPk: this.pk,
      appId: "TEAM.app",
    };
  }
  async enroll(i: EnrollInput): Promise<EnrollResult> {
    this.calls.push("enroll");
    this.enrolls.push(i);
    if (this.failEnrolls > 0) {
      this.failEnrolls--;
      throw new RefereeError("enroll", "request failed: The operation timed out.", false);
    }
    if (this.refuseEnrolls > 0) {
      this.refuseEnrolls--;
      throw new RefereeError("enroll", "attestation refused: certificate expired", true);
    }
    const d = this.admit(i);
    this.records.set(i.accountId, d);
    this.unreadable.delete(i.accountId);
    return {
      callId: "call-enroll",
      refereePk: this.pk,
      appAttestPk: d.appAttestPk,
      receipt: d.receipt,
      sig: this.signReceipt(d.receipt),
      attested: d.attested,
    };
  }
  private admit(i: EnrollInput): FakeDevice {
    const fresh: FakeDevice = {
      appAttestPk: i.appAttestPk,
      playerBoxPk: i.playerBoxPk,
      nearPk: i.nearPk,
      // As the referee: attested when it got an attestation to check.
      attested: i.attestation !== undefined,
      receipt: crypto.getRandomValues(new Uint8Array(8)),
    };
    const old = this.records.get(i.accountId);
    if (!old) return fresh;
    if (
      equal(old.appAttestPk, fresh.appAttestPk) &&
      equal(old.playerBoxPk, fresh.playerBoxPk) &&
      equal(old.nearPk, fresh.nearPk)
    ) {
      return fresh.attested && !old.attested ? fresh : old;
    }
    if (!i.rebindSig) {
      throw new RefereeError(
        "enroll",
        `${i.accountId} is enrolled with another device: moving it takes rebind_sig from that device's NEAR key`,
        true,
      );
    }
    const digest = rebindDigest(i.accountId, fresh.appAttestPk, fresh.playerBoxPk, fresh.nearPk);
    if (!ed25519.verify(i.rebindSig, digest, old.nearPk)) {
      throw new RefereeError(
        "enroll",
        "rebind_sig is not the enrolled device's signature over these keys",
        true,
      );
    }
    return fresh;
  }
  /** The record of `account` becomes one this referee cannot read; it keeps no key to check. */
  makeUnreadable(account: string) {
    this.records.delete(account);
    this.unreadable.add(account);
  }
  async devices(accountIds: string[]): Promise<HeldDevice[]> {
    this.calls.push("devices");
    return accountIds.map((a) => ({
      accountId: a,
      receipt: this.records.get(a)?.receipt ?? null,
      unreadable: this.unreadable.has(a) ? "device record version 7" : null,
    }));
  }
  async start(i: StartInput): Promise<StartResult> {
    this.calls.push("start");
    if (this.refuseStart) throw new RefereeError("start", "match already started", true);
    for (const a of i.players)
      if (this.unreadable.has(a))
        throw new RefereeError("start", `device record of ${a}: device record version 7`, true);
    const players = sortAccounts(i.players);
    const m: FakeMatch = {
      matchId: i.matchId,
      players,
      km: crypto.getRandomValues(new Uint8Array(32)),
      startMs: i.startMs,
      seq: 0,
      prev: new Uint8Array(32),
      leaves: [],
      anchored: 0,
      tickNo: 0,
      nextSeq: players.map(() => 0),
      chainTip: players.map(() => new Uint8Array(32)),
      nextHintId: 0,
      hintTargets: [],
    };
    this.matches.set(toHex(i.matchId), m);
    const log: LogEntry[] = players.map((account, player) => ({
      kind: "Enrolled",
      player,
      account,
      keyHash: new Uint8Array(32),
      attested: true,
    }));
    for (const e of log) m.leaves.push(merkleLeaf(e));
    const v = this.verdict(
      m,
      {
        kind: "Start",
        playersHash: new Uint8Array(32),
        ringCommit: new Uint8Array(32),
        startMs: BigInt(i.startMs),
        endMs: BigInt(i.startMs + i.durationMs),
      },
      log,
    );
    const keys = players.map((accountId, player) => {
      const k = {
        matchId: i.matchId,
        player,
        startMs: BigInt(i.startMs),
        endMs: BigInt(i.startMs + i.durationMs),
        kTag: deriveTagKey(m.km),
        kPlayer: derivePlayerKey(m.km, player),
        target: players[(player + 1) % players.length] as string,
      };
      return {
        player,
        accountId,
        sealed: sealSignedPlayerKeys(this.boxOf(m, player), signPlayerKeys(k, this.sk)),
      };
    });
    return {
      callId: "call-start",
      startMs: i.startMs,
      endMs: i.startMs + i.durationMs,
      verdicts: [v],
      keys,
      state: this.state(m),
      ...this.appended(m, 0, log),
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
      const m = this.m(i.matchId);
      this.checkState(m, i.state, i.lastSeq);
      // A real referee keeps nothing from a call whose answer the relay throws away; this fake
      // remembers where it was so a discarded (lying) tick can be undone.
      const undo = structuredClone({ ...m, matchId: undefined, km: undefined });
      this.ticksSeen.push({ batches: i.batches.length, receipts: i.receipts.length });
      const tickNo = m.tickNo + 1;
      const from = m.leaves.length;
      const log: LogEntry[] = [];
      const nowMs = Date.now();
      this.log(m, [{ kind: "Tick", tickNo, nowMs: BigInt(nowMs), callId: new Uint8Array(16) }], log);
      // Receipts are the voice answers' sealed entries: logged as they are.
      for (const r of i.receipts) this.log(m, this.openLog(r), log);
      const verdicts: RawVerdict[] = [];
      const proofs: VerdictProof[] = [];
      const hints: TickResult["hints"] = [];
      for (const [k, sealed] of i.batches.entries()) {
        const batch = this.openBatch(sealed);
        if (!batch) {
          this.log(m, [{ kind: "Batch", player: 0, seq: k, hash: sha256(sealed) }], log);
          continue;
        }
        this.log(m, [{ kind: "Batch", player: batch.player, seq: batch.seq, hash: batchHash(batch) }], log);
        m.nextSeq[batch.player] = batch.seq + 1;
        m.chainTip[batch.player] = batchHash(batch);
        for (const a of batch.actions) {
          if (a.kind !== "Hint") continue;
          m.hintTargets.push((batch.player + 1) % m.players.length);
          verdicts.push(
            this.verdict(
              m,
              {
                kind: "Hint",
                from: batch.player,
                amount: FAKE_HINT_PRICE,
                hintId: m.nextHintId,
                hint: a.hint,
                tMs: BigInt(nowMs),
              },
              log,
            ),
          );
          hints.push({ player: batch.player, blob: this.hintBlob(m, batch.player) });
        }
      }
      if (tickNo === this.hintAtTick) {
        m.hintTargets.push(1);
        verdicts.push(
          this.verdict(
            m,
            {
              kind: "Hint",
              from: 0,
              amount: FAKE_HINT_PRICE,
              hintId: m.nextHintId,
              hint: 0,
              tMs: BigInt(nowMs),
            },
            log,
          ),
        );
        hints.push({ player: 0, blob: this.hintBlob(m, 0) });
      }
      if (tickNo === this.checkpointAtTick) {
        const a = this.anchor(m, m.seq + 1);
        proofs.push(a.proof);
        verdicts.push(this.verdict(m, { kind: "Checkpoint", logSize: a.size, root: a.root }, log));
      }
      m.tickNo = tickNo;
      const root = merkleRoot(m.leaves);
      const huds = m.players.map((_, player) => ({
        player,
        sealed: sealSignedHud(this.boxOf(m, player), signHud(this.hud(m, player, tickNo, root), this.sk)),
      }));
      const out: TickResult = {
        callId: `call-tick-${tickNo}`,
        tickNo,
        nowMs,
        seq: m.seq,
        state: this.state(m),
        verdicts,
        proofs,
        huds,
        ...this.appended(m, from, log),
        logSize: m.leaves.length,
        logRoot: root,
        unopened: [],
        rejected: [],
        refused: [],
        hints,
        over: tickNo >= this.overAt,
      };
      if (this.lieAboutLog || this.lied) {
        if (this.lieAboutLog) out.logRoot = Uint8Array.from(root, (b, k) => (k === 0 ? b ^ 1 : b));
        this.lieAboutLog = false;
        this.lied = false;
        Object.assign(m, { ...undo, matchId: m.matchId, km: m.km });
        this.ticksSeen.pop();
      }
      return out;
    } finally {
      this.inFlight--;
    }
  }
  private openBatch(sealed: Uint8Array): Batch | undefined {
    try {
      return decodeBatchEnvelope(open(this.boxSk, sealed, SealContext.batch)).batch;
    } catch {
      return undefined;
    }
  }
  private hud(m: FakeMatch, player: number, tick: number, root: Uint8Array): Hud {
    return {
      matchId: m.matchId,
      player,
      tick,
      epoch: 0,
      lock: 0,
      heat: 0,
      head: 1_000_000n,
      status: 0,
      target: m.players[(player + 1) % m.players.length] as string,
      nextSeq: m.nextSeq[player] ?? 0,
      chainTip: m.chainTip[player] ?? new Uint8Array(32),
      darkMs: 0,
      tags: 0,
      logSize: BigInt(m.leaves.length),
      root,
      hintPrices: [FAKE_HINT_PRICE, FAKE_HINT_PRICE, FAKE_HINT_PRICE],
      hintRecent: 0,
    };
  }
  async voice(i: VoiceInput): Promise<VoiceResult> {
    this.calls.push("voice");
    if (this.failVoices > 0) {
      this.failVoices--;
      throw new RefereeError("voice", "request failed: timeout", false);
    }
    const h = JSON.parse(new TextDecoder().decode(open(this.boxSk, i.blob, FAKE_HINT))) as {
      match: string;
      hintId: number;
      asker: number;
    };
    const m = this.m(fromHex(h.match));
    if (!new TextDecoder().decode(i.state).startsWith(`state:${h.match}:`))
      throw new RefereeError("voice", "state is not this hint's match", true);
    const text = `line for hint ${h.hintId}`;
    const line = { matchId: m.matchId, player: h.asker, hintId: h.hintId, text };
    // Salted by the tick that logs it, for the index it lands at.
    const receipt: LogEntry = {
      kind: "HintReceipt",
      hintId: h.hintId,
      chatId: "c",
      textHash: sha256(utf8(text)),
      signature: new Uint8Array(65),
      signingAddress: "0x0",
      salt: new Uint8Array(16),
    };
    return {
      player: h.asker,
      hintId: h.hintId,
      sealed: sealSignedVoiceLine(this.boxOf(m, h.asker), signVoiceLine(line, this.sk)),
      signedText: `fake-model:${toHex(sha256(utf8("req")))}:${toHex(sha256(utf8(text)))}`,
      receipt: this.sealLog([receipt]),
    };
  }
  /**
   * As the referee (crates/referee-wasi cmd/end.rs): the first `end` records the End; the same
   * input again gets that End back, any other input is refused.
   */
  async end(i: EndInput): Promise<EndResult> {
    this.calls.push("end");
    const input = JSON.stringify([toHex(i.state), i.lastSeq, i.receipts.map(toHex)]);
    const recorded = this.ended.get(toHex(i.matchId));
    if (recorded) {
      if (recorded.input !== input)
        throw new RefereeError("end", "match has already ended with another End", true);
      return recorded.result;
    }
    const result = await this.endOnce(i);
    this.ended.set(toHex(i.matchId), { input, result });
    if (this.loseNextEndAnswer) {
      this.loseNextEndAnswer = false;
      throw new RefereeError("end", "request failed: the answer was lost", false);
    }
    return result;
  }
  private async endOnce(i: EndInput): Promise<EndResult> {
    const m = this.m(i.matchId);
    this.checkState(m, i.state, i.lastSeq);
    const from = m.leaves.length;
    const log: LogEntry[] = [];
    // As the referee: receipts of the last tick's hints join the log before End's root.
    for (const r of i.receipts) this.log(m, this.openLog(r), log);
    const a = this.anchor(m, m.seq + 1);
    const v = this.verdict(
      m,
      {
        kind: "End",
        alpha: "vrf:1:x:y",
        vrfSignature: new Uint8Array(64),
        logSize: a.size,
        root: a.root,
        hintTargets: m.hintTargets,
      },
      log,
    );
    return {
      callId: "call-end",
      verdicts: [v],
      proofs: [a.proof],
      logSize: Number(a.size),
      root: a.root,
      state: this.state(m),
      ...this.appended(m, from, log),
    };
  }
  declassifyChunks: number[] = [];
  async declassifyBatches(i: DeclassifyBatchesInput): Promise<DeclassifyBatchesResult> {
    this.calls.push("declassify_batches");
    this.declassifyChunks.push(i.sealed.length);
    // Every sealed batch opens (stand-ins to their own bytes), plus one the log never accepted.
    const batches = i.sealed.map((s) => {
      const b = this.openBatch(s);
      return b ? encodeBatch(b) : s;
    });
    return { batches: [...batches, new Uint8Array([9, 9, 9])], refused: [] };
  }
  async declassify(matchId: Uint8Array, logSealed: Uint8Array[]): Promise<DeclassifyResult> {
    this.calls.push("declassify");
    this.declassified = logSealed;
    return {
      log: logSealed.flatMap((b) => this.openLog(b)).map(encodeLogEntry),
      reveal: {
        ring: ["a", "b", "c"],
        k_m: toHex(this.m(matchId).km),
        vrf_alpha: "vrf:1:x:y",
        vrf_signature: "00".repeat(64),
      },
    };
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
  /** The referee that registered the device; null: enrolled here, not with a referee yet. */
  referee: FakeReferee | null = null,
  /** The device's X25519 box key; the referee seals keys, HUDs and Handler lines to it. */
  boxPk: Uint8Array = x25519.getPublicKey(x25519.utils.randomSecretKey()),
) {
  const receipt = crypto.getRandomValues(new Uint8Array(8));
  // Each device its own App Attest key, as the store requires.
  const appAttestPk = crypto.getRandomValues(new Uint8Array(65));
  referee?.records.set(accountId, {
    appAttestPk,
    playerBoxPk: boxPk,
    nearPk,
    attested: kind === "phone",
    receipt,
  });
  store.putDevice({
    account_id: accountId,
    kind,
    app_attest_pk: appAttestPk,
    player_box_pk: boxPk,
    near_pk: nearPk,
    receipt: referee ? receipt : null,
    receipt_sig: referee ? referee.signReceipt(receipt) : null,
    enroll_call_id: referee ? "c" : null,
    created_ms: 0,
    attestation: null,
    challenge: null,
    attested: referee ? (kind === "phone" ? 1 : 0) : null,
    referee_pk: referee ? referee.pk : null,
  });
}
