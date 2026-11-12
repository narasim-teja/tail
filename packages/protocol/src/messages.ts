// Wire messages (TECHNICAL.md 4.3, 4.10, 4.11). Field order is the borsh order; it must match
// crates/tail-protocol/src/messages.rs exactly. Enum variant order is the u8 tag: append new
// variants at the end, never reorder.

import { Reader, Writer } from "./borsh.ts";

export type Bytes = Uint8Array;

// ── Phone → enclave ─────────────────────────────────────────────────────────────

export interface Fix {
  tMs: bigint;
  latE7: number;
  lonE7: number;
  accM: number;
  speedCmps: number;
  /** FixFlag bits. */
  flags: number;
}

export interface Sighting {
  epoch: number;
  /** 16-byte beacon token. */
  token: Bytes;
  rssiMax: number;
  rssiMed: number;
  n: number;
}

export type Action =
  | { kind: "Hint"; hint: number; nonce: number; text?: string }
  | { kind: "Strike"; nonce: number };

export interface Batch {
  matchId: Bytes; // 16
  player: number;
  seq: number;
  prev: Bytes; // 32, SHA256(borsh(previous batch)), zeros for seq 0
  tMs: bigint;
  fixes: Fix[];
  sightings: Sighting[];
  actions: Action[];
}

/** What a phone seals to the referee: the batch plus its App Attest assertion. */
export interface BatchEnvelope {
  batch: Batch;
  assertion: Bytes;
}

const writeFix = (w: Writer, f: Fix) =>
  w.u64(f.tMs).i32(f.latE7).i32(f.lonE7).u16(f.accM).u16(f.speedCmps).u8(f.flags);
const readFix = (r: Reader): Fix => ({
  tMs: r.u64(),
  latE7: r.i32(),
  lonE7: r.i32(),
  accM: r.u16(),
  speedCmps: r.u16(),
  flags: r.u8(),
});

const writeSighting = (w: Writer, s: Sighting) =>
  w.u32(s.epoch).fixed(s.token, 16).i8(s.rssiMax).i8(s.rssiMed).u8(s.n);
const readSighting = (r: Reader): Sighting => ({
  epoch: r.u32(),
  token: r.fixed(16),
  rssiMax: r.i8(),
  rssiMed: r.i8(),
  n: r.u8(),
});

const writeAction = (w: Writer, a: Action) => {
  if (a.kind === "Hint")
    w.u8(0)
      .u8(a.hint)
      .u32(a.nonce)
      .option(a.text, (w2, t) => w2.string(t));
  else w.u8(1).u32(a.nonce);
};
const readAction = (r: Reader): Action => {
  const tag = r.u8();
  if (tag === 0) {
    const hint = r.u8();
    const nonce = r.u32();
    const text = r.option((r2) => r2.string());
    return text === undefined ? { kind: "Hint", hint, nonce } : { kind: "Hint", hint, nonce, text };
  }
  if (tag === 1) return { kind: "Strike", nonce: r.u32() };
  throw new Error(`unknown Action tag ${tag}`);
};

export function writeBatch(w: Writer, b: Batch): Writer {
  return w
    .fixed(b.matchId, 16)
    .u16(b.player)
    .u32(b.seq)
    .fixed(b.prev, 32)
    .u64(b.tMs)
    .vec(b.fixes, writeFix)
    .vec(b.sightings, writeSighting)
    .vec(b.actions, writeAction);
}
export function readBatch(r: Reader): Batch {
  return {
    matchId: r.fixed(16),
    player: r.u16(),
    seq: r.u32(),
    prev: r.fixed(32),
    tMs: r.u64(),
    fixes: r.vec(readFix),
    sightings: r.vec(readSighting),
    actions: r.vec(readAction),
  };
}

export const encodeBatch = (b: Batch) => writeBatch(new Writer(), b).bytes();
export function decodeBatch(bytes: Bytes): Batch {
  const r = new Reader(bytes);
  const b = readBatch(r);
  r.done();
  return b;
}

export const encodeBatchEnvelope = (e: BatchEnvelope) =>
  writeBatch(new Writer(), e.batch).vecU8(e.assertion).bytes();
export function decodeBatchEnvelope(bytes: Bytes): BatchEnvelope {
  const r = new Reader(bytes);
  const e = { batch: readBatch(r), assertion: r.vecU8() };
  r.done();
  return e;
}

// ── Enclave → contract ──────────────────────────────────────────────────────────

export type Verdict =
  | { kind: "Start"; playersHash: Bytes; ringCommit: Bytes; startMs: bigint; endMs: bigint }
  | { kind: "Hint"; from: number; to: number; amount: bigint; hintId: number }
  | { kind: "Tag"; hunter: number; target: number }
  | { kind: "Forfeit"; player: number; to: number }
  | { kind: "Checkpoint"; logSize: bigint; root: Bytes }
  | { kind: "End"; alpha: string; vrfSignature: Bytes; logSize: bigint; root: Bytes };

export function writeVerdict(w: Writer, v: Verdict): Writer {
  switch (v.kind) {
    case "Start":
      return w.u8(0).fixed(v.playersHash, 32).fixed(v.ringCommit, 32).u64(v.startMs).u64(v.endMs);
    case "Hint":
      return w.u8(1).u16(v.from).u16(v.to).u128(v.amount).u32(v.hintId);
    case "Tag":
      return w.u8(2).u16(v.hunter).u16(v.target);
    case "Forfeit":
      return w.u8(3).u16(v.player).u16(v.to);
    case "Checkpoint":
      return w.u8(4).u64(v.logSize).fixed(v.root, 32);
    case "End":
      return w.u8(5).string(v.alpha).fixed(v.vrfSignature, 64).u64(v.logSize).fixed(v.root, 32);
  }
}
export function readVerdict(r: Reader): Verdict {
  const tag = r.u8();
  switch (tag) {
    case 0:
      return {
        kind: "Start",
        playersHash: r.fixed(32),
        ringCommit: r.fixed(32),
        startMs: r.u64(),
        endMs: r.u64(),
      };
    case 1:
      return { kind: "Hint", from: r.u16(), to: r.u16(), amount: r.u128(), hintId: r.u32() };
    case 2:
      return { kind: "Tag", hunter: r.u16(), target: r.u16() };
    case 3:
      return { kind: "Forfeit", player: r.u16(), to: r.u16() };
    case 4:
      return { kind: "Checkpoint", logSize: r.u64(), root: r.fixed(32) };
    case 5:
      return {
        kind: "End",
        alpha: r.string(),
        vrfSignature: r.fixed(64),
        logSize: r.u64(),
        root: r.fixed(32),
      };
    default:
      throw new Error(`unknown Verdict tag ${tag}`);
  }
}
export const encodeVerdict = (v: Verdict) => writeVerdict(new Writer(), v).bytes();
export function decodeVerdict(bytes: Bytes): Verdict {
  const r = new Reader(bytes);
  const v = readVerdict(r);
  r.done();
  return v;
}

/**
 * The signed part of a verdict. `callId` is the OutLayer call (UUID bytes) that produced it,
 * so the replay can fetch that call's attestation record and check the executed wasm hash.
 */
export interface VerdictPayload {
  matchId: Bytes; // 16
  seq: number;
  callId: Bytes; // 16
  body: Verdict;
}

export interface SignedVerdict extends VerdictPayload {
  sig: Bytes; // 64, ed25519 over verdictDigest(payload)
}

export const encodeVerdictPayload = (p: VerdictPayload) =>
  writeVerdict(new Writer().fixed(p.matchId, 16).u32(p.seq).fixed(p.callId, 16), p.body).bytes();

export const encodeSignedVerdict = (v: SignedVerdict) =>
  writeVerdict(new Writer().fixed(v.matchId, 16).u32(v.seq).fixed(v.callId, 16), v.body)
    .fixed(v.sig, 64)
    .bytes();
export function decodeSignedVerdict(bytes: Bytes): SignedVerdict {
  const r = new Reader(bytes);
  const v = {
    matchId: r.fixed(16),
    seq: r.u32(),
    callId: r.fixed(16),
    body: readVerdict(r),
    sig: r.fixed(64),
  };
  r.done();
  return v;
}

// ── Match log (Merkle leaves) ───────────────────────────────────────────────────

export type LogEntry =
  | { kind: "Batch"; player: number; seq: number; hash: Bytes }
  | { kind: "Contact"; a: number; b: number; epoch: number }
  | { kind: "Verdict"; seq: number; digest: Bytes }
  | {
      kind: "HintReceipt";
      hintId: number;
      chatId: string;
      textHash: Bytes;
      signature: Bytes;
      signingAddress: string;
    };

export function writeLogEntry(w: Writer, e: LogEntry): Writer {
  switch (e.kind) {
    case "Batch":
      return w.u8(0).u16(e.player).u32(e.seq).fixed(e.hash, 32);
    case "Contact":
      return w.u8(1).u16(e.a).u16(e.b).u32(e.epoch);
    case "Verdict":
      return w.u8(2).u32(e.seq).fixed(e.digest, 32);
    case "HintReceipt":
      return w
        .u8(3)
        .u32(e.hintId)
        .string(e.chatId)
        .fixed(e.textHash, 32)
        .vecU8(e.signature)
        .string(e.signingAddress);
  }
}
export function readLogEntry(r: Reader): LogEntry {
  const tag = r.u8();
  switch (tag) {
    case 0:
      return { kind: "Batch", player: r.u16(), seq: r.u32(), hash: r.fixed(32) };
    case 1:
      return { kind: "Contact", a: r.u16(), b: r.u16(), epoch: r.u32() };
    case 2:
      return { kind: "Verdict", seq: r.u32(), digest: r.fixed(32) };
    case 3:
      return {
        kind: "HintReceipt",
        hintId: r.u32(),
        chatId: r.string(),
        textHash: r.fixed(32),
        signature: r.vecU8(),
        signingAddress: r.string(),
      };
    default:
      throw new Error(`unknown LogEntry tag ${tag}`);
  }
}
export const encodeLogEntry = (e: LogEntry) => writeLogEntry(new Writer(), e).bytes();
export function decodeLogEntry(bytes: Bytes): LogEntry {
  const r = new Reader(bytes);
  const e = readLogEntry(r);
  r.done();
  return e;
}

// ── Enclave → phone (sealed to the player's box key) ─────────────────────────────

/** Sent once at Start: everything a phone needs to beacon and recognise its match. */
export interface PlayerKeys {
  matchId: Bytes; // 16
  player: number;
  startMs: bigint;
  endMs: bigint;
  kTag: Bytes; // 32
  kPlayer: Bytes; // 32
  /** Account id of this player's target. */
  target: string;
}

export const encodePlayerKeys = (k: PlayerKeys) =>
  new Writer()
    .fixed(k.matchId, 16)
    .u16(k.player)
    .u64(k.startMs)
    .u64(k.endMs)
    .fixed(k.kTag, 32)
    .fixed(k.kPlayer, 32)
    .string(k.target)
    .bytes();
export function decodePlayerKeys(bytes: Bytes): PlayerKeys {
  const r = new Reader(bytes);
  const k = {
    matchId: r.fixed(16),
    player: r.u16(),
    startMs: r.u64(),
    endMs: r.u64(),
    kTag: r.fixed(32),
    kPlayer: r.fixed(32),
    target: r.string(),
  };
  r.done();
  return k;
}

export const TargetStatus = { Hunting: 0, Out: 1, Won: 2 } as const;

export interface GridCell {
  latE7: number;
  lonE7: number;
}

export interface HintFact {
  hintId: number;
  hint: number; // HintKind
  /** NEAR: 0/1. BEARING: 0..7 (N, NE, E, …). TREND: 0 farther, 1 closer, 2 same. */
  value: number;
}

/** Per-tick heads-up display for one player. Only their own data, never anyone's position. */
export interface Hud {
  tick: number;
  epoch: number;
  lock: number;
  heat: number;
  head: bigint;
  status: number; // TargetStatus
  /** Account id of the current target (changes after a tag). */
  target: string;
  leak?: GridCell;
  hintFact?: HintFact;
  /**
   * Once this player is out: the account that took their head (the hunter for a Tag, the
   * receiver for a Forfeit). Lets the phone name who got them.
   */
  taggedBy?: string;
}

export const encodeHud = (h: Hud) =>
  new Writer()
    .u32(h.tick)
    .u32(h.epoch)
    .u8(h.lock)
    .u8(h.heat)
    .u128(h.head)
    .u8(h.status)
    .string(h.target)
    .option(h.leak, (w, c) => w.i32(c.latE7).i32(c.lonE7))
    .option(h.hintFact, (w, f) => w.u32(f.hintId).u8(f.hint).u8(f.value))
    .option(h.taggedBy, (w, a) => w.string(a))
    .bytes();
export function decodeHud(bytes: Bytes): Hud {
  const r = new Reader(bytes);
  const base = {
    tick: r.u32(),
    epoch: r.u32(),
    lock: r.u8(),
    heat: r.u8(),
    head: r.u128(),
    status: r.u8(),
    target: r.string(),
  };
  const leak = r.option((r2) => ({ latE7: r2.i32(), lonE7: r2.i32() }));
  const hintFact = r.option((r2) => ({ hintId: r2.u32(), hint: r2.u8(), value: r2.u8() }));
  const taggedBy = r.option((r2) => r2.string());
  r.done();
  return {
    ...base,
    ...(leak ? { leak } : {}),
    ...(hintFact ? { hintFact } : {}),
    ...(taggedBy !== undefined ? { taggedBy } : {}),
  };
}
