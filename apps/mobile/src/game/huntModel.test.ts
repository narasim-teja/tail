import { describe, expect, test } from "bun:test";
import { DARK_LEAK_MS, HintKind, LOCK_EPOCHS, type PlayerKeys, TargetStatus } from "@tail/protocol";
import { hudView } from "./hud";
import { huntModel } from "./huntModel";
import type { SessionSnapshot } from "./session";

const NOW = 1_800_000_000_000;
const keys: PlayerKeys = {
  matchId: new Uint8Array(16),
  player: 0,
  startMs: BigInt(NOW - 60_000),
  endMs: BigInt(NOW + 760_000),
  kTag: new Uint8Array(32),
  kPlayer: new Uint8Array(32),
  target: "maya.tail.testnet",
};
const snap = (o: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  epoch: 4,
  token: null,
  heard: 0,
  fixes: 0,
  lastFix: { lat: 42.355, lon: -71.0656, acc: 5, heading: 90 },
  seq: 10,
  queued: 1,
  upload: { kind: "idle" },
  offline: false,
  carry: { kind: "off", why: "" },
  socket: "live",
  hud: hudView({
    tick: 1,
    epoch: 4,
    lock: 2,
    heat: 1,
    head: 5_400_000n,
    status: TargetStatus.Hunting,
    target: "maya.tail.testnet",
  }),
  notes: [],
  over: false,
  pendingActions: 0,
  strikeSentAtMs: null,
  landed: null,
  tags: 0,
  darkSinceMs: null,
  outSinceMs: null,
  frozenUntilMs: null,
  blocked: null,
  ...o,
});
const zone = { zone: { latE7: 423_550_000, lonE7: -710_656_000, radiusM: 100 }, safehouses: [] };
const ctx = { keys, stake: 5_000_000n, zone };

describe("hunt model", () => {
  test("reads the HUD as short labels: time left, head in dollars, lock and heat out of four", () => {
    const m = huntModel(snap(), ctx, NOW);
    expect([m.timeLeft, m.head, m.lock, m.heat, m.max]).toEqual(["12:40 left", "$5.40", 2, 1, LOCK_EPOCHS]);
    expect(m.waiting).toBe(false);
    expect(m.hints.map((h) => [h.kind, h.price])).toEqual([
      [HintKind.Near, "$0.10"],
      [HintKind.Bearing, "$0.25"],
      [HintKind.Trend, "$0.10"],
    ]);
  });

  test("before the first HUD it shows the stake as head and says it is waiting", () => {
    const m = huntModel(snap({ hud: null }), ctx, NOW);
    expect([m.head, m.waiting, m.target]).toEqual(["$5.00", true, "maya.tail.testnet"]);
  });

  test("going dark counts to the leak and then says your area was shown", () => {
    expect(huntModel(snap({ darkSinceMs: NOW - 25_000 }), ctx, NOW).banner).toEqual({
      kind: "dark",
      title: "Dark 25 s",
      detail: `Your area shows in ${DARK_LEAK_MS / 1000 - 25} s`,
    });
    expect(huntModel(snap({ darkSinceMs: NOW - 60_000 }), ctx, NOW).banner?.detail).toBe(
      "Your area was shown to your hunter",
    );
  });

  test("out of zone wins over dark and names the way back", () => {
    const m = huntModel(
      snap({
        darkSinceMs: NOW - 25_000,
        outSinceMs: NOW - 15_000,
        lastFix: { lat: 42.357, lon: -71.0656, acc: 5, heading: 0 },
      }),
      ctx,
      NOW,
    );
    expect(m.banner?.kind).toBe("zone");
    expect(m.banner?.title).toBe("Out of zone. Back S, 122 m");
  });

  test("a vehicle freeze shows the time left and the newest Handler line is the dispatch", () => {
    const m = huntModel(
      snap({
        frozenUntilMs: NOW + 105_000,
        notes: [
          { tMs: NOW - 2_000, kind: "info", text: "Hint asked" },
          { tMs: NOW - 5_000, kind: "handler", text: "North, darling." },
        ],
      }),
      ctx,
      NOW,
    );
    expect(m.frozenFor).toBe("1:45");
    expect(m.dispatch).toEqual({ atMs: NOW - 5_000, text: "North, darling." });
  });

  test("being out is the tagged state", () => {
    const hud = hudView({
      tick: 2,
      epoch: 5,
      lock: 0,
      heat: 4,
      head: 0n,
      status: TargetStatus.Out,
      target: "x",
    });
    expect(huntModel(snap({ hud }), ctx, NOW).tagged).toBe(true);
  });
});
