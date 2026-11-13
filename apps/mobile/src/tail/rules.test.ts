import { describe, expect, test } from "bun:test";
import { DARK_FORFEIT_MS, DARK_LEAK_MS, VEHICLE_FREEZE_MS, VEHICLE_HOLD_MS } from "@tail/protocol";
import { bearingDeg, compass8, distanceM, inCircle } from "./geo";
import { clock, darkState, HUD_STALE_MS, VehicleWatch, zoneState } from "./rules";

const common = { lat: 42.355, lon: -71.0656 };

describe("geometry", () => {
  test("distance and bearing agree with known values on Boston Common", () => {
    const north = { lat: common.lat + 0.001, lon: common.lon };
    expect(distanceM(common, north)).toBeCloseTo(111.2, 0);
    expect(compass8(bearingDeg(common, north))).toBe("N");
    expect(compass8(bearingDeg(common, { lat: common.lat - 0.001, lon: common.lon - 0.001 }))).toBe("SW");
  });

  test("a point is in the zone up to its radius", () => {
    const zone = { latE7: 423_550_000, lonE7: -710_656_000, radiusM: 120 };
    expect(inCircle({ lat: common.lat + 0.001, lon: common.lon }, zone)).toBe(true);
    expect(inCircle({ lat: common.lat + 0.0012, lon: common.lon }, zone)).toBe(false);
  });
});

describe("the phone's view of the rules", () => {
  test("dark is what the referee counts, running on between its HUDs", () => {
    const counting = { totalMs: 50_000, runMs: 20_000, counting: true, atMs: 10_000 };
    expect(darkState(10_000, null, false)).toBeNull();
    expect(darkState(15_000, counting, false)).toEqual({
      seconds: 25,
      leakIn: DARK_LEAK_MS / 1000 - 25,
      forfeitIn: (DARK_FORFEIT_MS - 55_000) / 1000,
    });
    expect(darkState(10_000 + DARK_LEAK_MS, counting, false)?.leakIn).toBe(0);
  });

  test("a referee not counting you dark shows no dark, until HUDs stop and the relay is gone too", () => {
    const fine = { totalMs: 0, runMs: 0, counting: false, atMs: 10_000 };
    expect(darkState(10_000 + 5 * HUD_STALE_MS, fine, false)).toBeNull();
    expect(darkState(10_000 + HUD_STALE_MS - 1, fine, true)).toBeNull();
    expect(darkState(10_000 + HUD_STALE_MS, fine, true)?.seconds).toBe(HUD_STALE_MS / 1000);
  });

  test("out of zone names the way back, the distance to the edge and both countdowns", () => {
    const zone = { latE7: 423_550_000, lonE7: -710_656_000, radiusM: 100 };
    const me = { lat: common.lat + 0.002, lon: common.lon };
    const z = zoneState(40_000, me, zone, 10_000);
    expect(z?.direction).toBe("S");
    expect(z?.distanceM).toBe(122);
    expect(z?.leakIn).toBe(DARK_LEAK_MS / 1000 - 30);
    expect(z?.forfeitIn).toBe(DARK_FORFEIT_MS / 1000 - 30);
    expect(zoneState(40_000, me, zone, null)).toBeNull();
  });

  test("a sustained vehicle speed freezes the lock for the freeze time", () => {
    const v = new VehicleWatch();
    v.add(0, 9);
    v.add(VEHICLE_HOLD_MS - 1, 9);
    expect(v.frozenFor(VEHICLE_HOLD_MS)).toBeNull();
    v.add(VEHICLE_HOLD_MS, 9);
    expect(v.frozenFor(VEHICLE_HOLD_MS)).toBe(VEHICLE_FREEZE_MS / 1000);
    v.add(VEHICLE_HOLD_MS + 1_000, 1);
    expect(v.frozenFor(VEHICLE_HOLD_MS + VEHICLE_FREEZE_MS + 1)).toBeNull();
  });

  test("clocks read as minutes and seconds and never go negative", () => {
    expect(clock(760_000)).toBe("12:40");
    expect(clock(5_400)).toBe("0:06");
    expect(clock(-1)).toBe("0:00");
  });
});
