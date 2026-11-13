// Request parsing shared by the routes: signed requests and typed JSON fields. Every refusal is
// an HttpError with a short message the phone can show as is.

import type { Context } from "hono";
import { REQUEST_SKEW_MS, requestDigest, verifyEd25519 } from "../auth.ts";
import type { Store } from "../db.ts";
import { HttpError } from "../errors.ts";

/** Largest body the relay reads (a sealed batch is a few KB; an attestation about 5 KB). */
export const MAX_BODY = 64 * 1024;

type Obj = Record<string, unknown>;

/**
 * The body, read chunk by chunk and given up on as soon as it passes MAX_BODY: a chunked upload
 * has no length to check first, and reading it whole before checking would let one request fill
 * memory. A declared length over the cap is refused before anything is read.
 */
export async function bodyBytes(c: Context): Promise<Uint8Array> {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > MAX_BODY) throw new HttpError(413, "request too large");
  const stream = c.req.raw.body;
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "request too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const ch of chunks) {
    out.set(ch, at);
    at += ch.length;
  }
  return out;
}

function parseJson(b: Uint8Array): Obj {
  if (b.length === 0) return {};
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder().decode(b));
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new HttpError(400, "body must be an object");
  return v as Obj;
}

export async function jsonBody(c: Context): Promise<Obj> {
  return parseJson(await bodyBytes(c));
}

/** When a signed request may be dated, and how long its digest is remembered to refuse a replay. */
export interface RequestWindow {
  fromMs: number;
  toMs: number;
  keepUntilMs: number;
}

export interface SignedOptions {
  /**
   * The window for this request, once its body is read (a batch's window depends on its match).
   * Default: within REQUEST_SKEW_MS of the relay's clock, remembered until REQUEST_SKEW_MS past
   * the request time, which is as long as it could be accepted.
   */
  window?: (body: Obj, timeMs: number, nowMs: number) => RequestWindow;
  /** `report`: a request seen before comes back with `repeat: true` instead of a 409. */
  onRepeat?: "refuse" | "report";
}

export const defaultWindow = (_b: Obj, timeMs: number, nowMs: number): RequestWindow => ({
  fromMs: nowMs - REQUEST_SKEW_MS,
  toMs: nowMs + REQUEST_SKEW_MS,
  keepUntilMs: timeMs + REQUEST_SKEW_MS,
});

/**
 * Signed requests (auth.ts) for the contract this relay serves. The digest names the contract
 * and the account, so a signature made for another deployment, or for another account that
 * shares the key, does not verify here.
 *
 * Requests that arrive inside a mesh carry envelope (routes/carry.ts) are dispatched through the
 * app like direct ones; the carry route marks their Request objects here, and nothing else can,
 * so a route can apply the carry rules only to what really came over the mesh.
 */
export class RequestAuth {
  private readonly carried = new WeakSet<Request>();

  constructor(
    private readonly store: Store,
    readonly contractId: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Marks a request built from an opened carry envelope. */
  markCarried(req: Request): Request {
    this.carried.add(req);
    return req;
  }

  isCarried(c: Context): boolean {
    return this.carried.has(c.req.raw);
  }

  /**
   * Checks the signature against the NEAR key the account enrolled with, the request time
   * against its window, and refuses (or reports) a request seen before. Returns the account and
   * the parsed body.
   */
  async signed(c: Context, o: SignedOptions = {}): Promise<{ account: string; body: Obj; repeat: boolean }> {
    const account = c.req.header("x-tail-account");
    const time = Number(c.req.header("x-tail-time"));
    const sigB64 = c.req.header("x-tail-sig");
    if (!account || !sigB64 || !Number.isSafeInteger(time)) throw new HttpError(401, "sign this request");
    const device = this.store.device(account);
    if (!device) throw new HttpError(401, "account not enrolled here");
    const bytes = await bodyBytes(c);
    const url = new URL(c.req.url);
    const digest = requestDigest({
      contractId: this.contractId,
      accountId: account,
      method: c.req.method,
      path: url.pathname + url.search,
      timeMs: time,
      body: bytes,
    });
    if (!verifyEd25519(device.near_pk, digest, new Uint8Array(Buffer.from(sigB64, "base64")))) {
      throw new HttpError(401, "bad request signature");
    }
    const body = parseJson(bytes);
    const now = this.now();
    const w = (o.window ?? defaultWindow)(body, time, now);
    if (time < w.fromMs || time > w.toMs) throw new HttpError(401, "request time is off; check the clock");
    const repeat = !this.store.firstSight(digest, Math.max(w.keepUntilMs, time + REQUEST_SKEW_MS), now);
    // `code` lets a client tell "already delivered" from a refusal without reading the message.
    if (repeat && o.onRepeat !== "report")
      throw new HttpError(409, "request already seen", { code: "duplicate" });
    return { account, body, repeat };
  }
}

export const field = {
  str(o: Obj, k: string, max = 256): string {
    const v = o[k];
    if (typeof v !== "string" || v.length === 0 || v.length > max)
      throw new HttpError(400, `${k}: expected text`);
    return v;
  },
  int(o: Obj, k: string, min: number, max: number): number {
    const v = o[k];
    if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) {
      throw new HttpError(400, `${k}: expected a whole number from ${min} to ${max}`);
    }
    return v as number;
  },
  bool(o: Obj, k: string): boolean {
    const v = o[k];
    if (typeof v !== "boolean") throw new HttpError(400, `${k}: expected true or false`);
    return v;
  },
  /** Base64 bytes, optionally of an exact length. */
  bytes(o: Obj, k: string, len?: number): Uint8Array {
    const v = o[k];
    if (typeof v !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(v))
      throw new HttpError(400, `${k}: expected base64`);
    const b = new Uint8Array(Buffer.from(v, "base64"));
    if (len !== undefined && b.length !== len) throw new HttpError(400, `${k}: expected ${len} bytes`);
    if (b.length === 0) throw new HttpError(400, `${k}: empty`);
    return b;
  },
  /** A decimal string amount in the token's smallest unit. */
  amount(o: Obj, k: string): bigint {
    const v = o[k];
    if (typeof v !== "string" || !/^[0-9]{1,30}$/.test(v))
      throw new HttpError(400, `${k}: expected a decimal string`);
    return BigInt(v);
  },
  matchId(v: string | undefined): string {
    if (!v || !/^[0-9a-f]{32}$/.test(v)) throw new HttpError(400, "match id: 32 lowercase hex characters");
    return v;
  },
  obj(o: Obj, k: string): Obj {
    const v = o[k];
    if (typeof v !== "object" || v === null || Array.isArray(v))
      throw new HttpError(400, `${k}: expected an object`);
    return v as Obj;
  },
  list(o: Obj, k: string, max: number): unknown[] {
    const v = o[k] ?? [];
    if (!Array.isArray(v) || v.length > max)
      throw new HttpError(400, `${k}: expected a list of at most ${max}`);
    return v;
  },
};
