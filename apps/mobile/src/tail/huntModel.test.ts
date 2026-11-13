import { describe, expect, test } from "bun:test";
import {
  DARK_FORFEIT_MS,
  DARK_LEAK_MS,
  HintKind,
  LOCK_EPOCHS,
  type PlayerKeys,
  TargetStatus,
} from "@tail/protocol";
import { hudOf } from "../../test/referee";
import { hudView } from "./hud";
import type { HuntSnapshot } from "./hunt";
import {
  handleOf,
  howVerified,
  huntModel,
  INVISIBLE_SHOW_MS,
  isTestPlayer,
  resultOutcome,
  taggedLines,
} from "./huntModel";

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
const snap = (o: Partial<HuntSnapshot> = {}): HuntSnapshot => ({
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
  hud: hudView(
    hudOf({
      tick: 1,
      epoch: 4,
      lock: 2,
      heat: 1,
      head: 5_400_000n,
      status: TargetStatus.Hunting,
      target: "maya.tail.testnet",
    }),
  ),
  notes: [],
  over: false,
  pendingActions: 0,
  strikeSentAtMs: null,
  landed: null,
  tags: 0,
  dark: null,
  outSinceMs: null,
  frozenUntilMs: null,
  blocked: null,
  invisible: null,
  noPocketSensor: false,
  logFork: null,
  relayFault: null,
  ...o,
});
/** The referee counting a dark run of `ms`, as of now. */
const darkRun = (ms: number) => ({ totalMs: ms, runMs: ms, counting: true, atMs: NOW });
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

  test("hint prices come from the signed HUD's board, with the Handler's reason", () => {
    const hud = hudView(
      hudOf({ head: 5_400_000n, hintPrices: [200_000n, 500_000n, 200_000n], hintRecent: 4 }),
    );
    const m = huntModel(snap({ hud }), ctx, NOW);
    expect(m.hints.map((h) => [h.name, h.price])).toEqual([
      ["Near", "$0.20"],
      ["Bearing", "$0.50"],
      ["Warmer", "$0.20"],
    ]);
    expect(m.hints[1]?.reason).toBe("Intel's dear: 4 hints bought in the last 5 minutes put Bearing at 2x.");
    // Before the first HUD: the base price, and no reason the phone cannot know.
    const first = huntModel(snap({ hud: null }), ctx, NOW).hints;
    expect(first.map((h) => [h.price, h.reason])).toEqual([
      ["$0.10", null],
      ["$0.25", null],
      ["$0.10", null],
    ]);
  });

  test("before the first HUD it shows the stake as head and says it is waiting", () => {
    const m = huntModel(snap({ hud: null }), ctx, NOW);
    expect([m.head, m.waiting, m.target]).toEqual(["$5.00", true, "maya.tail.testnet"]);
  });

  test("going dark by the referee's count runs to the leak, then to the forfeit", () => {
    expect(huntModel(snap({ dark: darkRun(25_000) }), ctx, NOW).banner).toEqual({
      kind: "dark",
      title: "Dark 25 s",
      detail: `Your area shows in ${DARK_LEAK_MS / 1000 - 25} s`,
    });
    expect(huntModel(snap({ dark: darkRun(60_000) }), ctx, NOW).banner?.detail).toBe(
      `Your area was shown. Head forfeits in ${(DARK_FORFEIT_MS - 60_000) / 1000} s`,
    );
  });

  test("no relay contact alone is not dark while the referee still hears you (the mesh may carry you)", () => {
    const heard = { totalMs: 0, runMs: 0, counting: false, atMs: NOW - 1_000 };
    expect(huntModel(snap({ dark: heard, offline: true }), ctx, NOW).banner).toBeNull();
  });

  test("out of zone wins over dark and names the way back", () => {
    const m = huntModel(
      snap({
        dark: darkRun(25_000),
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

  test("back from the background it says how long you were invisible, for a few seconds", () => {
    const back = snap({ invisible: { seconds: 42, atMs: NOW - 2_000 } });
    expect(huntModel(back, ctx, NOW).banner?.title).toBe("You were invisible 42 s");
    expect(huntModel(back, ctx, NOW - 2_000 + INVISIBLE_SHOW_MS).banner).toBeNull();
    // Being dark right now matters more than having been invisible.
    const dark = snap({ invisible: { seconds: 42, atMs: NOW }, dark: darkRun(25_000) });
    expect(huntModel(dark, ctx, NOW).banner?.title).toBe("Dark 25 s");
  });

  test("a log fork is the banner above every other warning, for the rest of the match", () => {
    const fork = {
      atMs: NOW,
      hud: { size: 3, root: new Uint8Array(32), signed: new Uint8Array(1) },
      other: { kind: "anchor" as const, anchor: { size: 5, root: new Uint8Array(32).fill(1) } },
    };
    const b = huntModel(snap({ logFork: fork, dark: darkRun(25_000) }), ctx, NOW).banner;
    expect(b).toMatchObject({ kind: "fork", title: "The referee showed you a log it later changed" });
  });

  test("a relay's bad log proof is only a word in the status line while it is being checked again", () => {
    const root = { size: 3, root: new Uint8Array(32), signed: new Uint8Array(1) };
    const relayFault = {
      atMs: NOW,
      count: 1,
      outstanding: true,
      hud: root,
      other: { kind: "hud" as const, hud: { ...root, size: 5 } },
      from: 3,
      to: 5,
      proof: [],
    };
    const m = huntModel(snap({ relayFault }), ctx, NOW);
    expect(m.banner).toBeNull();
    expect(m.status).toContain("Relay proof failed, rechecking");
    expect(
      huntModel(snap({ relayFault: { ...relayFault, outstanding: false } }), ctx, NOW).status,
    ).not.toContain("Relay proof");
  });

  test("a phone without a proximity sensor is warned that the screen won't go off in a pocket", () => {
    expect(huntModel(snap({ noPocketSensor: true }), ctx, NOW).banner?.title).toBe("No pocket sensor");
    expect(huntModel(snap(), ctx, NOW).banner).toBeNull();
  });

  test("approximate location blocks the hunt like location off", () => {
    expect(huntModel(snap({ blocked: "approximate" }), ctx, NOW).blocked).toBe("approximate");
  });

  test("being out is the tagged state", () => {
    const hud = hudView(
      hudOf({ tick: 2, epoch: 5, heat: 4, head: 0n, status: TargetStatus.Out, target: "x" }),
    );
    expect(huntModel(snap({ hud }), ctx, NOW).tagged).toBe(true);
  });

  test("a tagged HUD that names the hunter carries the name to the tagged screen", () => {
    const hud = hudView(
      hudOf({
        tick: 2,
        epoch: 5,
        head: 0n,
        status: TargetStatus.Out,
        target: "",
        taggedBy: "maya.tail.testnet",
      }),
    );
    expect(huntModel(snap({ hud }), ctx, NOW).taggedBy).toBe("maya.tail.testnet");
    expect(taggedLines("maya.tail.testnet", "$5.40")).toEqual({
      title: "maya got you",
      line: "Your head, $5.40, is theirs now.",
      more: null,
    });
  });

  test("a tagged HUD without a name falls back to your hunter and the replay", () => {
    expect(huntModel(snap(), ctx, NOW).taggedBy).toBeNull();
    expect(taggedLines(null, "$5.40")).toEqual({
      title: "Tagged",
      line: "Your head, $5.40, went to your hunter.",
      more: "The replay shows who, once the match ends.",
    });
  });
});

describe("names and outcomes", () => {
  test("a handle is the first label; a test player is named as one", () => {
    expect(handleOf("maya.tail-dev.testnet")).toBe("maya");
    expect(handleOf("ghost-10rytjmq.tail-dev.testnet")).toBe("Test player");
    expect(isTestPlayer("ghost-a.r.testnet")).toBe(true);
    expect(isTestPlayer("ghostly.r.testnet")).toBe(false);
  });

  test("the chain decides the outcome when the HUD's last word is missing", () => {
    const f = { hudStatus: null, out: false, ended: true, standing: 1 } as const;
    expect(resultOutcome(f)).toBe("won");
    expect(resultOutcome({ ...f, standing: 2 })).toBe("survived");
    expect(resultOutcome({ ...f, out: true })).toBe("out");
    expect(resultOutcome({ ...f, out: true, ended: false })).toBe("running");
    expect(resultOutcome({ ...f, hudStatus: "won", standing: 2 })).toBe("won");
    expect(resultOutcome({ ...f, hudStatus: "out", standing: 1 })).toBe("out");
  });
});

describe("how it's verified", () => {
  test("a local test referee is named as one and never as an enclave", () => {
    const t = howVerified("local");
    expect(t).toContain("test referee");
    expect(t).toContain("not in a hardware enclave");
  });

  test("an enclave is only what the relay says, with the replay as the check", () => {
    expect(howVerified("outlayer")).toContain(
      "The relay says its referee runs in OutLayer's hardware enclave",
    );
    expect(howVerified("outlayer")).toContain("replay");
  });

  test("a relay that does not say gets no enclave claim at all", () => {
    expect(howVerified(null)).not.toContain("enclave");
  });
});
