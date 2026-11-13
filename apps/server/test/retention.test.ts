// Retention (src/retention.ts): a private match's sealed batches and trails are deleted a window
// after End, a public match's are kept, a match from before the relay kept public_replay is looked
// up on chain, and a purged private replay answers 410. A purge by id refuses a running match.

import { describe, expect, test } from "bun:test";
import { sha256 } from "@tail/protocol";
import { ended, req, setup, started } from "./harness.ts";

const WINDOW = 24 * 3_600_000;

async function endedMatch(env: ReturnType<typeof setup>, publicReplay: boolean) {
  const m = await started(env, { public_replay: publicReplay });
  const b = new Uint8Array(64).fill(publicReplay ? 1 : 2);
  env.store.enqueueBatch(m.id, 0, b, sha256(b), Date.now());
  await ended(env, m.id);
  expect(env.store.allBatches(m.id).length).toBe(1);
  expect(env.store.trails(m.id).length).toBe(1);
  return m;
}

describe("retention", () => {
  test("a private match's batches and trails go a window after End, once", async () => {
    let now = Date.now();
    const env = setup({ now: () => now, retentionMs: WINDOW });
    const priv = await endedMatch(env, false);
    expect(await env.retention.sweep()).toEqual([]);
    now += WINDOW + 60_000;
    expect(await env.retention.sweep()).toEqual([priv.id]);
    expect(env.store.allBatches(priv.id)).toEqual([]);
    expect(env.store.trails(priv.id)).toEqual([]);
    expect(env.store.match(priv.id)?.purged_ms).toBe(now);
    // Once is enough.
    expect(await env.retention.sweep()).toEqual([]);
  });

  test("a public match keeps its trails past the window", async () => {
    let now = Date.now();
    const env = setup({ now: () => now, retentionMs: WINDOW });
    const pub = await endedMatch(env, true);
    now += WINDOW * 10;
    expect(await env.retention.sweep()).toEqual([]);
    expect(env.store.trails(pub.id).length).toBe(1);
    expect((await req(env, "GET", `/replay/${pub.id}`)).status).toBe(200);
  });

  test("a match from before the relay kept public_replay is looked up on chain", async () => {
    let now = Date.now();
    const env = setup({ now: () => now, retentionMs: WINDOW });
    const priv = await endedMatch(env, false);
    env.store.db.query("UPDATE matches SET public_replay = NULL WHERE match_id = ?").run(priv.id);
    now += WINDOW + 60_000;
    expect(await env.retention.sweep()).toEqual([priv.id]);
    expect(env.store.match(priv.id)?.public_replay).toBe(0);
  });

  test("a purged private replay answers 410 to its players", async () => {
    const env = setup();
    const priv = await endedMatch(env, false);
    env.retention.purge(priv.id);
    expect((await req(env, "GET", `/replay/${priv.id}`)).status).toBe(410);
  });

  test("a purge by id works now, public or private, but not on a match still being played", async () => {
    const env = setup();
    env.referee.overAt = 1_000_000;
    const running = await started(env);
    expect(() => env.retention.purge(running.id)).toThrow("is running");
    env.referee.overAt = 0;
    await ended(env, running.id);
    expect(env.retention.purge(running.id)).toEqual({ batches: 0, trails: 0 });
    expect(env.store.match(running.id)?.purged_ms).not.toBeNull();
  });
});
