// TAIL's own relay calls (apps/server, TECHNICAL.md 5.4): enrolment, lobbies and their codes, the
// match views, the replay log and the test relay's helpers. The calls any proximity game makes
// during play (signing, batches, the HUD socket, carry, receipts) are in proximity/relay.ts, which
// this extends, so every call the app makes to the relay is in these two files. Amounts are
// decimal strings. Answers are checked field by field.

import { decodeLogEntry, type LogEntry } from "@tail/protocol";
import { fromB64, toB64 } from "../lib/b64";
import { parseSettlement, type Settlement } from "../near/chain";
import { replayDigest, type Signer } from "../proximity/auth";
import { isMatchId, matchIdBytes, type Obj, obj, RelayError, RelayTransport, read } from "../proximity/relay";

/** `POST /matches` refused because this host already has a lobby that can still start. */
export class OpenLobbyError extends RelayError {
  override name = "OpenLobbyError";
  constructor(readonly matchId: string) {
    super(409, "You already have an open lobby.");
  }
}

/** A lobby code, in the form people see: "K7M-4QX". */
function readCode(o: Obj, k: string): string {
  const v = parseLobbyCode(read.str(o, k));
  if (!v) throw new RelayError(0, `relay answer: ${k} is not a lobby code`);
  return showLobbyCode(v);
}

// ── Shapes ─────────────────────────────────────────────────────────────────────────────────

export interface Challenge {
  challenge: Uint8Array;
  accountId: string;
  expiresMs: number;
}

export interface Enrolled {
  accountId: string;
}

/**
 * The relay refused because the referee it runs with does not know these players' devices (the
 * contract pinned another referee since they enrolled): each must refresh its enrolment. Start
 * answers this with the accounts named.
 */
export function refreshNeeded(e: unknown, accountId: string): boolean {
  if (!(e instanceof RelayError) || e.status !== 409 || e.detail["code"] !== "refresh") return false;
  const accounts = e.detail["accounts"];
  return !Array.isArray(accounts) || accounts.includes(accountId);
}

export interface Circle {
  latE7: number;
  lonE7: number;
  radiusM: number;
}

export interface NewMatch {
  /** Smallest token unit. */
  stake: bigint;
  durationMs: number;
  zone: Circle;
  safehouses: Circle[];
  publicReplay: boolean;
  minPlayers: number;
  maxPlayers: number;
  startByMs: number;
}

/** The contract's phases. A locked lobby is still `lobby`, with `lockedUntilMs` set. */
export const CHAIN_PHASES = ["lobby", "running", "ended", "aborted"] as const;
export type ChainPhase = (typeof CHAIN_PHASES)[number];
export type RelayPhase = "lobby" | "starting" | "running" | "ending" | "ended" | "failed";

export interface ChainPlayer {
  accountId: string;
  /** What the contract holds for this player now; 0 for everyone once the match settles. */
  head: bigint;
  out: boolean;
  /** What settlement credited this player (0 until End or abort): the final amount. */
  paid: bigint;
}

export interface ChainMatch {
  token: string;
  stake: bigint;
  durationMs: number;
  minPlayers: number;
  maxPlayers: number;
  startByMs: number;
  publicReplay: boolean;
  phase: ChainPhase;
  /** Set once the host locks the lobby: no joins from then on, no leaves until this time. */
  lockedUntilMs: number | null;
  /** Sorted by account id; index = player number in verdicts and batches. */
  players: ChainPlayer[];
  /** ed25519 key the match pinned at creation; it signs the referee's box key. */
  refereePk: Uint8Array;
  /** SHA256 commitment to the zone and safehouses. */
  zoneHash: Uint8Array;
  /** How the money left the match; null while it is a lobby or running. */
  settledAs: Settlement | null;
  /** On `refunded_rule_violation`: the rule End's replay found broken, in the contract's words. */
  violation: string | null;
}

export interface SealedKeys {
  player: number;
  accountId: string;
  sealed: Uint8Array;
}

/** `GET /matches/:id`: public, so it holds nothing about where the match is played. */
export interface MatchView {
  matchId: string;
  /** The short lobby code as people see it ("K7M-4QX"); null for a match made before codes. */
  code: string | null;
  host: string;
  phase: RelayPhase;
  startMs: number | null;
  endMs: number | null;
  chain: ChainMatch | null;
}

/** `GET /matches/:id/zone`: what only the host and the players may see, asked for signed. */
export interface MatchZone {
  matchId: string;
  /** As the relay sent it; check it against `chain.zoneHash` before use (tail/zone.ts). */
  zone: { zone: Circle; safehouses: Circle[] } | null;
  /** The caller's own seat, once the match has started; empty before. */
  keys: SealedKeys[];
  /** Why the last Start failed, if it did. */
  error: string | null;
}

function settlementOf(v: unknown): Settlement | null {
  try {
    return parseSettlement(v);
  } catch (e) {
    throw new RelayError(0, `relay answer: ${(e as Error).message}`);
  }
}

function parseChain(v: unknown): ChainMatch | null {
  if (v === null || v === undefined) return null;
  const c = obj(v, "chain");
  return {
    token: read.str(c, "token"),
    stake: read.amount(c, "stake"),
    durationMs: read.int(c, "duration_ms"),
    minPlayers: read.int(c, "min_players"),
    maxPlayers: read.int(c, "max_players"),
    startByMs: read.int(c, "start_by_ms"),
    publicReplay: read.bool(c, "public_replay"),
    phase: chainPhase(read.str(c, "phase")),
    lockedUntilMs: read.intOrNull(c, "locked_until_ms"),
    players: read.list(c, "players").map((p) => {
      const o = obj(p, "player");
      return {
        accountId: read.str(o, "account_id"),
        head: read.amount(o, "head"),
        out: read.bool(o, "out"),
        paid: read.amount(o, "paid"),
      };
    }),
    refereePk: read.hex(c, "referee_pk"),
    zoneHash: read.hex(c, "zone_hash"),
    settledAs: settlementOf(c["settled_as"]),
    violation: c["violation"] === null || c["violation"] === undefined ? null : read.str(c, "violation"),
  };
}

/** A circle in the relay's stored shape (camelCase) or the request shape (snake_case). */
function parseCircle(v: unknown): Circle {
  const o = obj(v, "circle");
  const pick = (camel: string, snake: string) => read.int(o, camel in o ? camel : snake);
  return {
    latE7: pick("latE7", "lat_e7"),
    lonE7: pick("lonE7", "lon_e7"),
    radiusM: pick("radiusM", "radius_m"),
  };
}

function parseZone(v: unknown): { zone: Circle; safehouses: Circle[] } | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, "zone");
  return {
    zone: parseCircle(o["zone"]),
    safehouses: Array.isArray(o["safehouses"]) ? o["safehouses"].map(parseCircle) : [],
  };
}

function refereeKind(v: unknown): RefereeKind | null {
  if (typeof v !== "object" || v === null) return null;
  const kind = (v as Obj)["kind"];
  return kind === "outlayer" || kind === "local" ? kind : null;
}

function chainPhase(s: string): ChainPhase {
  const phase = CHAIN_PHASES.find((p) => p === s);
  if (!phase) throw new RelayError(0, `relay answer: unknown match phase ${s}`);
  return phase;
}

const circle = (c: Circle) => ({ lat_e7: c.latE7, lon_e7: c.lonE7, radius_m: c.radiusM });

/**
 * Which referee the relay runs: the OutLayer enclave, or the local test referee (the same code on
 * the relay's own machine, not in an enclave). Null when the relay does not say. The relay is not
 * trusted for this, so the app only ever uses it to say less ("test referee"), and the replay is
 * where an enclave claim is checked.
 */
export type RefereeKind = "outlayer" | "local";

export interface RelayInfo {
  contract: string | null;
  testPlayers: boolean;
  referee: RefereeKind | null;
}

/**
 * Calls the relay answers only after a referee call (its own deadline is 60 s) and NEAR
 * transactions: enrolment and starting a match. Waiting less would report a failure while the
 * relay is still working, and a retry would then find the work half done.
 */
export const SLOW_CALL_MS = 120_000;

export class RelayClient extends RelayTransport {
  // ── Enrolment (TECHNICAL.md 4.4) ─────────────────────────────────────────────────────────

  async enrollChallenge(handle: string): Promise<Challenge> {
    const r = await this.json("POST", "/enroll/challenge", JSON.stringify({ handle }));
    return {
      challenge: read.b64(r, "challenge"),
      accountId: read.str(r, "account_id"),
      expiresMs: read.int(r, "expires_ms"),
    };
  }

  async enroll(i: {
    challenge: Uint8Array;
    keyId: string;
    attestation: string;
    playerBoxPk: Uint8Array;
    nearPk: Uint8Array;
    /** The NEAR key's consent to replace any record the referee holds for the account (enrol.ts). */
    rebindSig: Uint8Array;
  }): Promise<Enrolled> {
    const r = await this.json(
      "POST",
      "/enroll",
      JSON.stringify({
        challenge: toB64(i.challenge),
        key_id: i.keyId,
        attestation: i.attestation,
        player_box_pk: toB64(i.playerBoxPk),
        near_pk: toB64(i.nearPk),
        rebind_sig: toB64(i.rebindSig),
      }),
      {},
      SLOW_CALL_MS,
    );
    return { accountId: read.str(r, "account_id") };
  }

  /** Whether the referee the relay runs with now holds this account's device. */
  /**
   * Whether the relay's referee holds this account's device, and the App Attest keyId the relay
   * holds for it (standard base64 of SHA256 of the key, Apple's keyId); null from a relay too old
   * to send it.
   */
  async enrolStatus(
    signer: Signer,
  ): Promise<{ accountId: string; withReferee: boolean; appAttestKeyId: string | null }> {
    const r = await this.send(await this.sign(signer, "GET", "/enroll/status", ""));
    const absent = r["app_attest_key_id"] === undefined || r["app_attest_key_id"] === null;
    // Checked here: a key id the phone could never match would make every check refresh again.
    if (!absent && read.b64(r, "app_attest_key_id").length !== 32)
      throw new RelayError(0, "relay answer: app_attest_key_id is not a 32-byte key id");
    return {
      accountId: read.str(r, "account_id"),
      withReferee: read.bool(r, "with_referee"),
      appAttestKeyId: absent ? null : read.str(r, "app_attest_key_id"),
    };
  }

  /** A challenge to refresh the signer's own enrolment (a new referee needs a fresh attestation). */
  async refreshChallenge(signer: Signer): Promise<Challenge> {
    const r = await this.send(await this.sign(signer, "POST", "/enroll/refresh/challenge", "{}"));
    return {
      challenge: read.b64(r, "challenge"),
      accountId: read.str(r, "account_id"),
      expiresMs: read.int(r, "expires_ms"),
    };
  }

  /**
   * The fresh attestation, and `rebind_sig`: the account's NEAR key agreeing to move it to this
   * App Attest key. The relay answers only once the referee has taken the device.
   */
  async refreshEnrolment(
    signer: Signer,
    i: {
      challenge: Uint8Array;
      keyId: string;
      attestation: string;
      playerBoxPk: Uint8Array;
      rebindSig: Uint8Array;
    },
  ): Promise<Enrolled> {
    const body = JSON.stringify({
      challenge: toB64(i.challenge),
      key_id: i.keyId,
      attestation: i.attestation,
      player_box_pk: toB64(i.playerBoxPk),
      rebind_sig: toB64(i.rebindSig),
    });
    const r = await this.send(await this.sign(signer, "POST", "/enroll/refresh", body), SLOW_CALL_MS);
    return { accountId: read.str(r, "account_id") };
  }

  // ── Matches ──────────────────────────────────────────────────────────────────────────────

  async createMatch(signer: Signer, m: NewMatch): Promise<{ matchId: string; code: string }> {
    const body = JSON.stringify({
      stake: m.stake.toString(),
      duration_ms: m.durationMs,
      zone: circle(m.zone),
      safehouses: m.safehouses.map(circle),
      public_replay: m.publicReplay,
      min_players: m.minPlayers,
      max_players: m.maxPlayers,
      start_by_ms: m.startByMs,
    });
    try {
      const r = await this.send(await this.sign(signer, "POST", "/matches", body));
      return { matchId: read.matchId(r, "match_id"), code: readCode(r, "code") };
    } catch (e) {
      const open = e instanceof RelayError && e.status === 409 ? e.detail["match_id"] : undefined;
      if (typeof open === "string" && isMatchId(open)) throw new OpenLobbyError(open);
      throw e;
    }
  }

  /**
   * The open lobby a short code names. The relay answers 404 once the match has started or been
   * called off, so a stale code reads as "no open lobby" rather than an error.
   */
  async resolveCode(code: string): Promise<string> {
    try {
      return read.matchId(await this.json("GET", `/join/${code}`), "match_id");
    } catch (e) {
      if (e instanceof RelayError && e.status === 404)
        throw new RelayError(404, "No open lobby with that code.");
      throw e;
    }
  }

  async getMatch(matchId: string): Promise<MatchView> {
    const r = await this.json("GET", `/matches/${matchId}`);
    return {
      matchId: read.matchId(r, "match_id"),
      code: r["code"] === null || r["code"] === undefined ? null : readCode(r, "code"),
      host: read.str(r, "host"),
      phase: read.str(r, "phase") as RelayPhase,
      startMs: read.intOrNull(r, "start_ms"),
      endMs: read.intOrNull(r, "end_ms"),
      chain: parseChain(r["chain"]),
    };
  }

  /**
   * The zone, this player's sealed keys and the last Start failure. The relay answers only the
   * host, an invitee and the players (403 to anyone else), so the request is signed.
   */
  async matchZone(signer: Signer, matchId: string): Promise<MatchZone> {
    const r = await this.send(await this.sign(signer, "GET", `/matches/${matchId}/zone`, ""));
    return {
      matchId: read.matchId(r, "match_id"),
      zone: parseZone(r["zone"]),
      keys: read.list(r, "keys").map((k) => {
        const o = obj(k, "keys[]");
        return {
          player: read.int(o, "player"),
          accountId: read.str(o, "account_id"),
          sealed: read.b64(o, "sealed"),
        };
      }),
      error: typeof r["error"] === "string" ? r["error"] : null,
    };
  }

  /** Host only: locks the lobby and starts the referee. */
  async startMatch(signer: Signer, matchId: string): Promise<void> {
    await this.send(await this.sign(signer, "POST", `/matches/${matchId}/start`, "{}"), SLOW_CALL_MS);
  }

  // ── After the match ──────────────────────────────────────────────────────────────────────

  /**
   * The match log in plaintext, from the replay bundle (after End only). Asked as a player
   * (challenge, then the signed nonce), which a private match needs and a public one ignores.
   * Untrusted: every entry used from it is checked against a root anchored on NEAR.
   */
  async replayLog(signer: Signer, matchId: string): Promise<LogEntry[]> {
    const c = await this.json(
      "POST",
      `/replay/${matchId}/challenge`,
      JSON.stringify({ account_id: signer.accountId }),
    );
    const nonce = read.b64(c, "nonce");
    const sig = signer.sign(replayDigest(nonce, matchIdBytes(matchId), signer.accountId));
    const q = new URLSearchParams({ account_id: signer.accountId, nonce: toB64(nonce), sig: toB64(sig) });
    const bundle = await this.json("GET", `/replay/${matchId}?${q.toString()}`);
    return read.list(bundle, "log").map((e) => {
      if (typeof e !== "string") throw new RelayError(0, "relay answer: log entry is not base64");
      try {
        return decodeLogEntry(fromB64(e));
      } catch {
        throw new RelayError(0, "relay answer: log entry does not decode");
      }
    });
  }

  replayUrl(matchId: string): string {
    return `${this.baseUrl}/replay/${matchId}`;
  }

  // ── The relay itself ─────────────────────────────────────────────────────────────────────

  /**
   * What the relay says about itself: the contract it plays on (compared with the app's own
   * setting, never adopted silently: the contract is what anchors the referee's keys) and whether
   * it is a test relay that may fill a seat with a test player.
   */
  async info(): Promise<RelayInfo> {
    const r = await this.json("GET", "/health");
    return {
      contract: typeof r["contract"] === "string" ? r["contract"] : null,
      testPlayers: r["test_players"] === true,
      referee: refereeKind(r["referee"]),
    };
  }

  /** Test relays only: the host fills one seat with a stand-in that never moves. */
  async addTestPlayer(signer: Signer, matchId: string): Promise<string> {
    const r = await this.send(
      await this.sign(signer, "POST", "/dev/ghosts/fill", JSON.stringify({ match_id: matchId })),
      SLOW_CALL_MS,
    );
    return read.str(r, "account_id");
  }

  /** Testnet only: the relay mints the test token and credits it to `accountId` in the contract. */
  async topUp(signer: Signer, accountId: string, amount: bigint): Promise<void> {
    await this.send(
      await this.sign(
        signer,
        "POST",
        "/dev/topup",
        JSON.stringify({ account_id: accountId, amount: amount.toString() }),
      ),
    );
  }
}

// Lobby codes (apps/server src/codes.ts): six symbols from Crockford base32 without 0/O, 1/I/L
// and U, shown as "K7M-4QX". Typed in any case, with or without the dash.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/** What someone typed, as the six symbols of a lobby code ("K7M4QX"), or null. */
export function parseLobbyCode(input: string): string | null {
  const s = input.replace(/[\s-]/g, "").toUpperCase();
  if (s.length !== 6 || [...s].some((ch) => !CODE_ALPHABET.includes(ch))) return null;
  return s;
}

/** "K7M4QX" → "K7M-4QX". */
export const showLobbyCode = (code: string) => `${code.slice(0, 3)}-${code.slice(3)}`;

/** The link a lobby shares and its QR encodes: `tail://join/` and a match id or a lobby code. */
export const joinLink = (idOrCode: string) => `tail://join/${idOrCode}`;

/**
 * What a player typed, scanned or tapped to reach a lobby: a full match id (lobby QR, recent
 * match), a short lobby code, or a `tail://join/…` link holding either. Null when it is none.
 */
export function readJoin(input: string): { matchId: string } | { code: string } | null {
  const t = input.trim();
  const inner = /^tail:\/\/join\/(.+)$/i.exec(t)?.[1] ?? t;
  const id = inner.toLowerCase();
  if (isMatchId(id)) return { matchId: id };
  const code = parseLobbyCode(inner);
  return code ? { code } : null;
}
