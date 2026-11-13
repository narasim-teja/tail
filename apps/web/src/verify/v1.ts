// Protocol v1 verdicts and log entries, for replays recorded before protocol v2 (read only). A v1
// verdict has no `prev` link and a Hint without its kind; its digest is SHA256("tail/verdict/v1" ‖
// borsh(match_id, seq, call_id, body)). A v1 log has only the first four entry kinds, and its
// Contact and HintReceipt carry no salt. Nothing new is ever signed or logged this way: the
// encoders exist so the tests can build a v1 bundle.
//
// v1 bodies keep their own shape (VerdictV1): a v1 Hint named its target and paid it at once, and
// v1 Tags, Forfeits and End carried no credits or hint targets. Nothing fills those in, so code
// that needs them has to tell the two apart and say the v2 settlement replay didn't run.

import {
  concat,
  type LogEntry,
  Reader,
  type SignedVerdict,
  sha256,
  utf8,
  type Verdict,
  Writer,
} from "@tail/protocol";

const DOMAIN_V1 = "tail/verdict/v1";

/** A verdict body as protocol v1 signed it. */
export type VerdictV1 =
  | Extract<Verdict, { kind: "Start" | "Checkpoint" }>
  /** `hint` is HINT_KIND_UNKNOWN: v1 did not sign the kind. `to` was paid `amount` at once. */
  | { kind: "Hint"; from: number; to: number; amount: bigint; hintId: number; hint: number }
  | { kind: "Tag"; hunter: number; target: number }
  | { kind: "Forfeit"; player: number; to: number }
  | { kind: "End"; alpha: string; vrfSignature: Uint8Array; logSize: bigint; root: Uint8Array };

export interface SignedVerdictV1 extends Omit<SignedVerdict, "body"> {
  body: VerdictV1;
}

/** A v1 Hint did not carry its kind; the decoded body says so with -1. */
export const HINT_KIND_UNKNOWN = -1;

function readBodyV1(r: Reader): VerdictV1 {
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
      return {
        kind: "Hint",
        from: r.u16(),
        to: r.u16(),
        amount: r.u128(),
        hintId: r.u32(),
        hint: HINT_KIND_UNKNOWN,
      };
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

function writeBodyV1(w: Writer, v: VerdictV1): Writer {
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

const payloadV1 = (v: Omit<SignedVerdictV1, "prev" | "sig">) =>
  writeBodyV1(new Writer().fixed(v.matchId, 16).u32(v.seq).fixed(v.callId, 16), v.body);

/** The v1 verdict digest the referee signed and the log's Verdict entry holds. */
export const verdictDigestV1 = (v: Omit<SignedVerdictV1, "prev" | "sig">) =>
  sha256(concat(utf8(DOMAIN_V1), payloadV1(v).bytes()));

/** A v1 SignedVerdict. `prev` is zeros: v1 had no link, and nothing checks it for v1. */
export function decodeSignedVerdictV1(bytes: Uint8Array): SignedVerdictV1 {
  const r = new Reader(bytes);
  const matchId = r.fixed(16);
  const seq = r.u32();
  const callId = r.fixed(16);
  const body = readBodyV1(r);
  const sig = r.fixed(64);
  r.done();
  return { matchId, seq, prev: new Uint8Array(32), callId, body, sig };
}

export const encodeSignedVerdictV1 = (v: Omit<SignedVerdictV1, "prev">) =>
  payloadV1(v).fixed(v.sig, 64).bytes();

/**
 * A v1 Contact or HintReceipt has no salt; it decodes with an empty one, which no salt check
 * accepts. Leaves are hashed from the bytes as sent, never from a re-encoding, so the empty salt
 * never reaches a root.
 */
export const NO_SALT = new Uint8Array(0);

/** The v1 entry layouts (tags 0–3); a later tag is not a v1 entry. */
export function decodeLogEntryV1(bytes: Uint8Array): LogEntry {
  const r = new Reader(bytes);
  const tag = r.u8();
  let e: LogEntry;
  switch (tag) {
    case 0:
      e = { kind: "Batch", player: r.u16(), seq: r.u32(), hash: r.fixed(32) };
      break;
    case 1:
      e = { kind: "Contact", a: r.u16(), b: r.u16(), epoch: r.u32(), salt: NO_SALT };
      break;
    case 2:
      e = { kind: "Verdict", seq: r.u32(), digest: r.fixed(32) };
      break;
    case 3:
      e = {
        kind: "HintReceipt",
        hintId: r.u32(),
        chatId: r.string(),
        textHash: r.fixed(32),
        signature: r.vecU8(),
        signingAddress: r.string(),
        salt: NO_SALT,
      };
      break;
    default:
      throw new Error(`not a v1 LogEntry tag ${tag}`);
  }
  r.done();
  return e;
}

export function encodeLogEntryV1(e: LogEntry): Uint8Array {
  const w = new Writer();
  switch (e.kind) {
    case "Batch":
      return w.u8(0).u16(e.player).u32(e.seq).fixed(e.hash, 32).bytes();
    case "Contact":
      return w.u8(1).u16(e.a).u16(e.b).u32(e.epoch).bytes();
    case "Verdict":
      return w.u8(2).u32(e.seq).fixed(e.digest, 32).bytes();
    case "HintReceipt":
      return w
        .u8(3)
        .u32(e.hintId)
        .string(e.chatId)
        .fixed(e.textHash, 32)
        .vecU8(e.signature)
        .string(e.signingAddress)
        .bytes();
    default:
      throw new Error(`a v1 log has no ${e.kind} entry`);
  }
}
