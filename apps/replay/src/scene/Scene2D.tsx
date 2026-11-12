// The flat map for browsers without WebGL 2: the same vector tiles drawn once onto a canvas,
// and the same layers (zone, trails, people, lock line, flashes) drawn over it every frame.
// The camera holds the whole zone; nothing flies.

import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { useEffect, useImperativeHandle, useRef } from "react";
import { css } from "../lib/color.ts";
import type { Frame } from "./frame.ts";
import { lockFraction } from "./frame.ts";
import { tripsOf } from "./layers.ts";
import { TILES_URL } from "./mapStyle.ts";
import { palette as p } from "./palette.ts";
import type { SceneHandle, SceneProps } from "./scene.ts";

const TILE_PX = 256;

const worldX = (lon: number, z: number) => ((lon + 180) / 360) * TILE_PX * 2 ** z;
const worldY = (lat: number, z: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE_PX * 2 ** z;
};

interface View {
  z: number;
  ox: number;
  oy: number;
  w: number;
  h: number;
}

export function Scene2D({
  match,
  reduced,
  insets,
  onPick,
  onPlace,
  ref,
}: SceneProps & { ref: React.Ref<SceneHandle> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const base = useRef<HTMLCanvasElement | null>(null);
  const view = useRef<View | null>(null);
  const trips = useRef(tripsOf(match));
  const last = useRef<Frame | null>(null);
  const live = useRef({ insets, onPick, onPlace, reduced });
  live.current = { insets, onPick, onPlace, reduced };

  // Fit the zone, fetch its tiles once, and paint the base map.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let cancelled = false;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      const pad = live.current.insets;
      const availW = Math.max(200, w - pad.left - pad.right);
      const availH = Math.max(200, h - pad.top - pad.bottom);
      const metres = match.zone.radiusM * 2.25;
      const mpp0 = 156_543.03 * Math.cos((match.zone.lat * Math.PI) / 180);
      const z = Math.log2((mpp0 * Math.min(availW, availH)) / metres);
      const cx = worldX(match.zone.lon, z);
      const cy = worldY(match.zone.lat, z);
      view.current = { z, w, h, ox: cx - (pad.left + availW / 2), oy: cy - (pad.top + availH / 2) };
      void paintBase(el, view.current, match.zone).then(({ canvas: c, place }) => {
        if (cancelled) return;
        base.current = c;
        if (place) live.current.onPlace?.(place);
      });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => {
      cancelled = true;
      ro.disconnect();
    };
  }, [match]);

  useImperativeHandle(
    ref,
    (): SceneHandle => ({
      frame(f: Frame) {
        last.current = f;
        const el = canvas.current;
        const v = view.current;
        if (!el || !v) return;
        const g = el.getContext("2d");
        if (!g) return;
        const dpr = el.width / Math.max(1, v.w);
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.fillStyle = css(p.land);
        g.fillRect(0, 0, v.w, v.h);
        if (base.current) g.drawImage(base.current, 0, 0, v.w, v.h);
        drawOverlay(g, v, match, f, trips.current, live.current.reduced);
      },
      resync() {},
    }),
    [match],
  );

  const click = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const v = view.current;
    const f = last.current;
    if (!v || !f) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best: { i: number; d: number } | null = null;
    for (const pl of f.players) {
      const pos = pl.pos ?? pl.ghost;
      if (!pos) continue;
      const d = Math.hypot(worldX(pos[0], v.z) - v.ox - x, worldY(pos[1], v.z) - v.oy - y);
      if (d < 22 && (!best || d < best.d)) best = { i: pl.index, d };
    }
    if (best) live.current.onPick({ kind: "player", index: best.i });
  };

  return (
    <div className="absolute inset-0 z-map">
      <canvas
        ref={canvas}
        onClick={click}
        className="size-full"
        role="img"
        aria-label="Flat map of the match. The player list is the keyboard path to each player."
      />
      <p className="absolute top-2 right-3 text-[0.6875rem] text-text-3 md:top-auto md:bottom-1.5">
        ©{" "}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
          className="hover:text-text-2"
        >
          OpenStreetMap contributors
        </a>{" "}
        ·{" "}
        <a href="https://openfreemap.org" target="_blank" rel="noreferrer" className="hover:text-text-2">
          OpenFreeMap
        </a>
      </p>
    </div>
  );
}

const tileCache = new Map<string, Promise<VectorTile>>();
function tile(url: string): Promise<VectorTile> {
  let t = tileCache.get(url);
  if (!t) {
    t = fetch(url)
      .then((r) => r.arrayBuffer())
      .then((buf) => new VectorTile(new PbfReader(new Uint8Array(buf))));
    tileCache.set(url, t);
  }
  return t;
}
let tileJson: Promise<{ tiles: string[]; maxzoom?: number }> | null = null;

/** Paints the base map once per size; also finds the named park the zone sits in. */
async function paintBase(
  el: HTMLCanvasElement,
  v: View,
  zone: { lon: number; lat: number; radiusM: number },
): Promise<{ canvas: HTMLCanvasElement; place: string | null }> {
  const c = document.createElement("canvas");
  c.width = el.width;
  c.height = el.height;
  const g = c.getContext("2d");
  let place: { name: string; d: number } | null = null;
  if (!g) return { canvas: c, place: null };
  const dpr = el.width / Math.max(1, v.w);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  try {
    tileJson ??= fetch(TILES_URL).then((r) => r.json());
    const tj = await tileJson;
    const tmpl = tj.tiles[0];
    if (!tmpl) return { canvas: c, place: null };
    // The source serves tiles up to its maxzoom (14) and nothing deeper; draw those, scaled.
    const TILE_Z = Math.min(tj.maxzoom ?? 14, Math.floor(v.z));
    const scale = 2 ** (v.z - TILE_Z);
    const tx0 = Math.floor(v.ox / scale / TILE_PX);
    const ty0 = Math.floor(v.oy / scale / TILE_PX);
    const tx1 = Math.floor((v.ox + v.w) / scale / TILE_PX);
    const ty1 = Math.floor((v.oy + v.h) / scale / TILE_PX);
    const tiles: { x: number; y: number; t: VectorTile }[] = [];
    await Promise.all(
      Array.from({ length: (tx1 - tx0 + 1) * (ty1 - ty0 + 1) }, async (_, i) => {
        const x = tx0 + (i % (tx1 - tx0 + 1));
        const y = ty0 + Math.floor(i / (tx1 - tx0 + 1));
        const url = tmpl.replace("{z}", String(TILE_Z)).replace("{x}", String(x)).replace("{y}", String(y));
        tiles.push({ x, y, t: await tile(url) });
      }),
    );
    const passes: {
      layer: string;
      fill?: string;
      stroke?: string;
      width?: number;
      when?: (k: string) => boolean;
    }[] = [
      { layer: "park", fill: css(p.park) },
      { layer: "landcover", fill: css(p.park), when: (k) => k === "grass" || k === "wood" },
      { layer: "water", fill: css(p.water) },
      {
        layer: "transportation",
        stroke: css(p.road),
        width: 5,
        when: (k) => k !== "path" && k !== "pedestrian",
      },
      {
        layer: "transportation",
        stroke: css(p.path, 0.6),
        width: 1.2,
        when: (k) => k === "path" || k === "pedestrian",
      },
      { layer: "building", fill: css(p.building), stroke: css(p.buildingTop), width: 0.6 },
    ];
    for (const pass of passes)
      for (const { x, y, t } of tiles) {
        const layer = t.layers[pass.layer];
        if (!layer) continue;
        const k = (TILE_PX * scale) / layer.extent;
        const px = x * TILE_PX * scale - v.ox;
        const py = y * TILE_PX * scale - v.oy;
        for (let i = 0; i < layer.length; i++) {
          const feat = layer.feature(i);
          if (pass.when && !pass.when(String(feat.properties["class"] ?? ""))) continue;
          if (pass.fill && feat.type !== 3) continue;
          g.beginPath();
          for (const ring of feat.loadGeometry())
            for (const [j, pt] of ring.entries()) {
              if (j) g.lineTo(px + pt.x * k, py + pt.y * k);
              else g.moveTo(px + pt.x * k, py + pt.y * k);
            }
          if (pass.fill) {
            g.fillStyle = pass.fill;
            g.fill("evenodd");
          }
          if (pass.stroke) {
            g.strokeStyle = pass.stroke;
            g.lineWidth = pass.width ?? 1;
            g.lineCap = "round";
            g.lineJoin = "round";
            g.stroke();
          }
        }
      }
    // City parks are named in the POI layer; take the nearest one inside the zone.
    for (const { x, y, t } of tiles) {
      const poi = t.layers["poi"];
      if (!poi) continue;
      for (let i = 0; i < poi.length; i++) {
        const f = poi.feature(i);
        const name = f.properties["name:en"] ?? f.properties["name"];
        if (f.type !== 1 || f.properties["class"] !== "park" || typeof name !== "string") continue;
        const pt = f.loadGeometry()[0]?.[0];
        if (!pt) continue;
        const wx = (x + pt.x / poi.extent) * TILE_PX * scale;
        const wy = (y + pt.y / poi.extent) * TILE_PX * scale;
        const d =
          Math.hypot(wx - worldX(zone.lon, v.z), wy - worldY(zone.lat, v.z)) * metresPerPx(zone.lat, v.z);
        if (d <= zone.radiusM && (!place || d < place.d)) place = { name, d };
      }
    }
  } catch {
    // Offline: the overlay still draws on the plain ground colour.
  }
  return { canvas: c, place: place?.name ?? null };
}

const metresPerPx = (lat: number, z: number) => (156_543.03 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

function drawOverlay(
  g: CanvasRenderingContext2D,
  v: View,
  m: SceneProps["match"],
  f: Frame,
  trips: ReturnType<typeof tripsOf>,
  reduced: boolean,
) {
  const sx = (lon: number) => worldX(lon, v.z) - v.ox;
  const sy = (lat: number) => worldY(lat, v.z) - v.oy;
  const mpp = (156_543.03 * Math.cos((m.zone.lat * Math.PI) / 180)) / 2 ** v.z;
  const zr = m.zone.radiusM / mpp;
  const zx = sx(m.zone.lon);
  const zy = sy(m.zone.lat);

  // Outside the zone, dimmed.
  g.beginPath();
  g.rect(0, 0, v.w, v.h);
  g.arc(zx, zy, zr, 0, Math.PI * 2, true);
  g.fillStyle = css(p.shade, 0.5);
  g.fill("evenodd");
  g.beginPath();
  g.arc(zx, zy, zr, 0, Math.PI * 2);
  g.strokeStyle = css(p.zone, 0.5 + 0.5 * f.zoneGlow);
  g.lineWidth = 1.5 + 3 * f.zoneGlow;
  g.stroke();
  for (const s of m.safehouses) {
    g.beginPath();
    g.arc(sx(s.lon), sy(s.lat), s.radiusM / mpp, 0, Math.PI * 2);
    g.fillStyle = css(p.zone, 0.14);
    g.fill();
  }

  // Trails: the last 150 s, fading with age.
  const now = f.t / 1000;
  for (const trip of trips) {
    const focus = !!f.players[trip.index]?.role;
    g.lineWidth = focus ? 4 : 2.2;
    g.lineCap = "round";
    for (let i = 1; i < trip.path.length; i++) {
      const t = trip.timestamps[i] as number;
      if (t > now || now - t > 150) continue;
      const a = trip.path[i - 1] as [number, number];
      const b = trip.path[i] as [number, number];
      const fade = 1 - (now - t) / 150;
      g.strokeStyle = focus ? css(p.persimmon, 0.95 * fade) : css(p.trail, 0.42 * fade);
      g.beginPath();
      g.moveTo(sx(a[0]), sy(a[1]));
      g.lineTo(sx(b[0]), sy(b[1]));
      g.stroke();
    }
  }

  if (f.lock) {
    const k = lockFraction(f.lock.lock);
    const ax = sx(f.lock.from[0]);
    const ay = sy(f.lock.from[1]);
    const bx = sx(f.lock.to[0]);
    const by = sy(f.lock.to[1]);
    const sag = (1 - k) * 0.5 * Math.hypot(bx - ax, by - ay);
    g.beginPath();
    g.moveTo(ax, ay);
    g.quadraticCurveTo((ax + bx) / 2, (ay + by) / 2 - sag, bx, by);
    g.strokeStyle = css(p.persimmon, 0.45 + 0.55 * k);
    g.lineWidth = 1.5 + 3 * k;
    g.stroke();
  }

  for (const fl of f.flashes) {
    if (!fl.pos) continue;
    const grow = reduced ? 1 : 1 - 2 ** (-10 * fl.age);
    const fade = reduced ? 1 : 1 - fl.age;
    const color = fl.kind === "tag" ? p.persimmon : p.duskInk;
    g.beginPath();
    g.arc(sx(fl.pos[0]), sy(fl.pos[1]), (reduced ? 18 : 4 + 30 * grow) / mpp, 0, Math.PI * 2);
    g.fillStyle = css(color, 0.22 * fade);
    g.fill();
    g.strokeStyle = css(color, fade);
    g.lineWidth = 3;
    g.stroke();
  }

  g.textAlign = "center";
  g.textBaseline = "middle";
  for (const pl of [...f.players].sort((a, b) => Number(!!a.role) - Number(!!b.role))) {
    const pos = pl.pos ?? pl.ghost;
    if (!pos) continue;
    const x = sx(pos[0]);
    const y = sy(pos[1]);
    const r = pl.role ? 15 : 13;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = pl.pos ? (pl.role ? css(p.persimmon) : css(p.marker)) : css(p.dusk, 0.6);
    g.fill();
    g.lineWidth = pl.selected ? 3 : 2;
    g.strokeStyle = pl.selected ? css(p.duskInk) : pl.pos ? css(p.dusk) : css(p.markerOut);
    g.stroke();
    g.fillStyle = pl.pos ? css(p.ink) : css(p.markerOut);
    g.font = `700 ${pl.initials.length > 1 ? 11 : 13}px "Archivo Variable", sans-serif`;
    g.fillText(pl.initials, x, y + 0.5);
  }
}
