// Where the director wants the camera: on the chase in focus, the player being followed, the
// player going dark, or the whole zone. The film eases towards it; reduced motion cuts to it.

import type { Match } from "../model/match.ts";
import type { Frame } from "./frame.ts";

export interface Shot {
  center: [number, number];
  zoom: number;
  /** Changes when the subject changes; reduced motion cuts on a new key. */
  key: string;
}

const metresPerPx = (lat: number, zoom: number) => (156_543.03 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;

/** Zoom at which `metres` spans `px` pixels. */
export function zoomFor(lat: number, metres: number, px: number) {
  return Math.log2((156_543.03 * Math.cos((lat * Math.PI) / 180) * px) / metres);
}

export function shot(m: Match, f: Frame, follow: number | null, viewMin: number): Shot {
  const near = Math.min(19.3, zoomFor(m.zone.lat, 55, viewMin));
  if (follow !== null) {
    const pl = f.players[follow];
    const pos = pl?.pos ?? pl?.ghost;
    if (pos) return { center: pos, zoom: near, key: `follow:${follow}` };
  }
  if (f.focus.kind === "chase") {
    const a = f.players[f.focus.hunter];
    const b = f.players[f.focus.target];
    const pa = a?.pos ?? a?.ghost;
    const pb = b?.pos ?? b?.ghost;
    if (pa && pb) {
      const dx = (pa[0] - pb[0]) * 111_320 * Math.cos((pa[1] * Math.PI) / 180);
      const dy = (pa[1] - pb[1]) * 111_132;
      const span = Math.max(55, Math.hypot(dx, dy) * 2.2);
      return {
        center: [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2],
        zoom: Math.min(near, Math.max(16, zoomFor(m.zone.lat, span, viewMin))),
        key: `chase:${f.focus.hunter}>${f.focus.target}`,
      };
    }
    const one = pa ?? pb;
    if (one) return { center: one, zoom: near - 0.6, key: `chase:${f.focus.hunter}>${f.focus.target}` };
  }
  if (f.focus.kind === "player") {
    const pl = f.players[f.focus.player];
    const pos = pl?.pos ?? pl?.ghost;
    if (pos) return { center: pos, zoom: near - 0.5, key: `player:${f.focus.player}` };
  }
  return {
    center: [m.zone.lon, m.zone.lat],
    zoom: zoomFor(m.zone.lat, m.zone.radiusM * 2.3, viewMin),
    key: "zone",
  };
}

export { metresPerPx };
