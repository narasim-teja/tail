// Decodes a ReplayBundle (untrusted JSON from the relay or a fixture) into typed bytes. Shape
// problems throw BundleError; a single undecodable verdict, log entry or batch is kept with
// `null` so the checks can report it instead of the whole page failing.

import {
  type Batch,
  decodeBatch,
  decodeLogEntry,
  decodeSignedVerdict,
  fromHex,
  type LogEntry,
  type ReplayBundle,
  type SignedVerdict,
  sha256,
} from "@tail/protocol";

export class BundleError extends Error {
  override name = "BundleError";
}

export interface DecodedVerdict {
  index: number;
  bytes: Uint8Array;
  v: SignedVerdict | null;
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
 * A Handler line as the bundle quotes it. `signedText` is the NEAR AI signature's message
 * (`model:sha256(request):sha256(response)`), when the relay passes it on; the receipt in the log
 * holds the signature and address but not the message.
 */
export interface HandlerLine {
  hintId: number;
  text: string;
  chatId: string;
  model: string;
  signedText: string | null;
}

export interface DecodedBundle {
  raw: ReplayBundle;
  matchId: Uint8Array;
  players: string[];
  stake: bigint;
  refereePk: Uint8Array;
  vrfPk: Uint8Array;
  verdicts: DecodedVerdict[];
  log: DecodedLogEntry[];
  batches: DecodedBatch[];
  reveal: { alpha: string; vrfSignature: Uint8Array | null; ring: string[] };
  handler: HandlerLine[];
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The relay writes some byte fields as hex and some as base64; accept either by shape. */
export function hexOrB64(s: string): Uint8Array {
  return /^[0-9a-f]*$/i.test(s) && s.length % 2 === 0 ? fromHex(s) : fromB64(s);
}

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
  need(json["version"] === 1, "unknown version");
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
  const raw = json as unknown as ReplayBundle;

  const verdicts = raw.verdicts.map((x, index): DecodedVerdict => {
    need(isObj(x) && typeof x.signed === "string", "verdict");
    const bytes = attempt(() => fromB64(x.signed)) ?? new Uint8Array(0);
    return {
      index,
      bytes,
      v: attempt(() => decodeSignedVerdict(bytes)),
      txHash: typeof x.txHash === "string" && x.txHash.length > 0 ? x.txHash : null,
    };
  });
  const log = raw.log.map((s): DecodedLogEntry => {
    const bytes = attempt(() => fromB64(s)) ?? new Uint8Array(0);
    return { bytes, entry: attempt(() => decodeLogEntry(bytes)) };
  });
  const batches = raw.batches.map((s): DecodedBatch => {
    const bytes = attempt(() => fromB64(s)) ?? new Uint8Array(0);
    const batch = attempt(() => decodeBatch(bytes));
    return { bytes, batch, hash: batch ? sha256(bytes) : null };
  });
  const sig =
    typeof rev["vrfSignature"] === "string" ? attempt(() => hexOrB64(rev["vrfSignature"] as string)) : null;

  return {
    raw,
    matchId: fromHex(raw.match.id),
    players: raw.match.players,
    stake: BigInt(raw.match.stake),
    refereePk: fromHex(raw.referee.refereePk),
    vrfPk: fromHex(raw.referee.vrfPk),
    verdicts,
    log,
    batches,
    reveal: {
      alpha: typeof rev["vrfAlpha"] === "string" ? rev["vrfAlpha"] : "",
      vrfSignature: sig && sig.length === 64 ? sig : null,
      ring: strings(rev["ring"]) ? rev["ring"] : [],
    },
    handler: (raw.handler as unknown[]).flatMap((h): HandlerLine[] =>
      isObj(h) && typeof h["hintId"] === "number" && typeof h["text"] === "string"
        ? [
            {
              hintId: h["hintId"],
              text: h["text"],
              chatId: typeof h["chatId"] === "string" ? h["chatId"] : "",
              model: typeof h["model"] === "string" ? h["model"] : "",
              signedText: typeof h["signedText"] === "string" ? h["signedText"] : null,
            },
          ]
        : [],
    ),
  };
}
