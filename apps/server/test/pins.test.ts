// The relay's boot check (pins.ts): it serves only beside a contract that pins its referee, and
// never with a local test referee that does not answer.

import { describe, expect, test } from "bun:test";
import { toHex } from "@tail/protocol";
import { pinProblem } from "../src/pins.ts";
import type { RefereeKeys } from "../src/referee.ts";

const keys: RefereeKeys = {
  refereePk: new Uint8Array(32).fill(1),
  refereeBoxPk: new Uint8Array(32).fill(2),
  boxPkSig: new Uint8Array(64),
  vrfPk: new Uint8Array(32).fill(3),
  appId: "TEAM.app",
};
const pinned = { referee_pk: toHex(keys.refereePk), vrf_pk: toHex(keys.vrfPk), vrf_sender: "relay.testnet" };
const outlayer = { refereeMode: "outlayer" as const, vrfSender: "relay.testnet", appId: "TEAM.app" };
const local = { refereeMode: "local" as const, vrfSender: "relay.testnet", appId: "TEAM.app" };

describe("pinProblem", () => {
  test("the referee the contract pins passes", () => {
    expect(pinProblem(outlayer, pinned, keys)).toBeNull();
    expect(pinProblem(local, pinned, keys)).toBeNull();
  });

  test("a local referee that does not answer stops the relay; an enclave that does not is let be", () => {
    const down = new Error("local referee exited 127 without JSON");
    expect(pinProblem(local, pinned, down)).toContain("the local test referee does not answer");
    expect(pinProblem(outlayer, pinned, down)).toBeNull();
  });

  test("other keys or another VRF caller stop the relay", () => {
    for (const p of [
      { ...pinned, referee_pk: "00".repeat(32) },
      { ...pinned, vrf_pk: "00".repeat(32) },
      { ...pinned, vrf_sender: "someone-else.testnet" },
    ])
      expect(pinProblem(outlayer, p, keys)).toContain("pin-referee.ts");
  });

  test("a referee that checks another App ID than the relay names stops the relay", () => {
    expect(pinProblem(outlayer, pinned, { ...keys, appId: "OTHER.app" })).toContain("App ID OTHER.app");
    // A build from before pubkeys named it cannot be checked (main.ts warns).
    expect(pinProblem(outlayer, pinned, { ...keys, appId: null })).toBeNull();
  });
});
