import { describe, expect, test } from "bun:test";
import { fakeTime } from "../../test/fake-time";
import type { OutboxItem } from "./batch";
import { backoffMs, OFFLINE_CARRY_MS, Outbox, Uploader } from "./outbox";
import { RelayError } from "./relay";

const item = (seq: number): OutboxItem => ({
  seq,
  sealed: Uint8Array.of(seq),
  hash: new Uint8Array(32).fill(seq + 1),
  actions: [],
  sentMs: null,
  resent: false,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

function rig(items: number[], send: (it: OutboxItem) => Promise<void>) {
  const t = fakeTime(1_000_000);
  const outbox = new Outbox(items.map(item));
  const sent: number[] = [];
  const up = new Uploader({ outbox, send, onSent: (it) => sent.push(it.seq), now: t.now, timers: t.timers });
  return { t, outbox, sent, up };
}

describe("outbox order", () => {
  test("refuses a seq gap when pushing or loading", () => {
    const o = new Outbox([item(3), item(4)]);
    expect(() => o.push(item(6))).toThrow();
    expect(() => new Outbox([item(1), item(3)])).toThrow("seq gap");
  });

  test("loads out-of-order items sorted by seq", () => {
    expect(new Outbox([item(2), item(1)]).all()[0]?.seq).toBe(1);
  });

  test("a batch the relay took stays until the referee confirms it", () => {
    const o = new Outbox([item(0), item(1), item(2)]);
    expect(o.markSent(item(0).hash, 5)?.seq).toBe(0);
    expect(o.markSent(item(0).hash, 6)).toBeNull();
    expect(o.length).toBe(3);
    expect(o.nextUnsent()?.seq).toBe(1);
    expect(o.confirm(1).map((x) => x.seq)).toEqual([0]);
    expect(o.all().map((x) => x.seq)).toEqual([1, 2]);
  });

  test("resending from a seq marks it and every later batch unsent again", () => {
    const o = new Outbox([item(0), item(1), item(2)]);
    for (const it of o.all()) o.markSent(it.hash, 1);
    o.resendFrom(1);
    expect(o.all().map((x) => [x.seq, x.sentMs, x.resent])).toEqual([
      [0, 1, false],
      [1, null, true],
      [2, null, false],
    ]);
  });
});

describe("uploader", () => {
  test("sends one batch at a time, oldest first, and waits for each answer", async () => {
    const asked: number[] = [];
    let release: (() => void) | undefined;
    const r = rig([0, 1, 2], (it) => {
      asked.push(it.seq);
      return new Promise<void>((res) => {
        release = res;
      });
    });
    r.up.kick();
    r.up.kick();
    await flush();
    expect(asked).toEqual([0]);
    release?.();
    await flush();
    expect(asked).toEqual([0, 1]);
    release?.();
    await flush();
    release?.();
    await flush();
    expect(r.sent).toEqual([0, 1, 2]);
    expect(r.outbox.length).toBe(3);
    expect(r.up.state.kind).toBe("idle");
  });

  test("retries the same batch after a failure and never skips it", async () => {
    const asked: number[] = [];
    let fails = 2;
    const r = rig([0, 1], async (it) => {
      asked.push(it.seq);
      if (it.seq === 0 && fails-- > 0) throw new RelayError(null, "Can't reach the relay.");
    });
    r.up.kick();
    await flush();
    expect(r.up.state).toMatchObject({ kind: "waiting", seq: 0 });
    r.t.advance(backoffMs(1));
    await flush();
    r.t.advance(backoffMs(2));
    await flush();
    expect(asked).toEqual([0, 0, 0, 1]);
    expect(r.sent).toEqual([0, 1]);
  });

  test("backoff doubles from one second and stops growing at fifteen", () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
  });

  test("counts as offline only after the relay has been unreachable for twenty seconds", async () => {
    const r = rig([0], async () => {
      throw new RelayError(null, "Can't reach the relay.");
    });
    r.up.kick();
    await flush();
    expect(r.up.offline()).toBe(false);
    r.t.advance(OFFLINE_CARRY_MS);
    await flush();
    expect(r.up.offline()).toBe(true);
  });

  test("a refusal from the relay is contact, so it does not count as offline", async () => {
    const r = rig([0], async () => {
      throw new RelayError(429, "too many batches waiting");
    });
    r.up.kick();
    r.t.advance(OFFLINE_CARRY_MS + 1);
    await flush();
    expect(r.up.offline()).toBe(false);
    expect(r.up.state).toMatchObject({ kind: "waiting", error: "too many batches waiting" });
  });

  test("stops when the relay says the match is no longer running, or a batch is too large", async () => {
    for (const status of [409, 413]) {
      const r = rig([0, 1], async () => {
        throw new RelayError(status, "no");
      });
      r.up.kick();
      await flush();
      expect(r.up.state).toEqual({ kind: "stopped", error: "no" });
      expect(r.outbox.length).toBe(2);
    }
  });

  test("a batch delivered by the mesh counts once and is not sent over HTTP", async () => {
    const asked: number[] = [];
    const r = rig([0, 1], async (it) => {
      asked.push(it.seq);
    });
    r.up.delivered(item(0).hash);
    r.up.delivered(item(0).hash);
    r.up.delivered(new Uint8Array(32).fill(99));
    r.up.kick();
    await flush();
    expect(asked).toEqual([1]);
    expect(r.sent).toEqual([0, 1]);
  });

  test("an HTTP send that lands after the mesh delivered the same batch is not counted again", async () => {
    let release: (() => void) | undefined;
    const r = rig([0], () => new Promise<void>((res) => (release = res)));
    r.up.kick();
    await flush();
    r.up.delivered(item(0).hash);
    release?.();
    await flush();
    expect(r.sent).toEqual([0]);
  });

  test("a request the relay has already seen is the batch being there, not the match ending", async () => {
    const r = rig([0, 1], async (it) => {
      if (it.seq === 0) throw new RelayError(409, "request already seen", { error: "request already seen" });
    });
    r.up.kick();
    await flush();
    expect(r.sent).toEqual([0, 1]);
    expect(r.up.state.kind).toBe("idle");
  });
});
