// Every check the replay runs on a bundle, as pure functions over decoded bytes. Nothing here
// touches the network: chain data comes in as an argument (see chain.ts), so the same code runs
// in the browser and under `bun test`.

import { ed25519 } from "@noble/curves/ed25519.js";
import {
  buildRing,
  concat,
  equal,
  type LogEntry,
  merkleLeaf,
  playersHash,
  ringCommit,
  type SignedVerdict,
  sha256,
  toHex,
  utf8,
  type Verdict,
  verdictDigest,
} from "@tail/protocol";
import type { DecodedBundle } from "./bundle.ts";

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

  root(): Uint8Array {
    if (this.peaks.length === 0) return sha256(new Uint8Array(0));
    let acc = this.peaks[this.peaks.length - 1] as Uint8Array;
    for (let i = this.peaks.length - 2; i >= 0; i--)
      acc = sha256(concat(Uint8Array.of(1), this.peaks[i] as Uint8Array, acc));
    return acc;
  }
}

/** Roots of the log at each requested size (sizes past the end are left out). */
export function prefixRoots(log: DecodedBundle["log"], sizes: Iterable<number>): Map<number, Uint8Array> {
  const want = new Set([...sizes].filter((s) => s >= 0 && s <= log.length));
  const out = new Map<number, Uint8Array>();
  const f = new Frontier();
  if (want.has(0)) out.set(0, f.root());
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    // An undecodable entry still has bytes; its leaf is what the referee would have hashed.
    f.push(e?.entry ? merkleLeaf(e.entry) : sha256(concat(Uint8Array.of(0), e?.bytes ?? new Uint8Array(0))));
    if (want.has(i + 1)) out.set(i + 1, f.root());
  }
  return out;
}

// ── Per-verdict local checks ─────────────────────────────────────────────────────────

export interface LocalVerdictCheck {
  index: number;
  seq: number | null;
  kind: Verdict["kind"] | null;
  /** The bytes decode as a SignedVerdict for this match. */
  decodes: boolean;
  /** ed25519 over verdictDigest(payload) with the bundle's referee key. */
  signature: boolean;
  /** seq = position + 1: no gaps, no repeats. */
  order: boolean;
  /** The log holds Verdict{seq, digest} with this digest; index of that entry. */
  logIndex: number | null;
  inLog: boolean;
  /** Checkpoint/End: the root they claim is the log's root at that size. */
  rootClaim: boolean | null;
  /** Start: players hash; End: ring commit, VRF signature, alpha seed, rebuilt ring. */
  ring: RingCheck | null;
}

export interface RingCheck {
  playersHash?: boolean;
  commit?: boolean;
  vrf?: boolean;
  alphaSeed?: boolean;
  ringRebuilt?: boolean;
}

export const localOk = (c: LocalVerdictCheck) =>
  c.decodes &&
  c.signature &&
  c.order &&
  c.inLog &&
  c.rootClaim !== false &&
  (c.ring === null || Object.values(c.ring).every(Boolean));

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
  start: SignedVerdict | null;
}

export function localContext(d: DecodedBundle): LocalContext {
  const sizes: number[] = [];
  for (const x of d.verdicts) {
    const b = x.v?.body;
    if (b && (b.kind === "Checkpoint" || b.kind === "End")) sizes.push(Number(b.logSize));
  }
  return {
    entries: verdictEntries(d.log),
    roots: prefixRoots(d.log, sizes),
    start: d.verdicts.find((x) => x.v?.body.kind === "Start")?.v ?? null,
  };
}

export function checkVerdict(d: DecodedBundle, ctx: LocalContext, index: number): LocalVerdictCheck {
  const x = d.verdicts[index];
  const v = x?.v ?? null;
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
  };
  if (!v || !equal(v.matchId, d.matchId)) return base;
  const digest = verdictDigest(v);
  const entry = ctx.entries.get(v.seq);
  let signature = false;
  try {
    signature = ed25519.verify(v.sig, digest, d.refereePk);
  } catch {
    signature = false;
  }
  const out: LocalVerdictCheck = {
    ...base,
    decodes: true,
    signature,
    order: v.seq === index + 1,
    logIndex: entry?.index ?? null,
    inLog: !!entry && equal(entry.digest, digest),
  };
  const b = v.body;
  if (b.kind === "Checkpoint" || b.kind === "End") {
    const r = ctx.roots.get(Number(b.logSize));
    out.rootClaim = !!r && equal(r, b.root) && (entry ? entry.index >= Number(b.logSize) : false);
  }
  if (b.kind === "Start") out.ring = { playersHash: equal(b.playersHash, playersHash(d.players)) };
  if (b.kind === "End") out.ring = checkEnd(d, ctx.start, b);
  return out;
}

function checkEnd(
  d: DecodedBundle,
  start: SignedVerdict | null,
  b: Extract<Verdict, { kind: "End" }>,
): RingCheck {
  const commit = start?.body.kind === "Start" && equal(start.body.ringCommit, ringCommit(b.vrfSignature));
  let vrf = false;
  try {
    vrf = ed25519.verify(b.vrfSignature, utf8(b.alpha), d.vrfPk);
  } catch {
    vrf = false;
  }
  const rebuilt = buildRing(d.players, b.vrfSignature);
  const revealed = d.reveal.ring;
  return {
    commit,
    vrf,
    // The contract requires the VRF seed to be this match's id (TECHNICAL 4.8).
    alphaSeed: b.alpha.split(":").at(-1) === toHex(d.matchId),
    ringRebuilt:
      (revealed.length === 0 ||
        (revealed.length === rebuilt.length && revealed.every((a, i) => a === rebuilt[i]))) &&
      (d.reveal.vrfSignature === null || equal(d.reveal.vrfSignature, b.vrfSignature)),
  };
}

// ── Batches: hash in the log, hash chain per player ──────────────────────────────────

export interface BatchCheck {
  /** "player:seq" of every batch whose hash is in the log and whose chain link holds. */
  verified: Set<string>;
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
    if (prev && !equal(prev, batch.prev)) {
      failed.push({ key, why: "broken chain" });
      continue;
    }
    verified.add(key);
  }
  return { verified, failed };
}

// ── Handler lines: the text the page quotes is the text the log committed to ───────────

export function checkHandler(d: DecodedBundle): Map<number, boolean> {
  const receipts = new Map<number, Extract<LogEntry, { kind: "HintReceipt" }>>();
  for (const e of d.log) if (e.entry?.kind === "HintReceipt") receipts.set(e.entry.hintId, e.entry);
  const out = new Map<number, boolean>();
  for (const h of d.handler) {
    const r = receipts.get(h.hintId);
    out.set(h.hintId, !!r && equal(r.textHash, sha256(utf8(h.text))));
  }
  return out;
}
