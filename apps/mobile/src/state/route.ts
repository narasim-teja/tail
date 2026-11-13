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
  /**
   * The running hunt session, if any. It starts as soon as the orders open, so the phone reports
   * while the player reads them; `shown` once they tapped Hunt to leave the briefing.
   */
  session: { over: boolean; shown: boolean } | null;
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
  if (f.session) return f.session.over ? "results" : f.session.shown ? "hunt" : "briefing";
  // Out is final: a reopened app must not offer the hunt again while the others play on.
  if (f.out || f.phase === "ended") return "results";
  if (f.phase === "running" || f.phase === "ending") return "briefing";
  return "lobby";
}

/**
 * Whether Briefing reads the orders by itself now: not read yet, nothing in flight (the host's
 * own Start can still be running as the match goes live), and its own last try did not fail,
 * which waits for Try again. Only the briefing's own error counts: an unrelated one elsewhere in
 * the app must not leave the orders unread while the clock runs.
 */
export function autoBrief(f: { briefed: boolean; busy: string | null; briefError: string | null }): boolean {
  return !f.briefed && f.busy === null && f.briefError === null;
}

/**
 * Why a lobby link is not opened now, or null when it may be. While a hunt session runs (from the
 * briefing on), opening another match would drop the hunt screen's match from under it and leave
 * it blank, so the link waits; the line goes in the hunt's log.
 */
export function joinRefusal(session: { over: boolean } | null): string | null {
  return session && !session.over
    ? "A join link was opened. It can wait until this match is over: you're still in the hunt."
    : null;
}
