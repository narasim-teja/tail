// What the phone must not lose mid-match: the hash chain position, the batches the referee has
// not confirmed yet (sent or not), and where the referee's chain last stood. Losing them would
// cost reports; the chain itself is rebuilt from the next signed HUD if it has to be
// (proximity/chain.ts). Beside them: every report the relay took (seq and batch hash, for the
// inclusion receipts after the match), the referee's tag count, the newest fix time (so fixes
// stay in order after a relaunch) and strikes or hints not yet inside a committed batch. Sealed
// batches are ciphertext to the enclave and hashes reveal nothing, so a file is fine; secrets
// stay in the Keychain.

import { type Action, fromHex, toHex } from "@tail/protocol";
import { fromB64, toB64 } from "../lib/b64";
import { genesis, type OutboxItem } from "../proximity/batch";
import { unconfirmed } from "../proximity/chain";
import type { HuntRecord } from "../tail/hunt";

export interface MatchRecord extends HuntRecord {
  matchId: string;
}

/** Version 2: protocol v2 (signed HUDs, chain recovery, receipts). */
const VERSION = 2;

interface ItemJson {
  seq: number;
  sealed: string;
  hash: string;
  actions: Action["kind"][];
  sentMs: number | null;
  resent: boolean;
}

interface MatchJson {
  v?: number;
  matchId: string;
  seq: number;
  prev: string;
  outbox: ItemJson[];
  confirmed?: { nextSeq: number; tip: string };
  reports?: { seq: number; hash: string; code?: number }[];
  hudTick?: number;
  tags?: number;
  lastFixMs?: number | null;
  actions?: Action[];
}

export const emptyRecord = (matchId: string): MatchRecord => ({
  matchId,
  chain: genesis(),
  outbox: [],
  confirmed: unconfirmed(),
  reports: [],
  hudTick: 0,
  tags: 0,
  lastFixMs: null,
  actions: [],
});

const itemJson = (o: OutboxItem): ItemJson => ({
  seq: o.seq,
  sealed: toB64(o.sealed),
  hash: toHex(o.hash),
  actions: o.actions,
  sentMs: o.sentMs,
  resent: o.resent,
});

export const encodeMatchRecord = (r: MatchRecord): string =>
  JSON.stringify({
    v: VERSION,
    matchId: r.matchId,
    seq: r.chain.seq,
    prev: toHex(r.chain.prev),
    outbox: r.outbox.map(itemJson),
    confirmed: { nextSeq: r.confirmed.nextSeq, tip: toHex(r.confirmed.tip) },
    reports: r.reports.map((x) => ({
      seq: x.seq,
      hash: toHex(x.hash),
      ...(x.code === undefined ? {} : { code: x.code }),
    })),
    hudTick: r.hudTick,
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

const KINDS: readonly string[] = ["Hint", "Strike"];

function readItem(o: ItemJson): OutboxItem {
  return {
    seq: o.seq,
    sealed: fromB64(o.sealed),
    hash: fromHex(o.hash),
    actions: Array.isArray(o.actions) ? o.actions.filter((k) => KINDS.includes(k)) : [],
    sentMs: Number.isSafeInteger(o.sentMs) ? o.sentMs : null,
    resent: o.resent === true,
  };
}

export function decodeMatchRecord(text: string): MatchRecord {
  const j = JSON.parse(text) as MatchJson;
  // A file from before version 2 holds batches without their hashes, which no HUD can confirm.
  // They are dropped; the first HUD puts the chain where the referee has it.
  const v2 = j.v === VERSION;
  return {
    matchId: j.matchId,
    chain: { seq: j.seq, prev: fromHex(j.prev) },
    outbox: v2 ? j.outbox.map(readItem) : [],
    confirmed:
      v2 && j.confirmed ? { nextSeq: j.confirmed.nextSeq, tip: fromHex(j.confirmed.tip) } : unconfirmed(),
    reports:
      v2 && Array.isArray(j.reports)
        ? j.reports.map((x) => ({
            seq: x.seq,
            hash: fromHex(x.hash),
            ...(isU32(x.code) ? { code: x.code } : {}),
          }))
        : [],
    hudTick: isU32(j.hudTick) ? j.hudTick : 0,
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
