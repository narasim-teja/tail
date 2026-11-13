import { describe, expect, test } from "bun:test";
import { zoneHash as relayZoneHash } from "../../../server/src/matches.ts";
import { checkedZone, type Zone, zoneHash } from "./zone";

const zone: Zone = {
  zone: { latE7: 423_550_000, lonE7: -710_656_000, radiusM: 400 },
  safehouses: [{ latE7: 423_560_000, lonE7: -710_640_000, radiusM: 25 }],
};

describe("match zone", () => {
  test("hashes exactly as the relay commits it on chain", () => {
    expect(Array.from(zoneHash(zone))).toEqual(Array.from(relayZoneHash(zone)));
  });

  test("is used only when it matches the chain's hash", () => {
    expect(checkedZone(zone, zoneHash(zone))).toEqual(zone);
    const moved = { ...zone, zone: { ...zone.zone, radiusM: 4_000 } };
    expect(checkedZone(moved, zoneHash(zone))).toBeNull();
    expect(checkedZone(zone, null)).toBeNull();
  });
});
