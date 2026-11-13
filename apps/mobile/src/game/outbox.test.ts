import { describe, expect, test } from "bun:test";
import { fakeTime } from "../../test/fake-time";
import { RelayError } from "../relay/client";
import type { OutboxItem } from "./batch";
import { backoffMs, OFFLINE_CARRY_MS, Outbox, Uploader } from "./outbox";

const item = (seq: number): OutboxItem => ({ seq, sealed: Uint8Array.of(seq) });
const flush = () => new Promise((r) => setTimeout(r, 0));

function rig(items: number[], send: (it: OutboxItem) => Promise<void>) {
  const t = fakeTime(1_000_000);
  const outbox = new Outbox(items.map(item));
  const acked: number[] = [];
  const up = new Uploader({ outbox, send, onAck: (s) => acked.push(s), now: t.now, timers: t.timers });
  return { t, outbox, acked, up };
}

describe("outbox order", () => {
  test("refuses a seq gap when pushing or loading", () => {
    const o = new Outbox([item(3), item(4)]);
    expect(() => o.push(item(6))).toThrow();
    expect(() => new Outbox([item(1), item(3)])).toThrow("seq gap");
  });

  test("loads out-of-order items sorted by seq", () => {
    expect(new Outbox([item(2), item(1)]).head()?.seq).toBe(1);
  });

  test("only the head can be acknowledged", () => {
    const o = new Outbox([item(0), item(1)]);
    expect(() => o.ack(1)).toThrow();
    o.ack(0);
    expect(o.head()?.seq).toBe(1);
  });
});

describe("uploader", () => {
  test("sends one batch at a time, oldest first, and waits for each answer", async () => {
    const sent: number[] = [];
    let release: (() => void) | undefined;
    const r = rig([0, 1, 2], (it) => {
      sent.push(it.seq);
      return new Promise<void>((res) => {
        release = res;
      });
    });
    r.up.kick();
    r.up.kick();
    await flush();
    expect(sent).toEqual([0]);
    release?.();
    await flush();
    expect(sent).toEqual([0, 1]);
    release?.();
    await flush();
    release?.();
    await flush();
    expect(r.acked).toEqual([0, 1, 2]);
    expect(r.up.state.kind).toBe("idle");
  });

  test("retries the same batch after a failure and never skips it", async () => {
    const sent: number[] = [];
    let fails = 2;
    const r = rig([0, 1], async (it) => {
      sent.push(it.seq);
      if (it.seq === 0 && fails-- > 0) throw new RelayError(null, "Can't reach the relay.");
    });
    r.up.kick();
    await flush();
    expect(r.up.state).toMatchObject({ kind: "waiting", seq: 0 });
    r.t.advance(backoffMs(1));
    await flush();
    r.t.advance(backoffMs(2));
    await flush();
    expect(sent).toEqual([0, 0, 0, 1]);
    expect(r.acked).toEqual([0, 1]);
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

  test("stops when the relay says the match is no longer running", async () => {
    const r = rig([0, 1], async () => {
      throw new RelayError(409, "match is ended");
    });
    r.up.kick();
    await flush();
    expect(r.up.state).toEqual({ kind: "stopped", error: "match is ended" });
    expect(r.outbox.length).toBe(2);
  });

  test("stops when the relay says a batch is too large, since every later batch chains to it", async () => {
    const r = rig([0, 1], async () => {
      throw new RelayError(413, "That was too big for the relay to take.");
    });
    r.up.kick();
    await flush();
    expect(r.up.state).toEqual({ kind: "stopped", error: "That was too big for the relay to take." });
    expect(r.outbox.length).toBe(2);
  });

  test("a batch delivered by the mesh leaves the queue and is not sent again", async () => {
    const sent: number[] = [];
    const r = rig([0, 1], async (it) => {
      sent.push(it.seq);
    });
    r.up.delivered(0);
    r.up.delivered(5);
    r.up.kick();
    await flush();
    expect(sent).toEqual([1]);
    expect(r.acked).toEqual([0, 1]);
  });
});
