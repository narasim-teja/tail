// Every check the replay runs on a bundle, as pure functions over decoded bytes. Nothing here
// touches the network: chain data comes in as an argument (see chain.ts), so the same code runs
// in the browser and under `bun test`.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  badLogSalts,
  buildRing,
  concat,
  equal,
  type LogEntry,
  logEntrySalt,
  playersHash,
  ringCommit,
  sha256,
  toHex,
  utf8,
  verifyEd25519,
} from "@tail/protocol";
import type { AnySignedVerdict, AnyVerdict, DecodedBundle } from "./bundle.ts";

// ── Merkle frontier: the root of every log prefix in one pass ────────────────────────

/** RFC 6962 root of a growing log, keeping one hash per set bit of the size. */
export class Frontier {
  private peaks: Uint8Array[] = [];
  size = 0;

  push(leaf: Uint8Array) {
    let h = leaf;
    let s = this.size;
    while (s & 1) {
      h = sha256(concat(Uint8Array.of(1), this.peaks.pop() as Uint8Array, h));
      s >>= 1;
    }
    this.peaks.push(h);
    this.size++;
  }

  /** Roots of the perfect subtrees the log is made of, largest first (merklePeaks order). */
  peaksNow(): Uint8Array[] {
    return [...this.peaks];
  }

  root(): Uint8Array {
    if (this.peaks.length === 0) return sha256(new Uint8Array(0));
    let acc = this.peaks[this.peaks.length - 1] as Uint8Array;
    for (let i = this.peaks.length - 2; i >= 0; i--)
      acc = sha256(concat(Uint8Array.of(1), this.peaks[i] as Uint8Array, acc));
    return acc;
  }
}

/** Roots of the log at each requested size (sizes past the end are left out). */
export function prefixRoots(leaves: readonly Uint8Array[], sizes: Iterable<number>): Map<number, Uint8Array> {
  const want = new Set([...sizes].filter((s) => s >= 0 && s <= leaves.length));
  const out = new Map<number, Uint8Array>();
  const f = new Frontier();
  if (want.has(0)) out.set(0, f.root());
  for (let i = 0; i < leaves.length; i++) {
    f.push(leaves[i] as Uint8Array);
    if (want.has(i + 1)) out.set(i + 1, f.root());
  }
  return out;
}

// ── Per-verdict local checks ─────────────────────────────────────────────────────────

export interface LocalVerdictCheck {
  index: number;
  seq: number | null;
  kind: AnyVerdict["kind"] | null;
  /** The bytes decode as a SignedVerdict for this match. */
  decodes: boolean;
  /**
   * ed25519 over the verdict digest (v2, or v1 for an old bundle) with the bundle's referee key,
   * strict (verifyEd25519): a non-canonical point encoding or a small-order key fails, as in the
   * protocol package's verdict chain check, rather than noble's permissive ZIP-215 default.
   */
  signature: boolean;
  /** seq = position + 1: no gaps, no repeats. */
  order: boolean;
  /** The log holds Verdict{seq, digest} with this digest; index of that entry. */
  logIndex: number | null;
  inLog: boolean;
  /**
   * Checkpoint/End: the root they claim is the log's root at that size, and every leaf hash the
   * bundle sent below that size is the hash of the entry it sent.
   */
  rootClaim: boolean | null;
  /** Start: players hash; End: ring commit, VRF signature, alpha seed, rebuilt ring. */
  ring: RingCheck | null;
  /**
   * Tag: the tag check against the strike rule (evidence.ts, tagHolds) holds (true) or breaks it
   * (false); null for other verdicts, and for a tag the released data can't re-check.
   */
  tag: boolean | null;
}

/** true: held; false: failed; null: nothing to compare (counts as neither). */
export interface RingCheck {
  playersHash?: boolean;
  commit?: boolean;
  vrf?: boolean;
  alphaSeed?: boolean;
  /** The relay's copy of the order (and of the VRF signature) equals the page's rebuild. */
  ringRebuilt?: boolean | null;
}

export const ringOk = (r: RingCheck) => Object.values(r).every((x) => x !== false);

export const localOk = (c: LocalVerdictCheck) =>
  c.decodes &&
  c.signature &&
  c.order &&
  c.inLog &&
  c.rootClaim !== false &&
  (c.ring === null || ringOk(c.ring)) &&
  c.tag !== false;

/** Index of each Verdict{seq} entry in the log, by seq. */
export function verdictEntries(
  log: DecodedBundle["log"],
): Map<number, { index: number; digest: Uint8Array }> {
  const out = new Map<number, { index: number; digest: Uint8Array }>();
  log.forEach((e, index) => {
    if (e.entry?.kind === "Verdict" && !out.has(e.entry.seq))
      out.set(e.entry.seq, { index, digest: e.entry.digest });
  });
  return out;
}

export interface LocalContext {
  entries: Map<number, { index: number; digest: Uint8Array }>;
  roots: Map<number, Uint8Array>;
  start: AnySignedVerdict | null;
  /** The first position where the bundle's leaf hash disagrees with its entry, or Infinity. */
  firstConflict: number;
  /** By verdict index, each tag's tagHolds outcome (evidence.ts tagChecks), null elsewhere. */
  tags: readonly (boolean | null)[];
}

/**
 * `tags` is each tag check's outcome, by verdict index. It is computed from the match model, once
 * per replay (verify/index.ts prepare), and passed in so a tag that breaks the rule fails here.
 */
export function localContext(d: DecodedBundle, tags: readonly (boolean | null)[]): LocalContext {
  const sizes: number[] = [];
  for (const x of d.verdicts) {
    const b = x.v?.body;
    if (b && (b.kind === "Checkpoint" || b.kind === "End")) sizes.push(Number(b.logSize));
  }
  return {
    entries: verdictEntries(d.log),
    roots: prefixRoots(d.leaves, sizes),
    start: d.verdicts.find((x) => x.v?.body.kind === "Start")?.v ?? null,
    firstConflict: d.leafConflicts[0] ?? Number.POSITIVE_INFINITY,
    tags,
  };
}

export function checkVerdict(d: DecodedBundle, ctx: LocalContext, index: number): LocalVerdictCheck {
  const x = d.verdicts[index];
  const v = x?.v ?? null;
  const digest = x?.digest ?? null;
  const base: LocalVerdictCheck = {
    index,
    seq: v?.seq ?? null,
    kind: v?.body.kind ?? null,
    decodes: false,
    signature: false,
    order: false,
    logIndex: null,
    inLog: false,
    rootClaim: null,
    ring: null,
    tag: null,
  };
  if (!v || !digest || !equal(v.matchId, d.matchId)) return base;
  const entry = ctx.entries.get(v.seq);
  const signature = verifyEd25519(d.refereePk, digest, v.sig);
  const out: LocalVerdictCheck = {
    ...base,
    decodes: true,
    signature,
    order: v.seq === index + 1,
    logIndex: entry?.index ?? null,
    inLog: !!entry && equal(entry.digest, digest),
    tag: ctx.tags[index] ?? null,
  };
  const b = v.body;
  if (b.kind === "Checkpoint" || b.kind === "End") {
    const r = ctx.roots.get(Number(b.logSize));
    out.rootClaim =
      !!r &&
      equal(r, b.root) &&
      ctx.firstConflict >= Number(b.logSize) &&
      (entry ? entry.index >= Number(b.logSize) : false);
  }
  if (b.kind === "Start") out.ring = { playersHash: equal(b.playersHash, playersHash(d.players)) };
  if (b.kind === "End") out.ring = checkEnd(d, ctx.start, b);
  return out;
}

function checkEnd(
  d: DecodedBundle,
  start: AnySignedVerdict | null,
  b: Extract<AnyVerdict, { kind: "End" }>,
): RingCheck {
  const commit = start?.body.kind === "Start" && equal(start.body.ringCommit, ringCommit(b.vrfSignature));
  const vrf = verifyEd25519(d.vrfPk, utf8(b.alpha), b.vrfSignature);
  const rebuilt = buildRing(d.players, b.vrfSignature);
  const revealed = d.reveal.ring;
  const sameSig = d.reveal.vrfSignature === null || equal(d.reveal.vrfSignature, b.vrfSignature);
  return {
    commit,
    vrf,
    // The contract requires the VRF seed to be this match's id (TECHNICAL 4.8).
    alphaSeed: b.alpha.split(":").at(-1) === toHex(d.matchId),
    // The page rebuilds the order from End's signed VRF signature either way; an empty copy from
    // the relay has nothing to compare, so it is unchecked rather than a pass.
    ringRebuilt: !sameSig
      ? false
      : revealed.length === 0
        ? null
        : revealed.length === rebuilt.length && revealed.every((a, i) => a === rebuilt[i]),
  };
}

// ── Batches: hash in the log, hash chain per player ──────────────────────────────────

export interface BatchCheck {
  /** "player:seq" of every batch whose hash is in the log and whose chain link holds. */
  verified: Set<string>;
  /** Hash in the log, but the log lacks the predecessor, so the chain link was not checked. */
  unchecked: Set<string>;
  /** verified ∪ unchecked: every batch whose hash the log holds (the trails are drawn from these). */
  inLog: Set<string>;
  failed: {
    key: string;
    why: "not in log" | "hash differs" | "broken chain" | "undecodable" | "other match";
  }[];
}

export const batchKey = (player: number, seq: number) => `${player}:${seq}`;

export function checkBatches(d: DecodedBundle): BatchCheck {
  const logged = new Map<string, Uint8Array>();
  for (const e of d.log)
    if (e.entry?.kind === "Batch") logged.set(batchKey(e.entry.player, e.entry.seq), e.entry.hash);
  const verified = new Set<string>();
  const unchecked = new Set<string>();
  const failed: BatchCheck["failed"] = [];
  for (const [i, x] of d.batches.entries()) {
    if (!x.batch || !x.hash) {
      failed.push({ key: `#${i}`, why: "undecodable" });
      continue;
    }
    const { batch } = x;
    const key = batchKey(batch.player, batch.seq);
    if (!equal(batch.matchId, d.matchId)) {
      failed.push({ key, why: "other match" });
      continue;
    }
    const inLog = logged.get(key);
    if (!inLog) {
      failed.push({ key, why: "not in log" });
      continue;
    }
    if (!equal(inLog, x.hash)) {
      failed.push({ key, why: "hash differs" });
      continue;
    }
    // The link must name the predecessor the log holds; one the log lacks cannot be checked.
    const prev =
      batch.seq === 0 ? new Uint8Array(32) : (logged.get(batchKey(batch.player, batch.seq - 1)) ?? null);
    if (!prev) {
      unchecked.add(key);
      continue;
    }
    if (!equal(prev, batch.prev)) {
      failed.push({ key, why: "broken chain" });
      continue;
    }
    verified.add(key);
  }
  return { verified, unchecked, inLog: new Set([...verified, ...unchecked]), failed };
}

// ── Handler lines ───────────────────────────────────────────────────────────────────

/**
 * text: SHA-256 of the quote equals the HintReceipt's text hash (the log committed to the line);
 * null when the bundle has no quote (protocol v2: the words were sealed to the asker).
 * signature, from the receipt's NEAR AI chat signature:
 *   signed: it recovers to the logged signing address over the signed text `model:req:resp`;
 *   bad: it does not, or the signed text is not of that shape or names another model than the
 *        one the bundle quotes (v1);
 *   unsigned: the receipt carries no signature (a template line, or the lookup failed);
 *   unchecked: the bundle does not carry the signed text, so there is nothing to verify against.
 * A good signature shows that the logged address signed hashes of this chat's request and
 * response for that model. It does not show the address is a TEE key (NEAR AI's attestation
 * report does), and the response hash is not matched to the words here.
 */
export interface HandlerCheck {
  text: boolean | null;
  signature: "signed" | "bad" | "unsigned" | "unchecked";
  signer: string | null;
  model: string | null;
}

const SIGNED_TEXT = /^(.+):([0-9a-f]{64}):([0-9a-f]{64})$/;

/** Ethereum address that signed `message` personal_sign style (65-byte r ‖ s ‖ v), or null. */
export function personalSignSigner(message: string, sig: Uint8Array): string | null {
  if (sig.length !== 65) return null;
  const v = sig[64] as number;
  const rec = v >= 27 ? v - 27 : v;
  if (rec !== 0 && rec !== 1) return null;
  const msg = utf8(message);
  const digest = keccak_256(concat(utf8(`\x19Ethereum Signed Message:\n${msg.length}`), msg));
  try {
    const pk = secp256k1.recoverPublicKey(concat(Uint8Array.of(rec), sig.slice(0, 64)), digest, {
      prehash: false,
    });
    const point = secp256k1.Point.fromBytes(pk).toBytes(false);
    return `0x${toHex(keccak_256(point.slice(1)).slice(12))}`;
  } catch {
    return null;
  }
}

export function checkHandler(d: DecodedBundle): Map<number, HandlerCheck> {
  const receipts = new Map<number, Extract<LogEntry, { kind: "HintReceipt" }>>();
  for (const e of d.log) if (e.entry?.kind === "HintReceipt") receipts.set(e.entry.hintId, e.entry);
  const out = new Map<number, HandlerCheck>();
  for (const h of d.handler) {
    const r = receipts.get(h.hintId);
    const text = h.text === null ? null : !!r && equal(r.textHash, sha256(utf8(h.text)));
    let signature: HandlerCheck["signature"] = "unchecked";
    let model: string | null = null;
    if (r && r.signature.length === 0) signature = "unsigned";
    else if (r && h.signedText !== null) {
      const m = SIGNED_TEXT.exec(h.signedText);
      model = m?.[1] ?? null;
      const signer = m ? personalSignSigner(h.signedText, r.signature) : null;
      signature =
        signer !== null &&
        model !== null &&
        (h.model === null || model === h.model) &&
        signer === r.signingAddress.toLowerCase()
          ? "signed"
          : "bad";
    }
    out.set(h.hintId, {
      text,
      signature,
      signer: signature === "signed" && r ? r.signingAddress.toLowerCase() : null,
      model: signature === "signed" ? model : null,
    });
  }
  return out;
}

// ── Log salts: the leaves the relay held during play gave nothing away ────────────────

/**
 * Contact, HintReceipt and Evidence entries end in a salt, logSalt(K_log, index) with
 * K_log = HKDF(K_m, "tail/log"). The referee drew K_m inside itself at start and released it only
 * with the log after End, so during play the relay could not test guesses of those entries (who
 * met whom, a hint's fact) against the leaf hashes it held. Checked here from the K_m the bundle
 * carries: every salt is the one its position gets, so none was left out or chosen.
 *   v1: recorded before protocol v2, whose log had no salts;
 *   no-key: the bundle does not carry K_m, so nothing was checked;
 *   checked: `salted` entries carry a salt, `bad` are the indexes whose salt is not their own.
 */
export type SaltCheck =
  | { kind: "v1" }
  | { kind: "no-key" }
  | { kind: "checked"; salted: number; bad: number[] };

export function checkSalts(d: DecodedBundle): SaltCheck {
  if (d.version === 1) return { kind: "v1" };
  if (!d.reveal.kM) return { kind: "no-key" };
  const entries = d.log.map((e) => e.entry);
  return {
    kind: "checked",
    salted: entries.filter((e) => e && logEntrySalt(e)).length,
    bad: badLogSalts(d.reveal.kM, entries),
  };
}

// ── Devices: who enrolled with an Apple attestation ──────────────────────────────────

/**
 * Per player, from the log's Enrolled entries (protocol v2; the referee writes one per player at
 * start, under the anchored roots): whether the referee checked the phone's Apple App Attest
 * attestation. `attested: false` is a test player the referee took without one (testnet only).
 * null: no Enrolled entry for that player (a bundle from before v2, or the entry is missing).
 * `sameAccount` is false when the entry names another account than the player list.
 */
export interface Enrolment {
  attested: boolean | null;
  sameAccount: boolean | null;
}

export function enrolments(d: DecodedBundle): Enrolment[] {
  const out: Enrolment[] = d.players.map(() => ({ attested: null, sameAccount: null }));
  for (const e of d.log) {
    const x = e.entry;
    if (x?.kind !== "Enrolled" || out[x.player] === undefined) continue;
    out[x.player] = { attested: x.attested, sameAccount: d.players[x.player] === x.account };
  }
  return out;
}

/** A player the referee enrolled without an Apple attestation. */
export const isTestPlayer = (e: Enrolment | undefined) => e?.attested === false;
