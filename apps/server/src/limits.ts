// Per-client rate limits for the routes anyone can call without proving a key: enrolment and
// refresh challenges, HUD sockets in their auth window, replay challenges, and new enrolments.
// Each has a global cap behind it too (the challenge tables, the pending-socket count, the daily
// enrolment count); the buckets here stop one client from using up those global caps alone.
//
// The client is the TCP peer's address. Behind a reverse proxy every request comes from the
// proxy, so RELAY_CLIENT_IP_HEADER names the header the proxy sets (cf-connecting-ip,
// x-forwarded-for, …). Only then is a header read: a client can write any header it likes, so
// trusting one without a proxy that overwrites it would let each request pick its own bucket.

import type { Context } from "hono";
import { HttpError } from "./errors.ts";

export interface Rate {
  /** Requests a client may make at once. */
  burst: number;
  /** One more request is allowed every this many ms, up to `burst`. */
  everyMs: number;
}

export const DAY_MS = 86_400_000;

/** The per-client rates. A phone needs one or two of each; a household or a venue shares an address. */
export const RATES = {
  /** POST /enroll/challenge and POST /enroll/refresh/challenge. */
  enrolChallenge: { burst: 10, everyMs: 30_000 },
  /** GET /hud upgrades (a phone reconnects on every network change). */
  hudSocket: { burst: 30, everyMs: 2_000 },
  /** POST /replay/:id/challenge. */
  replayChallenge: { burst: 10, everyMs: 10_000 },
} as const satisfies Record<string, Rate>;

/**
 * Caps on new phone enrolments, each of which costs the relay about 0.1 NEAR. App Attest proves
 * a real iPhone ran the app, not that it is a new person: one iPhone can make any number of App
 * Attest keys, so it could make any number of accounts without these.
 */
export interface EnrolCaps {
  /** New phones in any rolling 24 h, in all (RELAY_ENROLS_PER_DAY). */
  perDay: number;
  /** New phones in any rolling 24 h from one client address (RELAY_ENROLS_PER_IP_PER_DAY). */
  perIpPerDay: number;
}
export const DEFAULT_ENROL_CAPS: EnrolCaps = { perDay: 100, perIpPerDay: 3 };

/** Clients tracked per bucket; past it the longest-tracked is forgotten (it starts full again). */
const MAX_CLIENTS = 10_000;

/** A token bucket per client, in memory: a restart forgets them, which only ever lets more through. */
export class Buckets {
  private readonly clients = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly rate: Rate,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes one token for `client`; false when it has none left. */
  take(client: string): boolean {
    const now = this.now();
    const b = this.clients.get(client);
    const tokens = b
      ? Math.min(this.rate.burst, b.tokens + (now - b.at) / this.rate.everyMs)
      : this.rate.burst;
    if (tokens < 1) return false;
    this.clients.delete(client);
    this.clients.set(client, { tokens: tokens - 1, at: now });
    if (this.clients.size > MAX_CLIENTS) {
      const oldest = this.clients.keys().next().value;
      if (oldest !== undefined) this.clients.delete(oldest);
    }
    return true;
  }

  /** As take, but refuses with a 429 the phone can show. */
  takeOrRefuse(client: string, what: string) {
    if (!this.take(client))
      throw new HttpError(429, `too many ${what} from your network; try again in a minute`);
  }
}

/**
 * Who is asking: the configured proxy header (its last entry, the one the proxy itself added),
 * else the TCP peer as Bun reports it. A request the app dispatches to itself (a mesh carry's
 * inner request) counts against the client that posted the envelope.
 */
export class Clients {
  private readonly forwarded = new WeakMap<Request, string>();

  constructor(private readonly proxyHeader: string | undefined) {}

  /** Marks `req`, built by the relay from what `from` sent, as coming from `from`'s client. */
  forward(req: Request, from: Context): Request {
    this.forwarded.set(req, this.ip(from));
    return req;
  }

  ip(c: Context): string {
    const forwarded = this.forwarded.get(c.req.raw);
    if (forwarded) return forwarded;
    if (this.proxyHeader) {
      const last = c.req.header(this.proxyHeader)?.split(",").at(-1)?.trim();
      if (last) return last;
    }
    // Bun.serve passes the server as the app's env; tests that call app.request have none.
    const server = c.env as { requestIP?: (r: Request) => { address: string } | null } | undefined;
    try {
      return server?.requestIP?.(c.req.raw)?.address ?? "unknown";
    } catch {
      return "unknown";
    }
  }
}
