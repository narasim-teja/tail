import { describe, expect, test } from "bun:test";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import {
  HintKind,
  type Hud,
  LOCK_EPOCHS,
  RefuseCode,
  RejectCode,
  sealSignedVoiceLine,
  signVoiceLine,
  TargetStatus,
} from "@tail/protocol";
import { hudOf, refereePk, refereeSk, sealedHud } from "../../test/referee";
import { openHud } from "../proximity/hud";
import {
  describeHintFact,
  describeRefusal,
  describeRejectCode,
  formatAmount,
  hudView,
  openVoice,
  rejectReason,
} from "./hud";

const sk = x25519.utils.randomSecretKey();
const pk = x25519.getPublicKey(sk);
const seat = { matchId: new Uint8Array(16).fill(4), player: 0 };
const base: Hud = hudOf({ tick: 7, epoch: 30, lock: 2, heat: 1, head: 5_250_000n });
const otherSk = ed25519.utils.randomSecretKey();

describe("HUD view", () => {
  test("an out player's HUD names who took their head", () => {
    const hud: Hud = { ...base, status: TargetStatus.Out, target: "", taggedBy: "maya.tail.testnet" };
    expect(hudView(openHud(sk, sealedHud(pk, hud), refereePk, seat)).taggedBy).toBe("maya.tail.testnet");
    expect(hudView(base).taggedBy).toBeNull();
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
});

describe("Handler lines", () => {
  test("a Handler line opens only when the referee signed it", () => {
    const line = { matchId: seat.matchId, player: 0, hintId: 3, text: "North, darling." };
    expect(openVoice(sk, sealSignedVoiceLine(pk, signVoiceLine(line, refereeSk)), refereePk, seat).text).toBe(
      "North, darling.",
    );
    const swapped = sealSignedVoiceLine(pk, signVoiceLine({ ...line, text: "South." }, otherSk));
    expect(() => openVoice(sk, swapped, refereePk, seat)).toThrow("not signed");
  });
});

describe("words", () => {
  test("amounts format exactly, without floating point", () => {
    expect(formatAmount(5_250_000n)).toBe("5.25");
    expect(formatAmount(1n)).toBe("0.000001");
    expect(formatAmount(3_000_000n)).toBe("3.00");
  });

  test("referee refusals read as plain sentences, one for every RefuseCode", () => {
    expect(describeRefusal("hint", RefuseCode.NoFix)).toBe(
      "Hint refused. No location for you or your target yet. Try again in a minute.",
    );
    expect(describeRefusal("strike", RefuseCode.Lock)).toBe("Strike refused. Your lock isn't full.");
    for (const code of Object.values(RefuseCode))
      expect(describeRefusal("hint", code)).not.toContain("Reason");
    expect(describeRefusal("", 99)).toBe("Refused. Reason 99.");
    expect(describeRefusal("strike", null)).toBe("Strike refused. No reason given.");
  });

  test("every refusal code has plain words, and the ones the phone mends itself say nothing", () => {
    for (const code of Object.values(RejectCode)) {
      expect(rejectReason(code)).not.toContain("reason");
      if (code === RejectCode.Seq || code === RejectCode.Prev) expect(describeRejectCode(code)).toBeNull();
      else expect(describeRejectCode(code)).toBeTruthy();
    }
    expect(describeRejectCode(RejectCode.ClockSkew)).toContain("clock");
    expect(describeRejectCode(99)).toBe("Report not counted (reason 99).");
  });
});
