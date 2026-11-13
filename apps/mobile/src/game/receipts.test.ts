import { describe, expect, test } from "bun:test";
import {
  type AnchoredRoot,
  decodePresenceProof,
  type LogEntry,
  merkleLeaf,
  merkleProof,
  merkleRoot,
  RejectCode,
  verifyPresence,
} from "@tail/protocol";
import { fromB64 } from "../lib/b64";
import type { InclusionProof } from "../relay/client";
import {
  checkReceipts,
  meetings,
  type ProofSource,
  presenceJson,
  type Report,
  receiptLines,
} from "./receipts";

const h = (n: number) => new Uint8Array(32).fill(n);
const ME = 1;
const players = ["ann.tail.testnet", "bea.tail.testnet", "cy.tail.testnet"];
const matchId = new Uint8Array(16).fill(3);

// A match log as the referee writes it: my batches 0–2 accepted, 3 refused for the clock,
// contacts with both other players, and someone else's batch in between.
const log: LogEntry[] = [
  { kind: "Batch", player: ME, seq: 0, hash: h(10) },
  { kind: "Batch", player: 0, seq: 0, hash: h(20) },
  { kind: "Contact", a: 0, b: ME, epoch: 3 },
  { kind: "Batch", player: ME, seq: 1, hash: h(11) },
  { kind: "Batch", player: ME, seq: 2, hash: h(12) },
  { kind: "Rejected", player: ME, seq: 3, hash: h(13), code: RejectCode.ClockSkew },
  { kind: "Contact", a: ME, b: 2, epoch: 5 },
  { kind: "Contact", a: 0, b: ME, epoch: 6 },
];
const leaves = log.map(merkleLeaf);
const rootAt = (size: number): AnchoredRoot => ({
  logSize: BigInt(size),
  root: merkleRoot(leaves.slice(0, size)),
});

/** The relay's inclusion endpoint, built with the protocol's own prover. */
const relay =
  (tamper?: (p: InclusionProof) => InclusionProof): ProofSource =>
  async (leaf, size) => {
    const index = leaves.slice(0, size).findIndex((l) => l.every((b, i) => b === leaf[i]));
    if (index < 0) return null;
    const p = { index, size, path: merkleProof(leaves.slice(0, size), index) };
    return tamper ? tamper(p) : p;
  };

const reports: Report[] = [
  { seq: 0, hash: h(10) },
  { seq: 1, hash: h(11) },
  { seq: 2, hash: h(12) },
  { seq: 3, hash: h(13) },
];

describe("inclusion receipts", () => {
  test("every report is found against End's root: accepted ones as batches, the refused one with its reason", async () => {
    const r = await checkReceipts({
      player: ME,
      reports,
      root: rootAt(log.length),
      final: true,
      proofs: relay(),
    });
    expect(r).toMatchObject({
      included: [0, 1, 2],
      refused: [{ seq: 3, code: RejectCode.ClockSkew }],
      missing: [],
    });
    expect(receiptLines(r)).toEqual({
      lines: ["3 of 4 reports are in the log anchored on NEAR.", "1 refused by the referee (clock off)."],
      problems: [],
    });
  });

  test("a report the referee never logged is listed as a problem", async () => {
    const r = await checkReceipts({
      player: ME,
      reports: [...reports, { seq: 4, hash: h(14) }],
      root: rootAt(log.length),
      final: true,
      proofs: relay(),
    });
    expect(r.missing).toEqual([4]);
    expect(receiptLines(r).problems[0]).toContain("Missing from the log: report 4.");
  });

  test("a tampered path does not verify against NEAR's root, and is named as the relay's", async () => {
    const tampered = relay((p) => ({ ...p, path: p.path.map((x, i) => (i === 0 ? h(99) : x)) }));
    const r = await checkReceipts({
      player: ME,
      reports,
      root: rootAt(log.length),
      final: true,
      proofs: tampered,
    });
    expect(r.included).toEqual([]);
    expect(r.badProof).toEqual([0, 1, 2, 3]);
    expect(receiptLines(r).problems).toEqual([
      "The relay's proof for reports 0, 1, 2 and 3 doesn't match NEAR.",
    ]);
  });

  test("a path for the wrong size, or against a root the relay made up, does not count", async () => {
    const wrongSize = relay((p) => ({ ...p, size: p.size - 1 }));
    expect(
      (await checkReceipts({ player: ME, reports, root: rootAt(8), final: true, proofs: wrongSize }))
        .badProof,
    ).toHaveLength(4);
    const fakeRoot = { logSize: 8n, root: h(1) };
    expect(
      (await checkReceipts({ player: ME, reports, root: fakeRoot, final: true, proofs: relay() })).included,
    ).toEqual([]);
  });

  test("against a checkpoint, reports after it are not anchored yet rather than missing", async () => {
    const r = await checkReceipts({ player: ME, reports, root: rootAt(4), final: false, proofs: relay() });
    expect(r).toMatchObject({ included: [0, 1], missing: [2, 3] });
    expect(receiptLines(r)).toEqual({
      lines: [
        "2 of 4 reports are in the log anchored on NEAR so far.",
        "2 not anchored yet; checked again once the match ends.",
      ],
      problems: [],
    });
  });
});

describe("presence proofs", () => {
  const root = rootAt(log.length);

  test("one proof per player met, the latest contact, each verifying from chain data alone", () => {
    const m = meetings({ matchId, contract: "tail.testnet", log, me: ME, players, root });
    expect(m.map((x) => [x.other, x.epoch])).toEqual([
      ["ann.tail.testnet", 6],
      ["cy.tail.testnet", 5],
    ]);
    for (const x of m) expect(verifyPresence(x.proof, [root], players).ok).toBe(true);
  });

  test("the shared JSON carries the borsh proof, which decodes and verifies on its own", () => {
    const [first] = meetings({ matchId, contract: "tail.testnet", log, me: ME, players, root });
    const j = JSON.parse(presenceJson(first as NonNullable<typeof first>)) as {
      proof: string;
      accounts: string[];
    };
    expect(j.accounts).toEqual(["ann.tail.testnet", "bea.tail.testnet"]);
    expect(verifyPresence(decodePresenceProof(fromB64(j.proof)), [root], players)).toMatchObject({
      ok: true,
      epoch: 6,
    });
  });

  test("a log the relay altered yields no proof that does not verify", () => {
    // The altered leaf is a sibling on ann's path too, so neither proof holds against NEAR's root.
    const altered = log.map((e, i) => (i === 6 ? { kind: "Contact" as const, a: ME, b: 2, epoch: 50 } : e));
    expect(meetings({ matchId, contract: "tail.testnet", log: altered, me: ME, players, root })).toEqual([]);
  });
});
