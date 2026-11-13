// The tick loop across restarts and processes: a Start the last run left unfinished reopens its
// lobby, a second relay on the same database never ticks a match the first holds (and takes over
// when it stops), a write after the lease was lost stores nothing, and a tick's verdicts go on
// chain right after it rather than a tick later.

import { describe, expect, test } from "bun:test";
import { Store } from "../src/db.ts";
import { LEASE_MS } from "../src/matches.ts";
import { FakeChain, FakeReferee, until } from "./fakes.ts";
import { appliedSeqs, ended, lobby, req, setup, started } from "./harness.ts";

describe("boot", () => {
  test("a Start the relay never finished reopens its lobby, and the host can start again", async () => {
    const store = new Store(":memory:");
    const chain = new FakeChain();
    const first = setup({ store, chain });
    const l = await lobby(first);
    // The process died after claiming the start, before the referee's answer was stored.
    expect(store.claimPhase(l.id, "lobby", "starting")).toBe(true);
    first.matches.stop();

    // The same referee behind the restarted relay: it still holds every device.
    const next = setup({ store, chain, referee: first.referee });
    next.matches.resume();
    const m = store.match(l.id);
    expect(m?.phase).toBe("lobby");
    expect(m?.error).toBe("the relay restarted during Start; press Start again");
    expect((await req(next, "POST", `/matches/${l.id}/start`, {}, l.a)).status).toBe(200);
  });

  test("a Start whose lease a dead process still held reopens once that lease runs out", async () => {
    const store = new Store(":memory:");
    const chain = new FakeChain();
    const first = setup({ store, chain });
    const l = await lobby(first);
    expect(store.claimPhase(l.id, "lobby", "starting")).toBe(true);
    // The crashed process's lease has 100 ms left when the relay boots again.
    expect(store.holdLease(l.id, "dead-process", Date.now() - LEASE_MS + 100, LEASE_MS)).toBe(true);
    first.matches.stop();

    const next = setup({ store, chain, referee: first.referee });
    next.matches.resume();
    expect(store.match(l.id)?.phase).toBe("starting");
    await until(() => store.match(l.id)?.phase === "lobby", "the lobby to reopen after the lease");
    expect((await req(next, "POST", `/matches/${l.id}/start`, {}, l.a)).status).toBe(200);
  });

  test("a Start another live process is running is left alone", async () => {
    const store = new Store(":memory:");
    const chain = new FakeChain();
    const first = setup({ store, chain });
    const l = await lobby(first);
    expect(store.claimPhase(l.id, "lobby", "starting")).toBe(true);
    expect(store.holdLease(l.id, first.matches.holder, Date.now(), LEASE_MS)).toBe(true);

    setup({ store, chain }).matches.resume();
    expect(store.match(l.id)?.phase).toBe("starting");
  });
});

describe("leases", () => {
  test("a second relay on one database does not tick a match the first holds, and takes over when it stops", async () => {
    const store = new Store(":memory:");
    const chain = new FakeChain();
    const referee = new FakeReferee();
    referee.overAt = 8;
    referee.tickDelayMs = 2;
    const first = setup({ store, chain, referee });
    const m = await started(first);
    const second = setup({ store, chain, referee });
    second.matches.resume();
    await until(() => store.ticks(m.id).length >= 3, "three ticks by the first relay");
    // Both loops are scheduled; only one ever has a referee call in flight.
    expect(referee.maxInFlight).toBe(1);
    first.matches.stop();
    await ended(second, m.id);
    expect(store.ticks(m.id).map((t) => t.tick_no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(referee.maxInFlight).toBe(1);
    expect(appliedSeqs(second)).toEqual([1, 2, 3]);
  });

  test("a tick whose lease was taken meanwhile stores nothing", async () => {
    const env = setup({ tickMs: 60_000 });
    env.referee.overAt = 1_000_000;
    env.referee.tickDelayMs = 50;
    const m = await started(env);
    await until(() => env.referee.inFlight, "the first tick to be under way");
    // Another process takes the match while this one waits for the referee.
    env.store.db
      .query("UPDATE leases SET holder = 'other', expires_ms = ? WHERE match_id = ?")
      .run(Date.now() + LEASE_MS, m.id);
    await until(
      () => env.referee.calls.filter((c) => c === "tick").length && !env.referee.inFlight,
      "the tick",
    );
    await Bun.sleep(20);
    expect(env.store.ticks(m.id)).toEqual([]);
    expect(env.store.match(m.id)?.tick_no).toBe(0);
  });
});

describe("verdicts", () => {
  test("a tick's verdicts are applied right after it, not a tick later", async () => {
    const env = setup({ tickMs: 60_000 });
    env.referee.overAt = 1_000_000;
    env.referee.hintAtTick = 1;
    const m = await started(env);
    await until(() => appliedSeqs(env).length === 2, "the Hint to be applied");
    expect(env.referee.calls.filter((c) => c === "tick").length).toBe(1);
    expect(env.store.pendingVerdicts(m.id)).toEqual([]);
  });
});

describe("finality", () => {
  /** A relay whose loop the test steps itself. */
  function stepped() {
    const env = setup({ tickMs: 60_000 });
    env.matches.stop();
    const steps = async (id: string) => {
      for (let k = 0; k < 20; k++) if (!(await env.matches.step(id))) return true;
      return false;
    };
    return { env, steps };
  }

  test("a verdict seen only in an optimistic block that is then dropped is sent again", async () => {
    const { env, steps } = stepped();
    // Start lands in a block that optimistic reads show and the chain then drops.
    env.chain.nextApplyUnfinal = true;
    const m = await started(env);
    expect((await env.chain.getMatch(m.id))?.seq).toBe(1);
    expect((await env.chain.getMatch(m.id, "final"))?.seq).toBe(0);
    env.chain.dropUnfinal();
    // The relay never counted Start as applied, so it sends it again and the match goes on.
    expect(await steps(m.id)).toBe(true);
    expect(env.store.match(m.id)?.phase).toBe("ended");
    expect(appliedSeqs(env)).toEqual([1, 2, 3]);
    expect(env.store.pendingVerdicts(m.id)).toEqual([]);
  });

  test("the reveal waits until End is final", async () => {
    const { env } = stepped();
    env.referee.overAt = 1;
    const m = await started(env);
    // Tick 1 is over and has no verdict; End goes out in an optimistic block.
    env.chain.nextApplyUnfinal = true;
    expect(await env.matches.step(m.id)).toBe(true);
    expect(env.store.match(m.id)?.phase).toBe("ending");
    expect(env.store.verdicts(m.id).at(-1)?.kind).toBe("End");
    expect(env.store.match(m.id)?.reveal).toBeNull();
    env.chain.dropUnfinal();
    // The next step sends End again and, once it is final, declassifies the match.
    expect(await env.matches.step(m.id)).toBe(false);
    expect(env.store.match(m.id)?.phase).toBe("ended");
    expect(appliedSeqs(env).at(-1)).toBe(2);
  });
});

describe("end", () => {
  test("a lost end answer: the next step gets the same End back, a hint the Handler missed dropped first", async () => {
    const env = setup({ tickMs: 60_000 });
    env.matches.stop();
    // The last tick issues a hint; the Handler misses it, and end's answer is lost.
    env.referee.overAt = 2;
    env.referee.hintAtTick = 2;
    env.referee.failVoices = 1;
    env.referee.loseNextEndAnswer = true;
    const m = await started(env);
    expect(await env.matches.step(m.id)).toBe(true);
    await expect(env.matches.step(m.id)).rejects.toThrow("the answer was lost");
    expect(env.store.match(m.id)?.phase).toBe("ending");
    // No special case: the next step asks again and settles the match.
    expect(await env.matches.step(m.id)).toBe(false);
    expect(env.store.match(m.id)?.phase).toBe("ended");
    const calls = env.referee.calls;
    expect(calls.filter((c) => c === "end").length).toBe(2);
    // Nothing was voiced after End: that line would have had no receipt in the log.
    expect(calls.slice(calls.indexOf("end"))).not.toContain("voice");
    expect(env.store.voiceHints(m.id, "dropped").length).toBe(1);
    expect(appliedSeqs(env)).toEqual([1, 2, 3]);
  });
});

describe("intake", () => {
  const sealed = (n: number) => Buffer.alloc(64, n).toString("base64");

  test("a batch sent while the tick that ends the match runs is refused, not acknowledged", async () => {
    const env = setup({ tickMs: 60_000 });
    env.matches.stop();
    env.referee.overAt = 1;
    env.referee.tickDelayMs = 50;
    const m = await started(env);
    const step = env.matches.step(m.id);
    await until(() => env.referee.inFlight, "the last tick to be under way");
    // `end` takes no batches, so this one could never reach the referee: the phone hears so.
    const r = await req(env, "POST", "/batch", { match_id: m.id, sealed: sealed(1) }, m.b);
    expect(r.status).toBe(409);
    expect(r.json["error"]).toBe("match is ending");
    expect(await step).toBe(false);
    expect(env.store.allBatches(m.id)).toEqual([]);
  });

  test("a batch sent while a tick runs is acknowledged once that tick is stored, and goes in the next", async () => {
    const env = setup({ tickMs: 60_000 });
    env.matches.stop();
    env.referee.overAt = 3;
    env.referee.tickDelayMs = 50;
    const m = await started(env);
    const step = env.matches.step(m.id);
    await until(() => env.referee.inFlight, "tick 1 to be under way");
    const r = await req(env, "POST", "/batch", { match_id: m.id, sealed: sealed(2) }, m.b);
    expect(r.status).toBe(200);
    expect(r.json["queued"]).toBe(true);
    // Answered after tick 1 was stored, which did not carry it.
    expect(env.store.match(m.id)?.tick_no).toBe(1);
    expect(env.referee.ticksSeen[0]?.batches).toBe(0);
    await step;
    await env.matches.step(m.id);
    expect(env.referee.ticksSeen[1]?.batches).toBe(1);
  });
});
