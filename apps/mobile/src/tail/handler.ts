// The Handler's lines against the referee's log. The referee signs each line it sends a player
// and logs a HintReceipt with SHA256(text) for it, but the receipt reaches the log through the
// relay, which passes it to the next tick. So after End the phone compares: for every line it
// received (kept as hint id and text hash in the match file), the logged receipt with that hint
// id must carry the same hash. The log comes from the relay too, so it counts only if it hashes
// to End's root on NEAR.

import {
  type AnchoredRoot,
  equal,
  type LogEntry,
  merkleLeaf,
  merkleRoot,
  sha256,
  utf8,
} from "@tail/protocol";

/** One Handler line this phone received, as the match file keeps it. */
export interface HandlerLine {
  hintId: number;
  /** SHA256 of the line's UTF-8 text, as the referee hashes it for the receipt. */
  textHash: Uint8Array;
}

export const handlerLine = (hintId: number, text: string): HandlerLine => ({
  hintId,
  textHash: sha256(utf8(text)),
});

export type HandlerCheck =
  /** Every received line whose receipt is in the log matches it; `checked` lines had one. */
  | { kind: "ok"; checked: number }
  /** Hint ids whose logged receipt hashes a different line than the one this phone got. */
  | { kind: "mismatch"; hintIds: number[] }
  /** The log the relay sent does not hash to End's root, so it proves nothing either way. */
  | { kind: "unverified" };

/** Checks `lines` against the HintReceipts in `log`, taken only if it is the log End anchored. */
export function checkHandlerLines(
  lines: readonly HandlerLine[],
  log: readonly LogEntry[],
  root: AnchoredRoot,
): HandlerCheck {
  const size = Number(root.logSize);
  const entries = log.slice(0, size);
  if (entries.length !== size || !equal(merkleRoot(entries.map(merkleLeaf)), root.root))
    return { kind: "unverified" };
  const logged = new Map<number, Uint8Array>();
  for (const e of entries) if (e.kind === "HintReceipt") logged.set(e.hintId, e.textHash);
  const hintIds: number[] = [];
  let checked = 0;
  for (const l of lines) {
    const hash = logged.get(l.hintId);
    if (!hash) continue;
    checked++;
    if (!equal(hash, l.textHash)) hintIds.push(l.hintId);
  }
  return hintIds.length ? { kind: "mismatch", hintIds } : { kind: "ok", checked };
}

/** What Results says about a mismatch; null when there is nothing to say. */
export function handlerProblem(c: HandlerCheck | null): string | null {
  if (c?.kind !== "mismatch") return null;
  const n = c.hintIds.length;
  return `The relay delivered a different Handler line than the referee logged${n > 1 ? ` (${n} lines)` : ""}.`;
}
