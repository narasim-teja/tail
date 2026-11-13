// Publishes a finished, public match with the site: fetches its replay bundle from a relay,
// writes it to public/matches/<id>.json with the front page's scene of it beside it
// (<id>.scene.json, scripts/scene.ts), and lists it first in public/matches/index.json.
//
//   bun apps/web/scripts/publish-match.ts <match id> --place "Boston Common" [--map <name>]
//     [--relay <url>] [--featured]
//
// --map names the place's map in public/maps/<name>.json (scripts/fetch-paths.ts writes one),
// which the front page draws under the match when it is featured; without one it draws the zone
// alone. The stake token's decimals are read from NEAR (ft_metadata), so the hero's head is exact.
//
// The relay defaults to http://localhost:8787. A private match is refused: the relay serves it
// only to its players (403), and a bundle that says it isn't public is refused too. The bundle
// holds every player's location trail for the whole match, and once committed anyone who opens
// the site can download it, so publish only a match whose players agreed to that.
//
// The published copy earns no trust of its own: the replay checks it against the pinned
// contract exactly as it checks the relay's.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type PublishedMatch, parseIndex } from "../src/lib/published.ts";
import { decodeBundle } from "../src/verify/bundle.ts";
import { nearReader } from "../src/verify/chain.ts";
import { prepare } from "../src/verify/index.ts";
import { networkOf } from "../src/verify/pins.ts";
import { sceneOfMatch, survivorsOf } from "./scene.ts";

export class PublishError extends Error {
  override name = "PublishError";
}

export interface PublishOptions {
  id: string;
  place: string;
  relay?: string;
  featured?: boolean;
  /** The place's map, public/maps/<name>.json; it must exist beside `dir`. */
  map?: string;
  /** Where index.json and the bundles live (public/matches). */
  dir: string;
  fetch?: typeof fetch;
  /** The stake token's decimals, or null when NEAR doesn't say; NEAR's ft_metadata by default. */
  tokenDecimals?: (token: string) => Promise<number | null>;
}

const decimalsFromNear = async (token: string) =>
  (await nearReader(networkOf(token)).token(token))?.decimals ?? null;

const REFUSED: Record<number, string> = {
  403: "the relay serves this match only to its players: it is private. Its host can turn on Public replay in the app.",
  404: "the relay has no such match.",
  409: "the match hasn't finished yet.",
  410: "the relay has deleted this match's trails after its retention window.",
};

export async function publishMatch(o: PublishOptions): Promise<string[]> {
  const id = o.id.toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(id)) throw new PublishError("a match id is 32 hex characters");
  const place = o.place.trim();
  if (!place) throw new PublishError('say where it was played: --place "Boston Common"');
  const relay = (o.relay ?? "http://localhost:8787").replace(/\/+$/, "");
  const map = o.map?.trim();
  if (map !== undefined) {
    if (!/^[a-z0-9-]+$/.test(map))
      throw new PublishError("a map name is lowercase letters, digits and dashes");
    if (!existsSync(join(o.dir, "..", "maps", `${map}.json`)))
      throw new PublishError(
        `no map public/maps/${map}.json: fetch it first (scripts/fetch-paths.ts --map ${map})`,
      );
  }
  const get = o.fetch ?? fetch;

  const res = await get(`${relay}/replay/${id}`, { headers: { accept: "application/json" } });
  const why = REFUSED[res.status];
  if (why) throw new PublishError(`not published: ${why}`);
  if (!res.ok) throw new PublishError(`not published: the relay answered ${res.status}`);
  const bundle = (await res.json()) as { match?: { id?: unknown; publicReplay?: unknown } };
  if (bundle.match?.id !== id)
    throw new PublishError("not published: the relay sent a bundle for another match");
  if (bundle.match.publicReplay !== true)
    throw new PublishError("not published: the bundle says this match is private (publicReplay is not true)");

  // Read with the replay's own model, so the list and the picture say what the replay will show.
  const match = prepare(decodeBundle(JSON.parse(JSON.stringify(bundle)))).match;
  if (!match.events.some((e) => e.kind === "end"))
    throw new PublishError("not published: the bundle has no End");
  const entry: PublishedMatch = {
    id,
    place,
    playedAt: new Date(match.startMs).toISOString(),
    players: match.players.length,
    minutes: Math.round(match.durationMs / 60_000),
    survivors: survivorsOf(match),
    ...(map ? { map } : {}),
    ...(o.featured ? { featured: true } : {}),
  };
  const decimals = await (o.tokenDecimals ?? decimalsFromNear)(match.token);
  if (decimals === null)
    throw new PublishError(`not published: NEAR didn't say how many decimals ${match.token} has`);

  mkdirSync(o.dir, { recursive: true });
  const indexPath = join(o.dir, "index.json");
  const before = existsSync(indexPath) ? parseIndex(JSON.parse(readFileSync(indexPath, "utf8"))) : [];
  const rest = before
    .filter((m) => m.id !== id)
    .map((m) => {
      if (!o.featured || !m.featured) return m;
      const { featured: _, ...plain } = m;
      return plain;
    });
  const index = [entry, ...rest];
  parseIndex(index);
  writeFileSync(join(o.dir, `${id}.json`), `${JSON.stringify(bundle)}\n`);
  writeFileSync(
    join(o.dir, `${id}.scene.json`),
    `${JSON.stringify(sceneOfMatch(match, "published", place, decimals))}\n`,
  );
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  const trails = match.tracks.filter(Boolean).length;
  return [
    `published ${id}: ${place}, ${entry.playedAt.slice(0, 10)}, ${entry.players} players, ${entry.minutes} min, ${entry.survivors} survived${o.featured ? ", featured" : ""}`,
    `wrote ${id}.json, ${id}.scene.json and index.json in ${o.dir}`,
    `THE BUNDLE CONTAINS EVERY PLAYER'S LOCATION TRAIL for the whole match (${trails} of ${entry.players} players' trails). Once committed and deployed, anyone can download it. Commit it only if every player agreed.`,
  ];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const id = args.find(
    (a, i) => !a.startsWith("--") && !["--place", "--relay", "--map"].includes(args[i - 1] ?? ""),
  );
  try {
    const lines = await publishMatch({
      id: id ?? "",
      place: flag("--place") ?? "",
      featured: args.includes("--featured"),
      ...(flag("--map") ? { map: flag("--map") as string } : {}),
      dir: join(import.meta.dir, "..", "public", "matches"),
      ...(flag("--relay") ? { relay: flag("--relay") as string } : {}),
    });
    for (const l of lines) console.log(l);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
