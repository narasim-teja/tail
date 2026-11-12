// What the phone must not lose mid-match: the hash chain position and the sealed batches not yet
// acknowledged by the relay. Losing either would break the seq chain the referee enforces. The
// sealed batches are ciphertext to the enclave, so a file is fine; secrets stay in the Keychain.

import { fromHex, toHex } from "@tail/protocol";
import type { ChainState, OutboxItem } from "../game/batch";
import { fromB64, toB64 } from "../lib/b64";

export interface MatchRecord {
  matchId: string;
  chain: ChainState;
  outbox: OutboxItem[];
}

interface MatchJson {
  matchId: string;
  seq: number;
  prev: string;
  outbox: { seq: number; sealed: string }[];
}

export const encodeMatchRecord = (r: MatchRecord): string =>
  JSON.stringify({
    matchId: r.matchId,
    seq: r.chain.seq,
    prev: toHex(r.chain.prev),
    outbox: r.outbox.map((o) => ({ seq: o.seq, sealed: toB64(o.sealed) })),
  } satisfies MatchJson);

export function decodeMatchRecord(text: string): MatchRecord {
  const j = JSON.parse(text) as MatchJson;
  return {
    matchId: j.matchId,
    chain: { seq: j.seq, prev: fromHex(j.prev) },
    outbox: j.outbox.map((o) => ({ seq: o.seq, sealed: fromB64(o.sealed) })),
  };
}

/** Text files by name. files.ts is the device one; tests use a Map. */
export interface FileStore {
  read(name: string): string | null;
  /** Atomic: a crash leaves the old or the new content, never half of it. */
  write(name: string, text: string): void;
  remove(name: string): void;
}
