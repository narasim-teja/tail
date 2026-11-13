// The contract's End replay, re-run by the page (src/verify/settle.ts): an honest match pays out,
// a validly signed match that broke a rule is refunded, and NEAR's settlement is compared with
// the page's. v1 bundles say the replay doesn't apply.

import { describe, expect, test } from "bun:test";
import { SettleCheck } from "@tail/protocol";
import { forgedFixture, makeFixtures } from "../scripts/fixture.ts";
import { buildMatch, snapshotAt } from "../src/model/match.ts";
import { refundLine, settlementProof } from "../src/replay/copy.ts";
import type { ChainState, Expect } from "../src/verify/anchor.ts";
import { type DecodedBundle, decodeBundle } from "../src/verify/bundle.ts";
import { checkBatches, checkHandler } from "../src/verify/checks.ts";
import { verifyAll } from "../src/verify/index.ts";
import { matchProblem } from "../src/verify/report.ts";
import { expectedPaid, settlementOf } from "../src/verify/settle.ts";
import { chainFor } from "./chain.ts";

const fx = makeFixtures();
const through = (b: unknown) => decodeBundle(JSON.parse(JSON.stringify(b)));
const EXPECT: Expect = { contract: "tail.tail-dev-a38d13.testnet", network: "testnet", matchId: null };
const good = through(fx.full);
const refunded = through(fx.refunded);
const offRing = through(forgedFixture("tag"));
const modelOf = (d: DecodedBundle) => buildMatch(d, checkBatches(d).inLog, checkHandler(d));
const stakes = (d: DecodedBundle) => d.players.map(() => d.stake);
/** NEAR's view with some fields changed, for the comparisons. */
const withMatch = (c: Extract<ChainState, { kind: "found" }>, m: Partial<typeof c.match>): ChainState => ({
  ...c,
  match: { ...c.match, ...m },
});

describe("the honest match", () => {
  test("passes the replay and pays out what the pool still owes the survivors", () => {
    const s = settlementOf(good);
    expect(s.kind).toBe("payout");
    const paid = expectedPaid(good, s, 0n) as bigint[];
    expect(paid.reduce((a, b) => a + b, 0n)).toBe(good.stake * BigInt(good.players.length));
    expect(paid).toEqual(chainFor(good).match.players.map((p) => BigInt(p.paid)));
    const r = verifyAll(good, chainFor(good), EXPECT);
    expect(r.level?.payouts).toBe(true);
    expect(matchProblem(r.binding, r.level, r, s)).toBeNull();
    expect(settlementProof(s).check).toBe("pass");
    expect(refundLine(s)).toBeNull();
  });

  test("splits a sponsor pot among survivors, the first of them taking the remainder", () => {
    const paid = expectedPaid(good, settlementOf(good), 7n) as bigint[];
    const base = expectedPaid(good, settlementOf(good), 0n) as bigint[];
    const gained = paid.map((p, i) => p - (base[i] as bigint));
    expect(gained.filter((g) => g > 0n)).toEqual([4n, 3n]);
  });

  test("NEAR reporting a refund, or other payouts, doesn't match", () => {
    const c = chainFor(good);
    const refund = withMatch(c, { settled_as: "refunded_rule_violation" });
    expect(verifyAll(good, refund, EXPECT).level?.payouts).toBe(false);
    const p = c.match.players.map((x, i) => (i === 0 ? { ...x, paid: String(BigInt(x.paid) + 1n) } : x));
    expect(verifyAll(good, withMatch(c, { players: p }), EXPECT).level?.payouts).toBe(false);
    // A contract from before protocol v2 reports no settled_as; paid alone is compared.
    const { settled_as: _, violation: __, ...old } = c.match;
    expect(verifyAll(good, { ...c, match: old }, EXPECT).level?.payouts).toBe(true);
  });
});

describe("a signed match that broke a rule", () => {
  test("a hint End names off its asker's target is refunded: rule violation", () => {
    // Every verdict is the referee's and chained; only the replay sees the lie.
    const r = verifyAll(refunded, { kind: "absent" }, EXPECT);
    expect(r.statuses.every((x) => x === "unanchored")).toBe(true);
    const s = settlementOf(refunded);
    expect(s).toEqual({
      kind: "refunded",
      violation: { check: SettleCheck.HintTarget, event: 0 },
      text: "event 0: a hint was not about its asker's target",
    });
    expect(expectedPaid(refunded, s, 9n)).toEqual(stakes(refunded));
    expect(matchProblem(r.binding, r.level, r, s)?.line).toBe("Refunded: rule violation");
    expect(settlementProof(s)).toMatchObject({ check: "fail", title: "Refunded: rule violation" });
    expect(refundLine(s)).toContain("a hint was not about its asker's target");
  });

  test("the film ends with every head back at the stake", () => {
    const m = modelOf(refunded);
    expect(snapshotAt(m, m.durationMs).heads).toEqual(stakes(refunded));
  });

  test("a Tag off the hunting order is refunded: rule violation", () => {
    const s = settlementOf(offRing);
    // The second Tag (play event 4) names Dee, who was hunting Eli, as Ana's hunter.
    expect(s).toMatchObject({ kind: "refunded", violation: { check: SettleCheck.TagRing, event: 4 } });
    expect(verifyAll(offRing, { kind: "absent" }, EXPECT).statuses.every((x) => x === "unanchored")).toBe(
      true,
    );
  });

  test("NEAR refunding for the same rule matches; paying out, or another reason, doesn't", () => {
    const c = chainFor(refunded);
    expect(c.match.settled_as).toBe("refunded_rule_violation");
    expect(verifyAll(refunded, c, EXPECT).level?.payouts).toBe(true);
    expect(verifyAll(refunded, withMatch(c, { settled_as: "payout" }), EXPECT).level?.payouts).toBe(false);
    const other = withMatch(c, { violation: "event 4: a Tag did not follow the ring" });
    expect(verifyAll(refunded, other, EXPECT).level?.payouts).toBe(false);
    // Paid out as heads while it says refunded: still a mismatch.
    const honestPaid = chainFor(good).match.players;
    const paidOut = withMatch(c, { players: honestPaid });
    expect(verifyAll(refunded, paidOut, EXPECT).level?.payouts).toBe(false);
  });
});

describe("when the replay doesn't run", () => {
  test("a verdict that isn't the referee's stops it (the tampered fixture)", () => {
    expect(settlementOf(through(fx.tampered))).toEqual({ kind: "not-run", why: "unsigned" });
  });

  test("a bundle without End has nothing to replay against", () => {
    const b = JSON.parse(JSON.stringify(fx.full));
    b.verdicts.pop();
    const d = decodeBundle(b);
    expect(settlementOf(d)).toEqual({ kind: "not-run", why: "no-end" });
    expect(expectedPaid(d, settlementOf(d), 0n)).toBeNull();
  });

  test("a v1 bundle keeps its v1 money: hints paid the target, no credits, no replay", () => {
    const d = through(fx.v1);
    expect(settlementOf(d)).toEqual({ kind: "v1" });
    expect(settlementProof(settlementOf(d)).check).toBe("info");
    const m = modelOf(d);
    const hint = m.events.find((e) => e.kind === "hint");
    expect(hint?.b).toBe(m.players.findIndex((p) => p.name === "Ana"));
    expect(m.events.some((e) => e.credit !== undefined)).toBe(false);
    expect(snapshotAt(m, hint?.t ?? 0).heads[hint?.b ?? -1]).toBe(d.stake + (hint?.amount as bigint));
    expect(verifyAll(d, chainFor(d), EXPECT).level?.payouts).toBe(true);
  });
});
