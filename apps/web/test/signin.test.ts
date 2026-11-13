// A private replay opened from the TAIL app: /?match=<id>#account_id=…&nonce=…&sig=…, nonce and
// sig in unpadded base64url. The page takes the fragment out of the address before anything else,
// passes the values to the relay as GET /replay/:id reads them, and keeps nothing in storage.

import { afterEach, describe, expect, test } from "bun:test";
import { pageState } from "../src/replay/copy.ts";
import { loadBundle, type SignIn, type Source, signInFromHash, takeSignIn } from "../src/replay/load.ts";

const MATCH = "ab".repeat(16);
const RELAY: Source = { kind: "relay", matchId: MATCH, url: `https://relay.example/replay/${MATCH}` };
const FIXTURE: Source = { kind: "fixture", name: "boston-common", url: "/fixtures/boston-common.json" };

// Bytes that spell "+" and "/" in base64 ("-" and "_" in base64url), so the conversion shows.
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => [0xfb, 0xef, 0xff][i % 3] as number);
const NONCE = bytes(32);
const SIG = bytes(64).reverse();
const url64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const std64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const ACCOUNT = "ghost-ro4ng7aq.tail-dev.testnet";
const HASH = `#account_id=${ACCOUNT}&nonce=${url64(NONCE)}&sig=${url64(SIG)}`;
const SIGN_IN: SignIn = { accountId: ACCOUNT, nonce: std64(NONCE), sig: std64(SIG) };

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});

/** The page's address and history, as takeSignIn sees them. */
function browser(path: string, hash: string) {
  const [pathname = "", search = ""] = path.split(/(?=\?)/);
  const loc = { pathname, search, hash };
  const replaced: string[] = [];
  const hist = {
    state: null,
    replaceState(_: unknown, __: string, url?: string | URL | null) {
      replaced.push(String(url));
      loc.hash = "";
    },
  };
  return { loc, hist, replaced };
}

/** Stubs fetch with one answer, recording each URL asked for and the address hash at that moment. */
function relayAnswers(status: number, body: unknown, hashAt: () => string = () => "") {
  const calls: { url: string; hash: string }[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push({ url: String(input), hash: hashAt() });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return calls;
}

describe("the sign-in in a replay link's fragment", () => {
  test("is read from unpadded base64url and handed on as the standard base64 the relay decodes", () => {
    expect(url64(NONCE)).toMatch(/[-_]/);
    const s = signInFromHash(HASH);
    expect(s).toEqual(SIGN_IN);
    expect(s?.nonce).toMatch(/[+/]/);
    expect(Buffer.from(s?.nonce ?? "", "base64")).toEqual(Buffer.from(NONCE));
    expect(Buffer.from(s?.sig ?? "", "base64")).toEqual(Buffer.from(SIG));
  });

  test("anything malformed counts as no sign-in at all", () => {
    const n = url64(NONCE);
    const g = url64(SIG);
    const malformed = [
      "",
      "#",
      `#nonce=${n}&sig=${g}`,
      `#account_id=${ACCOUNT}&sig=${g}`,
      `#account_id=${ACCOUNT}&nonce=${n}`,
      `#account_id=${ACCOUNT}&nonce=${n}=&sig=${g}`, // padded
      `#account_id=${ACCOUNT}&nonce=${std64(NONCE).replace(/=+$/, "")}&sig=${g}`, // "+" and "/"
      `#account_id=${ACCOUNT}&nonce=${url64(bytes(31))}&sig=${g}`,
      `#account_id=${ACCOUNT}&nonce=${url64(bytes(33))}&sig=${g}`,
      `#account_id=${ACCOUNT}&nonce=${n}&sig=${url64(bytes(63))}`,
      `#account_id=${ACCOUNT}&nonce=${n.slice(0, -1)}B&sig=${g}`, // stray bits: not canonical
      `#account_id=${ACCOUNT}&nonce=${n}&sig=${g}&sig=${g}`,
      `#account_id=Ghost.testnet&nonce=${n}&sig=${g}`,
      `#account_id=a&nonce=${n}&sig=${g}`,
      `#account_id=${"a".repeat(65)}&nonce=${n}&sig=${g}`,
      `#account_id=ghost..testnet&nonce=${n}&sig=${g}`,
    ];
    for (const hash of malformed) expect([hash, signInFromHash(hash)]).toEqual([hash, null]);
  });

  test("leaves the address bar before the relay is asked, and the relay gets the query it reads", async () => {
    const b = browser(`/?match=${MATCH}`, HASH);
    const calls = relayAnswers(200, { version: 2 }, () => b.loc.hash);
    const signIn = takeSignIn(b.loc, b.hist);
    expect(b.replaced).toEqual([`/?match=${MATCH}`]);
    expect(await loadBundle(RELAY, signIn)).toEqual({ kind: "ok", json: { version: 2 } });
    expect(calls).toHaveLength(1);
    const call = calls[0] as { url: string; hash: string };
    expect(call.hash).toBe("");
    // Hono reads a bare "+" as a space, so base64's "+", "/" and "=" must travel percent-encoded.
    const raw = (call.url.split("?")[1] ?? "").split("&").map((kv) => kv.slice(kv.indexOf("=") + 1));
    for (const v of raw) expect(v).not.toMatch(/[+/=]/);
    const u = new URL(call.url);
    expect(u.origin + u.pathname).toBe(RELAY.url);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      account_id: ACCOUNT,
      nonce: std64(NONCE),
      sig: std64(SIG),
    });
    expect(u.search).toContain("%2B");
  });

  test("a malformed fragment is still taken out of the address, and the relay gets no query", async () => {
    const b = browser(`/?match=${MATCH}&t=30`, `#account_id=${ACCOUNT}&nonce=short&sig=short`);
    const calls = relayAnswers(403, {});
    const signIn = takeSignIn(b.loc, b.hist);
    expect(signIn).toBeNull();
    expect(b.replaced).toEqual([`/?match=${MATCH}&t=30`]);
    expect(await loadBundle(RELAY, signIn)).toEqual({ kind: "private", refused: false });
    expect(calls.map((c) => c.url)).toEqual([RELAY.url]);
  });

  test("an address without a fragment is left alone", () => {
    const b = browser(`/?match=${MATCH}`, "");
    expect(takeSignIn(b.loc, b.hist)).toBeNull();
    expect(b.replaced).toEqual([]);
  });

  test("a used or expired sign-in (403) sends the player back to the app, not the no-sign-in page", async () => {
    relayAnswers(403, { error: "this replay is for the match's players" });
    const r = await loadBundle(RELAY, SIGN_IN);
    expect(r).toEqual({ kind: "private", refused: true });
    const used = pageState({ kind: "private", players: 4, refused: true });
    expect(used).toEqual({
      title: "This replay is private",
      body: "This sign-in link had expired or was already used. Each one works once, within two minutes. If you played, open the replay again from the TAIL app.",
      retry: false,
    });
    expect(pageState({ kind: "private", players: 4, refused: false }).body).not.toBe(used.body);
  });

  test("a public match loads as it always did; a fixture never sends a sign-in", async () => {
    const plain = relayAnswers(200, { version: 2 });
    const unsigned = await loadBundle(RELAY);
    expect(await loadBundle(RELAY, SIGN_IN)).toEqual(unsigned);
    expect(unsigned).toEqual({ kind: "ok", json: { version: 2 } });
    expect(plain[0]?.url).toBe(RELAY.url);

    const calls = relayAnswers(200, { version: 2 });
    await loadBundle(FIXTURE, SIGN_IN);
    expect(calls.map((c) => c.url)).toEqual([FIXTURE.url]);
  });

  test("nothing is written to web storage", async () => {
    const writes: string[] = [];
    const storage = (name: string) =>
      ({
        getItem: () => null,
        setItem: (k: string) => writes.push(`${name}.setItem ${k}`),
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        length: 0,
      }) as unknown as Storage;
    const g = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
    const saved = { local: g.localStorage, session: g.sessionStorage };
    g.localStorage = storage("localStorage");
    g.sessionStorage = storage("sessionStorage");
    try {
      const b = browser(`/?match=${MATCH}`, HASH);
      relayAnswers(200, { version: 2 });
      await loadBundle(RELAY, takeSignIn(b.loc, b.hist));
      relayAnswers(403, {});
      await loadBundle(RELAY, SIGN_IN);
      expect(writes).toEqual([]);
    } finally {
      if (saved.local) g.localStorage = saved.local;
      else delete g.localStorage;
      if (saved.session) g.sessionStorage = saved.session;
      else delete g.sessionStorage;
    }
  });
});
