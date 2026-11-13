// The match zone comes through the relay, which is untrusted; the chain stores only its hash.
// zone_hash = SHA256("tail/zone/v1" ‖ borsh(zone: Circle, safehouses: Vec<Circle>)), Circle =
// {lat_e7 i32, lon_e7 i32, radius_m u32}, as apps/server/src/matches.ts and referee-core define it.
import { equal, sha256, utf8, Writer } from "@tail/protocol";
import type { Circle } from "./geo";

export interface Zone {
  zone: Circle;
  safehouses: Circle[];
}

export function zoneHash(z: Zone): Uint8Array {
  const circle = (w: Writer, c: Circle) => w.i32(c.latE7).i32(c.lonE7).u32(c.radiusM);
  const w = new Writer().raw(utf8("tail/zone/v1"));
  circle(w, z.zone);
  return sha256(w.vec(z.safehouses, circle).bytes());
}

/** The zone, if it is the one the match committed to on chain; otherwise null. */
export const checkedZone = (z: Zone | null, chainHash: Uint8Array | null): Zone | null =>
  z && chainHash && equal(zoneHash(z), chainHash) ? z : null;
