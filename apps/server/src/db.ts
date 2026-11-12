// The relay's own records in SQLite (bun:sqlite, WAL). Nothing here is trusted by anyone else:
// the chain holds the money and the verdict order, the referee holds the secrets. What the relay
// must not lose is what only it holds between calls: queued sealed batches, the sealed match
// state, signed verdicts not yet on chain, hint receipts for the next tick, and the match log.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Circle } from "./referee.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS challenges (
  challenge BLOB PRIMARY KEY,
  account_id TEXT NOT NULL,
  expires_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  account_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('phone', 'ghost')),
  app_attest_pk BLOB NOT NULL,
  player_box_pk BLOB NOT NULL,
  near_pk BLOB NOT NULL,
  receipt BLOB NOT NULL,
  receipt_sig BLOB NOT NULL,
  enroll_call_id TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  match_id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  zone TEXT NOT NULL,
  phase TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  start_ms INTEGER,
  end_ms INTEGER,
  players TEXT,
  keys TEXT,
  state BLOB,
  last_seq INTEGER NOT NULL DEFAULT 0,
  tick_no INTEGER NOT NULL DEFAULT 0,
  reveal TEXT,
  trails_done INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL,
  player INTEGER NOT NULL,
  sealed BLOB NOT NULL,
  digest BLOB NOT NULL,
  received_ms INTEGER NOT NULL,
  sent_tick INTEGER
);
CREATE INDEX IF NOT EXISTS batches_pending ON batches (match_id, digest, sent_tick);
CREATE TABLE IF NOT EXISTS verdicts (
  match_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  raw BLOB NOT NULL,
  call_id TEXT NOT NULL,
  applied_ms INTEGER,
  tx_hash TEXT,
  PRIMARY KEY (match_id, seq)
);
CREATE TABLE IF NOT EXISTS log_entries (
  match_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  entry BLOB NOT NULL,
  PRIMARY KEY (match_id, idx)
);
CREATE TABLE IF NOT EXISTS hints (
  match_id TEXT NOT NULL,
  hint_id INTEGER NOT NULL,
  asker INTEGER NOT NULL,
  hint INTEGER NOT NULL,
  value INTEGER NOT NULL,
  question TEXT,
  issued_ms INTEGER NOT NULL,
  text TEXT,
  chat_id TEXT,
  model TEXT,
  receipt BLOB,
  status TEXT NOT NULL CHECK (status IN ('pending', 'voiced', 'consumed', 'dropped')),
  PRIMARY KEY (match_id, hint_id)
);
CREATE TABLE IF NOT EXISTS huds (
  match_id TEXT NOT NULL,
  player INTEGER NOT NULL,
  tick_no INTEGER NOT NULL,
  sealed BLOB NOT NULL,
  PRIMARY KEY (match_id, player)
);
CREATE TABLE IF NOT EXISTS ticks (
  match_id TEXT NOT NULL,
  tick_no INTEGER NOT NULL,
  call_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  wall_ms INTEGER NOT NULL,
  batches INTEGER NOT NULL,
  verdicts TEXT NOT NULL,
  rejected TEXT NOT NULL,
  refused TEXT NOT NULL,
  PRIMARY KEY (match_id, tick_no)
);
CREATE TABLE IF NOT EXISTS trails (
  match_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  batch BLOB NOT NULL,
  PRIMARY KEY (match_id, idx)
);
CREATE TABLE IF NOT EXISTS seen_requests (
  digest BLOB PRIMARY KEY,
  expires_ms INTEGER NOT NULL
);
`;

export type Phase = "lobby" | "starting" | "running" | "ending" | "ended" | "failed";

export interface DeviceRow {
  account_id: string;
  kind: "phone" | "ghost";
  app_attest_pk: Uint8Array;
  player_box_pk: Uint8Array;
  near_pk: Uint8Array;
  receipt: Uint8Array;
  receipt_sig: Uint8Array;
  enroll_call_id: string;
  created_ms: number;
}

export interface Zone {
  zone: Circle;
  safehouses: Circle[];
}

export interface PlayerKeysRow {
  player: number;
  account_id: string;
  /** base64 of the PlayerKeys sealed to the player's box key. */
  sealed: string;
}

export interface MatchRow {
  match_id: string;
  host: string;
  zone: Zone;
  phase: Phase;
  created_ms: number;
  start_ms: number | null;
  end_ms: number | null;
  /** Sorted account ids (player index = position), fixed at start. */
  players: string[] | null;
  keys: PlayerKeysRow[] | null;
  state: Uint8Array | null;
  last_seq: number;
  tick_no: number;
  reveal: Record<string, unknown> | null;
  /** 1 once the declassified batches (trails) are stored. */
  trails_done: number;
  error: string | null;
}

interface MatchRaw extends Omit<MatchRow, "zone" | "players" | "keys" | "reveal"> {
  zone: string;
  players: string | null;
  keys: string | null;
  reveal: string | null;
}

export interface QueuedBatch {
  id: number;
  player: number;
  sealed: Uint8Array;
}

export interface VerdictRow {
  seq: number;
  kind: string;
  raw: Uint8Array;
  call_id: string;
  applied_ms: number | null;
  /** The NEAR transaction that applied it; null if that answer was lost (the chain has it anyway). */
  tx_hash: string | null;
}

export interface HintRow {
  hint_id: number;
  asker: number;
  hint: number;
  value: number;
  question: string | null;
  issued_ms: number;
  text: string | null;
  chat_id: string | null;
  model: string | null;
  receipt: Uint8Array | null;
  status: "pending" | "voiced" | "consumed" | "dropped";
}

export interface TickRow {
  tick_no: number;
  call_id: string;
  at_ms: number;
  wall_ms: number;
  batches: number;
  verdicts: string[];
  rejected: unknown[];
  refused: unknown[];
}

const u8 = (b: Uint8Array | Buffer) => new Uint8Array(b);

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { strict: true, create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(SCHEMA);
  }

  close() {
    this.db.close();
  }

  /** Runs `f` in one transaction: everything a tick learns is stored together or not at all. */
  tx<T>(f: () => T): T {
    return this.db.transaction(f)();
  }

  // ── Enrolment challenges ─────────────────────────────────────────────────────────

  putChallenge(challenge: Uint8Array, accountId: string, expiresMs: number) {
    this.db.query("DELETE FROM challenges WHERE expires_ms < ?").run(Date.now());
    this.db
      .query("INSERT INTO challenges (challenge, account_id, expires_ms) VALUES (?, ?, ?)")
      .run(challenge, accountId, expiresMs);
  }

  /** Single use: the row is deleted whether or not it is still valid. */
  takeChallenge(challenge: Uint8Array): { account_id: string; expires_ms: number } | undefined {
    const row = this.db
      .query<{ account_id: string; expires_ms: number }, [Uint8Array]>(
        "DELETE FROM challenges WHERE challenge = ? RETURNING account_id, expires_ms",
      )
      .get(challenge);
    return row ?? undefined;
  }

  // ── Devices ──────────────────────────────────────────────────────────────────────

  putDevice(d: DeviceRow) {
    this.db
      .query(
        `INSERT OR REPLACE INTO devices (account_id, kind, app_attest_pk, player_box_pk, near_pk, receipt, receipt_sig, enroll_call_id, created_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.account_id,
        d.kind,
        d.app_attest_pk,
        d.player_box_pk,
        d.near_pk,
        d.receipt,
        d.receipt_sig,
        d.enroll_call_id,
        d.created_ms,
      );
  }

  device(accountId: string): DeviceRow | undefined {
    const r = this.db.query<DeviceRow, [string]>("SELECT * FROM devices WHERE account_id = ?").get(accountId);
    if (!r) return undefined;
    return {
      ...r,
      app_attest_pk: u8(r.app_attest_pk),
      player_box_pk: u8(r.player_box_pk),
      near_pk: u8(r.near_pk),
      receipt: u8(r.receipt),
      receipt_sig: u8(r.receipt_sig),
    };
  }

  // ── Matches ──────────────────────────────────────────────────────────────────────

  putMatch(matchId: string, host: string, zone: Zone, createdMs: number) {
    this.db
      .query("INSERT INTO matches (match_id, host, zone, phase, created_ms) VALUES (?, ?, ?, 'lobby', ?)")
      .run(matchId, host, JSON.stringify(zone), createdMs);
  }

  match(matchId: string): MatchRow | undefined {
    const r = this.db.query<MatchRaw, [string]>("SELECT * FROM matches WHERE match_id = ?").get(matchId);
    if (!r) return undefined;
    return {
      ...r,
      zone: JSON.parse(r.zone) as Zone,
      players: r.players ? (JSON.parse(r.players) as string[]) : null,
      keys: r.keys ? (JSON.parse(r.keys) as PlayerKeysRow[]) : null,
      reveal: r.reveal ? (JSON.parse(r.reveal) as Record<string, unknown>) : null,
      state: r.state ? u8(r.state) : null,
    };
  }

  matchesIn(phases: Phase[]): string[] {
    const q = `SELECT match_id FROM matches WHERE phase IN (${phases.map(() => "?").join(",")})`;
    return this.db
      .query<{ match_id: string }, string[]>(q)
      .all(...phases)
      .map((r) => r.match_id);
  }

  /** Moves a match from one phase to another; false if it was not in `from` (someone else won). */
  claimPhase(matchId: string, from: Phase, to: Phase): boolean {
    return (
      this.db.query("UPDATE matches SET phase = ? WHERE match_id = ? AND phase = ?").run(to, matchId, from)
        .changes === 1
    );
  }

  setPhase(matchId: string, phase: Phase, error: string | null = null) {
    this.db.query("UPDATE matches SET phase = ?, error = ? WHERE match_id = ?").run(phase, error, matchId);
  }

  setStarted(
    matchId: string,
    m: { startMs: number; endMs: number; players: string[]; keys: PlayerKeysRow[] },
  ) {
    this.db
      .query("UPDATE matches SET start_ms = ?, end_ms = ?, players = ?, keys = ? WHERE match_id = ?")
      .run(m.startMs, m.endMs, JSON.stringify(m.players), JSON.stringify(m.keys), matchId);
  }

  setState(matchId: string, state: Uint8Array, tickNo: number) {
    this.db.query("UPDATE matches SET state = ?, tick_no = ? WHERE match_id = ?").run(state, tickNo, matchId);
  }

  setLastSeq(matchId: string, seq: number) {
    this.db
      .query("UPDATE matches SET last_seq = ? WHERE match_id = ? AND last_seq < ?")
      .run(seq, matchId, seq);
  }

  setReveal(matchId: string, reveal: Record<string, unknown>) {
    this.db.query("UPDATE matches SET reveal = ? WHERE match_id = ?").run(JSON.stringify(reveal), matchId);
  }

  // ── Batch queue ──────────────────────────────────────────────────────────────────

  /**
   * Queues a sealed batch. False if the same bytes are already waiting for a tick (a retried
   * upload). Bytes the referee already saw may be queued again: only the referee can tell
   * whether it accepted them (a resend after a seq gap must go through), and it refuses a seq
   * it already accepted.
   */
  enqueueBatch(
    matchId: string,
    player: number,
    sealed: Uint8Array,
    digest: Uint8Array,
    nowMs: number,
  ): boolean {
    return this.tx(() => {
      const waiting = this.db
        .query("SELECT 1 FROM batches WHERE match_id = ? AND digest = ? AND sent_tick IS NULL")
        .get(matchId, digest);
      if (waiting) return false;
      this.db
        .query("INSERT INTO batches (match_id, player, sealed, digest, received_ms) VALUES (?, ?, ?, ?, ?)")
        .run(matchId, player, sealed, digest, nowMs);
      return true;
    });
  }

  queuedCount(matchId: string, player: number): number {
    return (
      this.db
        .query<{ n: number }, [string, number]>(
          "SELECT COUNT(*) AS n FROM batches WHERE match_id = ? AND player = ? AND sent_tick IS NULL",
        )
        .get(matchId, player)?.n ?? 0
    );
  }

  /** Oldest first, so each phone's batches reach the referee in the order they were sent. */
  queuedBatches(matchId: string, limit: number): QueuedBatch[] {
    return this.db
      .query<QueuedBatch, [string, number]>(
        "SELECT id, player, sealed FROM batches WHERE match_id = ? AND sent_tick IS NULL ORDER BY id LIMIT ?",
      )
      .all(matchId, limit)
      .map((b) => ({ ...b, sealed: u8(b.sealed) }));
  }

  /**
   * Marks batches as delivered by tick `tickNo`. They stay stored: the referee can open a
   * match's sealed batches after End for the replay, and the digest still refuses a replayed upload.
   */
  markBatchesSent(ids: number[], tickNo: number) {
    const q = this.db.query("UPDATE batches SET sent_tick = ? WHERE id = ?");
    for (const id of ids) q.run(tickNo, id);
  }

  /** Every sealed batch received for a match, per player in arrival order. */
  allBatches(matchId: string): QueuedBatch[] {
    return this.db
      .query<QueuedBatch, [string]>(
        "SELECT id, player, sealed FROM batches WHERE match_id = ? ORDER BY player, id",
      )
      .all(matchId)
      .map((b) => ({ ...b, sealed: u8(b.sealed) }));
  }

  // ── Verdicts ─────────────────────────────────────────────────────────────────────

  putVerdict(matchId: string, v: { seq: number; kind: string; raw: Uint8Array; callId: string }) {
    this.db
      .query("INSERT OR IGNORE INTO verdicts (match_id, seq, kind, raw, call_id) VALUES (?, ?, ?, ?, ?)")
      .run(matchId, v.seq, v.kind, v.raw, v.callId);
  }

  pendingVerdicts(matchId: string): VerdictRow[] {
    return this.db
      .query<VerdictRow, [string]>(
        "SELECT seq, kind, raw, call_id, applied_ms, tx_hash FROM verdicts WHERE match_id = ? AND applied_ms IS NULL ORDER BY seq",
      )
      .all(matchId)
      .map((v) => ({ ...v, raw: u8(v.raw) }));
  }

  verdicts(matchId: string): VerdictRow[] {
    return this.db
      .query<VerdictRow, [string]>(
        "SELECT seq, kind, raw, call_id, applied_ms, tx_hash FROM verdicts WHERE match_id = ? ORDER BY seq",
      )
      .all(matchId)
      .map((v) => ({ ...v, raw: u8(v.raw) }));
  }

  setVerdictTx(matchId: string, seqs: number[], txHash: string) {
    const q = this.db.query("UPDATE verdicts SET tx_hash = ? WHERE match_id = ? AND seq = ?");
    for (const s of seqs) q.run(txHash, matchId, s);
  }

  /** Everything up to `seq` is on chain (read back from get_match().seq). */
  markApplied(matchId: string, seq: number, nowMs: number) {
    this.tx(() => {
      this.db
        .query("UPDATE verdicts SET applied_ms = ? WHERE match_id = ? AND seq <= ? AND applied_ms IS NULL")
        .run(nowMs, matchId, seq);
      this.setLastSeq(matchId, seq);
    });
  }

  // ── Log ──────────────────────────────────────────────────────────────────────────

  appendLog(matchId: string, entries: Uint8Array[]) {
    const next =
      this.db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM log_entries WHERE match_id = ?")
        .get(matchId)?.n ?? 0;
    const q = this.db.query("INSERT INTO log_entries (match_id, idx, entry) VALUES (?, ?, ?)");
    for (const [i, e] of entries.entries()) q.run(matchId, next + i, e);
  }

  log(matchId: string): Uint8Array[] {
    return this.db
      .query<{ entry: Uint8Array }, [string]>("SELECT entry FROM log_entries WHERE match_id = ? ORDER BY idx")
      .all(matchId)
      .map((r) => u8(r.entry));
  }

  // ── Hints ────────────────────────────────────────────────────────────────────────

  putHint(
    matchId: string,
    h: { hintId: number; asker: number; hint: number; value: number; question: string | null },
    nowMs: number,
  ) {
    this.db
      .query(
        `INSERT OR IGNORE INTO hints (match_id, hint_id, asker, hint, value, question, issued_ms, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(matchId, h.hintId, h.asker, h.hint, h.value, h.question, nowMs);
  }

  hints(matchId: string, status: HintRow["status"]): HintRow[] {
    return this.db
      .query<HintRow, [string, string]>(
        "SELECT * FROM hints WHERE match_id = ? AND status = ? ORDER BY hint_id",
      )
      .all(matchId, status)
      .map((h) => ({ ...h, receipt: h.receipt ? u8(h.receipt) : null }));
  }

  setHintVoiced(
    matchId: string,
    hintId: number,
    v: { text: string; receipt: Uint8Array | undefined; chatId: string | null; model: string | null },
  ) {
    this.db
      .query(
        "UPDATE hints SET text = ?, receipt = ?, chat_id = ?, model = ?, status = ? WHERE match_id = ? AND hint_id = ? AND status = 'pending'",
      )
      .run(v.text, v.receipt ?? null, v.chatId, v.model, v.receipt ? "voiced" : "dropped", matchId, hintId);
  }

  /** Every hint that got a Handler line, for the replay. */
  voicedHints(matchId: string): HintRow[] {
    return this.db
      .query<HintRow, [string]>(
        "SELECT * FROM hints WHERE match_id = ? AND text IS NOT NULL ORDER BY hint_id",
      )
      .all(matchId)
      .map((h) => ({ ...h, receipt: h.receipt ? u8(h.receipt) : null }));
  }

  setHintStatus(matchId: string, hintIds: number[], status: HintRow["status"]) {
    const q = this.db.query("UPDATE hints SET status = ? WHERE match_id = ? AND hint_id = ?");
    for (const id of hintIds) q.run(status, matchId, id);
  }

  // ── HUDs and tick records ────────────────────────────────────────────────────────

  putHud(matchId: string, player: number, tickNo: number, sealed: Uint8Array) {
    this.db
      .query("INSERT OR REPLACE INTO huds (match_id, player, tick_no, sealed) VALUES (?, ?, ?, ?)")
      .run(matchId, player, tickNo, sealed);
  }

  hud(matchId: string, player: number): { tick_no: number; sealed: Uint8Array } | undefined {
    const r = this.db
      .query<{ tick_no: number; sealed: Uint8Array }, [string, number]>(
        "SELECT tick_no, sealed FROM huds WHERE match_id = ? AND player = ?",
      )
      .get(matchId, player);
    return r ? { tick_no: r.tick_no, sealed: u8(r.sealed) } : undefined;
  }

  putTick(matchId: string, t: TickRow) {
    this.db
      .query(
        `INSERT OR REPLACE INTO ticks (match_id, tick_no, call_id, at_ms, wall_ms, batches, verdicts, rejected, refused)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        matchId,
        t.tick_no,
        t.call_id,
        t.at_ms,
        t.wall_ms,
        t.batches,
        JSON.stringify(t.verdicts),
        JSON.stringify(t.rejected),
        JSON.stringify(t.refused),
      );
  }

  ticks(matchId: string): TickRow[] {
    type Raw = Omit<TickRow, "verdicts" | "rejected" | "refused"> & {
      verdicts: string;
      rejected: string;
      refused: string;
    };
    return this.db
      .query<Raw, [string]>("SELECT * FROM ticks WHERE match_id = ? ORDER BY tick_no")
      .all(matchId)
      .map((t) => ({
        ...t,
        verdicts: JSON.parse(t.verdicts) as string[],
        rejected: JSON.parse(t.rejected) as unknown[],
        refused: JSON.parse(t.refused) as unknown[],
      }));
  }

  // ── Declassified trails ──────────────────────────────────────────────────────────

  /** Stores the opened batches (borsh Batch) and marks the match's trails done, in one go. */
  putTrails(matchId: string, batches: Uint8Array[]) {
    this.tx(() => {
      this.db.query("DELETE FROM trails WHERE match_id = ?").run(matchId);
      const q = this.db.query("INSERT INTO trails (match_id, idx, batch) VALUES (?, ?, ?)");
      for (const [i, b] of batches.entries()) q.run(matchId, i, b);
      this.db.query("UPDATE matches SET trails_done = 1 WHERE match_id = ?").run(matchId);
    });
  }

  trails(matchId: string): Uint8Array[] {
    return this.db
      .query<{ batch: Uint8Array }, [string]>("SELECT batch FROM trails WHERE match_id = ? ORDER BY idx")
      .all(matchId)
      .map((r) => u8(r.batch));
  }

  // ── Signed-request replay guard ──────────────────────────────────────────────────

  /** False if this signed request was seen before (inside its freshness window). */
  firstSight(digest: Uint8Array, expiresMs: number, nowMs: number): boolean {
    this.db.query("DELETE FROM seen_requests WHERE expires_ms < ?").run(nowMs);
    return (
      this.db
        .query("INSERT OR IGNORE INTO seen_requests (digest, expires_ms) VALUES (?, ?)")
        .run(digest, expiresMs).changes === 1
    );
  }
}
