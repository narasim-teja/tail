import { describe, expect, test } from "bun:test";
import {
  consistencyProof,
  decodeSignedHud,
  encodeSignedHud,
  type Hud,
  merkleRoot,
  sha256,
  signHud,
  verifySignedHud,
} from "@tail/protocol";
import { fakeTime } from "../../test/fake-time";
import { hudOf, refereePk, refereeSk } from "../../test/referee";
import {
  forkJson,
  freshMonitor,
  type LogFork,
  LogMonitor,
  MONITOR_RETRY_MAX_MS,
  MONITOR_RETRY_MS,
  type MonitorRecord,
  type RelayFault,
  relayFaultJson,
  retryDelay,
} from "./monitor";

const START = 1_800_000_000_000;

/** The referee's real log, and a fork of it that rewrote entry 2. */
const log = Array.from({ length: 40 }, (_, i) => sha256(Uint8Array.of(i)));
const forked = log.map((l, i) => (i === 2 ? sha256(Uint8Array.of(0xff)) : l));
const root = (n: number, leaves = log) => merkleRoot(leaves.slice(0, n));
/** What an honest relay holding `leaves` answers. */
const relayOf =
  (leaves = log) =>
  async (from: number, to: number) =>
    consistencyProof(leaves.slice(0, to), from);

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

let tick = 0;
/** A HUD the referee signed with the log at `size`, and its signed bytes. */
function hud(size: number, leaves = log): [Hud, Uint8Array] {
  const h = hudOf({ tick: ++tick, logSize: BigInt(size), root: root(size, leaves) });
  return [h, encodeSignedHud(signHud(h, refereeSk))];
}

function rig(
  consistency: (from: number, to: number) => Promise<Uint8Array[]> = relayOf(),
  record: MonitorRecord = freshMonitor(),
) {
  const t = fakeTime(START);
  const calls: [number, number][] = [];
  const forks: LogFork[] = [];
  const faults: RelayFault[] = [];
  let changed = 0;
  const m = new LogMonitor(
    {
      consistency: (from, to) => {
        calls.push([from, to]);
        return consistency(from, to);
      },
      changed: () => changed++,
      onFork: (f) => forks.push(f),
      onRelayFault: (f) => faults.push(f),
      now: t.now,
      timers: t.timers,
    },
    record,
  );
  return {
    t,
    m,
    calls,
    forks,
    faults,
    changed: () => changed,
    see: (size: number, leaves = log) => m.onHud(...hud(size, leaves)),
  };
}

/** The HUD inside signed evidence, after checking the referee's signature on it. */
const signedHud = (bytes: Uint8Array) => {
  const s = decodeSignedHud(bytes);
  expect(verifySignedHud(s, refereePk)).toBe(true);
  return s.hud;
};

describe("log monitor", () => {
  test("honest growth: each grown log is proven against the last verified root", async () => {
    const r = rig();
    r.see(3);
    r.see(5);
    await flush();
    r.see(5);
    r.see(8);
    await flush();
    expect(r.calls).toEqual([
      [3, 5],
      [5, 8],
    ]);
    expect(r.forks).toEqual([]);
    expect(r.m.record().verified?.size).toBe(8);
    expect(r.m.record().pending).toBeNull();
    expect(r.changed()).toBe(2);
  });

  test("a proof that does not verify blames the relay, not the referee: kept, retried with a growing wait, and monitoring goes on", async () => {
    let lies = 2;
    const r = rig(async (from, to) => {
      if (lies > 0) {
        lies--;
        return [sha256(Uint8Array.of(0xee))];
      }
      return relayOf()(from, to);
    });
    r.see(5);
    r.see(9);
    await flush();
    expect(r.forks).toEqual([]);
    expect(r.m.fork).toBeNull();
    expect(r.faults.map((f) => [f.count, f.from, f.to])).toEqual([[1, 5, 9]]);
    const fault = r.m.relayFault as RelayFault;
    expect(fault.outstanding).toBe(true);
    expect(fault.proof).toEqual([sha256(Uint8Array.of(0xee))]);
    expect(signedHud(fault.hud.signed).logSize).toBe(5n);
    // While it waits, a new HUD only moves the target: the relay is not asked on every tick.
    r.see(11);
    await flush();
    expect(r.calls).toEqual([[5, 9]]);
    r.t.advance(MONITOR_RETRY_MS);
    await flush();
    expect(r.calls).toEqual([
      [5, 9],
      [5, 11],
    ]);
    expect(r.m.relayFault?.count).toBe(2);
    // The second wait is twice the first.
    r.t.advance(MONITOR_RETRY_MS);
    await flush();
    expect(r.calls).toHaveLength(2);
    r.t.advance(MONITOR_RETRY_MS);
    await flush();
    expect(r.calls).toHaveLength(3);
    expect(r.m.record().verified?.size).toBe(11);
    expect(r.m.relayFault).toMatchObject({ count: 2, outstanding: false });
    expect(r.forks).toEqual([]);
    // Monitoring carries on as normal.
    r.see(14);
    await flush();
    expect(r.calls.at(-1)).toEqual([11, 14]);
    const doc = JSON.parse(relayFaultJson(r.m.relayFault as RelayFault, "ab".repeat(16))) as {
      kind: string;
      proof: string[];
    };
    expect(doc.kind).toBe("tail/relay-bad-proof/v1");
    expect(doc.proof).toHaveLength(1);
  });

  test("the wait between rechecks doubles up to a ceiling", () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(retryDelay)).toEqual([
      MONITOR_RETRY_MS,
      2 * MONITOR_RETRY_MS,
      4 * MONITOR_RETRY_MS,
      8 * MONITOR_RETRY_MS,
      MONITOR_RETRY_MAX_MS,
      MONITOR_RETRY_MAX_MS,
      MONITOR_RETRY_MAX_MS,
    ]);
  });

  test("a rewritten log is a fork once two signed roots contradict by themselves, kept with both signed HUDs", async () => {
    // An honest relay can't prove the rewrite consistent: that alone blames the relay.
    const r = rig();
    r.see(5);
    r.see(9, forked);
    await flush();
    expect(r.forks).toEqual([]);
    expect(r.faults).toHaveLength(1);
    // The referee then signs the real log at the same size: two roots for size 9, no proof needed.
    r.see(9);
    expect(r.forks).toHaveLength(1);
    const f = r.m.fork as LogFork;
    expect(r.m.record().fork).toBe(f);
    expect(f.other.kind).toBe("hud");
    if (f.other.kind === "hud") expect(signedHud(f.other.hud.signed).root).toEqual(root(9));
    expect(signedHud(f.hud.signed).root).toEqual(root(9, forked));
    // The monitor stops there: later HUDs are not checked.
    r.see(12);
    r.t.advance(MONITOR_RETRY_MAX_MS);
    await flush();
    expect(r.calls).toEqual([[5, 9]]);
    const doc = JSON.parse(forkJson(f, "ab".repeat(16))) as { kind: string; proof?: unknown };
    expect(doc.kind).toBe("tail/log-fork/v2");
    expect(doc.proof).toBeUndefined();
  });

  test("a relay it can't reach is no failure: it asks again later", async () => {
    let down = true;
    const r = rig(async (from, to) => {
      if (down) throw new Error("Can't reach the relay.");
      return relayOf()(from, to);
    });
    r.see(3);
    r.see(7);
    await flush();
    expect(r.forks).toEqual([]);
    expect(r.m.record().pending?.size).toBe(7);
    down = false;
    r.t.advance(MONITOR_RETRY_MS);
    await flush();
    expect(r.calls).toEqual([
      [3, 7],
      [3, 7],
    ]);
    expect(r.m.record().verified?.size).toBe(7);
    expect(r.forks).toEqual([]);
  });

  test("HUDs that arrive during a fetch are caught up with one proof from the last verified root", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const r = rig(async (from, to) => {
      if (from === 3) await gate;
      return relayOf()(from, to);
    });
    r.see(3);
    r.see(5);
    r.see(6);
    r.see(7);
    r.see(9);
    await flush();
    expect(r.calls).toEqual([[3, 5]]);
    release();
    await flush();
    expect(r.calls).toEqual([
      [3, 5],
      [5, 9],
    ]);
    expect(r.m.record().verified?.size).toBe(9);
  });

  test("roots anchored on NEAR are checked against the HUD root, either way round", async () => {
    const r = rig();
    r.see(8);
    await r.m.checkAnchors([
      { logSize: 5n, root: root(5) },
      { logSize: 8n, root: root(8) },
      { logSize: 12n, root: root(12) },
    ]);
    expect(r.calls).toEqual([
      [5, 8],
      [8, 12],
    ]);
    expect(r.m.record().anchored).toBe(12);
    // Already checked: not asked again.
    await r.m.checkAnchors([{ logSize: 12n, root: root(12) }]);
    expect(r.calls).toHaveLength(2);
    expect(r.forks).toEqual([]);
  });

  test("an anchored root that differs from a signed HUD root of the same size is a fork, with both as evidence", async () => {
    const r = rig();
    r.see(4);
    r.see(10);
    await flush();
    await r.m.checkAnchors([{ logSize: 10n, root: root(10, forked) }]);
    const f = r.forks[0];
    expect(f?.other).toEqual({ kind: "anchor", anchor: { size: 10, root: root(10, forked) } });
    expect(signedHud(f?.hud.signed ?? new Uint8Array()).logSize).toBe(10n);
    expect(r.calls).toEqual([[4, 10]]);
  });

  test("an anchored root of another size that the relay's proof doesn't fit blames the relay, and is checked again", async () => {
    const r = rig();
    r.see(4);
    await r.m.checkAnchors([{ logSize: 10n, root: root(10, forked) }]);
    expect(r.forks).toEqual([]);
    expect(r.faults[0]?.other).toEqual({ kind: "anchor", anchor: { size: 10, root: root(10, forked) } });
    r.t.advance(MONITOR_RETRY_MS);
    await flush();
    expect(r.calls).toEqual([
      [4, 10],
      [4, 10],
    ]);
    expect(r.m.relayFault?.count).toBe(2);
    expect(r.m.record().anchored).toBe(0);
  });

  test("anchors read before any HUD wait for one, and the loop still starts afterwards", async () => {
    const r = rig();
    await r.m.checkAnchors([{ logSize: 6n, root: root(6) }]);
    expect(r.calls).toEqual([]);
    r.see(2);
    r.see(4);
    await flush();
    expect(r.calls).toEqual([
      [2, 4],
      [4, 6],
    ]);
    expect(r.m.record().anchored).toBe(6);
  });

  test("a saved pending root is proven after a relaunch", async () => {
    const first = rig(async () => {
      throw new Error("offline");
    });
    first.see(2);
    first.see(6);
    await flush();
    first.m.stop();
    const again = rig(relayOf(), first.m.record());
    again.m.resume();
    await flush();
    expect(again.calls).toEqual([[2, 6]]);
    expect(again.m.record().verified?.size).toBe(6);
  });

  test("held by a bad proof, the final check still compares End's root before it stops", async () => {
    // The relay lies about the HUD root of size 9 only; End's root of size 12 has an honest proof.
    const liar = async (from: number, to: number) =>
      to === 9 ? [sha256(Uint8Array.of(0xee))] : relayOf()(from, to);
    const end = [{ logSize: 12n, root: root(12) }];
    const r = rig(liar);
    r.see(4);
    r.see(9);
    await flush();
    expect(r.m.relayFault?.outstanding).toBe(true);
    // The hold: an ordinary check asks nothing until the retry.
    await r.m.checkAnchors(end);
    expect(r.calls).toEqual([[4, 9]]);
    await r.m.finalCheck(end);
    expect(r.calls).toEqual([
      [4, 9],
      [4, 9],
      [4, 12],
    ]);
    expect(r.m.record().anchored).toBe(12);
    // Stopped: no retry follows.
    r.t.advance(MONITOR_RETRY_MAX_MS);
    await flush();
    expect(r.calls).toHaveLength(3);

    // Results after a relaunch: a new monitor from the saved record does the same.
    const again = rig(liar, { ...r.m.record(), anchored: 0 });
    await again.m.finalCheck(end);
    expect(again.calls).toEqual([
      [4, 9],
      [4, 12],
    ]);
    expect(again.m.record().anchored).toBe(12);
  });

  test("a final check whose own proof fails stops with the fault outstanding", async () => {
    const r = rig(async () => [sha256(Uint8Array.of(0xee))]);
    r.see(4);
    await r.m.finalCheck([{ logSize: 12n, root: root(12) }]);
    expect(r.calls).toEqual([[4, 12]]);
    expect(r.m.relayFault?.outstanding).toBe(true);
    r.t.advance(MONITOR_RETRY_MAX_MS);
    await flush();
    expect(r.calls).toHaveLength(1);
  });
});
