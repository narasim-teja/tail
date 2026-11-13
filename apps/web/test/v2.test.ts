// Protocol v2 checks: the verdict chain against NEAR's head, the append-only log, the tag
// evidence with its inclusion paths, presence proofs, unattested players, both tampered
// fixtures, and reading a v1 bundle.

import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  EPOCH_MS,
  encodeLogEntry,
  encodePresenceProof,
  encodeSignedVerdict,
  LOCK_EPOCHS,
  type LogEntry,
  merkleLeaf,
  merkleVerify,
  type SignedVerdict,
  sha256,
  signVerdict,
  toHex,
  utf8,
  verdictDigest,
  WINDOW_EPOCHS,
} from "@tail/protocol";
import { makeFixtures, REWRITTEN_CHECKPOINT } from "../scripts/fixture.ts";
import { buildMatch, type Match, type MatchEvent, type Snapshot } from "../src/model/match.ts";
import type { ChainState, Expect } from "../src/verify/anchor.ts";
import { type DecodedBundle, decodeBundle, toB64 } from "../src/verify/bundle.ts";
import { parseHead } from "../src/verify/chain.ts";
import { checkBatches, checkHandler, checkSalts, enrolments, isTestPlayer } from "../src/verify/checks.ts";
import { evidenceCheck, inclusionOf, tagEvidence } from "../src/verify/evidence.ts";
import { anchoredRoots, checkConsistency, checkVerdictChain } from "../src/verify/history.ts";
import { verifyAll } from "../src/verify/index.ts";
import {
  checkPresence,
  fromPresenceParam,
  parsePresence,
  presenceFor,
  presenceParam,
  toPresenceJson,
} from "../src/verify/presence.ts";
import { matchProblem } from "../src/verify/report.ts";
import { decodeLogEntryV1 } from "../src/verify/v1.ts";
import { chainFor } from "./chain.ts";

const fx = makeFixtures();
const through = (b: unknown) => JSON.parse(JSON.stringify(b));
const json = JSON.stringify(fx.full);
const clone = () => JSON.parse(json) as typeof fx.full;
const good = decodeBundle(clone());
const onChain = chainFor(good);
const EXPECT: Expect = { contract: "tail.tail-dev-a38d13.testnet", network: "testnet", matchId: null };
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
/** The fixture's public test referee key (scripts/fixture.ts). */
const REFEREE_SK = sha256(utf8("TAIL replay fixture referee key. Test only, public, never on NEAR."));

const modelOf = (d: DecodedBundle) => {
  const bc = checkBatches(d);
  return { m: buildMatch(d, bc.inLog, checkHandler(d)), inLog: bc.inLog };
};
const { m, inLog } = modelOf(good);
const tags = m.events.filter((e) => e.kind === "tag");

/** The bundle with log entry `i` replaced (leaves follow, so only the change itself differs). */
function withEntry(i: number, e: LogEntry, from: typeof fx.full = clone()): DecodedBundle {
  const b = from;
  b.log[i] = toB64(encodeLogEntry(e));
  b.leaves[i] = toB64(merkleLeaf(e));
  return decodeBundle(b);
}

// ── 2. the verdict chain ─────────────────────────────────────────────────────────

describe("the verdict chain", () => {
  test("the honest fixture is one chain whose head is NEAR's", () => {
    expect(checkVerdictChain(good, onChain)).toMatchObject({
      kind: "checked",
      breakAt: null,
      onNear: "match",
    });
    expect(verifyAll(good, onChain, EXPECT).verdictChain).toMatchObject({ breakAt: null, onNear: "match" });
  });

  test("a head NEAR holds that isn't the bundle's last digest fails", () => {
    const head: ChainState = {
      ...onChain,
      head: { kind: "found", digest: new Uint8Array(32).fill(7), seq: null },
    };
    expect(checkVerdictChain(good, head)).toMatchObject({ breakAt: null, onNear: "mismatch" });
    const seq: ChainState = {
      ...onChain,
      head: { kind: "found", digest: good.verdicts.at(-1)?.digest as Uint8Array, seq: 99 },
    };
    expect(checkVerdictChain(good, seq)).toMatchObject({ onNear: "mismatch" });
  });

  test("without the view, or without NEAR, the head is not checked", () => {
    expect(checkVerdictChain(good, { ...onChain, head: { kind: "no-view" } })).toMatchObject({
      onNear: "no-view",
    });
    expect(checkVerdictChain(good, { kind: "absent" })).toMatchObject({
      breakAt: null,
      onNear: "not-checked",
    });
    expect(checkVerdictChain(good, { kind: "unreachable", reason: "x" })).toMatchObject({
      onNear: "not-checked",
    });
  });

  test("a validly signed verdict whose prev skips its predecessor breaks the chain there", () => {
    const b = clone();
    const k = 5;
    const v = good.verdicts[k]?.v as SignedVerdict | undefined;
    if (!v) throw new Error("no verdict");
    const resigned = signVerdict({ ...v, prev: good.verdicts[k - 2]?.digest as Uint8Array }, REFEREE_SK);
    expect(ed25519.verify(resigned.sig, verdictDigest(resigned), good.refereePk)).toBe(true);
    (b.verdicts[k] as { signed: string }).signed = toB64(encodeSignedVerdict(resigned));
    expect(checkVerdictChain(decodeBundle(b), null)).toMatchObject({ breakAt: k });
  });

  test("the tampered fixture breaks at the rewritten Tag", () => {
    const d = decodeBundle(through(fx.tampered));
    const forged = d.verdicts.filter((x) => x.v?.body.kind === "Tag")[1]?.index;
    expect(checkVerdictChain(d, null)).toMatchObject({ breakAt: forged });
  });

  test("the head view's answer is read as a digest, with its seq when given", () => {
    const hex = "ab".repeat(32);
    expect(parseHead(hex)).toMatchObject({ kind: "found", seq: null });
    expect(parseHead({ digest: hex, seq: 4 })).toMatchObject({ kind: "found", seq: 4 });
    expect(parseHead(null)).toEqual({ kind: "none" });
    expect(parseHead("abcd").kind).toBe("unreadable");
  });
});

// ── 3. the append-only log ───────────────────────────────────────────────────────

describe("each checkpoint extends the previous one", () => {
  test("every link holds in the honest fixture, against NEAR's roots and the signed ones", () => {
    for (const chain of [onChain, null]) {
      const r = checkConsistency(good.leaves, anchoredRoots(good, chain));
      expect(r.source).toBe(chain ? "near" : "signed");
      expect(r.links.length).toBe(onChain.roots.checkpoints.length);
      expect(r.ok).toBe(true);
      expect(r.links.every((l) => l.proofLength > 0)).toBe(true);
    }
  });

  test("a root NEAR holds that isn't a prefix of the next fails the links on both sides", () => {
    const chain = structuredClone(onChain);
    const k = 3;
    const cp = chain.roots.checkpoints[k] as { root: string };
    cp.root = `${cp.root[0] === "0" ? "1" : "0"}${cp.root.slice(1)}`;
    const r = checkConsistency(good.leaves, anchoredRoots(good, chain));
    expect(r.links.map((l, i) => (l.ok ? -1 : i)).filter((i) => i >= 0)).toEqual([k - 1, k]);
  });

  test("the tampered-log fixture fails exactly around the rewritten checkpoint", () => {
    const d = decodeBundle(through(fx.tamperedLog));
    const r = verifyAll(d, { kind: "absent" }, EXPECT);
    // Every signature and the chain still hold: the referee signed the rewrite itself.
    expect(r.local.every((l) => l.signature && l.order)).toBe(true);
    expect(r.verdictChain).toMatchObject({ breakAt: null });
    const k = REWRITTEN_CHECKPOINT - 1; // 0-based checkpoint index
    expect(r.consistency.ok).toBe(false);
    expect(r.consistency.links.map((l, i) => (l.ok ? -1 : i)).filter((i) => i >= 0)).toEqual([k - 1, k]);
    // Only that checkpoint's own root claim fails: the later ones are over the rewritten log.
    const claims = r.local.filter((l) => l.kind === "Checkpoint").map((l) => l.rootClaim);
    expect(claims.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0)).toEqual([k]);
    // Against the chain those roots would make, the verdicts under the rewritten root stop matching.
    const anchored = verifyAll(d, chainFor(d), EXPECT);
    expect(anchored.consistency.source).toBe("near");
    expect(anchored.consistency.ok).toBe(false);
    expect(anchored.statuses.some((s) => s === "mismatch")).toBe(true);
  });
});

// ── 4. the tag evidence ──────────────────────────────────────────────────────────

describe("the tag's Evidence entry", () => {
  const first = tags[0] as MatchEvent;
  const ev0 = evidenceCheck(good, m, inLog, first);
  if (ev0.kind !== "checked") throw new Error("the fixture logs evidence");
  const evAt = ev0.entryIndex;
  const entry = good.log[evAt]?.entry as Extract<LogEntry, { kind: "Evidence" }>;
  const e = entry.strikeEpoch;
  const recheck = (epochs: number[], over: Partial<typeof entry> = {}) => {
    const d = withEntry(evAt, { ...entry, epochs, ...over });
    return evidenceCheck(d, modelOf(d).m, inLog, first);
  };

  test("every tag's evidence meets the rule, and its strike matches the released batch", () => {
    expect(tags.length).toBe(2);
    for (const t of tags) {
      const r = evidenceCheck(good, m, inLog, t);
      expect(r).toMatchObject({ kind: "checked", ok: true, strike: "match", sameTag: true, lockFrom: 0 });
      if (r.kind === "checked") expect(r.count).toBeGreaterThanOrEqual(4);
    }
  });

  test("without trails the rule is still checked, from the entry alone", () => {
    const d = decodeBundle(through(fx.noTrails));
    const nm = modelOf(d);
    const t = nm.m.events.find((x) => x.kind === "tag") as MatchEvent;
    expect(tagEvidence(d, nm.m, nm.inLog, t)).toEqual({ kind: "no-strike" });
    expect(evidenceCheck(d, nm.m, nm.inLog, t)).toMatchObject({ ok: true, strike: "not-released" });
  });

  test("an epoch WINDOW_EPOCHS back is outside; too few, or none in e or e − 1, is refused", () => {
    const cited = entry.epochs;
    expect(recheck([e - 8, ...cited.slice(1)])).toMatchObject({ inWindow: false, ok: false });
    expect(recheck(cited.slice(0, 3))).toMatchObject({ count: 3, ok: false });
    expect(recheck(cited.filter((x) => x < e - 1))).toMatchObject({ touching: false, ok: false });
  });

  test("a cited window with no Contact entry before the tag is refused", () => {
    const free = [...Array(8).keys()].map((k) => e - k).find((x) => !entry.epochs.includes(x)) as number;
    const r = recheck([...entry.epochs.slice(1), free]);
    expect(r).toMatchObject({ ok: false });
    if (r.kind === "checked") expect(r.contacts.some((c) => c.logIndex === null)).toBe(true);
  });

  test("evidence naming another hunter, or a strike the released batch lacks, is refused", () => {
    expect(recheck(entry.epochs, { hunter: (entry.hunter + 1) % 5 })).toMatchObject({
      sameTag: false,
      ok: false,
    });
    expect(recheck(entry.epochs, { strikeSeq: entry.strikeSeq - 1 })).toMatchObject({
      strike: "differs",
      ok: false,
    });
  });

  // Each test below breaks exactly one term of the rule and checks every other term still holds,
  // so the tag fails on that term alone.

  test("enough cited contacts, none in the strike's window or the one before, fails on that alone", () => {
    // Without trails, so no released strike batch pins the strike's epoch.
    const d0 = decodeBundle(through(fx.noTrails));
    const t0 = modelOf(d0).m.events.find((x) => x.kind === "tag") as MatchEvent;
    const r0 = evidenceCheck(d0, modelOf(d0).m, modelOf(d0).inLog, t0);
    if (r0.kind !== "checked") throw new Error("the fixture logs evidence");
    const ent = d0.log[r0.entryIndex]?.entry as Extract<LogEntry, { kind: "Evidence" }>;
    const [a, b] = ent.hunter < ent.target ? [ent.hunter, ent.target] : [ent.target, ent.hunter];
    const have = [
      ...new Set(
        d0.log
          .slice(0, t0.logIndex as number)
          .flatMap((x) =>
            x.entry?.kind === "Contact" && x.entry.a === a && x.entry.b === b ? [x.entry.epoch] : [],
          ),
      ),
    ].sort((x, y) => x - y);
    // LOCK_EPOCHS logged contacts close enough that a strike two windows after the last still
    // has them all in its window.
    const k = have.findIndex(
      (x, i) =>
        i + LOCK_EPOCHS <= have.length && (have[i + LOCK_EPOCHS - 1] as number) - x < WINDOW_EPOCHS - 2,
    );
    expect(k).toBeGreaterThanOrEqual(0);
    const cited = have.slice(k, k + LOCK_EPOCHS);
    const strikeEpoch = (cited.at(-1) as number) + 2;
    const d = withEntry(r0.entryIndex, { ...ent, epochs: cited, strikeEpoch }, through(fx.noTrails));
    const dm = modelOf(d);
    const r = evidenceCheck(d, dm.m, dm.inLog, dm.m.events.find((x) => x.kind === "tag") as MatchEvent);
    expect(r).toMatchObject({
      kind: "checked",
      sameTag: true,
      inWindow: true,
      count: LOCK_EPOCHS,
      touching: false,
      afterAssigned: true,
      targetOk: true,
      strike: "not-released",
      ok: false,
    });
    if (r.kind === "checked") expect(r.contacts.every((c) => c.logIndex !== null)).toBe(true);
  });

  /**
   * `m` as if `first`'s hunter had taken a head (a forfeit onto them) just before `first`, logged
   * at `logIndex`. The snapshots shift with the extra event, so `first`'s target stays the hunter's.
   */
  const wonAt = (logIndex: number): Match => {
    const h = first.a as number;
    const before = m.events.filter(
      (x) =>
        x.index < first.index &&
        (x.kind === "hint" || x.kind === "tag" || x.kind === "forfeit" || x.kind === "end"),
    ).length;
    const won: MatchEvent = {
      ...first,
      kind: "forfeit",
      a: (h + 1) % good.players.length,
      b: h,
      logIndex,
      index: first.index - 0.5,
    };
    const s = m.snapshots;
    return {
      ...m,
      events: [...m.events, won].sort((x, y) => x.index - y.index),
      snapshots: [...s.slice(0, before + 1), s[before] as Snapshot, ...s.slice(before + 1)],
    };
  };

  test("a cited window from before the hunter got this target fails the tag on that alone", () => {
    const r = evidenceCheck(good, wonAt(first.logIndex as number), inLog, first);
    expect(r).toMatchObject({
      kind: "checked",
      sameTag: true,
      inWindow: true,
      touching: true,
      targetOk: true,
      strike: "match",
      afterAssigned: false,
      ok: false,
    });
    if (r.kind === "checked") {
      expect(r.count).toBeGreaterThanOrEqual(LOCK_EPOCHS);
      expect(r.contacts.every((c) => c.logIndex !== null)).toBe(true);
    }
  });

  test("lock_from is the window after the tick of the hunter's last head, not that tick's own", () => {
    const start = good.verdicts.find((x) => x.v?.body.kind === "Start")?.v?.body;
    if (start?.kind !== "Start") throw new Error("no Start");
    const tickIn = (epoch: number) =>
      good.log.findIndex((x, i) => {
        const tk = x.entry;
        return (
          i < evAt && tk?.kind === "Tick" && Number((tk.nowMs - start.startMs) / BigInt(EPOCH_MS)) === epoch
        );
      });
    const lo = Math.min(...entry.epochs);
    expect(tickIn(lo)).toBeGreaterThanOrEqual(0);
    expect(tickIn(lo - 1)).toBeGreaterThanOrEqual(0);
    // A head taken in a tick of the earliest cited window: that window no longer counts.
    expect(evidenceCheck(good, wonAt(tickIn(lo) + 1), inLog, first)).toMatchObject({
      lockFrom: lo + 1,
      afterAssigned: false,
      ok: false,
    });
    // Taken in a tick of the window before: every cited window is after it.
    expect(evidenceCheck(good, wonAt(tickIn(lo - 1) + 1), inLog, first)).toMatchObject({
      lockFrom: lo,
      afterAssigned: true,
      ok: true,
    });
  });

  test("a v2 Tag without its Evidence entry fails", () => {
    const d = withEntry(evAt, { kind: "Contact", a: 0, b: 1, epoch: 0, salt: new Uint8Array(16) });
    expect(evidenceCheck(d, modelOf(d).m, inLog, first)).toEqual({ kind: "missing" });
  });

  test("each cited contact has a Merkle path to an anchored root, and a wrong root refuses it", () => {
    const roots = anchoredRoots(good, onChain).roots;
    for (const c of ev0.contacts) {
      const inc = inclusionOf(good, c.logIndex as number, roots);
      expect(inc?.ok).toBe(true);
      if (!inc) continue;
      expect(inc.size).toBeGreaterThan(inc.index);
      expect(
        merkleVerify(
          merkleLeaf(good.log[inc.index]?.entry as LogEntry),
          inc.index,
          inc.size,
          inc.path,
          inc.root,
        ),
      ).toBe(true);
      const bad = roots.map((r) => ({ ...r, root: new Uint8Array(32) }));
      expect(inclusionOf(good, inc.index, bad)?.ok).toBe(false);
    }
  });
});

// ── 5. presence proofs ───────────────────────────────────────────────────────────

describe("presence proofs", () => {
  const roots = anchoredRoots(good, onChain).roots;
  const at = m.contacts[10]?.logIndex as number;
  const proof = presenceFor(good, at, roots);
  if (!proof) throw new Error("no proof");
  const pinned = EXPECT.contract;

  test("a proof made from the replay verifies against the chain's roots and players", () => {
    const r = checkPresence(proof, onChain, pinned);
    const c = good.log[at]?.entry as Extract<LogEntry, { kind: "Contact" }>;
    expect(r).toEqual({
      ok: true,
      a: c.a,
      b: c.b,
      epoch: c.epoch,
      accounts: [good.players[c.a], good.players[c.b]] as [string, string],
    });
  });

  test("its JSON, its link and its borsh form read back to the same proof", () => {
    const j = JSON.stringify(toPresenceJson(proof));
    expect(toPresenceJson(parsePresence(j))).toEqual(toPresenceJson(proof));
    expect(toPresenceJson(parsePresence(fromPresenceParam(presenceParam(proof))))).toEqual(
      toPresenceJson(proof),
    );
    expect(toPresenceJson(parsePresence(toB64(encodePresenceProof(proof))))).toEqual(toPresenceJson(proof));
    expect(() => parsePresence('{"type":"something else"}')).toThrow();
  });

  test("another contract, another match, a bad path or other accounts are refused", () => {
    expect(checkPresence({ ...proof, contract: "tail.evil-copy.testnet" }, onChain, pinned)).toMatchObject({
      ok: false,
      why: "other-contract",
    });
    expect(checkPresence(proof, { kind: "absent" }, pinned)).toMatchObject({ why: "no-match" });
    const other = { ...onChain, match: { ...onChain.match, match_id: "00".repeat(16) } };
    expect(checkPresence(proof, other, pinned)).toMatchObject({ why: "no-match" });
    const path = proof.path.map((h, i) => (i === 0 ? h.map((x) => x ^ 1) : h));
    expect(checkPresence({ ...proof, path }, onChain, pinned)).toMatchObject({ why: "bad-path" });
    expect(checkPresence({ ...proof, size: proof.size + 1n }, onChain, pinned)).toMatchObject({
      why: "no-root",
    });
    const swapped: [string, string] = [proof.accounts[1], proof.accounts[0]];
    expect(checkPresence({ ...proof, accounts: swapped }, onChain, pinned)).toMatchObject({
      why: "wrong-accounts",
    });
    const moved = {
      ...proof,
      entry: { ...proof.entry, epoch: (proof.entry as { epoch: number }).epoch + 1 },
    };
    expect(checkPresence(moved, onChain, pinned)).toMatchObject({ why: "bad-path" });
  });

  test("only Contact entries make presence proofs", () => {
    const tick = good.log.findIndex((x) => x.entry?.kind === "Tick");
    expect(presenceFor(good, tick, roots)).toBeNull();
  });
});

// ── 6. unattested players ────────────────────────────────────────────────────────

describe("log salts", () => {
  test("every contact, receipt and evidence entry carries the salt K_m gives its index", () => {
    const r = checkSalts(good);
    expect(r).toMatchObject({ kind: "checked", bad: [] });
    if (r.kind === "checked") expect(r.salted).toBeGreaterThan(20);
    expect(verifyAll(good, onChain, EXPECT).salts).toEqual(r);
    // Both tampered fixtures fail for their own reasons; their salts are the referee's.
    for (const t of [fx.tampered, fx.tamperedLog])
      expect(checkSalts(decodeBundle(through(t)))).toMatchObject({ bad: [] });
  });

  test("a salt moved to another index, or checked with another key, fails; no key, no check", () => {
    const at = good.log.findIndex((e) => e.entry?.kind === "Contact");
    const e = good.log[at]?.entry as LogEntry & { kind: "Contact" };
    const next = good.log.findIndex((x, i) => i > at && x.entry?.kind === "Contact");
    const other = good.log[next]?.entry as typeof e;
    const swapped = withEntry(at, { ...e, salt: other.salt });
    expect(checkSalts(swapped)).toMatchObject({ bad: [at] });
    const b = clone();
    b.reveal.kM = "00".repeat(32);
    expect(checkSalts(decodeBundle(b))).toMatchObject({ kind: "checked" });
    expect((checkSalts(decodeBundle(b)) as { bad: number[] }).bad.length).toBe(
      (checkSalts(good) as { salted: number }).salted,
    );
    const { kM: _k, ...noKey } = clone().reveal;
    expect(checkSalts(decodeBundle({ ...clone(), reveal: noKey }))).toEqual({ kind: "no-key" });
  });
});

describe("devices", () => {
  test("every fixture phone enrolled with an attestation", () => {
    expect(enrolments(good).every((x) => x.attested === true && x.sameAccount === true)).toBe(true);
    expect(m.players.every((p) => p.attested === true)).toBe(true);
  });

  test("an Enrolled entry with attested=false makes that player a test player, in every event they're in", () => {
    const at = good.log.findIndex((x) => x.entry?.kind === "Enrolled" && x.entry.player === 0);
    const e = good.log[at]?.entry as Extract<LogEntry, { kind: "Enrolled" }>;
    const d = withEntry(at, { ...e, attested: false });
    expect(enrolments(d).map(isTestPlayer)).toEqual([true, false, false, false, false]);
    const dm = modelOf(d).m;
    expect(dm.players[0]?.attested).toBe(false);
    const involved = dm.events.filter((x) => (x.a === 0 || x.b === 0) && x.kind !== "start");
    expect(involved.length).toBeGreaterThan(0);
    expect(
      involved.every((x) => [x.a, x.b].some((p) => p !== undefined && dm.players[p]?.attested === false)),
    ).toBe(true);
  });

  test("an entry naming another account than the player list is flagged", () => {
    const at = good.log.findIndex((x) => x.entry?.kind === "Enrolled");
    const e = good.log[at]?.entry as Extract<LogEntry, { kind: "Enrolled" }>;
    expect(enrolments(withEntry(at, { ...e, account: "mallory.testnet" }))[e.player]?.sameAccount).toBe(
      false,
    );
  });
});

// ── v1 bundles, read only ────────────────────────────────────────────────────────

describe("a bundle recorded before protocol v2", () => {
  const d = decodeBundle(through(fx.v1));
  test("decodes with the v1 verdict format and passes the v1 checks", () => {
    expect(d.version).toBe(1);
    expect(d.verdicts.every((x) => x.v !== null)).toBe(true);
    const r = verifyAll(d, { kind: "absent" }, EXPECT);
    expect(r.statuses.every((s) => s === "unanchored")).toBe(true);
    expect(r.verdictChain).toEqual({ kind: "v1" });
    expect(r.consistency.ok).toBe(true);
    expect(enrolments(d).every((x) => x.attested === null)).toBe(true);
    expect(chainFor(d).roots.checkpoints.length).toBeGreaterThan(0);
  });

  test("its tags are re-checked from the released batches; there is no Evidence entry", () => {
    const vm = modelOf(d);
    const t = vm.m.events.find((x) => x.kind === "tag") as MatchEvent;
    expect(evidenceCheck(d, vm.m, vm.inLog, t)).toEqual({ kind: "v1" });
    expect(tagEvidence(d, vm.m, vm.inLog, t)).toMatchObject({ kind: "checked", ok: true });
  });

  test("a v1 verdict read as v2 doesn't decode, so the version can't be swapped", () => {
    const b = through(fx.v1);
    b.version = 2;
    b.leaves = [];
    expect(decodeBundle(b).verdicts.every((x) => x.v === null)).toBe(true);
  });

  test("its log entries are only v1 kinds, in the v1 layouts (no salts)", () => {
    const kinds = new Set(fx.v1.log.map((s) => decodeLogEntryV1(unb64(s)).kind));
    expect([...kinds].sort()).toEqual(["Batch", "Contact", "HintReceipt", "Verdict"]);
    expect(d.log.every((e) => e.entry !== null)).toBe(true);
    expect(toHex(d.matchId)).toBe(good.raw.match.id);
    expect(checkSalts(d)).toEqual({ kind: "v1" });
  });
});

describe("the match as a whole", () => {
  test("a broken chain or a rewritten log fails the match, whatever each verdict shows", () => {
    const honest = verifyAll(good, onChain, EXPECT);
    expect(matchProblem(honest.binding, honest.level, honest)).toBeNull();
    const d = decodeBundle(through(fx.tamperedLog));
    const r = verifyAll(d, { kind: "absent" }, EXPECT);
    expect(matchProblem(r.binding, r.level, r)?.line).toBe("The log was rewritten");
    const t = verifyAll(decodeBundle(through(fx.tampered)), { kind: "absent" }, EXPECT);
    expect(matchProblem(t.binding, t.level, t)?.line).toBe("Verdict history is broken");
  });
});
