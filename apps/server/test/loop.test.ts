// The tick loop across restarts and processes: a Start the last run left unfinished reopens its
// lobby, a second relay on the same database never ticks a match the first holds (and takes over
// when it stops), a write after the lease was lost stores nothing, and a tick's verdicts go on
// chain right after it rather than a tick later.

import { describe, expect, test } from "bun:test";
import { decodeLogEntry } from "@tail/protocol";
import { Store } from "../src/db.ts";
import { LEASE_MS, RECEIPT_WINDOW_MS, VOICE_WINDOW_MS } from "../src/matches.ts";
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

describe("voice", () => {
  const voices = (env: ReturnType<typeof setup>) => env.referee.calls.filter((c) => c === "voice").length;
  /** The Handler messages the asker (player 0) is sent. */
  const lines = (env: ReturnType<typeof setup>, matchId: string) => {
    const got: string[] = [];
    env.hub.subscribe(matchId, 0, {
      send: (t: string) => {
        if ((JSON.parse(t) as { type: string }).type === "handler") got.push(t);
      },
    });
    return got;
  };
  /** A stepped relay whose hint (tick 1) is voiced only once `gate` opens. */
  const slowHandler = async (over: Parameters<typeof setup>[0] = {}) => {
    const env = setup({ tickMs: 60_000, ...over });
    env.matches.stop();
    env.referee.hintAtTick = 1;
    env.referee.overAt = 6;
    const gate = Promise.withResolvers<void>();
    env.referee.voiceGate = gate.promise;
    const m = await started(env);
    return { env, m, gate, got: lines(env, m.id) };
  };

  test("the voice window leaves headroom inside the referee's receipt window", async () => {
    const lib = await Bun.file(new URL("../../../crates/referee-core/src/lib.rs", import.meta.url)).text();
    const rust = /pub const RECEIPT_WINDOW_MS: u64 = ([\d_]+);/.exec(lib)?.[1];
    expect(Number(rust?.replaceAll("_", ""))).toBe(RECEIPT_WINDOW_MS);
    expect(VOICE_WINDOW_MS).toBeLessThan(RECEIPT_WINDOW_MS);
  });

  test("a line stored while a tick is in flight goes to the next tick, and only it is consumed then", async () => {
    const { env, m, gate } = await slowHandler();
    expect(await env.matches.step(m.id)).toBe(true);
    // Tick 2 is held at the referee; the line is stored meanwhile.
    const tick = env.referee.tick.bind(env.referee);
    const held = Promise.withResolvers<void>();
    let entered = false;
    env.referee.tick = async (i) => {
      entered = true;
      await held.promise;
      return tick(i);
    };
    const s = env.matches.step(m.id);
    await until(() => entered, "tick 2 in flight");
    gate.resolve();
    await until(() => env.store.voiceHints(m.id, "voiced").length === 1, "the line stored mid-tick");
    held.resolve();
    expect(await s).toBe(true);
    env.referee.tick = tick;
    // Tick 2 did not carry the receipt, so it must not have marked it consumed.
    expect(env.store.voiceHints(m.id, "voiced").length).toBe(1);
    expect(await env.matches.step(m.id)).toBe(true);
    expect(env.referee.ticksSeen.map((t) => t.receipts)).toEqual([0, 0, 1]);
    expect(env.store.voiceHints(m.id, "consumed").length).toBe(1);
  });

  test("a hint dropped while its voice runs stays dropped, and its line is not sent", async () => {
    const { env, m, gate, got } = await slowHandler();
    expect(await env.matches.step(m.id)).toBe(true);
    await until(() => voices(env) === 1, "the voice call");
    const [h] = env.store.voiceHints(m.id, "pending");
    env.store.setVoiceStatus([h?.id as number], "dropped");
    gate.resolve();
    // To End, which waits for the worker: by then its answer has been handled.
    while (await env.matches.step(m.id));
    expect(env.store.voiceHints(m.id, "dropped").length).toBe(1);
    expect(got).toEqual([]);
    expect(env.referee.ticksSeen.every((t) => t.receipts === 0)).toBe(true);
    expect(env.store.log(m.id).some((e) => decodeLogEntry(e).kind === "HintReceipt")).toBe(false);
    expect(voices(env)).toBe(1);
  });

  test("a line that comes back too late for the referee's receipt window is dropped, not sent", async () => {
    const clock = { ms: Date.now() };
    const { env, m, gate, got } = await slowHandler({ now: () => clock.ms });
    expect(await env.matches.step(m.id)).toBe(true);
    await until(() => voices(env) === 1, "the voice call");
    clock.ms += VOICE_WINDOW_MS + 1;
    gate.resolve();
    await until(() => env.store.voiceHints(m.id, "dropped").length === 1, "the hint dropped");
    expect(await env.matches.step(m.id)).toBe(true);
    expect(got).toEqual([]);
    expect(env.referee.ticksSeen.map((t) => t.receipts)).toEqual([0, 0]);
    expect(voices(env)).toBe(1);
  });

  test("a slow Handler holds up no tick, its receipt goes to the first tick after it, and no hint is voiced twice", async () => {
    const env = setup({ tickMs: 60_000 });
    env.matches.stop();
    env.referee.hintAtTick = 1;
    env.referee.overAt = 6;
    const gate = Promise.withResolvers<void>();
    env.referee.voiceGate = gate.promise;
    const m = await started(env);
    // Tick 1 issues the hint and its voice starts; ticks 2 and 3 run while it hangs.
    for (let k = 0; k < 3; k++) expect(await env.matches.step(m.id)).toBe(true);
    expect(env.referee.ticksSeen.map((t) => t.receipts)).toEqual([0, 0, 0]);
    expect(voices(env)).toBe(1);
    gate.resolve();
    await until(() => env.store.voiceHints(m.id, "voiced").length === 1, "the line to be stored");
    expect(await env.matches.step(m.id)).toBe(true);
    expect(env.referee.ticksSeen.map((t) => t.receipts)).toEqual([0, 0, 0, 1]);
    // Logged once, voiced once, through to End.
    while (await env.matches.step(m.id));
    expect(env.store.match(m.id)?.phase).toBe("ended");
    expect(env.referee.ticksSeen.map((t) => t.receipts)).toEqual([0, 0, 0, 1, 0, 0]);
    expect(voices(env)).toBe(1);
    expect(env.store.voiceHints(m.id, "consumed").length).toBe(1);
  });

  test("a voice still running when the match ends is waited for, and its receipt goes to `end`", async () => {
    const env = setup({ tickMs: 60_000 });
    env.matches.stop();
    env.referee.hintAtTick = 1;
    env.referee.overAt = 2;
    const gate = Promise.withResolvers<void>();
    env.referee.voiceGate = gate.promise;
    const m = await started(env);
    expect(await env.matches.step(m.id)).toBe(true);
    // Tick 2 ends the match; `end` waits for the line rather than dropping a paid hint.
    const last = env.matches.step(m.id);
    await until(() => env.referee.ticksSeen.length === 2, "the last tick");
    expect(env.referee.calls).not.toContain("end");
    gate.resolve();
    expect(await last).toBe(false);
    expect(env.referee.ticksSeen.map((t) => t.receipts)).toEqual([0, 0]);
    expect(env.store.log(m.id).some((e) => decodeLogEntry(e).kind === "HintReceipt")).toBe(true);
    expect(voices(env)).toBe(1);
    expect(env.store.voiceHints(m.id, "consumed").length).toBe(1);
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
