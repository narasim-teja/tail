// The relay calls a proximity game needs during play (apps/server, TECHNICAL.md 5.4): signing a
// request with the player's NEAR key, sending a sealed batch, the HUD socket URL, the mesh carry
// keys and forwarding, inclusion and consistency proofs and the referee's keys. Any game's own endpoints (lobbies,
// enrolment, …) go in a subclass (relay/client.ts for TAIL). Bytes are base64 on the wire, match
// ids are 32 lowercase hex characters. Answers are checked field by field: a shape change fails
// here with the field's name, not somewhere in the hunt loop.

import { type CarryAck, type CarryRequest, decodeCarryAck, fromHex, toHex, utf8 } from "@tail/protocol";
import { fromB64, toB64 } from "../lib/b64";
import { requestDigest, type Signer } from "./auth";

/** A refusal or failure from the relay. `status` is null when the relay could not be reached. */
export class RelayError extends Error {
  override name = "RelayError";
  constructor(
    readonly status: number | null,
    message: string,
    /** The relay's whole answer to a refusal: some carry fields to act on beside `error`. */
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
  get unreachable(): boolean {
    return this.status === null;
  }
}

export type Obj = Record<string, unknown>;

export function obj(v: unknown, what: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new RelayError(0, `${what}: expected an object`);
  return v as Obj;
}

/** Field readers for relay answers; each throws a RelayError naming the field. */
export const read = {
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
  list(o: Obj, k: string): unknown[] {
    const v = o[k];
    if (!Array.isArray(v)) throw new RelayError(0, `relay answer: ${k} is not a list`);
    return v;
  },
};

/** A signed relay request, ready to send over HTTP or to hand to the mesh carry path. */
export interface SignedRequest {
  method: "GET" | "POST";
  /** Path and query, as given to the client (the base URL's own path is not included). */
  path: string;
  /** Path and query as the relay sees them, base path included: what the signature covers. */
  signedPath: string;
  /** Empty for a GET, which sends no body; the signature covers SHA256 of the empty string. */
  body: string;
  account: string;
  timeMs: number;
  sig: Uint8Array;
}

export interface RefereeKeys {
  refereePk: Uint8Array;
  refereeBoxPk: Uint8Array;
  boxPkSig: Uint8Array;
}

/** The relay's keys for mesh-carried requests (`GET /carry/key`). */
export interface CarryKey {
  /** X25519: carried requests are sealed to it (`sealCarry`). */
  boxPk: Uint8Array;
  /** ed25519: signs the receipt for each carried envelope (`verifyCarryAck`). */
  ackPk: Uint8Array;
}

/** The relay's answer to a carried envelope: its signed receipt and, if it has one, your latest sealed HUD. */
export interface CarryReply {
  ack: CarryAck;
  /** The bytes of `ack` as the relay sent them, so a carrier can pass them on unchanged. */
  ackBytes: Uint8Array;
  hud: Uint8Array | null;
}

/** An RFC 9162 audit path from `GET /matches/:id/inclusion`. Unverified: check it against NEAR. */
export interface InclusionProof {
  index: number;
  size: number;
  path: Uint8Array[];
}

/** The part of fetch the clients use; tests pass their own. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface RelayOptions {
  fetch?: Fetch;
  now?: () => number;
  timeoutMs?: number;
  /** The contract the relay serves, when already known; otherwise read once from GET /health. */
  contractId?: string;
}

export class RelayTransport {
  readonly baseUrl: string;
  private readonly fetchFn: Fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private contract: Promise<string> | null;

  constructor(baseUrl: string, o: RelayOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchFn = o.fetch ?? ((url, init) => fetch(url, init));
    this.now = o.now ?? Date.now;
    this.timeoutMs = o.timeoutMs ?? 15_000;
    this.contract = o.contractId ? Promise.resolve(o.contractId) : null;
  }

  /**
   * The contract this relay serves, from GET /health, asked once. Every signed request names
   * it, so the relay refuses a signature made for another deployment. The app still compares it
   * with the contract its build names (app.ts `contractMismatch`) and never adopts it.
   */
  contractId(): Promise<string> {
    this.contract ??= this.json("GET", "/health").then((r) => {
      const contract = typeof r["contract"] === "string" ? r["contract"] : null;
      if (!contract) throw new RelayError(0, "The relay doesn't say which contract it serves.");
      return contract;
    });
    // A failed read is asked again next time, not remembered.
    this.contract.catch(() => {
      this.contract = null;
    });
    return this.contract;
  }

  // ── Play ─────────────────────────────────────────────────────────────────────────────────

  /** The signed `POST /batch` for one sealed batch. The same request goes over HTTP or the mesh. */
  batchRequest(signer: Signer, matchId: string, sealed: Uint8Array): Promise<SignedRequest> {
    return this.sign(signer, "POST", "/batch", JSON.stringify({ match_id: matchId, sealed: toB64(sealed) }));
  }

  /**
   * Any 2xx is the relay having the batch: queued now, or already held from an earlier send
   * (`queued: false`), or by the mesh (`duplicate: true`). Whether the referee accepted it is for
   * the signed HUD to say, not the relay.
   */
  async uploadBatch(req: SignedRequest): Promise<void> {
    await this.send(req);
  }

  hudUrl(matchId: string, accountId: string): string {
    const ws = this.baseUrl.replace(/^http/, "ws");
    return `${ws}/hud?match_id=${matchId}&account_id=${encodeURIComponent(accountId)}`;
  }

  async refereeKeys(): Promise<RefereeKeys> {
    const r = await this.json("GET", "/referee");
    return {
      refereePk: read.b64(r, "referee_pk"),
      refereeBoxPk: read.b64(r, "referee_box_pk"),
      boxPkSig: read.b64(r, "box_pk_sig"),
    };
  }

  // ── Mesh carry (TECHNICAL.md 7) ──────────────────────────────────────────────────────────

  /** Fetched at briefing, while the phone is online: the keys a carried request needs. */
  async carryKey(): Promise<CarryKey> {
    const r = await this.json("GET", "/carry/key");
    const boxPk = read.b64(r, "box_pk");
    const ackPk = read.b64(r, "ack_pk");
    if (boxPk.length !== 32 || ackPk.length !== 32) throw new RelayError(0, "relay answer: carry keys");
    return { boxPk, ackPk };
  }

  /**
   * Forwards someone's sealed envelope unchanged, as a carrier. Unsigned: the request inside is
   * signed by its sender, and this phone learns nothing about it.
   */
  async forwardCarry(envelope: Uint8Array): Promise<CarryReply> {
    // A copy, so the body is exactly the envelope even if it is a view into a larger buffer.
    const r = await this.json("POST", "/carry", envelope.slice().buffer);
    const ackBytes = read.b64(r, "ack");
    let ack: CarryAck;
    try {
      ack = decodeCarryAck(ackBytes);
    } catch {
      throw new RelayError(0, "relay answer: ack is not a carry receipt");
    }
    const hud = r["hud"] === null || r["hud"] === undefined ? null : read.b64(r, "hud");
    return { ack, ackBytes, hud };
  }

  /** The request inside a carry envelope: exactly what an HTTP send would carry in its headers. */
  static carryRequest(req: SignedRequest): CarryRequest {
    return {
      account: req.account,
      timeMs: BigInt(req.timeMs),
      method: req.method,
      path: req.signedPath,
      body: utf8(req.body),
      sig: req.sig,
    };
  }

  // ── Receipts ─────────────────────────────────────────────────────────────────────────────

  /**
   * Where `leaf` sits in the first `size` leaves of the match log, or null when the relay says it
   * is not there. Public: leaf hashes reveal nothing. The caller verifies the path against a
   * root it read from NEAR itself.
   */
  async inclusion(matchId: string, leaf: Uint8Array, size: number): Promise<InclusionProof | null> {
    let r: Obj;
    try {
      r = await this.json("GET", `/matches/${matchId}/inclusion?leaf=${toHex(leaf)}&size=${size}`);
    } catch (e) {
      if (e instanceof RelayError && e.status === 404) return null;
      throw e;
    }
    return { index: read.int(r, "index"), size: read.int(r, "size"), path: hashes(r, "path") };
  }

  /**
   * The relay's proof that the log's first `from` leaves are a prefix of its first `to`. Public,
   * like inclusion paths. Unverified: the log monitor checks it against two roots the referee
   * signed or NEAR anchored (monitor.ts).
   */
  async consistency(matchId: string, from: number, to: number): Promise<Uint8Array[]> {
    const r = await this.json("GET", `/matches/${matchId}/consistency?from=${from}&to=${to}`);
    if (read.int(r, "from") !== from || read.int(r, "to") !== to)
      throw new RelayError(0, "relay answer: a proof between other sizes");
    return hashes(r, "path");
  }

  // ── Plumbing ─────────────────────────────────────────────────────────────────────────────

  /**
   * The relay checks the signature over the path and query it sees (`url.pathname + url.search`,
   * apps/server src/routes/util.ts), so the base URL must not be rewritten by a proxy. A GET has
   * an empty body.
   */
  async sign(
    signer: Signer,
    method: SignedRequest["method"],
    path: string,
    body: string,
  ): Promise<SignedRequest> {
    if (method === "GET" && body !== "") throw new Error("a GET has no body");
    const contractId = await this.contractId();
    const timeMs = this.now();
    const url = new URL(this.baseUrl + path);
    const signedPath = url.pathname + url.search;
    const sig = signer.sign(
      requestDigest({
        contractId,
        accountId: signer.accountId,
        method,
        path: signedPath,
        timeMs,
        body: utf8(body),
      }),
    );
    return { method, path, signedPath, body, account: signer.accountId, timeMs, sig };
  }

  protected send(req: SignedRequest, timeoutMs?: number): Promise<Obj> {
    return this.json(
      req.method,
      req.path,
      req.method === "GET" ? undefined : req.body,
      {
        "x-tail-account": req.account,
        "x-tail-time": String(req.timeMs),
        "x-tail-sig": toB64(req.sig),
      },
      timeoutMs,
    );
  }

  /** A string body is JSON; bytes (a carry envelope) go as they are. */
  protected async json(
    method: string,
    path: string,
    body?: string | ArrayBuffer,
    headers: Record<string, string> = {},
    timeoutMs: number = this.timeoutMs,
  ): Promise<Obj> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const type =
      body === undefined
        ? {}
        : { "content-type": typeof body === "string" ? "application/json" : "application/octet-stream" };
    let res: Response;
    try {
      res = await this.fetchFn(this.baseUrl + path, {
        method,
        headers: { ...type, ...headers },
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
    if (!res.ok) throw new RelayError(res.status, refusal(res.status, o["error"]), o);
    return o;
  }
}

/** A list of 32-byte hashes in lowercase hex, as proofs travel. */
function hashes(o: Obj, k: string): Uint8Array[] {
  return read.list(o, k).map((h) => {
    if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h))
      throw new RelayError(0, `relay answer: ${k} is not 32-byte hashes`);
    return fromHex(h);
  });
}

/**
 * The relay's reason for a refusal, as the screens show it. Too large and too many get plain
 * words of the phone's own when the relay gives none; a 429's own reason (which limit, when to
 * try again) is kept.
 */
function refusal(status: number, error: unknown): string {
  const said = typeof error === "string" && error ? error : null;
  if (status === 413) return "That was too big for the relay to take.";
  if (status === 429) {
    if (!said) return "The relay is busy. Try again in a minute.";
    const s = said.charAt(0).toUpperCase() + said.slice(1);
    return /[.!?]$/.test(s) ? s : `${s}.`;
  }
  return said ?? `HTTP ${status}`;
}

/** Match ids travel as 32 lowercase hex characters; the protocol uses the 16 bytes. */
export const matchIdBytes = (id: string) => fromHex(id);
export const matchIdHex = (b: Uint8Array) => toHex(b);
export function isMatchId(s: string): boolean {
  return /^[0-9a-f]{32}$/.test(s);
}
