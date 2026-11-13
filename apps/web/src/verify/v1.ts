// Protocol v1 verdicts, for replays recorded before protocol v2 (read only). A v1 verdict has no
// `prev` link and a Hint without its kind; its digest is SHA256("tail/verdict/v1" ‖ borsh(match_id,
// seq, call_id, body)). Nothing new is ever signed this way: the encoder exists so the tests can
// build a v1 bundle.

import { concat, Reader, type SignedVerdict, sha256, utf8, type Verdict, Writer } from "@tail/protocol";

const DOMAIN_V1 = "tail/verdict/v1";

/** A v1 Hint did not carry its kind; the decoded body says so with -1. */
export const HINT_KIND_UNKNOWN = -1;

function readBodyV1(r: Reader): Verdict {
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

function writeBodyV1(w: Writer, v: Verdict): Writer {
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

const payloadV1 = (v: Omit<SignedVerdict, "prev" | "sig">) =>
  writeBodyV1(new Writer().fixed(v.matchId, 16).u32(v.seq).fixed(v.callId, 16), v.body);

/** The v1 verdict digest the referee signed and the log's Verdict entry holds. */
export const verdictDigestV1 = (v: Omit<SignedVerdict, "prev" | "sig">) =>
  sha256(concat(utf8(DOMAIN_V1), payloadV1(v).bytes()));

/** A v1 SignedVerdict. `prev` is zeros: v1 had no link, and nothing checks it for v1. */
export function decodeSignedVerdictV1(bytes: Uint8Array): SignedVerdict {
  const r = new Reader(bytes);
  const matchId = r.fixed(16);
  const seq = r.u32();
  const callId = r.fixed(16);
  const body = readBodyV1(r);
  const sig = r.fixed(64);
  r.done();
  return { matchId, seq, prev: new Uint8Array(32), callId, body, sig };
}

export const encodeSignedVerdictV1 = (v: Omit<SignedVerdict, "prev">) =>
  payloadV1(v).fixed(v.sig, 64).bytes();
