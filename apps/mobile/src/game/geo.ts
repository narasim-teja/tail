// Small spherical geometry for the phone's own banners (zone edge, direction back). The referee
// decides everything that counts; these only tell the player what it will see.

export interface LatLon {
  lat: number;
  lon: number;
}

export interface Circle {
  latE7: number;
  lonE7: number;
  radiusM: number;
}

const R = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from north, 0..360. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export const compass8 = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8] as string;

export const circleCenter = (c: Circle): LatLon => ({ lat: c.latE7 / 1e7, lon: c.lonE7 / 1e7 });
export const inCircle = (p: LatLon, c: Circle) => distanceM(p, circleCenter(c)) <= c.radiusM;
