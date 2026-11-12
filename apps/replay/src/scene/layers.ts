// deck.gl layers for one frame. Ground layers (mask, zone, trails) go under the 3D buildings;
// people, needles, the lock line and flashes go over them.

import { iconSvg } from "@tail/brand";
import {
  ArcLayer,
  IconLayer,
  type Layer,
  LineLayer,
  PathLayer,
  type PickingInfo,
  ScatterplotLayer,
  SolidPolygonLayer,
  TripsLayer,
} from "deck.gl";
import { css, rgba } from "../lib/color.ts";
import type { Match } from "../model/match.ts";
import { type Frame, type FramePlayer, lockFraction } from "./frame.ts";
import { palette as p } from "./palette.ts";

/** Interleaved-mode prop (MapboxOverlay): draw under the 3D buildings. Not in deck's layer types. */
const UNDER = { beforeId: "buildings" };

export interface Trip {
  index: number;
  path: [number, number][];
  timestamps: number[];
}

/** Tracks as trips (seconds after start), one point every 4 s, split at gaps. */
export function tripsOf(m: Match): Trip[] {
  const out: Trip[] = [];
  m.tracks.forEach((tr, index) => {
    if (!tr) return;
    let cur: Trip | null = null;
    let lastT = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < tr.t.length; i++) {
      const t = tr.t[i] as number;
      if (t - lastT > 20_000) {
        if (cur && cur.path.length > 1) out.push(cur);
        cur = { index, path: [], timestamps: [] };
      } else if (t - lastT < 4_000 && i !== tr.t.length - 1) continue;
      cur?.path.push([tr.lon[i] as number, tr.lat[i] as number]);
      cur?.timestamps.push(t / 1000);
      lastT = t;
    }
    if (cur && cur.path.length > 1) out.push(cur);
  });
  return out;
}

const M_PER_DEG_LAT = 111_132;
export function circle(lon: number, lat: number, r: number, n = 96): [number, number][] {
  const mLon = M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [lon + (Math.cos(a) * r) / mLon, lat + (Math.sin(a) * r) / M_PER_DEG_LAT] as [number, number];
  });
}

export const needleHeight = (heads: number) => 5 + 6 * Math.sqrt(Math.max(0, heads));

const easeOutExpo = (x: number) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x));

const C = {
  persimmon: rgba(p.persimmon),
  ink: rgba(p.ink),
  trail: rgba(p.trail, 0.42),
  trailFocus: rgba(p.persimmon, 0.95),
  shadow: rgba(p.shade, 0.55),
  zone: rgba(p.zone, 0.55),
  mask: rgba(p.shade, 0.5),
  safehouse: rgba(p.zone, 0.14),
};

const SAFEHOUSE_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(iconSvg("safehouse", { size: 48, color: css(p.zone) }))}`;

export interface LayerOptions {
  reduced: boolean;
  onPick: (info: PickingInfo) => void;
}

const placed = (pl: FramePlayer) => pl.pos ?? pl.ghost;
const z = (pos: [number, number], h: number): [number, number, number] => [pos[0], pos[1], h];

export function groundLayers(m: Match, f: Frame, trips: Trip[]): Layer[] {
  const zone = circle(m.zone.lon, m.zone.lat, m.zone.radiusM);
  const big = 0.04;
  const outer: [number, number][] = [
    [m.zone.lon - big, m.zone.lat - big],
    [m.zone.lon + big, m.zone.lat - big],
    [m.zone.lon + big, m.zone.lat + big],
    [m.zone.lon - big, m.zone.lat + big],
  ];
  const focusKey = f.focus.kind === "chase" ? `${f.focus.hunter}>${f.focus.target}` : f.focus.kind;
  const roleOf = (i: number) => f.players[i]?.role ?? null;
  return [
    new SolidPolygonLayer({
      id: "outside-zone",
      data: [{ polygon: [outer, zone] }],
      getPolygon: (d: { polygon: [number, number][][] }) => d.polygon,
      getFillColor: C.mask,
      ...UNDER,
    }),
    new PathLayer({
      id: "zone",
      data: [{ path: zone }],
      getPath: (d: { path: [number, number][] }) => d.path,
      getColor: rgba(p.zone, 0.5 + 0.5 * f.zoneGlow),
      getWidth: 1.5 + 3 * f.zoneGlow,
      widthUnits: "pixels",
      updateTriggers: { getColor: f.zoneGlow, getWidth: f.zoneGlow },
      ...UNDER,
    }),
    new ScatterplotLayer({
      id: "safehouses",
      data: m.safehouses,
      getPosition: (s: Match["safehouses"][number]) => [s.lon, s.lat],
      getRadius: (s: Match["safehouses"][number]) => s.radiusM,
      getFillColor: C.safehouse,
      getLineColor: C.zone,
      stroked: true,
      lineWidthUnits: "pixels",
      getLineWidth: 1,
      ...UNDER,
    }),
    new IconLayer({
      id: "safehouse-icons",
      data: m.safehouses,
      getPosition: (s: Match["safehouses"][number]) => [s.lon, s.lat, 1],
      getIcon: () => ({ url: SAFEHOUSE_ICON, width: 48, height: 48 }),
      getSize: 18,
      sizeUnits: "pixels",
      billboard: true,
    }),
    new TripsLayer<Trip>({
      id: "trails",
      data: trips,
      getPath: (d) => d.path,
      getTimestamps: (d) => d.timestamps,
      getColor: (d) => (roleOf(d.index) ? C.trailFocus : C.trail),
      getWidth: (d) => (roleOf(d.index) ? 4.5 : 2.5),
      widthUnits: "pixels",
      capRounded: true,
      jointRounded: true,
      fadeTrail: true,
      trailLength: 150,
      currentTime: f.t / 1000,
      updateTriggers: { getColor: focusKey, getWidth: focusKey },
      ...UNDER,
    }),
  ];
}

export function peopleLayers(f: Frame, o: LayerOptions): Layer[] {
  const live = f.players.filter((pl) => pl.pos);
  const dark = f.players.filter((pl) => !pl.pos && pl.ghost);
  const shown = [...dark, ...live];
  const lift = (pl: FramePlayer) => (pl.pos ? needleHeight(pl.heads) : 3);
  const layers: Layer[] = [
    new ScatterplotLayer<FramePlayer>({
      id: "shadows",
      data: live,
      getPosition: (pl) => placed(pl) as [number, number],
      getRadius: 3.2,
      getFillColor: C.shadow,
    }),
    new LineLayer<FramePlayer>({
      id: "needles",
      data: live,
      getSourcePosition: (pl) => z(placed(pl) as [number, number], 0),
      getTargetPosition: (pl) => z(placed(pl) as [number, number], lift(pl)),
      getColor: (pl) => (pl.role ? rgba(p.persimmon, 0.75) : rgba(p.marker, 0.55)),
      getWidth: 1.5,
      widthUnits: "pixels",
    }),
  ];
  if (f.lock) {
    const k = lockFraction(f.lock.lock);
    const hunter = f.players[f.lock.hunter];
    const target = f.players[f.lock.target];
    const hh = hunter ? lift(hunter) : 2;
    const th = target ? lift(target) : 2;
    layers.push(
      new ArcLayer({
        id: "lock-line",
        data: [f.lock],
        // Head to head: a loose high arc at the first contact, pulled taut as the lock fills.
        getSourcePosition: (d: NonNullable<Frame["lock"]>) => z(d.from, hh),
        getTargetPosition: (d: NonNullable<Frame["lock"]>) => z(d.to, th),
        getHeight: 0.9 - 0.88 * k,
        getSourceColor: rgba(p.persimmon, 0.5 + 0.5 * k),
        getTargetColor: rgba(p.persimmon, 0.5 + 0.5 * k),
        getWidth: 2 + 3 * k,
        widthUnits: "pixels",
        pickable: true,
        onClick: o.onPick,
        parameters: { depthCompare: "always" },
        updateTriggers: {
          getSourcePosition: hh,
          getTargetPosition: th,
          getHeight: k,
          getSourceColor: k,
          getTargetColor: k,
          getWidth: k,
        },
      }),
    );
  }
  for (const [i, fl] of f.flashes.entries()) {
    if (!fl.pos) continue;
    const grow = o.reduced ? 1 : easeOutExpo(fl.age);
    const fade = o.reduced ? 1 : 1 - fl.age;
    const color = fl.kind === "tag" ? p.persimmon : p.duskInk;
    layers.push(
      new ScatterplotLayer({
        id: `flash-${i}`,
        data: [fl],
        getPosition: (d: typeof fl) => d.pos as [number, number],
        getRadius: o.reduced ? 18 : 4 + 30 * grow,
        filled: true,
        stroked: true,
        getFillColor: rgba(color, 0.22 * fade),
        getLineColor: rgba(color, fade),
        getLineWidth: o.reduced ? 3 : 1 + 3 * fade,
        lineWidthUnits: "pixels",
        updateTriggers: { getRadius: grow, getFillColor: fade, getLineColor: fade, getLineWidth: fade },
      }),
    );
  }
  // Head markers as single icons (disc + initials), so a marker in front hides the one behind
  // it cleanly. The chase in focus draws last, on top.
  const ordered = [...shown].sort((x, y) => Number(!!x.role) - Number(!!y.role));
  layers.push(
    new IconLayer<FramePlayer>({
      id: "heads",
      data: ordered,
      getPosition: (pl) => z(placed(pl) as [number, number], lift(pl)),
      getIcon: (pl) =>
        markerIcon(pl.initials, pl.pos ? (pl.role ? "focus" : "neutral") : "dark", pl.selected),
      getSize: (pl) => (pl.role ? 34 : 30),
      sizeUnits: "pixels",
      billboard: true,
      pickable: true,
      onClick: o.onPick,
      parameters: { depthCompare: "always" },
      updateTriggers: {
        getIcon: ordered.map((pl) => `${pl.initials}${pl.role}${!!pl.pos}${pl.selected}`).join(),
        getSize: ordered.map((pl) => pl.role).join(),
      },
    }),
  );
  return layers;
}

type MarkerKind = "focus" | "neutral" | "dark";
const markerCache = new Map<string, { id: string; url: string; width: number; height: number }>();

/** A player's head: a disc in persimmon (chase in focus) or warm light, initials in ink. */
function markerIcon(initials: string, kind: MarkerKind, selected: boolean) {
  const id = `${initials}:${kind}:${selected}`;
  const hit = markerCache.get(id);
  if (hit) return hit;
  const px = 96;
  const c = document.createElement("canvas");
  c.width = px;
  c.height = px;
  const g = c.getContext("2d");
  if (g) {
    const r = px / 2;
    g.beginPath();
    g.arc(r, r, r - 2, 0, Math.PI * 2);
    g.fillStyle = selected ? css(p.duskInk) : css(p.dusk);
    g.fill();
    g.beginPath();
    g.arc(r, r, r - (selected ? 10 : 6), 0, Math.PI * 2);
    g.fillStyle = kind === "focus" ? css(p.persimmon) : kind === "neutral" ? css(p.marker) : css(p.dusk);
    g.fill();
    if (kind === "dark") {
      g.lineWidth = 3;
      g.strokeStyle = css(p.markerOut);
      g.stroke();
    }
    g.fillStyle = kind === "dark" ? css(p.markerOut) : css(p.ink);
    g.font = `700 ${initials.length > 1 ? 34 : 42}px "Archivo Variable", sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(initials, r, r + 2);
  }
  const icon = { id, url: c.toDataURL(), width: px, height: px };
  markerCache.set(id, icon);
  return icon;
}
