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
