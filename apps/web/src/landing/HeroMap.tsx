// The hero's map panel: the place drawn from OpenStreetMap (map.ts) in the brand's colours, and
// on it a recorded match playing its first chase, as the phone's map panel draws a hunt
// (apps/mobile/src/ui/map.tsx): the dotted zone edge, the safehouse glyph on a paper disc, the
// hunter as the Trail mark on its paper disc pointing along its heading, the others as soft dots
// with their trails fading behind, and the strike ring where the tag lands.
//
// One requestAnimationFrame loop writes attributes directly, so React does no work per frame; it
// reports the hunter's lock, heat, head and clock only when one changes. It runs only while the
// panel is on screen and the tab is visible. Reduced motion draws one still frame: the strike.
//
// Without a map for the place (or one that doesn't cover the zone), the same marks are drawn on
// the plain zone.

import { icons, trail } from "@tail/brand";
import { useEffect, useMemo, useRef, useState } from "react";
import { type MapData, onMap } from "./map.ts";
import { at, headAt, lockAt, type Scene } from "./scene.ts";

const TRAIL = 7;
/** Match time between trail dots, tenths of a second. */
const TRAIL_STEP = 25;
/** Real time for the run-up to the tag, and for the strike after it, ms. */
const RUN_MS = 11_000;
const AFTER_MS = 2_800;
const FADE_MS = 500;
const RING_MS = 1_200;

const easeOut = (x: number) => 1 - (1 - x) ** 4;

/** Real ms into the loop → match time (tenths); fast through the quiet start, slowing into the tag. */
export function matchTime(chase: NonNullable<Scene["chase"]>, ms: number): number {
  if (ms <= RUN_MS) {
    const x = ms / RUN_MS;
    const w = 0.55 * x + 0.45 * (1 - (1 - x) ** 2);
    return chase.from + (chase.tag - chase.from) * w;
  }
  return chase.tag + (chase.to - chase.tag) * Math.min(1, (ms - RUN_MS) / AFTER_MS);
}

/** What the instruments beside the map show at a moment of the chase. */
export interface Reading {
  lock: number;
  heat: number;
  head: bigint;
  /** Match time, tenths of a second. */
  t: number;
}

export function readingAt(chase: NonNullable<Scene["chase"]>, t: number): Reading {
  return { lock: lockAt(chase.lock, t), heat: lockAt(chase.heat, t), head: headAt(chase.head, t), t };
}

/** The still frame Reduce Motion shows, and the first frame before the loop runs. */
export const stillTime = (chase: NonNullable<Scene["chase"]>) => chase.tag;

/** Compass heading (degrees, clockwise from north) from a to b. */
const bearing = (a: [number, number], b: [number, number]) =>
  (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;

const polyline = (d: number[]) => {
  let s = "";
  for (let i = 0; i < d.length; i += 2) s += `${i === 0 ? "M" : "L"}${d[i]} ${-(d[i + 1] as number)}`;
  return s;
};
const ring = (d: number[]) => `${polyline(d)}Z`;

/** Street-label length in px: tracked caps at the label's size. */
const labelPx = (name: string) => name.length * 7.1;

interface Frame {
  /** Visible box in map metres: west, north (svg y = −north), width, height. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Pixels per metre. */
  s: number;
}

export function HeroMap({
  scene,
  map,
  reduced,
  onReading,
}: {
  scene: Scene;
  map: MapData | null;
  reduced: boolean;
  onReading?: (r: Reading) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const chase = scene.chase;
  const R = scene.radius / 10;

  // Where the scene's zone sits on the map, and whether the map covers it at all.
  const placed = useMemo(() => {
    if (!map) return null;
    const [ox, oy] = onMap(map, scene.center[0], scene.center[1]);
    const [w, s, e, n] = map.extent;
    return ox > w && ox < e && oy > s && oy < n ? { map, ox, oy } : null;
  }, [map, scene]);
  const ox = placed?.ox ?? 0;
  const oy = placed?.oy ?? 0;
  const view = placed ? placed.map.view : [-R * 1.12, -R * 1.12, R * 2.24, R * 2.24];

  // The panel's size decides how much of the view shows (it fills the panel, cropping the long side).
  const [px, setPx] = useState<[number, number]>([560, 460]);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => {
      const r = e?.contentRect;
      if (r && r.width > 0 && r.height > 0) setPx([Math.round(r.width), Math.round(r.height)]);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const frame: Frame = useMemo(() => {
    const [vx, vy, vw, vh] = view as [number, number, number, number];
    const s = Math.max(px[0] / vw, px[1] / vh);
    const [w, h] = [px[0] / s, px[1] / s];
    const [cx, cy] = [vx + vw / 2, vy + vh / 2];
    return { x: cx - w / 2, y: -(cy + h / 2), w, h, s };
  }, [view, px]);
  const m = (p: number) => p / frame.s;

  const base = useMemo(() => {
    if (!placed) return null;
    const mp = placed.map;
    return {
      // One path per ring: overlapping rings drawn in opposite directions would cancel out under
      // the nonzero fill rule if they shared a path.
      parks: mp.parks.map(ring),
      water: mp.water.map(ring),
      roads: ([1, 2, 3] as const).map((c) =>
        mp.roads
          .filter((r) => r.c === c)
          .map((r) => polyline(r.d))
          .join(""),
      ),
      paths: mp.paths.map(polyline).join(""),
    };
  }, [placed]);

  // Labels that fit the visible box, nearest its middle, and don't run into each other.
  const labels = useMemo(() => {
    if (!placed) return [];
    const { x, y, w, h, s } = frame;
    const margin = 10 / s;
    const taken: [number, number, number][] = [];
    const free = (cx: number, cy: number, r: number) =>
      taken.every(([tx, ty, tr]) => Math.hypot(tx - cx, ty - cy) > tr + r);
    // Names give way to the game: none sits where the chase ends.
    if (chase) taken.push([chase.at[0] / 10 + ox, -(chase.at[1] / 10 + oy), 40 / s]);
    const out: {
      kind: "street" | "park" | "water" | "place";
      name: string;
      x: number;
      y: number;
      deg: number;
    }[] = [];
    for (const p of placed.map.places) {
      const [lx, ly] = [p.at[0], -p.at[1]];
      const half = (p.name.length * 7) / 2 / s;
      if (
        lx - half < x + margin ||
        lx + half > x + w - margin ||
        ly < y + margin * 2 ||
        ly > y + h - margin * 2
      )
        continue;
      if (!free(lx, ly, half)) continue;
      taken.push([lx, ly, half]);
      out.push({ kind: p.kind, name: p.name, x: lx, y: ly, deg: 0 });
    }
    const mid: [number, number] = [x + w / 2, y + h / 2];
    for (const st of placed.map.streets) {
      const half = labelPx(st.name) / 2 / s;
      const fits = st.at
        .map(([sx, sy, deg]) => ({ sx, sy: -sy, deg }))
        .filter(({ sx }) => sx - half > x + margin && sx + half < x + w - margin)
        .filter(({ sy }) => sy - half > y + margin && sy + half < y + h - margin)
        .filter(({ sx, sy }) => free(sx, sy, half))
        .sort((a, b) => Math.hypot(a.sx - mid[0], a.sy - mid[1]) - Math.hypot(b.sx - mid[0], b.sy - mid[1]));
      const best = fits[0];
      if (!best) continue;
      taken.push([best.sx, best.sy, half]);
      out.push({ kind: "street", name: st.name, x: best.sx, y: best.sy, deg: -best.deg });
    }
    return out;
  }, [placed, frame, chase, ox, oy]);

  useEffect(() => {
    const root = svg.current;
    if (!root || !chase) return;
    const k = 1 / frame.s;
    const toSvg = (p: [number, number]): [number, number] => [p[0] / 10 + ox, -(p[1] / 10 + oy)];
    const dots = scene.players.map((_, p) => [...root.querySelectorAll<SVGCircleElement>(`[data-p="${p}"]`)]);
    const names = scene.players.map((_, p) => root.querySelector<SVGTextElement>(`[data-name="${p}"]`));
    const marker = root.querySelector<SVGGElement>("[data-hunter]");
    const mark = root.querySelector<SVGGElement>("[data-mark]");
    const strike = root.querySelector<SVGCircleElement>("[data-ring]");
    const stage = root.querySelector<SVGGElement>("[data-stage]");
    let heading = 45;
    let shown: Reading | null = null;

    const draw = (t: number, ringK: number | null, fade: number) => {
      stage?.setAttribute("opacity", fade.toFixed(3));
      const heads = scene.players.map((_, p) => {
        const out = scene.out[p];
        const gone = out !== null && out !== undefined && t > out;
        let head: [number, number] | null = null;
        for (const el of dots[p] ?? []) {
          const i = Number(el.dataset["i"]);
          const pos = gone ? null : at(scene.tracks[p] ?? null, t - i * TRAIL_STEP, scene.gap);
          if (!pos) {
            el.setAttribute("visibility", "hidden");
            continue;
          }
          const [sx, sy] = toSvg(pos);
          if (i === 0) head = [sx, sy];
          el.setAttribute("visibility", "visible");
          el.setAttribute("cx", sx.toFixed(2));
          el.setAttribute("cy", sy.toFixed(2));
        }
        return head;
      });
      // The hunter's mark turns to the way it walks; standing still, it keeps its heading.
      const hunterAt = heads[chase.hunter];
      if (marker && mark) {
        if (hunterAt) {
          const track = scene.tracks[chase.hunter] ?? null;
          const now = at(track, t, scene.gap);
          const before = at(track, t - 40, scene.gap);
          if (now && before && Math.hypot(now[0] - before[0], now[1] - before[1]) > 6)
            heading = bearing(before, now);
          marker.setAttribute("visibility", "visible");
          marker.setAttribute("transform", `translate(${hunterAt[0].toFixed(2)} ${hunterAt[1].toFixed(2)})`);
          mark.setAttribute(
            "transform",
            `rotate(${(heading - 45).toFixed(1)}) scale(${((36 / 64) * k).toFixed(4)}) translate(-32 -32)`,
          );
        } else marker.setAttribute("visibility", "hidden");
      }
      // The target is named, as the hunt screen's strip names it, on the far side of its dot from
      // the hunter's mark so the two never collide. The hunter is you: the mark says so.
      const label = names[chase.target];
      const head = heads[chase.target];
      if (label) {
        if (!head) label.setAttribute("visibility", "hidden");
        else {
          const o = heads[chase.hunter];
          const dx = o ? head[0] - o[0] : 0;
          const dy = o ? head[1] - o[1] : 1;
          const len = Math.hypot(dx, dy);
          const [ux, uy] = len < 0.5 ? [0, 1] : [dx / len, dy / len];
          const gap = 16 * k;
          label.setAttribute("visibility", "visible");
          label.setAttribute("text-anchor", ux < -0.4 ? "end" : ux > 0.4 ? "start" : "middle");
          label.setAttribute("x", (head[0] + ux * gap).toFixed(2));
          label.setAttribute(
            "y",
            (head[1] + uy * gap + (uy > 0.4 ? 9 * k : uy < -0.4 ? 0 : 4 * k)).toFixed(2),
          );
        }
      }
      if (strike) {
        if (ringK === null || ringK >= 1) strike.setAttribute("opacity", "0");
        else {
          const [rx, ry] = toSvg(chase.at);
          strike.setAttribute("cx", rx.toFixed(2));
          strike.setAttribute("cy", ry.toFixed(2));
          strike.setAttribute("r", ((12 + 46 * easeOut(ringK)) * k).toFixed(2));
          strike.setAttribute("opacity", (1 - ringK).toFixed(3));
        }
      }
      const r = readingAt(chase, t);
      const sec = Math.floor(t / 10);
      if (
        onReading &&
        (!shown ||
          shown.lock !== r.lock ||
          shown.heat !== r.heat ||
          shown.head !== r.head ||
          Math.floor(shown.t / 10) !== sec)
      ) {
        shown = r;
        onReading(r);
      }
    };

    if (reduced) {
      draw(stillTime(chase), 0.3, 1);
      return;
    }
    const loop = RUN_MS + AFTER_MS;
    let elapsed = 0;
    let last: number | null = null;
    let raf = 0;
    let onScreen = false;
    const frameFn = (now: number) => {
      if (last !== null) elapsed = (elapsed + now - last) % loop;
      last = now;
      const fade = Math.max(0, Math.min(1, elapsed / FADE_MS, (loop - elapsed) / FADE_MS));
      const ringK = elapsed >= RUN_MS ? (elapsed - RUN_MS) / RING_MS : null;
      draw(matchTime(chase, elapsed), ringK, fade);
      raf = requestAnimationFrame(frameFn);
    };
    const run = () => {
      cancelAnimationFrame(raf);
      last = null;
      if (onScreen && !document.hidden) raf = requestAnimationFrame(frameFn);
    };
    const io =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            onScreen = entries.some((e) => e.isIntersecting);
            run();
          });
    if (io) io.observe(root);
    else onScreen = true;
    document.addEventListener("visibilitychange", run);
    // The first frame is drawn at once, so the panel is never empty before the loop starts.
    draw(chase.from, null, 1);
    run();
    return () => {
      cancelAnimationFrame(raf);
      io?.disconnect();
      document.removeEventListener("visibilitychange", run);
    };
  }, [scene, chase, reduced, onReading, frame, ox, oy]);

  const hunter = chase?.hunter ?? -1;
  const target = chase?.target ?? -1;
  const zx = ox;
  const zy = -oy;
  return (
    <div ref={box} className="l-map-box">
      <svg
        ref={svg}
        className="l-map-svg"
        viewBox={`${frame.x.toFixed(2)} ${frame.y.toFixed(2)} ${frame.w.toFixed(2)} ${frame.h.toFixed(2)}`}
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
      >
        <rect x={frame.x} y={frame.y} width={frame.w} height={frame.h} className="l-map-land" />
        {base && (
          <g className="l-map-base">
            <g className="l-map-park">
              {base.parks.map((d) => (
                <path key={d} d={d} />
              ))}
            </g>
            <path d={base.paths} className="l-map-path" strokeWidth={m(1.6)} />
            <g className="l-map-water">
              {base.water.map((d) => (
                <path key={d} d={d} />
              ))}
            </g>
            <path d={base.roads[2]} className="l-map-road" strokeWidth={m(5)} />
            <path d={base.roads[1]} className="l-map-road" strokeWidth={m(6.5)} />
            <path d={base.roads[0]} className="l-map-road" strokeWidth={m(8.5)} />
          </g>
        )}
        <g className="l-map-labels">
          {labels.map((l) => (
            <text
              key={`${l.kind}:${l.name}`}
              className={`l-map-label l-map-label-${l.kind}`}
              fontSize={m(l.kind === "street" ? 9.5 : 11.5)}
              strokeWidth={m(3)}
              letterSpacing={l.kind === "street" ? m(1.1) : 0}
              textAnchor="middle"
              transform={`translate(${l.x.toFixed(1)} ${l.y.toFixed(1)}) rotate(${l.deg})`}
              dy={m(3.4)}
            >
              {l.name}
            </text>
          ))}
        </g>
        <circle
          cx={zx}
          cy={zy}
          r={R}
          className="l-map-zone"
          strokeWidth={m(2.5)}
          strokeDasharray={`${m(2.5)} ${m(7)}`}
        />
        {scene.safehouses.map(([hx, hy]) => (
          <g
            key={`${hx}:${hy}`}
            transform={`translate(${(hx / 10 + ox).toFixed(2)} ${(-(hy / 10 + oy)).toFixed(2)})`}
          >
            <circle r={m(15)} className="l-map-pin" strokeWidth={m(1.5)} />
            <g
              transform={`scale(${(m(18) / 24).toFixed(4)}) translate(-12 -12)`}
              className="l-map-pin-icon"
              strokeWidth={1.75}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: the brand's own static icon markup
              dangerouslySetInnerHTML={{ __html: icons.safehouse }}
            />
          </g>
        ))}
        <g data-stage>
          {scene.players.map((_, p) => {
            const role = p === hunter ? "hunter" : p === target ? "target" : "crowd";
            const r = role === "target" ? 6.5 : role === "crowd" ? 5 : 4;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: one runner per player, in player order
              <g key={p} className={`l-runner l-runner-${role}`}>
                {Array.from({ length: TRAIL + 1 }, (_, n) => {
                  const i = TRAIL - n;
                  // The hunter's own dot is its mark, drawn below; its trail still fades behind it.
                  if (role === "hunter" && i === 0)
                    return <circle key={i} data-p={p} data-i={i} r={0} visibility="hidden" />;
                  const rr = i === 0 ? r : r * (0.78 - (i / TRAIL) * 0.45);
                  return (
                    <circle
                      key={i}
                      data-p={p}
                      data-i={i}
                      r={m(rr)}
                      opacity={i === 0 ? 1 : 0.5 * (1 - i / (TRAIL + 1))}
                      strokeWidth={i === 0 ? m(2.5) : 0}
                      className={i === 0 ? "l-runner-head" : undefined}
                      visibility="hidden"
                    />
                  );
                })}
              </g>
            );
          })}
          {chase && <circle data-ring r={m(12)} className="l-map-ring" strokeWidth={m(3)} opacity={0} />}
          {chase && (
            <g data-hunter visibility="hidden">
              <circle r={m(24)} className="l-map-halo" />
              <g data-mark>
                <path d={trail.tail} className="l-map-mark" fillOpacity={0.38} />
                <circle cx={trail.dot.cx} cy={trail.dot.cy} r={trail.dot.r} className="l-map-mark" />
              </g>
            </g>
          )}
          {chase && (
            <text
              data-name={target}
              className="l-map-name"
              fontSize={m(12)}
              strokeWidth={m(3.5)}
              visibility="hidden"
            >
              {scene.players[target]}
            </text>
          )}
        </g>
      </svg>
      {placed && (
        // OpenStreetMap's licence asks for this credit wherever its data is shown, at the map.
        <a className="l-osm" href="https://www.openstreetmap.org/copyright" rel="noopener">
          Map data © OpenStreetMap
        </a>
      )}
    </div>
  );
}
