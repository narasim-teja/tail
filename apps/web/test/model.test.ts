import { describe, expect, test } from "bun:test";
import { LOCK_EPOCHS } from "@tail/protocol";
import { makeFixtures } from "../scripts/fixture.ts";
import { money } from "../src/lib/format.ts";
import { FILM_SPEED, filmSpeed, focusAt } from "../src/model/film.ts";
import {
  buildMatch,
  displayName,
  displayNames,
  initialsFor,
  lockAt,
  logClock,
  type MatchEvent,
  positionAt,
  snapshotAt,
  snapshotBefore,
} from "../src/model/match.ts";
import { lengthLine } from "../src/replay/copy.ts";
import { decodeBundle } from "../src/verify/bundle.ts";
import { checkBatches, checkHandler } from "../src/verify/checks.ts";

const build = (json: unknown) => {
  const d = decodeBundle(json);
  return buildMatch(d, checkBatches(d).inLog, checkHandler(d));
};
// Built in memory, through JSON as the relay would send them: no generated files needed.
const fx = makeFixtures();
const fixture: unknown = JSON.parse(JSON.stringify(fx.full));
const noTrails: unknown = JSON.parse(JSON.stringify(fx.noTrails));
const m = build(fixture);
const name = (i: number | undefined) => m.players[i ?? -1]?.name;

describe("the match model", () => {
  test("tells the fixture's story in order", () => {
    const lines = m.events
      .filter((e) => e.kind === "tag" || e.kind === "forfeit" || e.kind === "hint")
      .map((e) => `${e.kind}:${name(e.a)}>${name(e.b)}`);
    expect(lines).toEqual([
      "hint:Eli>Ana",
      "tag:Ana>Bo",
      "forfeit:Cy>Ana",
      "hint:Eli>Ana",
      "tag:Eli>Ana",
      "hint:Eli>Dee",
    ]);
    const ts = m.events.map((e) => e.t);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  test("places each tag within a tick of the strike that caused it", () => {
    const tags = m.events.filter((e) => e.kind === "tag").map((e) => e.t / 1000);
    expect(Math.abs((tags[0] as number) - 415)).toBeLessThan(15);
    expect(Math.abs((tags[1] as number) - 1090)).toBeLessThan(15);
  });

  test("moves heads like the contract: the stake is conserved, the winner ends with it", () => {
    const end = snapshotAt(m, m.durationMs);
    expect(end.heads.reduce((a, b) => a + b, 0n)).toBe(m.stake * BigInt(m.players.length));
    // Eli paid 0.3125 for a hint about Dee after taking Ana's head (a Bearing at 1.25x: one hint
    // in the 5 minutes before); End credits it to Dee.
    expect(money(end.heads[m.players.findIndex((p) => p.name === "Eli")] ?? 0n, 6)).toBe("19.6875");
    expect(money(end.heads[m.players.findIndex((p) => p.name === "Dee")] ?? 0n, 6)).toBe("5.3125");
    expect(end.alive.filter(Boolean).length).toBe(2);
    expect(end.pool).toBe(0n);
  });

  test("a hint pays into the pool, the loser is credited first, End credits a survivor", () => {
    const eli = m.players.findIndex((p) => p.name === "Eli");
    const ana = m.players.findIndex((p) => p.name === "Ana");
    const dee = m.players.findIndex((p) => p.name === "Dee");
    const hints = m.events.filter((e) => e.kind === "hint");
    const first = hints[0] as MatchEvent;
    const before = snapshotBefore(m, first);
    const after = snapshotAt(m, first.t);
    // Only the asker's head moves; the money waits in the pool.
    expect(after.heads[eli]).toBe((before.heads[eli] as bigint) - (first.amount as bigint));
    expect(after.heads.filter((h, i) => h !== before.heads[i]).length).toBe(1);
    expect(after.pool).toBe(first.amount as bigint);
    // Eli's tag on Ana carries both hints about her as credit, and empties the pool of them.
    const tag = m.events.find((e) => e.kind === "tag" && e.b === ana) as MatchEvent;
    expect(tag.credit).toBe((hints[0]?.amount as bigint) + (hints[1]?.amount as bigint));
    expect(snapshotAt(m, tag.t).pool).toBe(0n);
    // The hint about Dee is still in the pool until End credits it to her.
    const end = m.events.find((e) => e.kind === "end") as MatchEvent;
    expect(snapshotBefore(m, end).pool).toBe(hints[2]?.amount as bigint);
    expect(m.settlement).toEqual({
      kind: "payout",
      owed: m.players.map((_, i) => (i === dee ? (hints[2]?.amount as bigint) : 0n)),
    });
  });

  test("every tag was preceded by a full lock from the log's contacts", () => {
    for (const e of m.events.filter((x) => x.kind === "tag"))
      expect(lockAt(m, e.a ?? 0, e.b ?? 0, e.t)).toBeGreaterThanOrEqual(LOCK_EPOCHS);
  });

  test("hints carry the asker's question and the Handler's signed chat; the words stay sealed", () => {
    const hints = m.events.filter((e) => e.kind === "hint");
    expect(hints[0]?.question).toBe("Is Ana anywhere near me?");
    expect(hints.every((h) => h.handler?.text === null && h.handler.verified === null)).toBe(true);
    expect(hints.every((h) => h.handler?.signature?.signature === "signed")).toBe(true);
  });

  test("a v1 replay quotes the Handler's verified line", () => {
    const hints = build(JSON.parse(JSON.stringify(fx.v1))).events.filter((e) => e.kind === "hint");
    expect(hints.length).toBe(3);
    expect(hints.every((h) => h.handler?.text && h.handler.verified === true)).toBe(true);
  });

  test("the match ends at the referee's last tick, so one that ends early has no dead stretch", () => {
    // Run to time: the last tick runs a little past the planned end, clamped to it as the referee does.
    expect(m.durationMs).toBe(m.plannedMs);
    expect(m.events.at(-1)).toMatchObject({ kind: "end", t: m.plannedMs });
    // The same log with a later planned end: the match ended before it, at its last tick.
    const later = JSON.parse(JSON.stringify(fx.full)) as typeof fx.full;
    later.match.endMs += 10 * 60_000;
    const early = build(later);
    const lastTick = decodeBundle(later)
      .log.flatMap((e) => (e.entry?.kind === "Tick" ? [Number(e.entry.nowMs)] : []))
      .at(-1) as number;
    expect(early.plannedMs).toBe(m.plannedMs + 10 * 60_000);
    expect(early.durationMs).toBe(lastTick - later.match.startMs);
    expect(early.events.at(-1)).toMatchObject({ kind: "end", t: early.durationMs });
    expect(lengthLine(early)).toBe("20 of 30 min");
    // A v1 log has no ticks: only the planned end.
    const v1 = build(JSON.parse(JSON.stringify(fx.v1)));
    expect(v1.durationMs).toBe(v1.plannedMs);
  });

  test("tracks come from verified batches and stop when a player goes dark", () => {
    const cy = m.players.findIndex((p) => p.name === "Cy");
    expect(positionAt(m.tracks[cy] ?? null, 300_000)).not.toBeNull();
    expect(positionAt(m.tracks[cy] ?? null, 700_000)).toBeNull();
  });

  test("without released batches the events still play, with no positions", () => {
    const bare = build(noTrails);
    expect(bare.hasTrails).toBe(false);
    expect(bare.events.map((e) => e.kind)).toEqual(m.events.map((e) => e.kind));
    // Contacts and checkpoints still pin the times, to within half a minute.
    bare.events.forEach((e, i) => {
      expect(Math.abs(e.t - (m.events[i]?.t ?? 0))).toBeLessThan(30_000);
    });
  });
});

describe("the film", () => {
  test("runs at 30x, eases to real time at each tag, and the chase in focus is the next tag's pair", () => {
    const tag = m.events.find((e) => e.kind === "tag");
    if (!tag) throw new Error("no tag");
    expect(filmSpeed(m, 60_000)).toBeCloseTo(FILM_SPEED, 0);
    expect(filmSpeed(m, tag.t)).toBe(1);
    expect(filmSpeed(m, tag.t - 30_000)).toBeLessThan(10);
    expect(focusAt(m, tag.t - 60_000)).toEqual({ kind: "chase", hunter: tag.a ?? -1, target: tag.b ?? -1 });
  });
});

describe("helpers", () => {
  test("initials stay one letter when unique and stay distinct for twelve players", () => {
    expect(initialsFor(["Ana", "Bo", "Cy"])).toEqual(["A", "B", "C"]);
    const twelve = ["Ana", "Alex", "Ali", "Bo", "Ben", "Cy", "Cara", "Dee", "Dan", "Eli", "Emma", "Fay"];
    const got = initialsFor(twelve);
    expect(new Set(got).size).toBe(12);
  });

  test("names come from the handle; a ghost is a test player, and test players stay apart", () => {
    expect(displayName("sam-k.tail-dev.testnet")).toBe("Sam k");
    expect(displayName("ghost-rt0oxf64.tail-dev.testnet")).toBe("Test player R");
    const ghost = (h: string) => `ghost-${h}.tail-dev.testnet`;
    expect(displayNames(["sam.t.testnet", ghost("rt0oxf64"), ghost("k2m"), ghost("a9")])).toEqual([
      "Sam",
      "Test player R",
      "Test player K",
      "Test player A",
    ]);
    // Two handles with one letter: numbered in player order instead.
    expect(displayNames([ghost("rt0"), "sam.t.testnet", ghost("r9x"), ghost("k2m")])).toEqual([
      "Test player 1",
      "Sam",
      "Test player 2",
      "Test player 3",
    ]);
  });

  test("the log clock is monotone and interpolates between anchors", () => {
    const at = logClock([0, null, null, 30_000, null, 20_000, 90_000], 100_000);
    expect(at(1)).toBe(10_000);
    expect(at(4)).toBe(30_000);
    expect(at(5)).toBe(30_000);
    expect(at(6)).toBe(90_000);
  });

  test("money is exact with two decimals at least", () => {
    expect(money(5_000_000n, 6)).toBe("5.00");
    expect(money(100_000n, 6)).toBe("0.10");
    expect(money(1_234_567_891n, 6)).toBe("1,234.567891");
  });
});
