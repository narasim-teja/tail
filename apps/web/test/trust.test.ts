// What the page trusts and what it refuses to take from the bundle: the pinned anchor, the
// enclave label, the tag rule, completeness against NEAR, and the Handler's model signature.

import { afterEach, describe, expect, test } from "bun:test";
import {
  decodeLogEntry,
  EPOCH_MS,
  encodeLogEntry,
  type ReplayBundle,
  type ReplayBundleV2,
  toHex,
  WINDOW_EPOCHS,
} from "@tail/protocol";
import { makeFixtures } from "../scripts/fixture.ts";
import { buildMatch, type Match } from "../src/model/match.ts";
import { createVerifyStore } from "../src/replay/state.ts";
import { runVerification } from "../src/replay/verify.ts";
import { overall } from "../src/ui/marks.ts";
import { type ChainState, type Expect, matchLevel } from "../src/verify/anchor.ts";
import { checkRecord, fetchAttestation, isEnclave } from "../src/verify/attestation.ts";
import { decodeBundle } from "../src/verify/bundle.ts";
import type { ChainReader } from "../src/verify/chain.ts";
import { checkBatches, checkHandler, personalSignSigner } from "../src/verify/checks.ts";
import { tagEvidence } from "../src/verify/evidence.ts";
import { prepare, verifyAll } from "../src/verify/index.ts";
import type { Pins } from "../src/verify/pins.ts";
import { matchProblem, summarize, summaryLine } from "../src/verify/report.ts";
import { signerOf } from "../src/verify/signer.ts";
import { chainFor } from "./chain.ts";

const fx = makeFixtures();
const json = JSON.stringify(fx.full);
const clone = () => JSON.parse(json) as ReplayBundleV2;
const good = decodeBundle(clone());
const onChain = chainFor(good);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

const ENCLAVE_PK = "e1".repeat(32);
const LOCAL_PK = "d3".repeat(32);
const WASM = "20".repeat(32);
const PINS: Pins = {
  network: "testnet",
  contract: "tail.tail-dev-a38d13.testnet",
  outlayerApi: "https://testnet-api.outlayer.ai",
  enclaveRefereePks: [ENCLAVE_PK],
  localRefereePks: [LOCAL_PK],
  refereeWasmSha256: [WASM],
};
const EXPECT: Expect = { contract: PINS.contract, network: PINS.network, matchId: null };
const MATCH_ID = good.raw.match.id;

// ── #1 the anchor is pinned ───────────────────────────────────────────────────────

describe("the chain anchor comes from the page, not the bundle", () => {
  test("a bundle naming another contract fails even against a chain that agrees with it", () => {
    const b = clone();
    b.match.contract = "tail.evil-copy.testnet";
    const d = decodeBundle(b);
    const r = verifyAll(d, chainFor(d), EXPECT);
    expect(r.binding).toEqual({
      ok: false,
      why: "contract",
      named: "tail.evil-copy.testnet",
      want: PINS.contract,
    });
    expect(r.statuses.every((s) => s === "mismatch")).toBe(true);
    expect(r.level).toBeNull();
    const problem = matchProblem(r.binding, r.level);
    expect(summaryLine(summarize(r.statuses), "found", problem)).toBe("Names another contract");
  });

  test("a bundle naming another network fails", () => {
    const b = clone();
    b.match.network = "mainnet";
    const r = verifyAll(decodeBundle(b), onChain, EXPECT);
    expect(r.binding.ok).toBe(false);
    expect(r.statuses.every((s) => s === "mismatch")).toBe(true);
  });

  test("a bundle for another match than the link asked for fails", () => {
    const r = verifyAll(good, onChain, { ...EXPECT, matchId: "0".repeat(32) });
    expect(r.binding).toMatchObject({ ok: false, why: "match" });
    expect(r.statuses.every((s) => s === "mismatch")).toBe(true);
    expect(
      verifyAll(good, onChain, { ...EXPECT, matchId: MATCH_ID }).statuses.every((s) => s === "verified"),
    ).toBe(true);
  });

  test("the page reads the pinned contract and the linked id, whatever the bundle names", () => {
    const b = clone();
    b.match.contract = "tail.evil-copy.testnet";
    const d = decodeBundle(b);
    const asked: [string, string][] = [];
    const reader: ChainReader = {
      read: (contract, id) => {
        asked.push([contract, id]);
        return new Promise<ChainState>(() => {});
      },
      token: () => Promise.resolve(null),
      verifyInclusion: () => Promise.resolve({ kind: "no-view" }),
    };
    const store = createVerifyStore(d.verdicts.length, { symbol: "USDC", decimals: 6 });
    const stop = runVerification(
      d,
      prepare(d),
      store,
      reader,
      { kind: "relay", matchId: MATCH_ID, url: "x" },
      PINS,
    );
    stop();
    expect(asked).toEqual([[PINS.contract, MATCH_ID]]);
    expect(store.get().binding.ok).toBe(false);
  });
});

// ── #2 "enclave" needs the record ────────────────────────────────────────────────

describe("the enclave label", () => {
  const call = good.verdicts[0]?.v?.callId as Uint8Array;
  const uuid = toHex(call).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");

  test("a record for this call that ran a published build is the enclave; anything else is not", () => {
    expect(checkRecord({ call_id: uuid, executed_wasm_sha256: WASM }, call, [WASM])).toEqual({
      kind: "published",
      wasm: WASM,
    });
    expect(checkRecord({ call_id: uuid, executed_wasm_sha256: "ab".repeat(32) }, call, [WASM]).kind).toBe(
      "other-code",
    );
    expect(checkRecord({ call_id: "0".repeat(32), executed_wasm_sha256: WASM }, call, [WASM]).kind).toBe(
      "other-call",
    );
    // `wasm_hash` is the uploaded file, not what ran: it never stands in.
    expect(checkRecord({ call_id: uuid, wasm_hash: WASM }, call, [WASM]).kind).toBe("no-hash");
    expect(checkRecord(null, call, [WASM]).kind).toBe("other-call");
  });

  describe("fetching", () => {
    const real = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = real;
    });

    test("reads the pinned OutLayer API, never the bundle's", async () => {
      const urls: string[] = [];
      globalThis.fetch = (async (u: string) => {
        urls.push(String(u));
        return new Response(JSON.stringify({ call_id: uuid, executed_wasm_sha256: WASM }), { status: 200 });
      }) as unknown as typeof fetch;
      const b = clone();
      b.referee.api = "https://outlayer.evil.example";
      const a = await fetchAttestation(PINS.outlayerApi, call, PINS.refereeWasmSha256);
      expect(urls).toEqual([`${PINS.outlayerApi}/attestations/by-call/${uuid}`]);
      expect(isEnclave(a)).toBe(true);
    });

    test("an unreadable record claims nothing", async () => {
      globalThis.fetch = (async () => {
        throw new TypeError("CORS");
      }) as unknown as typeof fetch;
      const a = await fetchAttestation("https://other.example", call, PINS.refereeWasmSha256);
      expect(a.kind).toBe("unreadable");
      expect(isEnclave(a)).toBe(false);
    });
  });

  test("local or enclave comes from NEAR's referee key, never from the bundle's `kind`", () => {
    const withKey = (pk: string): ChainState => ({ ...onChain, match: { ...onChain.match, referee_pk: pk } });
    expect(signerOf(false, withKey(ENCLAVE_PK), PINS)).toBe("enclave");
    expect(signerOf(false, withKey(LOCAL_PK.toUpperCase()), PINS)).toBe("local");
    expect(signerOf(false, withKey("ab".repeat(32)), PINS)).toBe("unknown");
    expect(signerOf(false, { kind: "absent" }, PINS)).toBe("unknown");
    expect(signerOf(false, null, PINS)).toBe("unknown");
    // The honest fixture is signed with a public test key: never the enclave.
    expect(signerOf(true, withKey(ENCLAVE_PK), PINS)).toBe("fixture");
  });
});

// ── #3 the tag rule ──────────────────────────────────────────────────────────────

describe("a tag re-checked against the strike rule", () => {
  const batches = checkBatches(good);
  const m = buildMatch(good, batches.inLog, checkHandler(good));
  const tags = m.events.filter((e) => e.kind === "tag");
  const first = tags[0] as (typeof tags)[number];
  const base = tagEvidence(good, m, batches.inLog, first);
  if (base.kind !== "checked") throw new Error("the fixture's strike is released");
  const e = base.epoch;
  const h = first.a as number;
  const t = first.b as number;
  const [a, b] = h < t ? [h, t] : [t, h];
  /** The match with only these contact epochs for the tag's pair, all logged before the tag. */
  const withContacts = (epochs: number[]): Match => ({
    ...m,
    contacts: [
      ...m.contacts.filter((c) => !(c.a === a && c.b === b)),
      ...epochs.map((epoch) => ({ a, b, epoch, t: epoch * EPOCH_MS, logIndex: 0 })),
    ],
  });

  test("every tag in the fixture meets it", () => {
    expect(tags.length).toBe(2);
    for (const ev of tags)
      expect(tagEvidence(good, m, batches.inLog, ev)).toMatchObject({ kind: "checked", ok: true });
  });

  test("the window is (e − WINDOW_EPOCHS, e]: the epoch WINDOW_EPOCHS back is outside", () => {
    const edge = [e - WINDOW_EPOCHS, e - 2, e - 1, e];
    expect(tagEvidence(good, withContacts(edge), batches.inLog, first)).toMatchObject({
      windows: 3,
      ok: false,
    });
    const inside = [e - WINDOW_EPOCHS + 1, e - 2, e - 1, e];
    expect(tagEvidence(good, withContacts(inside), batches.inLog, first)).toMatchObject({
      windows: 4,
      ok: true,
    });
  });

  test("a full lock without contact in e or e − 1 is refused", () => {
    const stale = [e - 5, e - 4, e - 3, e - 2];
    expect(tagEvidence(good, withContacts(stale), batches.inLog, first)).toMatchObject({
      windows: 4,
      touching: false,
      ok: false,
    });
  });

  test("contacts logged after the tag do not count", () => {
    const late: Match = {
      ...m,
      contacts: m.contacts.map((c) =>
        c.a === a && c.b === b ? { ...c, logIndex: first.logIndex as number } : c,
      ),
    };
    expect(tagEvidence(good, late, batches.inLog, first)).toMatchObject({ windows: 0, ok: false });
  });

  test("the target must be the hunter's target just before the tag", () => {
    const k = m.events.filter(
      (x) => x.index < first.index && x.kind !== "start" && x.kind !== "checkpoint",
    ).length;
    const snapshots = m.snapshots.map((s, i) => (i === k ? { ...s, target: s.target.map(() => -1) } : s));
    expect(tagEvidence(good, { ...m, snapshots }, batches.inLog, first)).toMatchObject({
      targetOk: false,
      ok: false,
    });
  });

  test("without the released strike batch nothing is claimed", () => {
    const d = decodeBundle(JSON.parse(JSON.stringify(fx.noTrails)));
    const bc = checkBatches(d);
    const nm = buildMatch(d, bc.inLog, checkHandler(d));
    const ev = nm.events.find((x) => x.kind === "tag");
    if (!ev) throw new Error("no tag");
    expect(tagEvidence(d, nm, bc.inLog, ev)).toEqual({ kind: "no-strike" });
  });
});

// ── #5 completeness against NEAR ─────────────────────────────────────────────────

describe("the bundle holds everything NEAR holds", () => {
  test("a checkpoint NEAR stored that the bundle lacks fails the match", () => {
    const chain = structuredClone(onChain);
    chain.roots.checkpoints.push({ log_size: good.log.length + 1, root: "00".repeat(32) });
    const r = verifyAll(good, chain, EXPECT);
    expect(r.level?.complete).toBe(false);
    const problem = matchProblem(r.binding, r.level);
    expect(problem?.line).toBe("Leaves out verdicts NEAR holds");
    expect(overall(summarize(r.statuses), "found", problem)).toBe("mismatch");
  });

  test("an ended match whose bundle stops short of NEAR's last seq fails", () => {
    const b = clone();
    b.verdicts = b.verdicts.slice(0, -2);
    const d = decodeBundle(b);
    const lvl = matchLevel(
      d,
      onChain.match,
      onChain.roots,
      d.verdicts.map((x) => x.v),
    );
    expect(lvl.complete).toBe(false);
  });

  test("the honest fixture against its own chain is complete", () => {
    expect(verifyAll(good, onChain, EXPECT).level?.complete).toBe(true);
  });
});

// ── #7 the Handler's model signature ─────────────────────────────────────────────

describe("the Handler's NEAR AI signature", () => {
  test("recovers a known Ethereum personal_sign vector", () => {
    // web3.js docs: accounts.sign("Some data", 0x4c0883a6…2318).
    const sig = Uint8Array.from(
      Buffer.from(
        "b91467e570a6466aa9e9876cbcd013baba02900b8979d43fe208a4a4f339f5fd6007e74cd82e037b800186422fc2da167c747ef045e5d18a5f5d4300f8e1a0291c",
        "hex",
      ),
    );
    expect(personalSignSigner("Some data", sig)).toBe("0x2c7536e3605d9c16a7a3d7b1898e529396a65c23");
    expect(personalSignSigner("Some datA", sig)).not.toBe("0x2c7536e3605d9c16a7a3d7b1898e529396a65c23");
  });

  test("every fixture line is signed by the logged address", () => {
    const r = checkHandler(good);
    expect(r.size).toBe(3);
    for (const c of r.values()) {
      expect(c.signature).toBe("signed");
      expect(c.signer).toMatch(/^0x[0-9a-f]{40}$/);
      expect(c.model).toBe("fixture (written by hand, not a model)");
    }
  });

  test("a changed signed text, another logged address or another model is refused", () => {
    const b = clone();
    const h = b.handler[0] as unknown as { signedText: string };
    h.signedText = `${h.signedText.slice(0, -1)}${h.signedText.endsWith("0") ? "1" : "0"}`;
    expect(checkHandler(decodeBundle(b)).get(0)?.signature).toBe("bad");

    const c = clone();
    const at = c.log.findIndex((s) => decodeLogEntry(unb64(s)).kind === "HintReceipt");
    const entry = decodeLogEntry(unb64(c.log[at] as string));
    if (entry.kind !== "HintReceipt") throw new Error("no receipt");
    c.log[at] = b64(encodeLogEntry({ ...entry, signingAddress: `0x${"11".repeat(20)}` }));
    expect(checkHandler(decodeBundle(c)).get(entry.hintId)?.signature).toBe("bad");

    // A v1 replay names the model it quotes: the signed text must be for that one.
    const signedText = good.handler[0]?.signedText as string;
    const v1 = () => {
      const x = JSON.parse(JSON.stringify(fx.v1)) as ReplayBundle;
      (x.handler[0] as unknown as { signedText: string }).signedText = signedText;
      return x;
    };
    expect(checkHandler(decodeBundle(v1())).get(0)?.signature).toBe("signed");
    const m = v1();
    (m.handler[0] as { model: string }).model = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
    expect(checkHandler(decodeBundle(m)).get(0)?.signature).toBe("bad");
  });

  test("without the signed text, or with no signature logged, nothing is claimed", () => {
    const b = clone();
    for (const h of b.handler) (h as { signedText: string | null }).signedText = null;
    expect(checkHandler(decodeBundle(b)).get(0)).toMatchObject({
      text: null,
      signature: "unchecked",
      signer: null,
    });

    const c = clone();
    const at = c.log.findIndex((s) => decodeLogEntry(unb64(s)).kind === "HintReceipt");
    const entry = decodeLogEntry(unb64(c.log[at] as string));
    if (entry.kind !== "HintReceipt") throw new Error("no receipt");
    c.log[at] = b64(encodeLogEntry({ ...entry, signature: new Uint8Array(0), signingAddress: "" }));
    expect(checkHandler(decodeBundle(c)).get(entry.hintId)?.signature).toBe("unsigned");
  });
});

// ── #8 nothing passes for lack of data ───────────────────────────────────────────

describe("missing data is unchecked, not passed", () => {
  test("a batch whose predecessor the log lacks is 'chain unchecked', not verified", () => {
    const b = clone();
    const d0 = decodeBundle(b);
    const victim = d0.batches.find((x) => x.batch && x.batch.seq > 0)?.batch;
    if (!victim) throw new Error("no batch");
    // Drop the predecessor's Batch entry from the log.
    b.log = b.log.filter((s) => {
      const e = decodeLogEntry(unb64(s));
      return !(e.kind === "Batch" && e.player === victim.player && e.seq === victim.seq - 1);
    });
    const r = checkBatches(decodeBundle(b));
    const key = `${victim.player}:${victim.seq}`;
    expect(r.verified.has(key)).toBe(false);
    expect(r.unchecked.has(key)).toBe(true);
    expect(r.inLog.has(key)).toBe(true);
  });

  test("an empty revealed ring is not a pass (and not a fail)", () => {
    const b = clone();
    b.reveal.ring = [];
    const r = verifyAll(decodeBundle(b), onChain, EXPECT);
    const end = r.local.findIndex((l) => l.kind === "End");
    expect(r.local[end]?.ring?.ringRebuilt).toBeNull();
    expect(r.statuses[end]).toBe("verified");
  });
});

describe("the fixtures", () => {
  test("the tampered fixture fails on the rewritten Tag's signature, and only there", () => {
    const d = decodeBundle(JSON.parse(JSON.stringify(fx.tampered)));
    const r = verifyAll(d, { kind: "absent" }, EXPECT);
    const bad = r.local.filter((l) => !l.signature);
    expect(bad.map((l) => l.kind)).toEqual(["Tag"]);
    expect(r.statuses.filter((s) => s === "mismatch").length).toBe(1);
  });
});
