// Retention (src/retention.ts): a private match's record of where and how it was played (sealed
// batches and state, trails, log, zone, HUDs, Handler lines) is deleted a window after End, a
// public match's is kept, a failed match's goes too, a match from before the relay kept
// public_replay is looked up on chain, and a purged private replay answers 410. A purge by id
// refuses a running match.

import { describe, expect, test } from "bun:test";
import { sha256 } from "@tail/protocol";
import { ended, lobby, req, setup, started } from "./harness.ts";

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
    expect(env.store.log(priv.id)).toEqual([]);
    expect(env.store.voiceHints(priv.id, "answered")).toEqual([]);
    expect(env.store.hud(priv.id, 0)).toBeUndefined();
    const m = env.store.match(priv.id);
    expect(m?.zone).toBeNull();
    expect(m?.state).toBeNull();
    expect(m?.purged_ms).toBe(now);
    // The leaves stay: proofs against the anchored roots still work.
    expect(env.store.leaves(priv.id).length).toBeGreaterThan(0);
    // The players' zone view no longer shows where they played.
    expect((await req(env, "GET", `/matches/${priv.id}/zone`, undefined, priv.a)).json["zone"]).toBeNull();
    // Once is enough.
    expect(await env.retention.sweep()).toEqual([]);
  });

  test("a failed match goes a window after it was made, public or not", async () => {
    let now = Date.now();
    const env = setup({ now: () => now, retentionMs: WINDOW });
    const l = await lobby(env, { public_replay: true });
    env.referee.refuseStart = true;
    expect((await req(env, "POST", `/matches/${l.id}/start`, {}, l.a)).status).toBe(502);
    expect(env.store.match(l.id)?.phase).toBe("failed");
    expect(await env.retention.sweep()).toEqual([]);
    now += WINDOW + 60_000;
    expect(await env.retention.sweep()).toEqual([l.id]);
    expect(env.store.match(l.id)?.zone).toBeNull();
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
    expect(env.retention.purge(running.id)).toMatchObject({ batches: 0, trails: 0 });
    expect(env.store.match(running.id)?.purged_ms).not.toBeNull();
  });
});
