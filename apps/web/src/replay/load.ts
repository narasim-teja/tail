// Where the bundle comes from, and what the relay's answer means for the page.
//
//   /?match=<32 hex>              the relay's GET /replay/:id (VITE_RELAY_URL, else /relay)
//   /?match=<id>&relay=<url>      a specific relay
//   /?fixture=<name>              a bundle from public/fixtures (default: boston-common)

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

export type Loaded =
  | { kind: "ok"; json: unknown }
  /** 403: a private match and the viewer is not signed in as a player. */
  | { kind: "private" }
  /** 409: the match has not ended (or not settled) yet. */
  | { kind: "not-finished" }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export async function loadBundle(src: Source, signal?: AbortSignal): Promise<Loaded> {
  let res: Response;
  try {
    res = await fetch(src.url, { headers: { accept: "application/json" }, ...(signal ? { signal } : {}) });
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : "network error" };
  }
  if (res.status === 403) return { kind: "private" };
  if (res.status === 409) return { kind: "not-finished" };
  if (res.status === 404) return { kind: "missing" };
  if (!res.ok) return { kind: "error", message: `The server answered ${res.status}.` };
  try {
    return { kind: "ok", json: await res.json() };
  } catch {
    return { kind: "error", message: "The server sent something that isn't a replay." };
  }
}
