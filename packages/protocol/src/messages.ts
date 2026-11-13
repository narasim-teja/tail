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
  /** `hint` is the HintKind, so the contract can check `amount == hintPrice(stake, hint)`. */
  | { kind: "Hint"; from: number; to: number; amount: bigint; hintId: number; hint: number }
  | { kind: "Tag"; hunter: number; target: number }
  | { kind: "Forfeit"; player: number; to: number }
  | { kind: "Checkpoint"; logSize: bigint; root: Bytes }
  | { kind: "End"; alpha: string; vrfSignature: Bytes; logSize: bigint; root: Bytes };

export function writeVerdict(w: Writer, v: Verdict): Writer {
  switch (v.kind) {
    case "Start":
      return w.u8(0).fixed(v.playersHash, 32).fixed(v.ringCommit, 32).u64(v.startMs).u64(v.endMs);
    case "Hint":
      return w.u8(1).u16(v.from).u16(v.to).u128(v.amount).u32(v.hintId).u8(v.hint);
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
      return { kind: "Hint", from: r.u16(), to: r.u16(), amount: r.u128(), hintId: r.u32(), hint: r.u8() };
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
export const decodeVerdict = (bytes: Bytes) => decodeAll(bytes, readVerdict);

/**
 * The signed part of a verdict. `prev` is the verdictDigest of the match's previous verdict
 * (zeros for the first, seq 1), so two different verdicts for one seq cannot both extend the
 * chain the contract holds. `callId` is the OutLayer call (UUID bytes) that produced it, so the
 * replay can fetch that call's attestation record and check the executed wasm hash.
 */
export interface VerdictPayload {
  matchId: Bytes; // 16
  seq: number;
  prev: Bytes; // 32
  callId: Bytes; // 16
  body: Verdict;
}

export interface SignedVerdict extends VerdictPayload {
  sig: Bytes; // 64, ed25519 over verdictDigest(payload)
}

const writeVerdictPayload = (w: Writer, p: VerdictPayload) =>
  writeVerdict(w.fixed(p.matchId, 16).u32(p.seq).fixed(p.prev, 32).fixed(p.callId, 16), p.body);

export const encodeVerdictPayload = (p: VerdictPayload) => writeVerdictPayload(new Writer(), p).bytes();
export const encodeSignedVerdict = (v: SignedVerdict) =>
  writeVerdictPayload(new Writer(), v).fixed(v.sig, 64).bytes();
export const decodeSignedVerdict = (bytes: Bytes): SignedVerdict =>
  decodeAll(bytes, (r) => ({
    matchId: r.fixed(16),
    seq: r.u32(),
    prev: r.fixed(32),
    callId: r.fixed(16),
    body: readVerdict(r),
    sig: r.fixed(64),
  }));

// ── Match log (Merkle leaves) ───────────────────────────────────────────────────

/**
 * `salt` (16 bytes, last field of Contact, HintReceipt and Evidence) is logSalt(K_log, leaf
 * index). During play the relay holds every leaf hash; without the salt it could hash each of
 * the few thousand possible Contact {a, b, epoch} and read the contact graph off the leaves.
 */
export type LogEntry =
  | { kind: "Batch"; player: number; seq: number; hash: Bytes }
  | { kind: "Contact"; a: number; b: number; epoch: number; salt: Bytes }
  | { kind: "Verdict"; seq: number; digest: Bytes }
  | {
      kind: "HintReceipt";
      hintId: number;
      chatId: string;
      textHash: Bytes;
      signature: Bytes;
      signingAddress: string;
      salt: Bytes;
    }
  /** One referee tick: when it ran and which OutLayer call ran it. */
  | { kind: "Tick"; tickNo: number; nowMs: bigint; callId: Bytes }
  /** A batch the referee refused; `hash` is batchHash, `code` a RejectCode. */
  | { kind: "Rejected"; player: number; seq: number; hash: Bytes; code: number }
  /** Written just before a Tag's Verdict entry: the strike and the contact epochs behind it. */
  | {
      kind: "Evidence";
      hunter: number;
      target: number;
      strikeSeq: number;
      strikeEpoch: number;
      epochs: number[];
      salt: Bytes;
    }
  /** At start, one per player: who plays as index `player`, with which device key. */
  | { kind: "Enrolled"; player: number; account: string; keyHash: Bytes; attested: boolean };

export function writeLogEntry(w: Writer, e: LogEntry): Writer {
  switch (e.kind) {
    case "Batch":
      return w.u8(0).u16(e.player).u32(e.seq).fixed(e.hash, 32);
    case "Contact":
      return w.u8(1).u16(e.a).u16(e.b).u32(e.epoch).fixed(e.salt, 16);
    case "Verdict":
      return w.u8(2).u32(e.seq).fixed(e.digest, 32);
    case "HintReceipt":
      return w
        .u8(3)
        .u32(e.hintId)
        .string(e.chatId)
        .fixed(e.textHash, 32)
        .vecU8(e.signature)
        .string(e.signingAddress)
        .fixed(e.salt, 16);
    case "Tick":
      return w.u8(4).u32(e.tickNo).u64(e.nowMs).fixed(e.callId, 16);
    case "Rejected":
      return w.u8(5).u16(e.player).u32(e.seq).fixed(e.hash, 32).u8(e.code);
    case "Evidence":
      return w
        .u8(6)
        .u16(e.hunter)
        .u16(e.target)
        .u32(e.strikeSeq)
        .u32(e.strikeEpoch)
        .vec(e.epochs, (w2, x) => w2.u32(x))
        .fixed(e.salt, 16);
    case "Enrolled":
      return w.u8(7).u16(e.player).string(e.account).fixed(e.keyHash, 32).bool(e.attested);
  }
}
export function readLogEntry(r: Reader): LogEntry {
  const tag = r.u8();
  switch (tag) {
    case 0:
      return { kind: "Batch", player: r.u16(), seq: r.u32(), hash: r.fixed(32) };
    case 1:
      return { kind: "Contact", a: r.u16(), b: r.u16(), epoch: r.u32(), salt: r.fixed(16) };
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
        salt: r.fixed(16),
      };
    case 4:
      return { kind: "Tick", tickNo: r.u32(), nowMs: r.u64(), callId: r.fixed(16) };
    case 5:
      return { kind: "Rejected", player: r.u16(), seq: r.u32(), hash: r.fixed(32), code: r.u8() };
    case 6:
      return {
        kind: "Evidence",
        hunter: r.u16(),
        target: r.u16(),
        strikeSeq: r.u32(),
        strikeEpoch: r.u32(),
        epochs: r.vec((r2) => r2.u32()),
        salt: r.fixed(16),
      };
    case 7:
      return {
        kind: "Enrolled",
        player: r.u16(),
        account: r.string(),
        keyHash: r.fixed(32),
        attested: r.bool(),
      };
    default:
      throw new Error(`unknown LogEntry tag ${tag}`);
  }
}
export const encodeLogEntry = (e: LogEntry) => writeLogEntry(new Writer(), e).bytes();
export const decodeLogEntry = (bytes: Bytes) => decodeAll(bytes, readLogEntry);

/**
 * "These two phones were near each other": a Contact log entry with its audit path to a root
 * that contract `contract` anchored for match `matchId`, plus the account ids it names.
 * Checked from chain data alone (verifyPresence); no new signature.
 */
export interface PresenceProof {
  matchId: Bytes; // 16
  contract: string;
  entry: LogEntry;
  index: bigint;
  size: bigint;
  path: Bytes[];
  /** Accounts of players `a` and `b` of the entry, in that order. */
  accounts: [string, string];
}

export const encodePresenceProof = (p: PresenceProof) =>
  writeLogEntry(new Writer().fixed(p.matchId, 16).string(p.contract), p.entry)
    .u64(p.index)
    .u64(p.size)
    .vec(p.path, (w, h) => w.fixed(h, 32))
    .string(p.accounts[0])
    .string(p.accounts[1])
    .bytes();
export const decodePresenceProof = (bytes: Bytes): PresenceProof =>
  decodeAll(bytes, (r) => ({
    matchId: r.fixed(16),
    contract: r.string(),
    entry: readLogEntry(r),
    index: r.u64(),
    size: r.u64(),
    path: r.vec((r2) => r2.fixed(32)),
    accounts: [r.string(), r.string()],
  }));

// ── Enclave → phone (signed by the referee, sealed to the player's box key) ──────

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

const writePlayerKeys = (w: Writer, k: PlayerKeys) =>
  w
    .fixed(k.matchId, 16)
    .u16(k.player)
    .u64(k.startMs)
    .u64(k.endMs)
    .fixed(k.kTag, 32)
    .fixed(k.kPlayer, 32)
    .string(k.target);
const readPlayerKeys = (r: Reader): PlayerKeys => ({
  matchId: r.fixed(16),
  player: r.u16(),
  startMs: r.u64(),
  endMs: r.u64(),
  kTag: r.fixed(32),
  kPlayer: r.fixed(32),
  target: r.string(),
});
export const encodePlayerKeys = (k: PlayerKeys) => writePlayerKeys(new Writer(), k).bytes();
export const decodePlayerKeys = (bytes: Bytes) => decodeAll(bytes, readPlayerKeys);

/**
 * Anyone holding a player's box public key can seal to it, the relay included, so the referee
 * signs what it seals: `sig = ed25519(referee_sk, keysSigDigest(keys))`.
 */
export interface SignedPlayerKeys {
  keys: PlayerKeys;
  sig: Bytes; // 64
}
export const encodeSignedPlayerKeys = (s: SignedPlayerKeys) =>
  writePlayerKeys(new Writer(), s.keys).fixed(s.sig, 64).bytes();
export const decodeSignedPlayerKeys = (bytes: Bytes): SignedPlayerKeys =>
  decodeAll(bytes, (r) => ({ keys: readPlayerKeys(r), sig: r.fixed(64) }));

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
  matchId: Bytes; // 16
  player: number;
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
  /**
   * The seq the referee expects next from this player, and the hash of their last accepted
   * batch: a phone that lost its outbox rebuilds its chain from these two.
   */
  nextSeq: number;
  chainTip: Bytes; // 32
  /** Cumulative dark time so far. */
  darkMs: number;
  /** Tags this player has made. */
  tags: number;
  /** The log at the end of this tick, so the phone can ask for an inclusion proof later. */
  logSize: bigint;
  root: Bytes; // 32
  /** This player's latest refused batch; `code` is a RejectCode. */
  rejected?: { seq: number; code: number };
}

const writeHud = (w: Writer, h: Hud) =>
  w
    .fixed(h.matchId, 16)
    .u16(h.player)
    .u32(h.tick)
    .u32(h.epoch)
    .u8(h.lock)
    .u8(h.heat)
    .u128(h.head)
    .u8(h.status)
    .string(h.target)
    .option(h.leak, (w2, c) => w2.i32(c.latE7).i32(c.lonE7))
    .option(h.hintFact, (w2, f) => w2.u32(f.hintId).u8(f.hint).u8(f.value))
    .option(h.taggedBy, (w2, a) => w2.string(a))
    .u32(h.nextSeq)
    .fixed(h.chainTip, 32)
    .u32(h.darkMs)
    .u8(h.tags)
    .u64(h.logSize)
    .fixed(h.root, 32)
    .option(h.rejected, (w2, x) => w2.u32(x.seq).u8(x.code));
function readHud(r: Reader): Hud {
  const base = {
    matchId: r.fixed(16),
    player: r.u16(),
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
  const chain = { nextSeq: r.u32(), chainTip: r.fixed(32), darkMs: r.u32(), tags: r.u8() };
  const log = { logSize: r.u64(), root: r.fixed(32) };
  const rejected = r.option((r2) => ({ seq: r2.u32(), code: r2.u8() }));
  return {
    ...base,
    ...(leak ? { leak } : {}),
    ...(hintFact ? { hintFact } : {}),
    ...(taggedBy !== undefined ? { taggedBy } : {}),
    ...chain,
    ...log,
    ...(rejected ? { rejected } : {}),
  };
}
export const encodeHud = (h: Hud) => writeHud(new Writer(), h).bytes();
export const decodeHud = (bytes: Bytes) => decodeAll(bytes, readHud);

/** `sig = ed25519(referee_sk, hudSigDigest(hud))`; see SignedPlayerKeys for why. */
export interface SignedHud {
  hud: Hud;
  sig: Bytes; // 64
}
export const encodeSignedHud = (s: SignedHud) => writeHud(new Writer(), s.hud).fixed(s.sig, 64).bytes();
export const decodeSignedHud = (bytes: Bytes): SignedHud =>
  decodeAll(bytes, (r) => ({ hud: readHud(r), sig: r.fixed(64) }));

/** The Handler's words for one hint, sealed to the asker so the relay can neither read nor swap them. */
export interface VoiceLine {
  matchId: Bytes; // 16
  player: number;
  hintId: number;
  text: string;
}
const writeVoiceLine = (w: Writer, v: VoiceLine) =>
  w.fixed(v.matchId, 16).u16(v.player).u32(v.hintId).string(v.text);
const readVoiceLine = (r: Reader): VoiceLine => ({
  matchId: r.fixed(16),
  player: r.u16(),
  hintId: r.u32(),
  text: r.string(),
});
export const encodeVoiceLine = (v: VoiceLine) => writeVoiceLine(new Writer(), v).bytes();
export const decodeVoiceLine = (bytes: Bytes) => decodeAll(bytes, readVoiceLine);

/**
 * `sig = ed25519(referee_sk, voiceSigDigest(line))`: sealing alone would stop reading, not
 * swapping, since the relay can seal to the asker too.
 */
export interface SignedVoiceLine {
  line: VoiceLine;
  sig: Bytes; // 64
}
export const encodeSignedVoiceLine = (s: SignedVoiceLine) =>
  writeVoiceLine(new Writer(), s.line).fixed(s.sig, 64).bytes();
export const decodeSignedVoiceLine = (bytes: Bytes): SignedVoiceLine =>
  decodeAll(bytes, (r) => ({ line: readVoiceLine(r), sig: r.fixed(64) }));

// ── Phone → relay over the mesh ──────────────────────────────────────────────────

/** A signed relay request (auth.ts), as a carrier phone forwards it. */
export interface CarryRequest {
  account: string;
  timeMs: bigint;
  method: string;
  path: string;
  body: Bytes;
  sig: Bytes; // 64
}
export const encodeCarryRequest = (c: CarryRequest) =>
  new Writer()
    .string(c.account)
    .u64(c.timeMs)
    .string(c.method)
    .string(c.path)
    .vecU8(c.body)
    .fixed(c.sig, 64)
    .bytes();
export const decodeCarryRequest = (bytes: Bytes): CarryRequest =>
  decodeAll(bytes, (r) => ({
    account: r.string(),
    timeMs: r.u64(),
    method: r.string(),
    path: r.string(),
    body: r.vecU8(),
    sig: r.fixed(64),
  }));

/**
 * The relay's receipt for a carried envelope: `sig = ed25519(relay_sk, carryAckDigest(envelope,
 * status, receivedMs))`, with `status` the HTTP status the request got.
 */
export interface CarryAck {
  status: number;
  receivedMs: bigint;
  sig: Bytes; // 64
}
export const encodeCarryAck = (a: CarryAck) =>
  new Writer().u16(a.status).u64(a.receivedMs).fixed(a.sig, 64).bytes();
export const decodeCarryAck = (bytes: Bytes): CarryAck =>
  decodeAll(bytes, (r) => ({ status: r.u16(), receivedMs: r.u64(), sig: r.fixed(64) }));

/** Reads one value that must use every byte: trailing bytes are a malformed message. */
function decodeAll<T>(bytes: Bytes, read: (r: Reader) => T): T {
  const r = new Reader(bytes);
  const v = read(r);
  r.done();
  return v;
}
