// Where the bundle comes from, and what the relay's answer means for the page.
//
//   /?match=<32 hex>              the relay's GET /replay/:id (VITE_RELAY_URL, else /relay)
//   /?match=<id>&relay=<url>      a specific relay
//   /?fixture=<name>              a bundle from public/fixtures (default: boston-common)
//
// A private match's relay serves the bundle only to a player who signed its challenge. The TAIL
// app does that on the phone and opens /?match=<id>#account_id=…&nonce=…&sig=…: the fragment
// never reaches a web server or its logs, and the page passes the three values on to the relay's
// GET /replay/:id once. They only open the relay's door: the bundle is checked exactly as any
// other, against the pinned contract.

export type Source =
  | { kind: "fixture"; name: string; url: string }
  | { kind: "relay"; matchId: string; url: string };

export function sourceFromUrl(search: string): Source {
  const q = new URLSearchParams(search);
  const match = q.get("match")?.toLowerCase();
  if (match && /^[0-9a-f]{32}$/.test(match)) {
    const relay = (q.get("relay") || import.meta.env.VITE_RELAY_URL || "/relay").replace(/\/+$/, "");
    return { kind: "relay", matchId: match, url: `${relay}/replay/${match}` };
  }
  const name = (q.get("fixture") || "boston-common").replace(/[^a-z0-9-]/gi, "");
  return { kind: "fixture", name, url: `${import.meta.env.BASE_URL}fixtures/${name}.json` };
}

/**
 * A player's answer to the relay's replay challenge, as the relay reads it: the account, the
 * 32-byte nonce and the 64-byte ed25519 signature, both in standard padded base64.
 */
export interface SignIn {
  accountId: string;
  nonce: string;
  sig: string;
}

// NEAR's account id rule (nearcore's AccountId): 2 to 64 characters, lowercase parts joined by
// "-" or "_", separated by dots. Implicit accounts (64 hex) fit it too.
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const isAccountId = (s: string) => s.length >= 2 && s.length <= 64 && ACCOUNT_ID.test(s);

/**
 * Exactly `bytes` bytes in unpadded base64url, re-encoded as the standard padded base64 the
 * relay documents; null for anything else. Only the canonical spelling is taken (re-encoding
 * the decoded bytes must give the input back), so one value has one form.
 */
function base64urlTo64(s: string, bytes: number): string | null {
  if (s.length !== Math.ceil((bytes * 4) / 3) || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  let raw: string;
  try {
    raw = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  } catch {
    return null;
  }
  if (raw.length !== bytes) return null;
  const out = btoa(raw);
  return out.replace(/=+$/, "") === std ? out : null;
}

/**
 * The sign-in a URL fragment carries: `account_id`, `nonce` (32 bytes) and `sig` (64 bytes), the
 * last two in unpadded base64url, each exactly once. Anything else is no sign-in at all.
 */
export function signInFromHash(hash: string): SignIn | null {
  const f = new URLSearchParams(hash.replace(/^#/, ""));
  const one = (k: string) => {
    const all = f.getAll(k);
    return all.length === 1 ? (all[0] ?? null) : null;
  };
  const accountId = one("account_id");
  const nonce = base64urlTo64(one("nonce") ?? "", 32);
  const sig = base64urlTo64(one("sig") ?? "", 64);
  return accountId !== null && isAccountId(accountId) && nonce && sig ? { accountId, nonce, sig } : null;
}

/**
 * Reads the sign-in from the address and drops the fragment from it (well-formed or not) with
 * `replaceState`, so the address a player copies or shares, or that the history keeps, carries no
 * signature. Called once, before the first render or request. The sign-in then lives only in this
 * page view's memory: nothing is written to storage, so a reload has none.
 */
export function takeSignIn(
  loc: Pick<Location, "hash" | "pathname" | "search">,
  hist: Pick<History, "state" | "replaceState">,
): SignIn | null {
  if (!loc.hash) return null;
  const signIn = signInFromHash(loc.hash);
  hist.replaceState(hist.state, "", loc.pathname + loc.search);
  return signIn;
}

export type Loaded =
  | { kind: "ok"; json: unknown }
  /**
   * 403: a private match. `refused` when the page offered the relay a sign-in and it said no:
   * the nonce had expired or was already used (it works once), or the signature isn't a player's.
   */
  | { kind: "private"; refused: boolean }
  /** 409: the match has not ended (or not settled) yet. */
  | { kind: "not-finished" }
  /** 410: the relay deleted the match's trails after its retention window, so it has no replay. */
  | { kind: "purged" }
  | { kind: "missing" }
  | { kind: "error"; message: string };

/**
 * Fetches the bundle. A sign-in goes to the relay as the query GET /replay/:id reads; the relay
 * ignores it for a public match. URLSearchParams percent-encodes base64's "+", "/" and "=", which
 * matters: Hono reads a bare "+" in a query as a space.
 */
export async function loadBundle(src: Source, signIn: SignIn | null = null): Promise<Loaded> {
  const signed = src.kind === "relay" && signIn !== null;
  const url = signed
    ? `${src.url}?${new URLSearchParams({ account_id: signIn.accountId, nonce: signIn.nonce, sig: signIn.sig })}`
    : src.url;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : "network error" };
  }
  if (res.status === 403) return { kind: "private", refused: signed };
  if (res.status === 409) return { kind: "not-finished" };
  if (res.status === 410) return { kind: "purged" };
  if (res.status === 404) return { kind: "missing" };
  if (!res.ok) return { kind: "error", message: `The server answered ${res.status}.` };
  try {
    return { kind: "ok", json: await res.json() };
  } catch {
    return { kind: "error", message: "The server sent something that isn't a replay." };
  }
}
