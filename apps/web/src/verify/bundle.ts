// Decodes a replay bundle (untrusted JSON from the relay or a fixture) into typed bytes. Shape
// problems throw BundleError; a single undecodable verdict, log entry or batch is kept with
// `null` so the checks can report it instead of the whole page failing.
//
// Two versions are read (@tail/protocol replay.ts). v2 (protocol v2): verdicts chained by `prev`,
// the log's leaf hashes, the plaintext log after End, and for each Handler line only the message
// its model signature covers (the words were sealed to the asker). v1: matches recorded before
// protocol v2, decoded read only with their own verdict format (v1.ts); the checks that need v2
// data say they were not run. A v1 log is read with its own entry layouts too (no salts).

import {
  type AnyReplayBundle,
  type Batch,
  concat,
  decodeBatch,
  decodeLogEntry,
  decodeSignedVerdict,
  equal,
  fromHex,
  type LogEntry,
  type ReplayBundleV2,
  type SignedVerdict,
  sha256,
  verdictDigest,
} from "@tail/protocol";
import { decodeLogEntryV1, decodeSignedVerdictV1, type SignedVerdictV1, verdictDigestV1 } from "./v1.ts";

export class BundleError extends Error {
  override name = "BundleError";
}

export type AnyBundle = AnyReplayBundle;

/** A decoded verdict of either version; `body` shapes differ where v2 changed them (see v1.ts). */
export type AnySignedVerdict = SignedVerdict | SignedVerdictV1;
export type AnyVerdict = AnySignedVerdict["body"];

export interface DecodedVerdict {
  index: number;
  bytes: Uint8Array;
  v: AnySignedVerdict | null;
  /** The digest the referee signed, in this bundle's verdict format; null if undecodable. */
  digest: Uint8Array | null;
  txHash: string | null;
}

export interface DecodedLogEntry {
  bytes: Uint8Array;
  entry: LogEntry | null;
}

export interface DecodedBatch {
  bytes: Uint8Array;
  batch: Batch | null;
  /** SHA-256 of the bytes as sent (what the log's Batch entry commits to), not a re-encoding. */
  hash: Uint8Array | null;
}

/**
 * A Handler line as the bundle gives it. `signedText` is the NEAR AI signature's message
 * (`model:sha256(request):sha256(response)`), when the relay passes it on; the receipt in the log
 * holds the signature and address but not the message. `text` and `model` are the quoted words
 * and the model the relay names: v1 only, since in v2 the words were sealed to the asker and the
 * relay never had them (null).
 */
export interface HandlerLine {
  hintId: number;
  text: string | null;
  chatId: string;
  model: string | null;
  signedText: string | null;
}

export interface DecodedBundle {
  raw: AnyBundle;
  /** 1: recorded before protocol v2 (read only); 2: protocol v2. */
  version: 1 | 2;
  matchId: Uint8Array;
  players: string[];
  stake: bigint;
  refereePk: Uint8Array;
  vrfPk: Uint8Array;
  verdicts: DecodedVerdict[];
  log: DecodedLogEntry[];
  /**
   * The leaf hash of every log entry, as the roots are computed: hashed from the entry's bytes
   * where the bundle has the entry (never a re-encoding), else the bundle's own leaf hash.
   */
  leaves: Uint8Array[];
  /** Positions where the bundle's leaf hash is not the hash of the entry it sent. */
  leafConflicts: number[];
  batches: DecodedBatch[];
  reveal: {
    alpha: string;
    vrfSignature: Uint8Array | null;
    ring: string[];
    /** The match key K_m, released with the log (v2); it derives every log salt. */
    kM: Uint8Array | null;
  };
  handler: HandlerLine[];
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toB64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/** The relay writes some byte fields as hex and some as base64; accept either by shape. */
export function hexOrB64(s: string): Uint8Array {
  return /^[0-9a-f]*$/i.test(s) && s.length % 2 === 0 ? fromHex(s) : fromB64(s);
}

/** RFC 6962 leaf hash of an entry's bytes as sent. */
export const leafOf = (bytes: Uint8Array) => sha256(concat(Uint8Array.of(0), bytes));

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");

function need(cond: unknown, what: string): asserts cond {
  if (!cond) throw new BundleError(`This replay is malformed (${what}).`);
}

function attempt<T>(f: () => T): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}

export function decodeBundle(json: unknown): DecodedBundle {
  need(isObj(json), "not an object");
  const version = json["version"];
  need(version === 1 || version === 2, "unknown version");
  const m = json["match"];
  const r = json["referee"];
  const rev = json["reveal"];
  need(isObj(m) && isObj(r) && isObj(rev), "missing sections");
  need(typeof m["id"] === "string" && /^[0-9a-f]{32}$/.test(m["id"]), "match id");
  need(strings(m["players"]) && m["players"].length >= 2, "players");
  need(typeof m["startMs"] === "number" && typeof m["endMs"] === "number", "times");
  need(m["endMs"] > m["startMs"], "times");
  need(typeof m["stake"] === "string" && /^\d+$/.test(m["stake"]), "stake");
  need(isObj(m["zone"]), "zone");
  need(typeof r["refereePk"] === "string" && /^[0-9a-f]{64}$/i.test(r["refereePk"]), "referee key");
  need(typeof r["vrfPk"] === "string" && /^[0-9a-f]{64}$/i.test(r["vrfPk"]), "VRF key");
  need(Array.isArray(json["verdicts"]), "verdicts");
  need(strings(json["log"]), "log");
  need(strings(json["batches"]), "batches");
  need(Array.isArray(json["handler"]), "handler lines");
  if (version === 2) need(strings(json["leaves"]), "leaves");
  const raw = json as unknown as AnyBundle;

  const decodeVerdict = (bytes: Uint8Array): { v: AnySignedVerdict; digest: Uint8Array } => {
    if (version === 2) {
      const v = decodeSignedVerdict(bytes);
      return { v, digest: verdictDigest(v) };
    }
    const v = decodeSignedVerdictV1(bytes);
    return { v, digest: verdictDigestV1(v) };
  };
  const verdicts = raw.verdicts.map((x, index): DecodedVerdict => {
    need(isObj(x) && typeof x.signed === "string", "verdict");
    const bytes = attempt(() => fromB64(x.signed)) ?? new Uint8Array(0);
    const got = attempt(() => decodeVerdict(bytes));
    return {
      index,
      bytes,
      v: got?.v ?? null,
      digest: got?.digest ?? null,
      txHash: typeof x.txHash === "string" && x.txHash.length > 0 ? x.txHash : null,
    };
  });
  const decodeEntry = version === 2 ? decodeLogEntry : decodeLogEntryV1;
  const log = raw.log.map((s): DecodedLogEntry => {
    const bytes = attempt(() => fromB64(s)) ?? new Uint8Array(0);
    return { bytes, entry: attempt(() => decodeEntry(bytes)) };
  });
  const sent = version === 2 ? (raw as ReplayBundleV2).leaves.map((s) => attempt(() => hexOrB64(s))) : [];
  const leaves: Uint8Array[] = [];
  const leafConflicts: number[] = [];
  for (let i = 0; i < Math.max(log.length, sent.length); i++) {
    const e = log[i];
    const given = sent[i];
    // The leaf is over the bytes as sent, never a re-encoding: two encodings that decode alike
    // must not share a root, and an undecodable entry still has bytes the referee hashed.
    const own = e ? leafOf(e.bytes) : null;
    if (own && given !== undefined && !(given && equal(given, own))) leafConflicts.push(i);
    leaves.push(own ?? (given && given.length === 32 ? given : new Uint8Array(0)));
  }
  const batches = raw.batches.map((s): DecodedBatch => {
    const bytes = attempt(() => fromB64(s)) ?? new Uint8Array(0);
    const batch = attempt(() => decodeBatch(bytes));
    return { bytes, batch, hash: batch ? sha256(bytes) : null };
  });
  const sig =
    typeof rev["vrfSignature"] === "string" ? attempt(() => hexOrB64(rev["vrfSignature"] as string)) : null;
  const kM =
    version === 2 && typeof rev["kM"] === "string" && /^[0-9a-f]{64}$/i.test(rev["kM"])
      ? fromHex(rev["kM"])
      : null;

  return {
    raw,
    version,
    matchId: fromHex(raw.match.id),
    players: raw.match.players,
    stake: BigInt(raw.match.stake),
    refereePk: fromHex(raw.referee.refereePk),
    vrfPk: fromHex(raw.referee.vrfPk),
    verdicts,
    log,
    leaves,
    leafConflicts,
    batches,
    reveal: {
      alpha: typeof rev["vrfAlpha"] === "string" ? rev["vrfAlpha"] : "",
      vrfSignature: sig && sig.length === 64 ? sig : null,
      ring: strings(rev["ring"]) ? rev["ring"] : [],
      kM,
    },
    handler: (raw.handler as unknown[]).flatMap((h): HandlerLine[] =>
      isObj(h) && typeof h["hintId"] === "number" && (version === 2 || typeof h["text"] === "string")
        ? [
            {
              hintId: h["hintId"],
              text: version === 1 ? (h["text"] as string) : null,
              chatId: typeof h["chatId"] === "string" ? h["chatId"] : "",
              model: version === 1 && typeof h["model"] === "string" ? h["model"] : null,
              signedText: typeof h["signedText"] === "string" ? h["signedText"] : null,
            },
          ]
        : [],
    ),
  };
}
