// Merkle proofs over a match's log, from the leaf hashes the relay keeps (RFC 6962 leaves; RFC
// 9162 proofs, built with @tail/protocol's merkle helpers). Public, during play too: a leaf hash
// reveals nothing about its entry, and the proofs only matter against a root the referee signed
// (a HUD's `log_size`/`root`) or the contract anchored (a Checkpoint or End).
//
//   GET /matches/:id/inclusion?leaf=<hex>&size=<n>  → {index, size, path: [hex]}
//       the first place `leaf` appears among the first `size` leaves, and its audit path in the
//       tree of that size; 404 if it is not there. verify: merkleVerify(leaf, index, size, path, root)
//   GET /matches/:id/consistency?from=<m>&to=<n>     → {from, to, path: [hex]}
//       the tree of the first m leaves is a prefix of the tree of the first n.
//       verify: verifyConsistency(m, n, rootM, rootN, path)

import { consistencyProof, fromHex, merkleProof, toHex } from "@tail/protocol";
import type { Hono } from "hono";
import type { Store } from "../db.ts";
import { HttpError } from "../errors.ts";
import { field } from "./util.ts";

/**
 * The largest log a proof is built over. A one-hour, twelve-player match logs well under 30 000
 * entries; building a proof hashes about `size` nodes, so the cap bounds what one request costs.
 */
export const MAX_PROOF_LOG = 65_536;

function size(v: string | undefined, name: string, min: 0 | 1): number {
  if (v === undefined || !/^(0|[1-9][0-9]{0,9})$/.test(v))
    throw new HttpError(400, `${name}: a whole number`);
  const n = Number(v);
  if (n < min || n > MAX_PROOF_LOG) throw new HttpError(400, `${name}: from ${min} to ${MAX_PROOF_LOG}`);
  return n;
}

export function proofRoutes(app: Hono, d: { store: Store }) {
  /** The match's leaf count, or 404 if the relay has no such match or fewer than `need` leaves. */
  const logOf = (id: string, need: number) => {
    if (!d.store.match(id)) throw new HttpError(404, "no such match");
    const have = d.store.leafCount(id);
    if (need > have) throw new HttpError(404, `the relay's log of this match has ${have} leaves`);
  };

  app.get("/matches/:id/inclusion", (c) => {
    const id = field.matchId(c.req.param("id"));
    const leafHex = c.req.query("leaf");
    if (!leafHex || !/^[0-9a-f]{64}$/.test(leafHex))
      throw new HttpError(400, "leaf: 64 lowercase hex characters");
    const n = size(c.req.query("size"), "size", 1);
    logOf(id, n);
    const index = d.store.leafIndex(id, fromHex(leafHex), n);
    if (index === undefined) throw new HttpError(404, `that leaf is not in the first ${n} leaves`);
    return c.json({ index, size: n, path: merkleProof(d.store.leaves(id, n), index).map(toHex) });
  });

  app.get("/matches/:id/consistency", (c) => {
    const id = field.matchId(c.req.param("id"));
    const from = size(c.req.query("from"), "from", 0);
    const to = size(c.req.query("to"), "to", 1);
    if (from > to) throw new HttpError(400, "from: at most to");
    logOf(id, to);
    return c.json({ from, to, path: consistencyProof(d.store.leaves(id, to), from).map(toHex) });
  });
}
