import { describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import {
  encodeHud,
  encodePlayerKeys,
  HintKind,
  type Hud,
  LOCK_EPOCHS,
  seal,
  TargetStatus,
} from "@tail/protocol";
import {
  describeHintFact,
  describeRefusal,
  describeRejection,
  formatAmount,
  hudView,
  openHud,
  openPlayerKeys,
} from "./hud";

const sk = x25519.utils.randomSecretKey();
const pk = x25519.getPublicKey(sk);
const base: Hud = {
  tick: 7,
  epoch: 30,
  lock: 2,
  heat: 1,
  head: 5_250_000n,
  status: TargetStatus.Hunting,
  target: "bob.tail.testnet",
};

describe("HUD", () => {
  test("a sealed HUD opens with the player box key and reads back field for field", () => {
    const hud: Hud = {
      ...base,
      leak: { latE7: 423_550_000, lonE7: -710_650_000 },
      hintFact: { hintId: 3, hint: HintKind.Near, value: 1 },
    };
    expect(openHud(sk, seal(pk, encodeHud(hud), "tail/hud"))).toEqual(hud);
  });

  test("an out player's sealed HUD names who took their head", () => {
    const hud: Hud = { ...base, status: TargetStatus.Out, target: "", taggedBy: "maya.tail.testnet" };
    const opened = openHud(sk, seal(pk, encodeHud(hud), "tail/hud"));
    expect(opened).toEqual(hud);
    expect(hudView(opened).taggedBy).toBe("maya.tail.testnet");
  });

  test("a HUD of a player still in names no one", () => {
    expect(hudView(openHud(sk, seal(pk, encodeHud(base), "tail/hud"))).taggedBy).toBeNull();
  });

  test("a HUD sealed under another context does not open", () => {
    expect(() => openHud(sk, seal(pk, encodeHud(base), "tail/keys"))).toThrow();
  });

  test("STRIKE shows only with a full lock while hunting", () => {
    expect(hudView({ ...base, lock: LOCK_EPOCHS - 1 }).canStrike).toBe(false);
    expect(hudView({ ...base, lock: LOCK_EPOCHS }).canStrike).toBe(true);
    expect(hudView({ ...base, lock: LOCK_EPOCHS, status: TargetStatus.Out }).canStrike).toBe(false);
  });

  test("the view caps lock and heat at the bar length and centres the leaked cell", () => {
    const v = hudView({ ...base, lock: 8, heat: 9, leak: { latE7: 423_550_000, lonE7: -710_650_000 } });
    expect([v.lock, v.heat]).toEqual([LOCK_EPOCHS, LOCK_EPOCHS]);
    expect(v.leak).toEqual({ lat: 42.355, lon: -71.065 });
  });

  test("hint facts read as short lines", () => {
    expect(describeHintFact({ hintId: 1, hint: HintKind.Near, value: 0 })).toBe("Not within 150 m");
    expect(describeHintFact({ hintId: 1, hint: HintKind.Bearing, value: 3 })).toBe("Bearing SE");
    expect(describeHintFact({ hintId: 1, hint: HintKind.Trend, value: 1 })).toBe("Closer");
  });

  test("player keys open only for the expected match and seat", () => {
    const keys = {
      matchId: new Uint8Array(16).fill(1),
      player: 2,
      startMs: 1n,
      endMs: 2n,
      kTag: new Uint8Array(32),
      kPlayer: new Uint8Array(32),
      target: "bob",
    };
    const sealed = seal(pk, encodePlayerKeys(keys), "tail/keys");
    expect(openPlayerKeys(sk, sealed, { matchId: keys.matchId, player: 2 })).toEqual(keys);
    expect(() => openPlayerKeys(sk, sealed, { matchId: keys.matchId, player: 1 })).toThrow("another player");
    expect(() => openPlayerKeys(sk, sealed, { matchId: new Uint8Array(16), player: 2 })).toThrow(
      "another match",
    );
  });

  test("amounts format exactly, without floating point", () => {
    expect(formatAmount(5_250_000n)).toBe("5.25");
    expect(formatAmount(1n)).toBe("0.000001");
    expect(formatAmount(3_000_000n)).toBe("3.00");
  });

  test("referee refusals read as plain sentences, whatever the Debug shape", () => {
    expect(describeRefusal("hint", "NoFix")).toBe(
      "Hint refused. No location for you or your target yet. Try again in a minute.",
    );
    expect(describeRefusal("strike", "Lock { lock: 2 }")).toBe("Strike refused. Your lock isn't full.");
    expect(describeRefusal("hint", "Cooldown { ready_ms: 5 }")).toBe(
      "Hint refused. Too soon for another hint.",
    );
    expect(describeRefusal("", "Something new")).toBe("Refused. Something new");
  });

  test("referee rejection reasons read as plain sentences", () => {
    expect(describeRejection("FixFlags { flags: 1 }")).toBe("Location looks simulated. Report rejected.");
    expect(describeRejection("FixFlags { flags: 3 }")).toBe("Location looks simulated. Report rejected.");
    // An accessory fix is a real receiver, not a fake: it is named as what it is.
    expect(describeRejection("FixFlags { flags: 2 }")).toContain("accessory");
    expect(describeRejection("FixFlags { flags: 2 }")).not.toContain("simulated");
    expect(describeRejection("ClockSkew { t_ms: 1, median_ms: 2 }")).toContain("clock");
  });
});
