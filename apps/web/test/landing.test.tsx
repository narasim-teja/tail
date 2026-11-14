// The front page and the docs: which address opens what, NEAR's word on each match row, the
// prices and the worked hunt, the hero's scene and its map, the site's links, its colours and its
// origin.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DARK_FORFEIT_MS,
  EPOCH_MS,
  HintKind,
  hintPrice,
  LOCK_EPOCHS,
  PRICE_CAP_BPS,
  PRICE_STEP_BPS,
  PRICE_WINDOW_MS,
  WINDOW_EPOCHS,
} from "@tail/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { makeFixtures } from "../scripts/fixture.ts";
import { FIXTURE_DECIMALS, sceneOf } from "../scripts/scene.ts";
import { Docs, SECTIONS } from "../src/docs-page/Docs.tsx";
import { Ledger, ledger } from "../src/docs-page/Ledger.tsx";
import { Hints } from "../src/landing/Beats.tsx";
import { configOf, DEFAULT_REPO_URL, repoFile } from "../src/landing/config.ts";
import { readingAt, stillTime } from "../src/landing/HeroMap.tsx";
import { onMap, parseMap } from "../src/landing/map.ts";
import { rowState } from "../src/landing/near.ts";
import { ProofStrip, REASONS, STANDING } from "../src/landing/Proof.tsx";
import { contrast, PAIRS } from "../src/landing/palette.ts";
import { STAKE, usdc } from "../src/landing/rules.ts";
import { SiteFooter, SiteTop } from "../src/landing/Site.tsx";
import { headAt, lockAt, parseScene } from "../src/landing/scene.ts";
import { siteOf } from "../src/landing/site.ts";
import { routeOf } from "../src/route.ts";
import type { ChainMatch, ChainState } from "../src/verify/anchor.ts";
import { text as plain } from "./render.tsx";

const fx = makeFixtures();
const ID = "ab".repeat(16);
const PUBLIC = join(import.meta.dir, "..", "public");

describe("which page an address opens", () => {
  test("the bare address is the front page, with or without a shared link's tracking tags", () => {
    expect(routeOf("/", "")).toEqual({ kind: "landing" });
    expect(routeOf("/", "?utm_source=x&s=20")).toEqual({ kind: "landing" });
    expect(routeOf("/index.html", "")).toEqual({ kind: "landing" });
  });

  test("/docs is the docs, with or without a trailing slash, and under a base path", () => {
    expect(routeOf("/docs", "")).toEqual({ kind: "docs" });
    expect(routeOf("/docs/", "")).toEqual({ kind: "docs" });
    expect(routeOf("/tail/docs", "", "/tail/")).toEqual({ kind: "docs" });
    expect(routeOf("/docs/more", "")).toEqual({ kind: "replay" });
  });

  test("every address the replay answered before still opens the replay", () => {
    for (const search of [
      `?match=${ID}`,
      `?match=${ID}&relay=https://relay.example`,
      "?fixture=boston-common",
      "?fixture=boston-common-economy&view=economy",
      "?view=economy",
      "?t=372",
      "?gl=0",
    ])
      expect(routeOf("/", search)).toEqual({ kind: "replay" });
    expect(routeOf("/anything", "")).toEqual({ kind: "replay" });
  });

  test("the presence and dossier pages keep their addresses", () => {
    expect(routeOf("/", "?presence=abc")).toEqual({ kind: "presence", initial: "abc" });
    expect(routeOf("/", "?presence")).toEqual({ kind: "presence", initial: "" });
    expect(routeOf("/dossier/ana.tail-dev-a38d13.testnet", "")).toEqual({
      kind: "dossier",
      account: "ana.tail-dev-a38d13.testnet",
    });
    expect(routeOf("/dossier/a%20b/", "")).toEqual({ kind: "dossier", account: "a b" });
  });

  test("under a base path, the front page is that path", () => {
    expect(routeOf("/tail/", "", "/tail/")).toEqual({ kind: "landing" });
    expect(routeOf("/", "", "/tail/")).toEqual({ kind: "replay" });
  });

  test("the static host serves the page for /docs and every dossier, as before", () => {
    const rules = readFileSync(join(PUBLIC, "_redirects"), "utf8")
      .trim()
      .split("\n")
      .map((l) => l.trim().split(/\s+/));
    expect(rules).toContainEqual(["/dossier/*", "/", "200"]);
    expect(rules).toContainEqual(["/docs", "/", "200"]);
    expect(rules).toContainEqual(["/docs/", "/", "200"]);
  });
});

describe("a match row's word from NEAR", () => {
  const found = (settled_as: ChainMatch["settled_as"]): ChainState => ({
    kind: "found",
    match: { settled_as } as ChainMatch,
    roots: { checkpoints: [], final_root: null },
    head: { kind: "none" },
  });
  test("is how the contract settled it, and says so when NEAR can't tell", () => {
    expect(rowState(found("payout"))).toBe("paid");
    expect(rowState(found("payout_unreplayed"))).toBe("paid-unreplayed");
    expect(rowState(found("refunded_rule_violation"))).toBe("refunded");
    expect(rowState(found("refunded_abort"))).toBe("refunded");
    expect(rowState(found(null))).toBe("open");
    expect(rowState({ kind: "absent" })).toBe("absent");
    expect(rowState({ kind: "unreachable", reason: "x" })).toBe("unreachable");
  });
});

describe("money on the site", () => {
  test("each hint's price shown is the pricing rule's, at the site's stake", () => {
    const page = plain(renderToStaticMarkup(<Hints />));
    for (const k of [HintKind.Near, HintKind.Bearing, HintKind.Trend])
      expect(page).toContain(`$${usdc(hintPrice(STAKE, k, 1))}`);
    expect(page).toContain("0.3125");
  });

  test("the worked hunt moves money without minting any: the table holds the stakes at every step", () => {
    const rows = ledger();
    const others = STAKE * 3n;
    for (const r of rows) expect(r.you + (r.target ?? 0n) + r.pool + others).toBe(STAKE * 5n);
    expect(rows[3]?.you).toBe(STAKE * 2n);
    const table = plain(renderToStaticMarkup(<Ledger />));
    expect(table).toContain(usdc(STAKE - hintPrice(STAKE, HintKind.Bearing, 0)));
    expect(table).toContain(usdc(hintPrice(STAKE, HintKind.Bearing, 0) + hintPrice(STAKE, HintKind.Near, 1)));
  });
});

describe("the docs", () => {
  const page = plain(renderToStaticMarkup(<Docs />));
  const html = renderToStaticMarkup(<Docs />);

  test("state the rules with the numbers the referee runs and the contract checks", () => {
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];
    expect(page).toContain(
      `${words[LOCK_EPOCHS]} of the last ${words[WINDOW_EPOCHS]} ${EPOCH_MS / 1000}-second windows`,
    );
    expect(page).toContain(`plus ${PRICE_STEP_BPS / 100}% for every hint`);
    expect(page).toContain(
      `last ${words[PRICE_WINDOW_MS / 60_000]} minutes, at most ${PRICE_CAP_BPS / 10_000}×`,
    );
    expect(page).toContain(`${words[DARK_FORFEIT_MS / 60_000]} minutes of dark time`);
    // The working stepper and the worked hunt, both priced by the rule.
    expect(page).toContain(`$${usdc(hintPrice(STAKE, HintKind.Bearing, 1))}`);
    expect(page).toContain(usdc(STAKE * 2n));
  });

  test("every section has the anchor the site links to", () => {
    for (const s of SECTIONS) expect(html).toContain(`id="${s.id}"`);
    expect(SECTIONS.map((s) => s.id)).toContain("proof");
    expect(SECTIONS.map((s) => s.id)).toContain("limits");
  });

  test("link into the repository for source files", () => {
    expect(html).toContain(`href="${DEFAULT_REPO_URL}/blob/main/crates/referee-verify/README.md"`);
    expect(html).toContain(`href="${DEFAULT_REPO_URL}/blob/main/ARCHITECTURE.md"`);
  });
});

describe("the site's links", () => {
  test("the repository defaults to the public GitHub repo, and VITE_REPO_URL overrides it", () => {
    expect(configOf({}).repoUrl).toBe("https://github.com/narasim-teja/tail");
    expect(configOf({ VITE_REPO_URL: " https://git.example/me/tail/ " }).repoUrl).toBe(
      "https://git.example/me/tail",
    );
    expect(repoFile("README.md", "https://git.example/me/tail")).toBe(
      "https://git.example/me/tail/blob/main/README.md",
    );
  });

  test("the docs are the site's own /docs unless VITE_DOCS_URL says otherwise", () => {
    expect(configOf({}).docsUrl).toBe("/docs");
    expect(configOf({}, "/tail/").docsUrl).toBe("/tail/docs");
    expect(configOf({ VITE_DOCS_URL: "https://docs.example" }).docsUrl).toBe("https://docs.example");
    expect(configOf({}).dossierAccount).toBeNull();
  });

  test("the top bar and the footer carry GitHub and Docs; the footer nothing else but the matches", () => {
    const top = renderToStaticMarkup(<SiteTop current="home" />);
    expect(top).toContain(`href="${DEFAULT_REPO_URL}"`);
    expect(top).toContain(">Docs<");
    const foot = renderToStaticMarkup(<SiteFooter />);
    expect(plain(foot)).toContain("GitHub");
    expect(plain(foot)).toContain("Docs");
    expect(plain(foot)).toContain("Watch a match");
    expect(plain(foot)).not.toContain("Built with");
    expect(plain(foot)).not.toContain("AGPL");
  });

  test("the proof section gives every reason, says where things stand, and sends the rest to the docs", () => {
    const strip = renderToStaticMarkup(<ProofStrip />);
    expect(strip.match(/<li /g)?.length).toBe(REASONS.length);
    expect(plain(strip)).toContain(STANDING);
    expect(strip).toContain('href="/docs#proof"');
    expect(strip).toContain('href="/docs#limits"');
  });
});

describe("the hero's scene", () => {
  const scene = parseScene(
    JSON.parse(JSON.stringify(sceneOf(fx.full, "fixture", "Boston Common", FIXTURE_DECIMALS))),
  );
  test("is the generated match's first chase, its lock filling from the logged contacts before the tag", () => {
    expect(scene.players).toEqual(["Ana", "Bo", "Cy", "Dee", "Eli"]);
    const chase = scene.chase;
    expect(chase).not.toBeNull();
    if (!chase) return;
    expect([scene.players[chase.hunter], scene.players[chase.target]]).toEqual(["Ana", "Bo"]);
    expect(lockAt(chase.lock, chase.from)).toBe(0);
    expect(lockAt(chase.lock, chase.tag)).toBe(4);
    expect(scene.out[chase.target]).toBe(chase.tag);
  });

  test("carries the hunter's head as the referee moved it: the stake, then the target's head on the tag", () => {
    const chase = scene.chase;
    if (!chase) throw new Error("no chase");
    expect(headAt(chase.head, chase.from)).toBe(STAKE);
    expect(headAt(chase.head, chase.tag)).toBeGreaterThan(STAKE);
    // Reduce Motion's still frame is the strike, read the way the instruments read it.
    expect(readingAt(chase, stillTime(chase)).lock).toBe(LOCK_EPOCHS);
  });

  test("a scene file that isn't one is refused", () => {
    expect(() => parseScene({ ...scene, version: 1 })).toThrow("version");
    expect(() => parseScene({ ...scene, tracks: [] })).toThrow("tracks");
    expect(() => parseScene({ ...scene, center: [1] })).toThrow("centre");
    expect(() => parseScene({ ...scene, chase: { ...scene.chase, head: [] } })).toThrow("head");
  });

  test("lies on the committed Boston Common map, which names the streets round it", () => {
    const bytes = readFileSync(join(PUBLIC, "maps", "boston-common.json"));
    // Light enough for the first screen: it travels gzipped.
    expect(Bun.gzipSync(bytes).length).toBeLessThan(20_000);
    const map = parseMap(JSON.parse(bytes.toString("utf8")));
    const [x, y] = onMap(map, scene.center[0], scene.center[1]);
    const [w, s, e, n] = map.extent;
    expect(x > w && x < e && y > s && y < n).toBe(true);
    const streets = map.streets.map((st) => st.name);
    for (const st of ["Beacon St", "Tremont St", "Boylston St", "Charles St", "Park St"])
      expect(streets).toContain(st);
    expect(map.places.map((p) => p.name)).toEqual(
      expect.arrayContaining(["Boston Common", "Frog Pond", "Public Garden"]),
    );
    expect(map.source).toContain("OpenStreetMap");
    expect(() => parseMap({ ...map, roads: [{ c: 4, d: [0, 0, 1, 1] }] })).toThrow("roads");
  });
});

describe("colours", () => {
  test("every text colour passes WCAG AA on every ground it is set on, the map's labels included", () => {
    for (const p of PAIRS) expect([p.what, contrast(p.fg, p.bg) >= 4.5]).toEqual([p.what, true]);
  });
});

describe("the site's origin", () => {
  test("defaults to playtail.app and must be https", () => {
    expect(siteOf(undefined)).toEqual({ url: "https://playtail.app", host: "playtail.app" });
    expect(siteOf("https://example.app/")).toEqual({ url: "https://example.app", host: "example.app" });
    expect(() => siteOf("http://playtail.app")).toThrow("https");
  });
});
