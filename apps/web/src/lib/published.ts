// The matches this site ships: `public/matches/index.json` lists them, newest first, and each
// one's replay bundle sits beside it at `<id>.json` (written by scripts/publish-match.ts). The
// list says where and when a match was played; nothing in it is trusted for verification: a
// published bundle is checked against the pinned contract exactly like one from the relay.

export interface PublishedMatch {
  /** 16-byte match id, lowercase hex. */
  id: string;
  /** Where it was played, as the publisher wrote it ("Boston Common"). */
  place: string;
  /** When it started, ISO 8601. */
  playedAt: string;
  players: number;
  minutes: number;
  /** Players still standing at End. */
  survivors?: number;
  /** The match the front page plays; without one, the first in the list. */
  featured?: boolean;
}

export class IndexError extends Error {
  override name = "IndexError";
}

const ID = /^[0-9a-f]{32}$/;
const count = (v: unknown, min: number, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/**
 * The index as the site serves it. Strict: anything that isn't the documented shape throws, so a
 * broken list shows as broken rather than as fewer matches.
 */
export function parseIndex(json: unknown): PublishedMatch[] {
  if (!Array.isArray(json)) throw new IndexError("the match list isn't a list");
  const seen = new Set<string>();
  return json.map((raw, i): PublishedMatch => {
    const e = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const bad = (what: string) => new IndexError(`entry ${i}: ${what}`);
    const { id, place, playedAt, players, minutes, survivors, featured } = e;
    if (typeof id !== "string" || !ID.test(id)) throw bad("id isn't 32 lowercase hex characters");
    if (seen.has(id)) throw bad("the same match is listed twice");
    seen.add(id);
    if (typeof place !== "string" || place.trim() === "") throw bad("no place");
    if (typeof playedAt !== "string" || Number.isNaN(Date.parse(playedAt)))
      throw bad("playedAt isn't a date");
    if (!count(players, 1, 64)) throw bad("players isn't a whole number");
    if (!count(minutes, 0, 24 * 60)) throw bad("minutes isn't a whole number");
    if (survivors !== undefined && !count(survivors, 0, players as number))
      throw bad("survivors isn't a whole number of the players");
    if (featured !== undefined && typeof featured !== "boolean") throw bad("featured isn't true or false");
    return {
      id,
      place: place.trim(),
      playedAt,
      players: players as number,
      minutes: minutes as number,
      ...(survivors === undefined ? {} : { survivors: survivors as number }),
      ...(featured ? { featured: true } : {}),
    };
  });
}

/** The front page's match: the one marked featured, else the newest. */
export const featuredOf = (list: readonly PublishedMatch[]): PublishedMatch | null =>
  list.find((m) => m.featured) ?? list[0] ?? null;

export const matchesDir = (base: string = import.meta.env.BASE_URL) => `${base}matches/`;

/** The site's list, or null when it can't be read (none deployed, or not the documented shape). */
export async function readIndex(base: string = import.meta.env.BASE_URL): Promise<PublishedMatch[] | null> {
  try {
    const res = await fetch(`${matchesDir(base)}index.json`, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return parseIndex(await res.json());
  } catch {
    return null;
  }
}
