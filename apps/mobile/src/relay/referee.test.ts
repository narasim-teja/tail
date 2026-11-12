import { describe, expect, test } from "bun:test";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { concat, sha256, utf8 } from "@tail/protocol";
import { checkedRefereeBox } from "./referee";

const refSk = ed25519.utils.randomSecretKey();
const refPk = ed25519.getPublicKey(refSk);
const boxPk = x25519.getPublicKey(x25519.utils.randomSecretKey());
const sig = ed25519.sign(sha256(concat(utf8("tail/referee-box/v1"), boxPk)), refSk);

describe("referee box key", () => {
  test("is accepted when the match's pinned referee key signed it", () => {
    expect(checkedRefereeBox({ refereePk: refPk, refereeBoxPk: boxPk, boxPkSig: sig }, refPk)).toEqual(boxPk);
  });

  test("is refused when the relay swaps in another box key or another referee", () => {
    const other = x25519.getPublicKey(x25519.utils.randomSecretKey());
    expect(() => checkedRefereeBox({ refereePk: refPk, refereeBoxPk: other, boxPkSig: sig }, refPk)).toThrow(
      "not signed",
    );
    const otherRef = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
    expect(() =>
      checkedRefereeBox({ refereePk: otherRef, refereeBoxPk: boxPk, boxPkSig: sig }, refPk),
    ).toThrow("another referee");
  });
});
