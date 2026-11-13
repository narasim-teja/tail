// What the phone must not lose mid-match: the hash chain position and the sealed batches not yet
// acknowledged by the relay. Losing either would break the seq chain the referee enforces. The
// sealed batches are ciphertext to the enclave, so a file is fine; secrets stay in the Keychain.
// Beside them: the tags this player won, the newest fix time (so fixes stay in order after a
// relaunch) and strikes or hints not yet inside a committed batch.

import { type Action, fromHex, toHex } from "@tail/protocol";
import { genesis } from "../game/batch";
import type { SessionRecord } from "../game/session";
import { fromB64, toB64 } from "../lib/b64";

export interface MatchRecord extends SessionRecord {
  matchId: string;
}

interface MatchJson {
  matchId: string;
  seq: number;
  prev: string;
  outbox: { seq: number; sealed: string }[];
  // Absent in files written before they were kept.
  tags?: number;
  lastFixMs?: number | null;
  actions?: Action[];
}

export const emptyRecord = (matchId: string): MatchRecord => ({
  matchId,
  chain: genesis(),
  outbox: [],
  tags: 0,
  lastFixMs: null,
  actions: [],
});

export const encodeMatchRecord = (r: MatchRecord): string =>
  JSON.stringify({
    matchId: r.matchId,
    seq: r.chain.seq,
    prev: toHex(r.chain.prev),
    outbox: r.outbox.map((o) => ({ seq: o.seq, sealed: toB64(o.sealed) })),
    tags: r.tags,
    lastFixMs: r.lastFixMs,
    actions: r.actions,
  } satisfies MatchJson);

const isU32 = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xffff_ffff;

/** An action read back from the file; anything malformed is dropped rather than sent. */
function readAction(v: unknown): Action | null {
  if (typeof v !== "object" || v === null) return null;
  const a = v as Record<string, unknown>;
  if (a["kind"] === "Strike" && isU32(a["nonce"])) return { kind: "Strike", nonce: a["nonce"] };
  if (a["kind"] === "Hint" && isU32(a["nonce"]) && isU32(a["hint"])) {
    const text = a["text"];
    return typeof text === "string"
      ? { kind: "Hint", hint: a["hint"], nonce: a["nonce"], text }
      : { kind: "Hint", hint: a["hint"], nonce: a["nonce"] };
  }
  return null;
}

export function decodeMatchRecord(text: string): MatchRecord {
  const j = JSON.parse(text) as MatchJson;
  return {
    matchId: j.matchId,
    chain: { seq: j.seq, prev: fromHex(j.prev) },
    outbox: j.outbox.map((o) => ({ seq: o.seq, sealed: fromB64(o.sealed) })),
    tags: isU32(j.tags) ? j.tags : 0,
    lastFixMs: Number.isSafeInteger(j.lastFixMs) ? (j.lastFixMs as number) : null,
    actions: Array.isArray(j.actions) ? j.actions.flatMap((a) => readAction(a) ?? []) : [],
  };
}

/** Text files by name. files.ts is the device one; tests use a Map. */
export interface FileStore {
  read(name: string): string | null;
  /** Atomic: a crash leaves the old or the new content, never half of it. */
  write(name: string, text: string): void;
  remove(name: string): void;
}
