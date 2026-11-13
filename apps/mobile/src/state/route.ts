// Which screen the app shows, decided from plain facts so every case can be tested. During a
// match the hunt session (when it runs) is the authority; without one (the app was reopened, or
// you were never in the hunt) the chain's record decides, including whether you are out.

/** Screens opened from Home, before any match. */
export type Page = "create" | "scan" | "profile";

export type Route =
  | "loading"
  | "enrol"
  | "primer"
  | "home"
  | Page
  | "lobby"
  | "briefing"
  | "hunt"
  | "results";

export interface RouteFacts {
  ready: boolean;
  enrolled: boolean;
  primerSeen: boolean;
  matchId: string | null;
  page: Page | null;
  /** The player asked for results (See results on the tagged screen). */
  resultsNow: boolean;
  /** The running hunt session, if any. */
  session: { over: boolean } | null;
  /** The relay's phase for the match. */
  phase: string | undefined;
  /** The chain says this player is out. */
  out: boolean;
}

export function routeFor(f: RouteFacts): Route {
  if (!f.ready) return "loading";
  if (!f.enrolled) return "enrol";
  if (!f.primerSeen) return "primer";
  if (!f.matchId) return f.page ?? "home";
  if (f.resultsNow) return "results";
  if (f.session) return f.session.over ? "results" : "hunt";
  // Out is final: a reopened app must not offer the hunt again while the others play on.
  if (f.out || f.phase === "ended") return "results";
  if (f.phase === "running" || f.phase === "ending") return "briefing";
  return "lobby";
}
