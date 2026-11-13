// The economy panel's figures (src/model/economy.ts) come only from the signed verdicts: money is
// conserved at every step, each transfer is the loser's head plus its credit, End's payout empties
// the pool, and the hint price is rebuilt from the Hint verdicts' times exactly as charged.

import { describe, expect, test } from "bun:test";
import { demandBps, HINT_BPS, type HintKind, PRICE_WINDOW_MS } from "@tail/protocol";
import { makeFixtures } from "../scripts/fixture.ts";
import { buildEconomy, valueAt } from "../src/model/economy.ts";
import { buildMatch } from "../src/model/match.ts";
import { type DecodedBundle, decodeBundle } from "../src/verify/bundle.ts";
import { checkBatches, checkHandler } from "../src/verify/checks.ts";

const fx = makeFixtures();
const through = (b: unknown) => decodeBundle(JSON.parse(JSON.stringify(b)));
const economyOf = (d: DecodedBundle) => {
  const m = buildMatch(d, checkBatches(d).inLog, checkHandler(d));
  return { m, eco: buildEconomy(m, d) };
};

describe("the economy of the honest match", () => {
  const d = through(fx.full);
  const { m, eco } = economyOf(d);
  const total = d.stake * BigInt(d.players.length);

  test("heads and the pool always add up to the stakes", () => {
    for (const s of m.snapshots) expect(s.heads.reduce((a, b) => a + b, 0n) + s.pool).toBe(total);
    for (const s of m.snapshots)
      expect(eco.heads.reduce((a, h) => a + valueAt(h, s.t), 0) + valueAt(eco.pool, s.t)).toBe(Number(total));
  });

  test("each Tag and Forfeit moves the loser's head and its credit to the winner", () => {
    const moves = d.verdicts.filter((x) => x.v?.body.kind === "Tag" || x.v?.body.kind === "Forfeit");
    expect(eco.flows.map((f) => f.event)).toEqual(moves.map((x) => x.index));
    for (const f of eco.flows) {
      const body = d.verdicts[f.event]?.v?.body;
      expect(body && "credit" in body ? body.credit : -1n).toBe(f.credit);
      expect(valueAt(eco.heads[f.loser] ?? [], f.t)).toBe(0);
      expect(f.head).toBeGreaterThan(0n);
    }
  });

  test("End pays the pool out to the survivors and leaves it empty", () => {
    expect(eco.payout?.kind).toBe("payout");
    const paid = (eco.payout?.delta ?? []).reduce((a, b) => a + b, 0n);
    const before = m.snapshots[m.snapshots.length - 2]?.pool ?? -1n;
    expect(paid).toBe(before);
    expect(valueAt(eco.pool, m.durationMs)).toBe(0);
  });

  test("the hint price is rebuilt from the verdicts and matches what each hint paid", () => {
    const hints = d.verdicts.flatMap((x) =>
      x.v?.body.kind === "Hint" && "tMs" in x.v.body ? [x.v.body] : [],
    );
    expect(hints.length).toBeGreaterThan(0);
    expect(eco.hints).toHaveLength(hints.length);
    expect(eco.moneyVerdicts.length).toBe(
      d.verdicts.filter((x) => x.v && ["Hint", "Tag", "Forfeit", "End"].includes(x.v.body.kind)).length,
    );
    if (eco.demand.kind !== "price") throw new Error("v2 hints carry their time");
    const { series } = eco.demand;
    for (const s of series) expect(s.v).toBeGreaterThanOrEqual(1);
    for (const s of series) expect(s.v).toBeLessThanOrEqual(4);
    hints.forEach((h, k) => {
      const t = Number(h.tMs) - m.startMs;
      const earlier = hints.slice(0, k).filter((e) => e.tMs + BigInt(PRICE_WINDOW_MS) > h.tMs).length;
      const base = (d.stake * BigInt(HINT_BPS[h.hint as HintKind])) / 10_000n;
      expect(eco.hints[k]?.paid).toBeCloseTo(Number(demandBps(earlier)) / 10_000, 2);
      expect(eco.hints[k]?.amount).toBe(h.amount);
      expect(base).toBeGreaterThan(0n);
      // From a hint's moment on, the price counts it (and any other hint of the same tick).
      const recent = hints.filter((e) => e.tMs <= h.tMs && e.tMs + BigInt(PRICE_WINDOW_MS) > h.tMs).length;
      expect(valueAt(series, t)).toBe(Number(demandBps(recent)) / 10_000);
    });
  });
});

describe("a bundle recorded before demand pricing", () => {
  test("shows hints bought per 5 minutes instead of a price", () => {
    const d = through(fx.v1);
    const { eco } = economyOf(d);
    if (eco.demand.kind !== "count") throw new Error("v1 hints carry no time");
    expect(eco.demand.counts.reduce((a, b) => a + b, 0)).toBe(eco.hints.length);
    expect(eco.hints.length).toBeGreaterThan(0);
  });
});
