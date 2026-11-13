// The relay's own records in SQLite (bun:sqlite, WAL). Nothing here is trusted by anyone else:
// the chain holds the money and the verdict order, the referee holds the secrets. What the relay
// must not lose is what only it holds between calls: queued sealed batches, the sealed match
// state, signed verdicts (and their consistency proofs) not yet on chain, Handler answers whose
// receipts go into the next tick, and the match log: during play its leaf hashes and the entries
// sealed to the referee, after End the plaintext the referee declassified.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Circle, LogAppend, VerdictProof } from "./referee.ts";

/** The devices table. The receipt columns are nullable: see DeviceRow. */
const DEVICE_COLUMNS = `
  account_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('phone', 'ghost')),
  app_attest_pk BLOB NOT NULL,
  player_box_pk BLOB NOT NULL,
  near_pk BLOB NOT NULL,
  receipt BLOB,
  receipt_sig BLOB,
  enroll_call_id TEXT,
  created_ms INTEGER NOT NULL,
  attestation BLOB,
  challenge BLOB,
  attested INTEGER
`;
/** The columns a devices table had before the attestation was kept for the referee. */
const DEVICE_COLUMNS_V1 =
  "account_id, kind, app_attest_pk, player_box_pk, near_pk, receipt, receipt_sig, enroll_call_id, created_ms";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS enroll_challenges (
  challenge BLOB PRIMARY KEY,
  account_id TEXT NOT NULL,
  expires_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS replay_challenges (
  nonce BLOB PRIMARY KEY,
  match_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  expires_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (${DEVICE_COLUMNS});
CREATE TABLE IF NOT EXISTS matches (
  match_id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  zone TEXT NOT NULL,
  code TEXT,
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
  error TEXT,
  public_replay INTEGER,
  purged_ms INTEGER
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
CREATE TABLE IF NOT EXISTS log_leaves (
  match_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  leaf BLOB NOT NULL,
  PRIMARY KEY (match_id, idx)
);
CREATE INDEX IF NOT EXISTS log_leaves_by_hash ON log_leaves (match_id, leaf, idx);
CREATE TABLE IF NOT EXISTS log_sealed (
  match_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  blob BLOB NOT NULL,
  PRIMARY KEY (match_id, idx)
);
CREATE TABLE IF NOT EXISTS voice_hints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL,
  asker INTEGER NOT NULL,
  blob BLOB NOT NULL,
  issued_ms INTEGER NOT NULL,
  sealed BLOB,
  signed_text TEXT,
  hint_id INTEGER,
  receipt BLOB,
  status TEXT NOT NULL CHECK (status IN ('pending', 'voiced', 'consumed', 'dropped'))
);
CREATE INDEX IF NOT EXISTS voice_hints_by_match ON voice_hints (match_id, status, id);
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
CREATE TABLE IF NOT EXISTS topups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester TEXT NOT NULL,
  target TEXT NOT NULL,
  amount INTEGER NOT NULL,
  at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS topups_by_requester ON topups (requester, at_ms);
CREATE TABLE IF NOT EXISTS leases (
  match_id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_ms INTEGER NOT NULL
);
`;

export type Phase = "lobby" | "starting" | "running" | "ending" | "ended" | "failed";

/**
 * A device the relay enrolled. The referee's receipt (and its call id) arrive later than the row:
 * enrolment answers the phone once the NEAR account exists, and the device is registered with
 * the referee in the background (enroll.ts). Null until then; a match cannot start with a
 * player whose receipt is still null.
 */
export interface DeviceRow {
  account_id: string;
  kind: "phone" | "ghost";
  app_attest_pk: Uint8Array;
  player_box_pk: Uint8Array;
  near_pk: Uint8Array;
  receipt: Uint8Array | null;
  receipt_sig: Uint8Array | null;
  enroll_call_id: string | null;
  created_ms: number;
  /**
   * The CBOR attestation object exactly as the phone sent it, and the challenge it answered.
   * Kept only until the referee has the device (it checks the attestation itself), then cleared.
   * Null for ghosts, which have no attestation.
   */
  attestation: Uint8Array | null;
  challenge: Uint8Array | null;
  /**
   * What the referee said when it registered the device: 1 it checked an Apple attestation, 0 it
   * took the device unattested (a ghost). Null until registered, or if the referee did not say.
   */
  attested: number | null;
}

/** What the referee's `enroll` returns, stored on the device row. */
export interface RefereeReceipt {
  app_attest_pk: Uint8Array;
  receipt: Uint8Array;
  receipt_sig: Uint8Array;
  enroll_call_id: string;
  attested: boolean | null;
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
  /** The short lobby code in stored form (codes.ts); null for matches made before codes. */
  code: string | null;
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
  /** 1 public, 0 private, null for matches made before the relay kept it (read it on chain). */
  public_replay: number | null;
  /** When the retention purge deleted the match's sealed batches and trails (retention.ts). */
  purged_ms: number | null;
  /** 2 for a match judged under protocol v2; null for one started before (served as v1). */
  protocol: number | null;
  /** The App ID the referee was given at start; null for matches started before it was kept. */
  app_id: string | null;
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
  /** A Checkpoint/End verdict's consistency proof, passed to `apply` with it. */
  proof: VerdictProof | null;
}

interface VerdictRaw extends Omit<VerdictRow, "proof"> {
  proof: string | null;
}

/** A declassified batch kept for the replay. */
export interface Trail {
  /** borsh Batch. */
  batch: Uint8Array;
  /** The App Attest assertion it arrived with; null for trails stored before they were kept. */
  assertion: Uint8Array | null;
  /** True for a batch the log holds only as `Rejected`: kept for verifiers, not drawn as a trail. */
  rejected: boolean;
}

/** A Handler line under protocol v2 (voice_hints): the relay holds only sealed parts of it. */
export interface VoiceHintRow {
  id: number;
  asker: number;
  /** The hint as the referee issued it, sealed to the referee. */
  blob: Uint8Array;
  issued_ms: number;
  /** SignedVoiceLine sealed to the asker, once voiced. */
  sealed: Uint8Array | null;
  signed_text: string | null;
  /** The hint the voice answer is for (its Hint verdict's `hintId`). */
  hint_id: number | null;
  /** The voice answer's sealed receipt, which the next tick takes and logs. */
  receipt: Uint8Array | null;
  status: "pending" | "voiced" | "consumed" | "dropped";
}

/** A Handler line from a match before protocol v2 (hints table), kept for its replay. */
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
    // Relays created before lobby codes have a matches table without the column. A code is
    // unique across every match the relay ever made, not only open lobbies: a start that fails
    // before the referee answers returns the match to its lobby, and its code must still be its own.
    this.addColumn("matches", "code", "TEXT");
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS matches_code ON matches (code)");
    this.addColumn("matches", "public_replay", "INTEGER");
    this.addColumn("matches", "purged_ms", "INTEGER");
    this.addColumn("matches", "protocol", "INTEGER");
    this.addColumn("verdicts", "proof", "TEXT");
    this.relaxDeviceReceipts();
    this.addColumn("devices", "attestation", "BLOB");
    this.addColumn("devices", "challenge", "BLOB");
    this.addColumn("devices", "attested", "INTEGER");
    // voice_hints first named a line by its receipt's leaf; a salted receipt's leaf is known only
    // once it is logged, so the line is named by its hint id (an older `leaves` column stays unread).
    this.addColumn("voice_hints", "hint_id", "INTEGER");
    // Trails stored before assertions and refused batches were released have neither: their
    // replay bundles leave those fields out.
    this.addColumn("trails", "assertion", "BLOB");
    this.addColumn("trails", "rejected", "INTEGER NOT NULL DEFAULT 0");
    // The App ID a match's assertions were checked against, for its replay; the relay's own
    // setting may change after the match.
    this.addColumn("matches", "app_id", "TEXT");
    this.uniqueDeviceKeys();
    this.splitChallenges();
  }

  private addColumn(table: string, name: string, type: string) {
    const cols = this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === name)) this.db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }

  /**
   * Relays created before background referee enrolment have NOT NULL receipt columns. SQLite
   * cannot drop a constraint in place, so the table is rebuilt once, rows and all.
   */
  private relaxDeviceReceipts() {
    const cols = this.db.query<{ name: string; notnull: number }, []>("PRAGMA table_info(devices)").all();
    if (!cols.some((c) => c.name === "receipt" && c.notnull === 1)) return;
    this.tx(() => {
      this.db.run(`CREATE TABLE devices_relaxed (${DEVICE_COLUMNS})`);
      this.db.run(
        `INSERT INTO devices_relaxed (${DEVICE_COLUMNS_V1}) SELECT ${DEVICE_COLUMNS_V1} FROM devices`,
      );
      this.db.run("DROP TABLE devices");
      this.db.run("ALTER TABLE devices_relaxed RENAME TO devices");
    });
  }

  /**
   * One device, one account: an App Attest key or a NEAR key enrolled twice would let one phone
   * hold two seats. Enrolment refuses a known key (enroll.ts); the index is the backstop. A
   * database that already holds a shared key is not repaired silently: which account keeps the
   * device is the operator's call, so the relay names them and stops.
   */
  private uniqueDeviceKeys() {
    for (const col of ["app_attest_pk", "near_pk"]) {
      const dup = this.db
        .query<{ accounts: string }, []>(
          `SELECT group_concat(account_id, ', ') AS accounts FROM devices GROUP BY ${col} HAVING COUNT(*) > 1`,
        )
        .all();
      if (dup.length) {
        throw new Error(`devices share one ${col}: ${dup.map((d) => d.accounts).join("; ")}`);
      }
      this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS devices_${col} ON devices (${col})`);
    }
  }

  /**
   * Relays before separate challenge tables kept enrolment and replay challenges in one table,
   * replay ones under `replay:<match id>:<account>`. Outstanding ones move over (a phone may be
   * mid-enrolment), then the old table goes.
   */
  private splitChallenges() {
    const old = this.db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'challenges'")
      .get();
    if (!old) return;
    this.tx(() => {
      const rows = this.db
        .query<{ challenge: Uint8Array; account_id: string; expires_ms: number }, []>(
          "SELECT challenge, account_id, expires_ms FROM challenges",
        )
        .all();
      for (const r of rows) {
        const replay = /^replay:([0-9a-f]{32}):(.+)$/.exec(r.account_id);
        if (replay) {
          this.db
            .query(
              "INSERT OR IGNORE INTO replay_challenges (nonce, match_id, account_id, expires_ms) VALUES (?, ?, ?, ?)",
            )
            .run(r.challenge, replay[1] as string, replay[2] as string, r.expires_ms);
        } else {
          this.db
            .query(
              "INSERT OR IGNORE INTO enroll_challenges (challenge, account_id, expires_ms) VALUES (?, ?, ?)",
            )
            .run(r.challenge, r.account_id, r.expires_ms);
        }
      }
      this.db.run("DROP TABLE challenges");
    });
  }

  close() {
    this.db.close();
  }

  /** Runs `f` in one transaction: everything a tick learns is stored together or not at all. */
  tx<T>(f: () => T): T {
    return this.db.transaction(f)();
  }

  // ── Challenges ───────────────────────────────────────────────────────────────────

  /**
   * Stores an enrolment challenge unless too many are outstanding, in all (`total`) or for this
   * account (`perAccount`). Expired ones are dropped first. False when a cap is reached.
   */
  putEnrolChallenge(
    challenge: Uint8Array,
    accountId: string,
    expiresMs: number,
    nowMs: number,
    caps: { total: number; perAccount: number },
  ): boolean {
    return this.tx(() => {
      this.db.query("DELETE FROM enroll_challenges WHERE expires_ms < ?").run(nowMs);
      const n = this.db
        .query<{ total: number; mine: number }, [string]>(
          "SELECT COUNT(*) AS total, COALESCE(SUM(account_id = ?), 0) AS mine FROM enroll_challenges",
        )
        .get(accountId);
      if ((n?.total ?? 0) >= caps.total || (n?.mine ?? 0) >= caps.perAccount) return false;
      this.db
        .query("INSERT INTO enroll_challenges (challenge, account_id, expires_ms) VALUES (?, ?, ?)")
        .run(challenge, accountId, expiresMs);
      return true;
    });
  }

  /** Single use: the row is deleted whether or not it is still valid. */
  takeEnrolChallenge(challenge: Uint8Array): { account_id: string; expires_ms: number } | undefined {
    const row = this.db
      .query<{ account_id: string; expires_ms: number }, [Uint8Array]>(
        "DELETE FROM enroll_challenges WHERE challenge = ? RETURNING account_id, expires_ms",
      )
      .get(challenge);
    return row ?? undefined;
  }

  /** As putEnrolChallenge, for a private replay: caps per (match, account) and in all. */
  putReplayChallenge(
    nonce: Uint8Array,
    matchId: string,
    accountId: string,
    expiresMs: number,
    nowMs: number,
    caps: { total: number; perAccount: number },
  ): boolean {
    return this.tx(() => {
      this.db.query("DELETE FROM replay_challenges WHERE expires_ms < ?").run(nowMs);
      const n = this.db
        .query<{ total: number; mine: number }, [string, string]>(
          "SELECT COUNT(*) AS total, COALESCE(SUM(match_id = ? AND account_id = ?), 0) AS mine FROM replay_challenges",
        )
        .get(matchId, accountId);
      if ((n?.total ?? 0) >= caps.total || (n?.mine ?? 0) >= caps.perAccount) return false;
      this.db
        .query("INSERT INTO replay_challenges (nonce, match_id, account_id, expires_ms) VALUES (?, ?, ?, ?)")
        .run(nonce, matchId, accountId, expiresMs);
      return true;
    });
  }

  /** Single use, like takeEnrolChallenge. */
  takeReplayChallenge(
    nonce: Uint8Array,
  ): { match_id: string; account_id: string; expires_ms: number } | undefined {
    const row = this.db
      .query<{ match_id: string; account_id: string; expires_ms: number }, [Uint8Array]>(
        "DELETE FROM replay_challenges WHERE nonce = ? RETURNING match_id, account_id, expires_ms",
      )
      .get(nonce);
    return row ?? undefined;
  }

  // ── Devices ──────────────────────────────────────────────────────────────────────

  /** A new device. Throws on a known account or key: REPLACE would drop another account's row. */
  putDevice(d: DeviceRow) {
    this.db
      .query(
        `INSERT INTO devices (account_id, kind, app_attest_pk, player_box_pk, near_pk, receipt, receipt_sig, enroll_call_id, created_ms, attestation, challenge, attested)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        d.attestation,
        d.challenge,
        d.attested,
      );
  }

  /** The account already enrolled with this App Attest key or this NEAR key, if any. */
  deviceWithKey(appAttestPk: Uint8Array, nearPk: Uint8Array): string | undefined {
    return (
      this.db
        .query<{ account_id: string }, [Uint8Array, Uint8Array]>(
          "SELECT account_id FROM devices WHERE app_attest_pk = ? OR near_pk = ? LIMIT 1",
        )
        .get(appAttestPk, nearPk)?.account_id ?? undefined
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
      receipt: r.receipt ? u8(r.receipt) : null,
      receipt_sig: r.receipt_sig ? u8(r.receipt_sig) : null,
      attestation: r.attestation ? u8(r.attestation) : null,
      challenge: r.challenge ? u8(r.challenge) : null,
    };
  }

  /**
   * The referee answered for this device: keep its receipt and its normalised App Attest key.
   * The attestation and challenge were kept only for the referee, so they go.
   */
  setDeviceReceipt(accountId: string, r: RefereeReceipt) {
    this.db
      .query(
        "UPDATE devices SET app_attest_pk = ?, receipt = ?, receipt_sig = ?, enroll_call_id = ?, attested = ?, attestation = NULL, challenge = NULL WHERE account_id = ?",
      )
      .run(
        r.app_attest_pk,
        r.receipt,
        r.receipt_sig,
        r.enroll_call_id,
        r.attested === null ? null : r.attested ? 1 : 0,
        accountId,
      );
  }

  /** Devices the referee has not registered yet, oldest first. */
  devicesAwaitingReferee(): string[] {
    return this.db
      .query<{ account_id: string }, []>(
        "SELECT account_id FROM devices WHERE receipt IS NULL ORDER BY created_ms",
      )
      .all()
      .map((r) => r.account_id);
  }

  // ── Matches ──────────────────────────────────────────────────────────────────────

  putMatch(
    matchId: string,
    host: string,
    zone: Zone,
    code: string,
    createdMs: number,
    publicReplay: boolean,
  ) {
    this.db
      .query(
        "INSERT INTO matches (match_id, host, zone, code, phase, created_ms, public_replay) VALUES (?, ?, ?, ?, 'lobby', ?, ?)",
      )
      .run(matchId, host, JSON.stringify(zone), code, createdMs, publicReplay ? 1 : 0);
  }

  /** The host's lobbies the relay still holds open (lobby or starting), newest first. */
  openLobbiesOf(host: string): string[] {
    return this.db
      .query<{ match_id: string }, [string]>(
        "SELECT match_id FROM matches WHERE host = ? AND phase IN ('lobby', 'starting') ORDER BY created_ms DESC",
      )
      .all(host)
      .map((r) => r.match_id);
  }

  /**
   * On boot: a `starting` match with no stored state never got the referee's answer (or the
   * relay died before storing it), so its lobby is open again and the host can press Start.
   * Skips a match another live process holds the lease of: that one is starting it right now.
   */
  reopenInterruptedStarts(nowMs: number): string[] {
    return this.db
      .query<{ match_id: string }, [number]>(
        `UPDATE matches SET phase = 'lobby', error = 'the relay restarted during Start; press Start again'
         WHERE phase = 'starting' AND state IS NULL
           AND match_id NOT IN (SELECT match_id FROM leases WHERE expires_ms > ?)
         RETURNING match_id`,
      )
      .all(nowMs)
      .map((r) => r.match_id);
  }

  codeTaken(code: string): boolean {
    return this.db.query("SELECT 1 FROM matches WHERE code = ?").get(code) !== null;
  }

  /** The match whose lobby this code opens, while the relay still holds that lobby open. */
  lobbyByCode(code: string): string | undefined {
    return (
      this.db
        .query<{ match_id: string }, [string]>(
          "SELECT match_id FROM matches WHERE code = ? AND phase = 'lobby'",
        )
        .get(code)?.match_id ?? undefined
    );
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

  /** Started under protocol v2: the replay of this match is a version 2 bundle. */
  setStarted(
    matchId: string,
    m: { startMs: number; endMs: number; players: string[]; keys: PlayerKeysRow[]; appId: string },
  ) {
    this.db
      .query(
        "UPDATE matches SET start_ms = ?, end_ms = ?, players = ?, keys = ?, app_id = ?, protocol = 2 WHERE match_id = ?",
      )
      .run(m.startMs, m.endMs, JSON.stringify(m.players), JSON.stringify(m.keys), m.appId, matchId);
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

  putVerdict(
    matchId: string,
    v: { seq: number; kind: string; raw: Uint8Array; callId: string; proof: VerdictProof | null },
  ) {
    const proof = v.proof && {
      seq: v.proof.seq,
      fromSize: v.proof.fromSize,
      path: v.proof.path.map((h) => Buffer.from(h).toString("base64")),
    };
    this.db
      .query(
        "INSERT OR IGNORE INTO verdicts (match_id, seq, kind, raw, call_id, proof) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(matchId, v.seq, v.kind, v.raw, v.callId, proof ? JSON.stringify(proof) : null);
  }

  private verdictRows(where: string, matchId: string): VerdictRow[] {
    return this.db
      .query<VerdictRaw, [string]>(
        `SELECT seq, kind, raw, call_id, applied_ms, tx_hash, proof FROM verdicts WHERE match_id = ? ${where} ORDER BY seq`,
      )
      .all(matchId)
      .map((v) => {
        const p = v.proof ? (JSON.parse(v.proof) as { seq: number; fromSize: number; path: string[] }) : null;
        return {
          ...v,
          raw: u8(v.raw),
          proof: p && { ...p, path: p.path.map((h) => new Uint8Array(Buffer.from(h, "base64"))) },
        };
      });
  }

  pendingVerdicts(matchId: string): VerdictRow[] {
    return this.verdictRows("AND applied_ms IS NULL", matchId);
  }

  verdicts(matchId: string): VerdictRow[] {
    return this.verdictRows("", matchId);
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

  private count(table: "log_leaves" | "log_sealed" | "log_entries", matchId: string): number {
    return (
      this.db
        .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE match_id = ?`)
        .get(matchId)?.n ?? 0
    );
  }

  /** What one referee call appended: its leaves after the ones stored, its sealed blob after the others. */
  appendLog(matchId: string, a: LogAppend) {
    const next = this.count("log_leaves", matchId);
    const q = this.db.query("INSERT INTO log_leaves (match_id, idx, leaf) VALUES (?, ?, ?)");
    for (const [i, leaf] of a.leaves.entries()) q.run(matchId, next + i, leaf);
    this.db
      .query("INSERT INTO log_sealed (match_id, idx, blob) VALUES (?, ?, ?)")
      .run(matchId, this.count("log_sealed", matchId), a.logSealed);
  }

  leafCount(matchId: string): number {
    return this.count("log_leaves", matchId);
  }

  /** The first `limit` leaf hashes (all of them without a limit), in order. */
  leaves(matchId: string, limit = -1): Uint8Array[] {
    return this.db
      .query<{ leaf: Uint8Array }, [string, number]>(
        "SELECT leaf FROM log_leaves WHERE match_id = ? ORDER BY idx LIMIT ?",
      )
      .all(matchId, limit)
      .map((r) => u8(r.leaf));
  }

  /** Where this leaf hash first appears among the first `size` leaves, if it does. */
  leafIndex(matchId: string, leaf: Uint8Array, size: number): number | undefined {
    return (
      this.db
        .query<{ idx: number }, [string, Uint8Array, number]>(
          "SELECT idx FROM log_leaves WHERE match_id = ? AND leaf = ? AND idx < ? ORDER BY idx LIMIT 1",
        )
        .get(matchId, leaf, size)?.idx ?? undefined
    );
  }

  /** Every `log_sealed` blob of the match, in the order the referee produced them. */
  logSealed(matchId: string): Uint8Array[] {
    return this.db
      .query<{ blob: Uint8Array }, [string]>("SELECT blob FROM log_sealed WHERE match_id = ? ORDER BY idx")
      .all(matchId)
      .map((r) => u8(r.blob));
  }

  /** The plaintext log the referee declassified after End (one borsh LogEntry each). */
  putLog(matchId: string, entries: Uint8Array[]) {
    this.tx(() => {
      this.db.query("DELETE FROM log_entries WHERE match_id = ?").run(matchId);
      const q = this.db.query("INSERT INTO log_entries (match_id, idx, entry) VALUES (?, ?, ?)");
      for (const [i, e] of entries.entries()) q.run(matchId, i, e);
    });
  }

  /**
   * The plaintext log: for a protocol v2 match, empty until the referee declassified it after
   * End; for an older match, what the relay held all along.
   */
  log(matchId: string): Uint8Array[] {
    return this.db
      .query<{ entry: Uint8Array }, [string]>("SELECT entry FROM log_entries WHERE match_id = ? ORDER BY idx")
      .all(matchId)
      .map((r) => u8(r.entry));
  }

  // ── Handler lines ────────────────────────────────────────────────────────────────

  putVoiceHint(matchId: string, asker: number, blob: Uint8Array, nowMs: number) {
    this.db
      .query(
        "INSERT INTO voice_hints (match_id, asker, blob, issued_ms, status) VALUES (?, ?, ?, ?, 'pending')",
      )
      .run(matchId, asker, blob, nowMs);
  }

  voiceHints(matchId: string, status: VoiceHintRow["status"] | "answered"): VoiceHintRow[] {
    const where = status === "answered" ? "status IN ('voiced', 'consumed')" : "status = ?";
    const args = status === "answered" ? [matchId] : [matchId, status];
    return this.db
      .query<VoiceHintRow, string[]>(
        `SELECT id, asker, blob, issued_ms, sealed, signed_text, hint_id, receipt, status FROM voice_hints WHERE match_id = ? AND ${where} ORDER BY id`,
      )
      .all(...args)
      .map((h) => ({
        ...h,
        blob: u8(h.blob),
        sealed: h.sealed ? u8(h.sealed) : null,
        receipt: h.receipt ? u8(h.receipt) : null,
      }));
  }

  /** The voice answer for a pending hint: the asker's sealed line and the receipt for the next tick. */
  setVoiced(
    id: number,
    v: { sealed: Uint8Array; signedText: string | null; hintId: number; receipt: Uint8Array },
  ) {
    this.db
      .query(
        "UPDATE voice_hints SET sealed = ?, signed_text = ?, hint_id = ?, receipt = ?, status = 'voiced' WHERE id = ? AND status = 'pending'",
      )
      .run(v.sealed, v.signedText, v.hintId, v.receipt, id);
  }

  setVoiceStatus(ids: number[], status: VoiceHintRow["status"]) {
    const q = this.db.query("UPDATE voice_hints SET status = ? WHERE id = ?");
    for (const id of ids) q.run(status, id);
  }

  /** Every hint of a match from before protocol v2 that got a Handler line, for its replay. */
  voicedHints(matchId: string): HintRow[] {
    return this.db
      .query<HintRow, [string]>(
        "SELECT * FROM hints WHERE match_id = ? AND text IS NOT NULL ORDER BY hint_id",
      )
      .all(matchId)
      .map((h) => ({ ...h, receipt: h.receipt ? u8(h.receipt) : null }));
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

  /** Stores the opened batches and marks the match's trails done, in one go. */
  putTrails(matchId: string, trails: Trail[]) {
    this.tx(() => {
      this.db.query("DELETE FROM trails WHERE match_id = ?").run(matchId);
      const q = this.db.query(
        "INSERT INTO trails (match_id, idx, batch, assertion, rejected) VALUES (?, ?, ?, ?, ?)",
      );
      for (const [i, t] of trails.entries()) q.run(matchId, i, t.batch, t.assertion, t.rejected ? 1 : 0);
      this.db.query("UPDATE matches SET trails_done = 1 WHERE match_id = ?").run(matchId);
    });
  }

  /** The accepted batches (borsh Batch): the players' trails. */
  trails(matchId: string): Uint8Array[] {
    return this.trailRows(matchId)
      .filter((t) => !t.rejected)
      .map((t) => t.batch);
  }

  /** Every stored batch with its assertion, accepted and refused, in stored order. */
  trailRows(matchId: string): Trail[] {
    return this.db
      .query<{ batch: Uint8Array; assertion: Uint8Array | null; rejected: number }, [string]>(
        "SELECT batch, assertion, rejected FROM trails WHERE match_id = ? ORDER BY idx",
      )
      .all(matchId)
      .map((r) => ({
        batch: u8(r.batch),
        assertion: r.assertion ? u8(r.assertion) : null,
        rejected: r.rejected === 1,
      }));
  }

  // ── Retention ────────────────────────────────────────────────────────────────────

  /**
   * Ended matches whose trails are due for the purge: not purged yet, End applied (or, if that
   * time was lost, the match's end) before `endedBeforeMs`, and not known to be public.
   * `public_replay` null means a match from before the relay kept it; the caller asks the chain.
   */
  purgeCandidates(endedBeforeMs: number): { match_id: string; public_replay: number | null }[] {
    return this.db
      .query<{ match_id: string; public_replay: number | null }, [number]>(
        `SELECT m.match_id, m.public_replay FROM matches m
         JOIN verdicts v ON v.match_id = m.match_id AND v.kind = 'End'
         WHERE m.phase = 'ended' AND m.purged_ms IS NULL AND COALESCE(m.public_replay, 0) = 0
           AND COALESCE(v.applied_ms, m.end_ms) < ?`,
      )
      .all(endedBeforeMs);
  }

  setPublicReplay(matchId: string, publicReplay: boolean) {
    this.db
      .query("UPDATE matches SET public_replay = ? WHERE match_id = ?")
      .run(publicReplay ? 1 : 0, matchId);
  }

  /** Deletes a match's sealed batches and declassified trails, and records when. */
  purgeMatch(matchId: string, nowMs: number): { batches: number; trails: number } {
    return this.tx(() => {
      const batches = this.db.query("DELETE FROM batches WHERE match_id = ?").run(matchId).changes;
      const trails = this.db.query("DELETE FROM trails WHERE match_id = ?").run(matchId).changes;
      this.db.query("UPDATE matches SET purged_ms = ? WHERE match_id = ?").run(nowMs, matchId);
      return { batches, trails };
    });
  }

  // ── Dev top-ups ──────────────────────────────────────────────────────────────────

  /**
   * Books a top-up against `requester` if their total over the last `windowMs` stays within
   * `cap`; returns the booking id, or null when it would not. Booked before the mint so two
   * requests at once cannot both pass the check.
   */
  bookTopup(
    requester: string,
    target: string,
    amount: bigint,
    nowMs: number,
    windowMs: number,
    cap: bigint,
  ): number | null {
    return this.tx(() => {
      const spent =
        this.db
          .query<{ n: number | bigint }, [string, number]>(
            "SELECT COALESCE(SUM(amount), 0) AS n FROM topups WHERE requester = ? AND at_ms > ?",
          )
          .get(requester, nowMs - windowMs)?.n ?? 0;
      if (BigInt(spent) + amount > cap) return null;
      return Number(
        this.db
          .query("INSERT INTO topups (requester, target, amount, at_ms) VALUES (?, ?, ?, ?)")
          .run(requester, target, amount, nowMs).lastInsertRowid,
      );
    });
  }

  /** A booked top-up whose mint failed no longer counts. */
  cancelTopup(id: number) {
    this.db.query("DELETE FROM topups WHERE id = ?").run(id);
  }

  // ── Match leases ─────────────────────────────────────────────────────────────────

  /**
   * Takes or renews the lease on a match for `holder` until `nowMs + ttlMs`. False when another
   * holder's lease has not run out: two processes on one database must never tick one match,
   * or they would fork its sealed state.
   */
  holdLease(matchId: string, holder: string, nowMs: number, ttlMs: number): boolean {
    return (
      this.db
        .query(
          `INSERT INTO leases (match_id, holder, expires_ms) VALUES (?, ?, ?)
           ON CONFLICT (match_id) DO UPDATE SET holder = excluded.holder, expires_ms = excluded.expires_ms
           WHERE leases.holder = excluded.holder OR leases.expires_ms <= ?`,
        )
        .run(matchId, holder, nowMs + ttlMs, nowMs).changes === 1
    );
  }

  releaseLease(matchId: string, holder: string) {
    this.db.query("DELETE FROM leases WHERE match_id = ? AND holder = ?").run(matchId, holder);
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
