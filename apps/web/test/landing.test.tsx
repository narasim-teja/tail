// The front page: which address opens it, NEAR's word on each match row, the prices and the
// worked hunt it shows, its scene of a match, its colours and its origin.

import { describe, expect, test } from "bun:test";
import { HintKind, hintPrice } from "@tail/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { makeFixtures } from "../scripts/fixture.ts";
import { sceneOf } from "../scripts/scene.ts";
import { Hints, STAKE, usdc } from "../src/landing/Beats.tsx";
import { ledger } from "../src/landing/Money.tsx";
import { rowState } from "../src/landing/near.ts";
import { contrast, ground, PAIRS, text } from "../src/landing/palette.ts";
import { lockAt, parseScene } from "../src/landing/scene.ts";
import { siteOf } from "../src/landing/site.ts";
import { routeOf } from "../src/route.ts";
import type { ChainMatch, ChainState } from "../src/verify/anchor.ts";
import { text as plain } from "./render.tsx";

const fx = makeFixtures();
const ID = "ab".repeat(16);

describe("which page an address opens", () => {
  test("the bare address is the front page, with or without a shared link's tracking tags", () => {
    expect(routeOf("/", "")).toEqual({ kind: "landing" });
    expect(routeOf("/", "?utm_source=x&s=20")).toEqual({ kind: "landing" });
    expect(routeOf("/index.html", "")).toEqual({ kind: "landing" });
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

describe("money on the front page", () => {
  test("each hint's price shown is the pricing rule's, at the page's stake", () => {
    const page = plain(renderToStaticMarkup(<Hints />));
    for (const k of [HintKind.Near, HintKind.Bearing, HintKind.Trend])
      expect(page).toContain(usdc(hintPrice(STAKE, k, 1)));
    expect(page).toContain("0.3125");
  });

  test("the worked hunt moves money without minting any: the table holds the stakes at every step", () => {
    const rows = ledger();
    const others = STAKE * 3n;
    for (const r of rows) expect(r.you + (r.target ?? 0n) + r.pool + others).toBe(STAKE * 5n);
    expect(rows[3]?.you).toBe(STAKE * 2n);
  });
});

describe("the hero's scene", () => {
  const scene = parseScene(JSON.parse(JSON.stringify(sceneOf(fx.full, "fixture", "Boston Common"))));
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

  test("a scene file that isn't one is refused", () => {
    expect(() => parseScene({ ...scene, version: 2 })).toThrow("version");
    expect(() => parseScene({ ...scene, tracks: [] })).toThrow("tracks");
  });
});

describe("colours", () => {
  test("every text colour passes WCAG AA on every ground it is set on, persimmon included", () => {
    for (const p of PAIRS) expect(contrast(text[p.fg], ground[p.bg])).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the site's origin", () => {
  test("defaults to playtail.app and must be https", () => {
    expect(siteOf(undefined)).toEqual({ url: "https://playtail.app", host: "playtail.app" });
    expect(siteOf("https://example.app/")).toEqual({ url: "https://example.app", host: "example.app" });
    expect(() => siteOf("http://playtail.app")).toThrow("https");
  });
});
