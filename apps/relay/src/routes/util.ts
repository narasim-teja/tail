// Request parsing shared by the routes: signed requests and typed JSON fields. Every refusal is
// an HttpError with a short message the phone can show as is.

import type { Context } from "hono";
import { REQUEST_SKEW_MS, requestDigest, verifyEd25519 } from "../auth.ts";
import type { Store } from "../db.ts";
import { HttpError } from "../errors.ts";

/** Largest body the relay reads (a sealed batch is a few KB; an attestation about 5 KB). */
export const MAX_BODY = 64 * 1024;

type Obj = Record<string, unknown>;

async function bodyBytes(c: Context): Promise<Uint8Array> {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > MAX_BODY) throw new HttpError(413, "request too large");
  const b = new Uint8Array(await c.req.arrayBuffer());
  if (b.length > MAX_BODY) throw new HttpError(413, "request too large");
  return b;
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

/**
 * Checks a signed request (auth.ts) against the NEAR key the account enrolled with, refuses a
 * replay inside the freshness window, and returns the account and the parsed body.
 */
export async function signedBody(
  c: Context,
  store: Store,
  now = Date.now(),
): Promise<{ account: string; body: Obj }> {
  const account = c.req.header("x-tail-account");
  const time = Number(c.req.header("x-tail-time"));
  const sigB64 = c.req.header("x-tail-sig");
  if (!account || !sigB64 || !Number.isSafeInteger(time)) throw new HttpError(401, "sign this request");
  if (Math.abs(now - time) > REQUEST_SKEW_MS)
    throw new HttpError(401, "request time is off; check the clock");
  const device = store.device(account);
  if (!device) throw new HttpError(401, "account not enrolled here");
  const bytes = await bodyBytes(c);
  const url = new URL(c.req.url);
  const digest = requestDigest(c.req.method, url.pathname + url.search, time, bytes);
  if (!verifyEd25519(device.near_pk, digest, new Uint8Array(Buffer.from(sigB64, "base64")))) {
    throw new HttpError(401, "bad request signature");
  }
  if (!store.firstSight(digest, time + REQUEST_SKEW_MS, now))
    throw new HttpError(409, "request already seen");
  return { account, body: parseJson(bytes) };
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
