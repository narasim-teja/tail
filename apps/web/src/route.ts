// Which page an address opens: the one owner of that rule. main.tsx reads it to load only the
// code the page needs (the landing never pulls the replay's map or verifier), and App.tsx to pick
// the replay's page.
//
//   /                              the landing page
//   /docs                          the docs (a fragment such as #proof is a section)
//   /dossier/<account>             a player's dossier
//   /?presence=<proof>, /?presence the presence proof page
//   /?match=…, /?fixture=…, and any address with a replay option (relay, t, gl, view), or any
//   other path: the replay, as before the landing existed (a bare option such as `/?t=372` still
//   plays the default fixture from that moment)
//
// Parameters the replay does not read (`utm_source`, `s`, `ref` from a shared link) keep the
// landing, so a post's tracking tags don't turn the front page into a film.

export type Route =
  | { kind: "landing" }
  | { kind: "docs" }
  | { kind: "dossier"; account: string }
  | { kind: "presence"; initial: string }
  | { kind: "replay" };

/** Every query parameter the replay reads; any one of them opens the replay. */
export const REPLAY_PARAMS = ["match", "fixture", "relay", "t", "gl", "view"] as const;

export function routeOf(pathname: string, search: string, base = "/"): Route {
  const dossier = /^\/dossier\/([^/]+)\/?$/.exec(pathname)?.[1];
  if (dossier) {
    let account = dossier;
    try {
      account = decodeURIComponent(dossier);
    } catch {
      // A malformed escape is kept as typed; the dossier page reads it as an unknown account.
    }
    return { kind: "dossier", account };
  }
  const q = new URLSearchParams(search);
  const presence = q.get("presence");
  if (presence !== null) return { kind: "presence", initial: presence };
  const root = base.endsWith("/") ? base : `${base}/`;
  if (pathname === `${root}docs` || pathname === `${root}docs/`) return { kind: "docs" };
  const atRoot = pathname === root || pathname === root.slice(0, -1) || pathname === `${root}index.html`;
  if (atRoot && !REPLAY_PARAMS.some((p) => q.has(p))) return { kind: "landing" };
  return { kind: "replay" };
}
