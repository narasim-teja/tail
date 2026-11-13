// The log under protocol v2: the relay keeps leaf hashes and the referee's sealed copy of the
// entries, passes each Checkpoint/End's consistency proof to `apply`, refuses a referee answer
// whose proof does not verify, serves inclusion and consistency proofs that the protocol's own
// verifiers accept against the roots the chain anchored, and has the log declassified after End
// from every sealed blob in order.

import { describe, expect, test } from "bun:test";
import {
  decodeLogEntry,
  fromHex,
  merkleLeaf,
  merkleRoot,
  merkleVerify,
  toHex,
  verifyConsistency,
} from "@tail/protocol";
import { MAX_PROOF_LOG } from "../src/routes/proofs.ts";
import { until } from "./fakes.ts";
import { ended, req, setup, started } from "./harness.ts";

const sealed = (n: number) => Buffer.alloc(64, n).toString("base64");

async function playedWithCheckpoint() {
  const env = setup();
  env.referee.checkpointAtTick = 2;
  env.referee.overAt = 4;
  const m = await started(env);
  await req(env, "POST", "/batch", { match_id: m.id, sealed: sealed(1) }, m.a);
  await req(env, "POST", "/batch", { match_id: m.id, sealed: sealed(2) }, m.b);
  await ended(env, m.id);
  const roots = await env.chain.getRoots(m.id);
  return { env, m, roots };
}

describe("apply", () => {
  test("gets a consistency proof for each Checkpoint and End, which the chain checks", async () => {
    const { env, m, roots } = await playedWithCheckpoint();
    expect(env.store.verdicts(m.id).map((v) => v.kind)).toEqual(["Start", "Hint", "Checkpoint", "End"]);
    const sent = env.chain.proofs.flat();
    expect(sent.map((p) => p.seq)).toEqual([3, 4]);
    const cp = roots.checkpoints[0];
    expect(sent[0]?.from_size).toBe("0");
    expect(sent[1]?.from_size).toBe(String(cp?.log_size));
    // The fake chain refuses a Checkpoint/End without a proof from its last anchor; it took both.
    expect(roots.final_root?.log_size).toBeGreaterThan(cp?.log_size ?? Infinity);
  });

  test("a referee answer whose proof does not verify is thrown away before the chain sees it", async () => {
    const env = setup();
    env.referee.checkpointAtTick = 2;
    env.referee.lieAboutProof = true;
    env.referee.overAt = 3;
    const m = await started(env);
    await ended(env, m.id);
    expect(env.store.ticks(m.id).map((t) => t.tick_no)).toEqual([1, 2, 3]);
    expect(env.referee.calls.filter((c) => c === "tick").length).toBe(4);
    expect(env.store.verdicts(m.id).map((v) => v.kind)).toContain("Checkpoint");
  });
});

describe("the log", () => {
  test("is leaves during play, and after End the declassified entries hash to exactly them", async () => {
    const env = setup();
    env.referee.overAt = 1_000_000;
    const m = await started(env);
    await req(env, "POST", "/batch", { match_id: m.id, sealed: sealed(1) }, m.a);
    await until(() => env.store.ticks(m.id).length >= 2, "two ticks");
    expect(env.store.leafCount(m.id)).toBeGreaterThan(0);
    expect(env.store.log(m.id)).toEqual([]);
    env.referee.overAt = 0;
    await ended(env, m.id);
    const leaves = env.store.leaves(m.id);
    expect(env.store.log(m.id).map((e) => toHex(merkleLeaf(decodeLogEntry(e))))).toEqual(leaves.map(toHex));
    // Every sealed blob went back to the referee, in the order it produced them.
    expect(env.referee.declassified).toEqual(env.store.logSealed(m.id));
    expect(env.referee.declassified.length).toBe(env.store.ticks(m.id).length + 2);
  });
});

describe("proof endpoints", () => {
  test("an inclusion proof verifies against the root the chain anchored at that size", async () => {
    const { env, m, roots } = await playedWithCheckpoint();
    const final = roots.final_root as { log_size: number; root: string };
    const leaves = env.store.leaves(m.id);
    for (const i of [0, 3, final.log_size - 1]) {
      const leaf = leaves[i] as Uint8Array;
      const r = await req(
        env,
        "GET",
        `/matches/${m.id}/inclusion?leaf=${toHex(leaf)}&size=${final.log_size}`,
      );
      expect(r.status).toBe(200);
      const p = r.json as { index: number; size: number; path: string[] };
      expect(p.index).toBe(i);
      expect(merkleVerify(leaf, p.index, p.size, p.path.map(fromHex), fromHex(final.root))).toBe(true);
    }
  });

  test("a consistency proof links the anchored checkpoint to End, and size 0 to anything", async () => {
    const { env, m, roots } = await playedWithCheckpoint();
    const cp = roots.checkpoints[0] as { log_size: number; root: string };
    const final = roots.final_root as { log_size: number; root: string };
    const r = await req(env, "GET", `/matches/${m.id}/consistency?from=${cp.log_size}&to=${final.log_size}`);
    expect(r.status).toBe(200);
    const p = r.json as { from: number; to: number; path: string[] };
    expect(p.from).toBe(cp.log_size);
    expect(verifyConsistency(p.from, p.to, fromHex(cp.root), fromHex(final.root), p.path.map(fromHex))).toBe(
      true,
    );
    const zero = await req(env, "GET", `/matches/${m.id}/consistency?from=0&to=${cp.log_size}`);
    expect(zero.json["path"]).toEqual([]);
    expect(verifyConsistency(0, cp.log_size, merkleRoot([]), fromHex(cp.root), [])).toBe(true);
  });

  test("a leaf beyond the asked size, or not in the log, is not found; bad input is refused", async () => {
    const { env, m, roots } = await playedWithCheckpoint();
    const cp = roots.checkpoints[0] as { log_size: number };
    const n = env.store.leafCount(m.id);
    const late = toHex(env.store.leaves(m.id)[n - 1] as Uint8Array);
    const get = (q: string) => req(env, "GET", `/matches/${m.id}/${q}`);
    expect((await get(`inclusion?leaf=${late}&size=${cp.log_size}`)).status).toBe(404);
    expect((await get(`inclusion?leaf=${"00".repeat(32)}&size=${n}`)).status).toBe(404);
    expect((await get(`inclusion?leaf=${late}&size=${n + 1}`)).status).toBe(404);
    expect((await get(`inclusion?leaf=${late.toUpperCase()}&size=${n}`)).status).toBe(400);
    expect((await get(`inclusion?leaf=${late}&size=0`)).status).toBe(400);
    expect((await get(`inclusion?leaf=${late}&size=${MAX_PROOF_LOG + 1}`)).status).toBe(400);
    expect((await get(`inclusion?leaf=${late}&size=1e3`)).status).toBe(400);
    expect((await get(`consistency?from=3&to=2`)).status).toBe(400);
    expect((await get(`consistency?from=-1&to=2`)).status).toBe(400);
    expect((await get(`consistency?from=1&to=${n + 1}`)).status).toBe(404);
    expect((await req(env, "GET", `/matches/${"ff".repeat(16)}/consistency?from=0&to=1`)).status).toBe(404);
  });
});
