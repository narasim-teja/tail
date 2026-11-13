// Every call the app makes to the relay (apps/server, TECHNICAL.md 5.4) lives in this file, so a
// change in an endpoint's shape is a one-file edit. Bytes are base64 on the wire, match ids are
// 32 lowercase hex characters, amounts are decimal strings. Answers are checked field by field:
// a shape change fails here with the field's name, not somewhere in the hunt loop.

import { fromHex, toHex, utf8 } from "@tail/protocol";
import { fromB64, toB64 } from "../lib/b64";
import { requestDigest, type Signer } from "./auth";

/** A refusal or failure from the relay. `status` is null when the relay could not be reached. */
export class RelayError extends Error {
  override name = "RelayError";
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
  get unreachable(): boolean {
    return this.status === null;
  }
}

type Obj = Record<string, unknown>;

function obj(v: unknown, what: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new RelayError(0, `${what}: expected an object`);
  return v as Obj;
}
const read = {
  str(o: Obj, k: string): string {
    const v = o[k];
    if (typeof v !== "string") throw new RelayError(0, `relay answer: ${k} is not text`);
    return v;
  },
  int(o: Obj, k: string): number {
    const v = o[k];
    if (typeof v !== "number" || !Number.isSafeInteger(v))
      throw new RelayError(0, `relay answer: ${k} is not a number`);
    return v;
  },
  intOrNull(o: Obj, k: string): number | null {
    return o[k] === null || o[k] === undefined ? null : read.int(o, k);
  },
  bool(o: Obj, k: string): boolean {
    const v = o[k];
    if (typeof v !== "boolean") throw new RelayError(0, `relay answer: ${k} is not true/false`);
    return v;
  },
  b64(o: Obj, k: string): Uint8Array {
    try {
      return fromB64(read.str(o, k));
    } catch {
      throw new RelayError(0, `relay answer: ${k} is not base64`);
    }
  },
  hex(o: Obj, k: string): Uint8Array {
    try {
      return fromHex(read.str(o, k));
    } catch {
      throw new RelayError(0, `relay answer: ${k} is not hex`);
    }
  },
  amount(o: Obj, k: string): bigint {
    const v = read.str(o, k);
    if (!/^[0-9]+$/.test(v)) throw new RelayError(0, `relay answer: ${k} is not an amount`);
    return BigInt(v);
  },
  matchId(o: Obj, k: string): string {
    const v = read.str(o, k);
    if (!isMatchId(v)) throw new RelayError(0, `relay answer: ${k} is not a match id`);
    return v;
  },
  /** A lobby code, in the form people see: "K7M-4QX". */
  code(o: Obj, k: string): string {
    const v = parseLobbyCode(read.str(o, k));
    if (!v) throw new RelayError(0, `relay answer: ${k} is not a lobby code`);
    return showLobbyCode(v);
  },
  list(o: Obj, k: string): unknown[] {
    const v = o[k];
    if (!Array.isArray(v)) throw new RelayError(0, `relay answer: ${k} is not a list`);
    return v;
  },
};

// ── Shapes ─────────────────────────────────────────────────────────────────────────────────

export interface Challenge {
  challenge: Uint8Array;
  accountId: string;
  expiresMs: number;
}

export interface Enrolled {
  accountId: string;
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
  head: bigint;
  out: boolean;
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
}

export interface SealedKeys {
  player: number;
  accountId: string;
  sealed: Uint8Array;
}

export interface MatchView {
  matchId: string;
  /** The short lobby code as people see it ("K7M-4QX"); null for a match made before codes. */
  code: string | null;
  host: string;
  phase: RelayPhase;
  error: string | null;
  startMs: number | null;
  endMs: number | null;
  keys: SealedKeys[];
  chain: ChainMatch | null;
  /** As the relay sent it; check it against `chain.zoneHash` before use (game/zone.ts). */
  zone: { zone: Circle; safehouses: Circle[] } | null;
}

export interface RefereeKeys {
  refereePk: Uint8Array;
  refereeBoxPk: Uint8Array;
  boxPkSig: Uint8Array;
}

/** A signed relay request, ready to send over HTTP or to hand to the mesh carry path. */
export interface SignedRequest {
  method: "POST";
  path: string;
  body: string;
  account: string;
  timeMs: number;
  sig: Uint8Array;
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
      return { accountId: read.str(o, "account_id"), head: read.amount(o, "head"), out: read.bool(o, "out") };
    }),
    refereePk: read.hex(c, "referee_pk"),
    zoneHash: read.hex(c, "zone_hash"),
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

function chainPhase(s: string): ChainPhase {
  const phase = CHAIN_PHASES.find((p) => p === s);
  if (!phase) throw new RelayError(0, `relay answer: unknown match phase ${s}`);
  return phase;
}

const circle = (c: Circle) => ({ lat_e7: c.latE7, lon_e7: c.lonE7, radius_m: c.radiusM });

/** The part of fetch the clients use; tests pass their own. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Calls the relay answers only after a referee call (its own deadline is 60 s) and NEAR
 * transactions: enrolment and starting a match. Waiting less would report a failure while the
 * relay is still working, and a retry would then find the work half done.
 */
export const SLOW_CALL_MS = 120_000;

export interface RelayOptions {
  fetch?: Fetch;
  now?: () => number;
  timeoutMs?: number;
}

export class RelayClient {
  readonly baseUrl: string;
  private readonly fetchFn: Fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, o: RelayOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchFn = o.fetch ?? ((url, init) => fetch(url, init));
    this.now = o.now ?? Date.now;
    this.timeoutMs = o.timeoutMs ?? 15_000;
  }

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
      }),
      {},
      SLOW_CALL_MS,
    );
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
    const r = await this.send(this.sign(signer, "/matches", body));
    return { matchId: read.matchId(r, "match_id"), code: read.code(r, "code") };
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
      matchId: read.str(r, "match_id"),
      code: r["code"] === null || r["code"] === undefined ? null : read.code(r, "code"),
      host: read.str(r, "host"),
      phase: read.str(r, "phase") as RelayPhase,
      error: typeof r["error"] === "string" ? r["error"] : null,
      startMs: read.intOrNull(r, "start_ms"),
      endMs: read.intOrNull(r, "end_ms"),
      keys: read.list(r, "keys").map((k) => {
        const o = obj(k, "keys[]");
        return {
          player: read.int(o, "player"),
          accountId: read.str(o, "account_id"),
          sealed: read.b64(o, "sealed"),
        };
      }),
      chain: parseChain(r["chain"]),
      zone: parseZone(r["zone"]),
    };
  }

  /** Host only: locks the lobby and starts the referee. */
  async startMatch(signer: Signer, matchId: string): Promise<void> {
    await this.send(this.sign(signer, `/matches/${matchId}/start`, "{}"), SLOW_CALL_MS);
  }

  // ── Hunt ─────────────────────────────────────────────────────────────────────────────────

  /** The signed `POST /batch` for one sealed batch. The same bytes go over HTTP or the mesh. */
  batchRequest(signer: Signer, matchId: string, sealed: Uint8Array): SignedRequest {
    return this.sign(signer, "/batch", JSON.stringify({ match_id: matchId, sealed: toB64(sealed) }));
  }

  /** `queued: false` means the relay already had this exact upload (a retry); that is success. */
  async uploadBatch(req: SignedRequest): Promise<{ queued: boolean; player: number }> {
    const r = await this.send(req);
    return { queued: read.bool(r, "queued"), player: read.int(r, "player") };
  }

  async refereeKeys(): Promise<RefereeKeys> {
    const r = await this.json("GET", "/referee");
    return {
      refereePk: read.b64(r, "referee_pk"),
      refereeBoxPk: read.b64(r, "referee_box_pk"),
      boxPkSig: read.b64(r, "box_pk_sig"),
    };
  }

  /** Testnet only: the relay mints the test token and credits it to `accountId` in the contract. */
  /**
   * Whether this relay is a test relay (its ghost door is open), so the lobby may offer a test
   * player. False for a relay that does not say.
   */
  async allowsTestPlayers(): Promise<boolean> {
    const r = await this.json("GET", "/health");
    return r["test_players"] === true;
  }

  /** Test relays only: the host fills one seat with a stand-in that never moves. */
  async addTestPlayer(signer: Signer, matchId: string): Promise<string> {
    const r = await this.send(
      this.sign(signer, "/dev/ghosts/fill", JSON.stringify({ match_id: matchId })),
      SLOW_CALL_MS,
    );
    return read.str(r, "account_id");
  }

  async topUp(signer: Signer, accountId: string, amount: bigint): Promise<void> {
    await this.send(
      this.sign(signer, "/dev/topup", JSON.stringify({ account_id: accountId, amount: amount.toString() })),
    );
  }

  hudUrl(matchId: string, accountId: string): string {
    const ws = this.baseUrl.replace(/^http/, "ws");
    return `${ws}/hud?match_id=${matchId}&account_id=${encodeURIComponent(accountId)}`;
  }

  replayUrl(matchId: string): string {
    return `${this.baseUrl}/replay/${matchId}`;
  }

  // ── Plumbing ─────────────────────────────────────────────────────────────────────────────

  /** The relay checks the signature over the path it sees, so the base URL must not be rewritten by a proxy. */
  sign(signer: Signer, path: string, body: string): SignedRequest {
    const timeMs = this.now();
    const fullPath = new URL(this.baseUrl + path).pathname;
    const sig = signer.sign(requestDigest("POST", fullPath, timeMs, utf8(body)));
    return { method: "POST", path, body, account: signer.accountId, timeMs, sig };
  }

  private send(req: SignedRequest, timeoutMs?: number): Promise<Obj> {
    return this.json(
      req.method,
      req.path,
      req.body,
      {
        "x-tail-account": req.account,
        "x-tail-time": String(req.timeMs),
        "x-tail-sig": toB64(req.sig),
      },
      timeoutMs,
    );
  }

  private async json(
    method: string,
    path: string,
    body?: string,
    headers: Record<string, string> = {},
    timeoutMs: number = this.timeoutMs,
  ): Promise<Obj> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(this.baseUrl + path, {
        method,
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        ...(body !== undefined ? { body } : {}),
        signal: ctrl.signal,
      });
    } catch (e) {
      // Say which failure it was: a timeout and a refused or blocked connection need different
      // fixes, and the platform's own reason is what tells them apart on a phone.
      if (ctrl.signal.aborted)
        throw new RelayError(null, `The relay didn't answer within ${Math.round(timeoutMs / 1000)} s.`);
      const why = e instanceof Error && e.message ? ` (${e.message})` : "";
      throw new RelayError(null, `Can't reach the relay${why}.`);
    } finally {
      clearTimeout(timer);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new RelayError(res.status, `The relay answered ${res.status} without JSON.`);
    }
    const o = obj(parsed, "relay answer");
    if (!res.ok)
      throw new RelayError(res.status, typeof o["error"] === "string" ? o["error"] : `HTTP ${res.status}`);
    return o;
  }
}

/** Match ids travel as 32 lowercase hex characters; the protocol uses the 16 bytes. */
export const matchIdBytes = (id: string) => fromHex(id);
export const matchIdHex = (b: Uint8Array) => toHex(b);
export function isMatchId(s: string): boolean {
  return /^[0-9a-f]{32}$/.test(s);
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
