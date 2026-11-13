// The hero: a recorded match drawn from its scene (scene.ts), playing its first chase on a loop.
// Every player is the Trail mark (a dot, its trail fading behind it) on the path they really
// walked, inside the dotted zone; the paths the whole match walked lie faint underneath, so the
// park draws itself. The hunter is persimmon, its lock arc filling from the logged contacts; at
// the tag a ring lands where the target was. The camera starts on the whole zone, pushes in on
// the chase as the lock fills, and pulls back out before the loop starts over.
//
// One requestAnimationFrame loop writes attributes directly, so React does no work per frame. It
// runs only while the picture is on screen and the tab is visible. Reduced motion draws one still
// frame: the moment of the strike, both players still on the board.

import { LOCK_EPOCHS } from "@tail/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { lockSegments } from "./instruments.tsx";
import { at, lockAt, type Scene } from "./scene.ts";

const SIZE = 640;
const C = SIZE / 2;
/** The zone's radius in the picture. */
const R = 300;
const TRAIL = 8;
/** Match time between trail dots, tenths of a second. */
const TRAIL_STEP = 22;
/** Real time for the run-up to the tag, and for the strike after it, ms. */
const RUN_MS = 10_500;
const AFTER_MS = 2_600;
/** The pull back out to the whole zone, while the stage fades, ms. */
const PULL_MS = 1_300;
const FADE_MS = 450;
/** The camera's push: when it starts and how long it takes, ms; and how far it goes. */
const PUSH_AT = 1_400;
const PUSH_MS = 5_600;
const ZOOM = 2.4;
const RING_MS = 1_100;

/** The lock arc round the hunter: its radius in the picture. */
const LOCK_R = 36;

const easeOut = (x: number) => 1 - (1 - x) ** 4;

/** Real ms into the loop → match time (tenths); fast through the quiet start, slowing into the tag. */
function matchTime(chase: NonNullable<Scene["chase"]>, ms: number): number {
  if (ms <= RUN_MS) {
    const x = ms / RUN_MS;
    const w = 0.55 * x + 0.45 * (1 - (1 - x) ** 2);
    return chase.from + (chase.tag - chase.from) * w;
  }
  return chase.tag + (chase.to - chase.tag) * Math.min(1, (ms - RUN_MS) / AFTER_MS);
}

/** The camera's zoom, real ms into the loop. */
function zoomAt(ms: number): number {
  const loop = RUN_MS + AFTER_MS + PULL_MS;
  if (ms > loop - PULL_MS) return 1 + (ZOOM - 1) * (1 - easeOut((ms - (loop - PULL_MS)) / PULL_MS));
  return 1 + (ZOOM - 1) * easeOut(Math.min(1, Math.max(0, (ms - PUSH_AT) / PUSH_MS)));
}

export function HeroScene({
  scene,
  reduced,
  onLock,
}: {
  scene: Scene;
  reduced: boolean;
  /** Each change of the hunter's lock and the match clock (tenths), for the readout beside it. */
  onLock?: (n: number, t: number) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  // Marks keep their size on screen: on a narrow phone the picture shrinks, so they grow in it.
  const [u, setU] = useState(1);
  useEffect(() => {
    const el = svg.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => {
      const w = e?.contentRect.width ?? 0;
      if (w > 0) setU(Math.round(Math.min(1.7, Math.max(1, 560 / w)) * 20) / 20);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const k = R / scene.radius;
  // The whole-zone drawing; the camera moves it as one (cam), the dots are placed through it.
  const px = (x: number) => C + x * k;
  const py = (y: number) => C - y * k;
  const chase = scene.chase;

  // The whole match's walked paths, drawn once.
  const ghosts = useMemo(() => {
    const kk = R / scene.radius;
    return scene.tracks.map((tr) => {
      if (!tr) return "";
      let d = "";
      let prevT = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < tr.length; i += 3) {
        const t = tr[i] as number;
        const x = C + (tr[i + 1] as number) * kk;
        const y = C - (tr[i + 2] as number) * kk;
        d += `${t - prevT > scene.gap ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
        prevT = t;
      }
      return d;
    });
  }, [scene]);

  useEffect(() => {
    const root = svg.current;
    if (!root || !chase) return;
    const runners = scene.players.map((_, p) => [
      ...root.querySelectorAll<SVGCircleElement>(`[data-p="${p}"]`),
    ]);
    const labels = scene.players.map((_, p) => root.querySelector<SVGTextElement>(`[data-label="${p}"]`));
    const lock = root.querySelector<SVGGElement>("[data-lock]");
    const segs = [...root.querySelectorAll<SVGPathElement>("[data-seg]")];
    const ring = root.querySelector<SVGCircleElement>("[data-ring]");
    const stage = root.querySelector<SVGGElement>("[data-stage]");
    const ground = root.querySelector<SVGGElement>("[data-ground]");
    let shownLock = -1;
    let shownSec = -1;
    // Camera: zoom z on a focus that slides from the zone's centre to where the tag lands.
    let z = 1;
    let fx = 0;
    let fy = 0;
    const sx = (x: number) => C + (x - fx) * k * z;
    const sy = (y: number) => C - (y - fy) * k * z;

    const draw = (t: number, ringK: number | null, fade: number, zoom: number) => {
      z = zoom;
      const m = (zoom - 1) / (ZOOM - 1);
      fx = chase.at[0] * m;
      fy = chase.at[1] * m;
      ground?.setAttribute(
        "transform",
        `translate(${(C - (C + fx * k) * z).toFixed(2)} ${(C - (C - fy * k) * z).toFixed(2)}) scale(${z.toFixed(4)})`,
      );
      stage?.setAttribute("opacity", fade.toFixed(3));
      const heads: ([number, number] | null)[] = scene.players.map((_, p) => {
        const out = scene.out[p];
        const gone = out !== null && out !== undefined && t > out;
        let head: [number, number] | null = null;
        for (const el of runners[p] ?? []) {
          const i = Number(el.dataset["i"]);
          const pos = gone ? null : at(scene.tracks[p] ?? null, t - i * TRAIL_STEP, scene.gap);
          if (i === 0) head = pos && [sx(pos[0]), sy(pos[1])];
          if (!pos) {
            el.setAttribute("visibility", "hidden");
            continue;
          }
          el.setAttribute("visibility", "visible");
          el.setAttribute("cx", sx(pos[0]).toFixed(1));
          el.setAttribute("cy", sy(pos[1]).toFixed(1));
        }
        return head;
      });
      // Each name sits on the far side of its dot from the other player's, so the two never collide.
      for (const [p, other] of [
        [chase.hunter, chase.target],
        [chase.target, chase.hunter],
      ] as const) {
        const label = labels[p];
        const head = heads[p];
        if (!label) continue;
        if (!head) {
          label.setAttribute("visibility", "hidden");
          continue;
        }
        const o = heads[other];
        const dx = o ? head[0] - o[0] : 1;
        const dy = o ? head[1] - o[1] : -1;
        const len = Math.hypot(dx, dy) || 1;
        const [ux, uy] = len < 1 ? [1, -1] : [dx / len, dy / len];
        label.setAttribute("visibility", "visible");
        label.setAttribute("text-anchor", ux < -0.3 ? "end" : ux > 0.3 ? "start" : "middle");
        label.setAttribute("x", (head[0] + ux * 26 * u).toFixed(1));
        label.setAttribute("y", (head[1] + (uy * 26 + 5) * u).toFixed(1));
      }
      const hunterHead = heads[chase.hunter];
      if (lock) {
        if (hunterHead) {
          lock.setAttribute("visibility", "visible");
          lock.setAttribute(
            "transform",
            `translate(${(hunterHead[0] - LOCK_R * u).toFixed(1)} ${(hunterHead[1] - LOCK_R * u).toFixed(1)}) scale(${u})`,
          );
        } else lock.setAttribute("visibility", "hidden");
      }
      const n = lockAt(chase.lock, t);
      if (n !== shownLock) {
        segs.forEach((s, i) => {
          s.setAttribute("class", i < n ? "l-seg-on" : "l-seg-off");
        });
        shownLock = n;
      }
      const sec = Math.floor(t / 10);
      if (onLock && sec !== shownSec) {
        shownSec = sec;
        onLock(n, t);
      }
      if (ring) {
        if (ringK === null || ringK >= 1) ring.setAttribute("opacity", "0");
        else {
          const e = easeOut(ringK);
          ring.setAttribute("cx", sx(chase.at[0]).toFixed(1));
          ring.setAttribute("cy", sy(chase.at[1]).toFixed(1));
          ring.setAttribute("r", ((10 + 52 * e) * u).toFixed(1));
          ring.setAttribute("opacity", (1 - ringK).toFixed(3));
        }
      }
    };

    if (reduced) {
      draw(chase.tag, 0.32, 1, ZOOM);
      return;
    }

    const loop = RUN_MS + AFTER_MS + PULL_MS;
    let elapsed = 0;
    let last: number | null = null;
    let raf = 0;
    let onScreen = false;
    const frame = (now: number) => {
      if (last !== null) elapsed = (elapsed + now - last) % loop;
      last = now;
      const fade = Math.min(1, elapsed / FADE_MS, (loop - elapsed) / PULL_MS);
      const ringK = elapsed >= RUN_MS ? (elapsed - RUN_MS) / RING_MS : null;
      draw(matchTime(chase, elapsed), ringK, Math.max(0, fade), zoomAt(elapsed));
      raf = requestAnimationFrame(frame);
    };
    const run = () => {
      cancelAnimationFrame(raf);
      last = null;
      if (onScreen && !document.hidden) raf = requestAnimationFrame(frame);
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
    // The first frame is drawn at once, so the picture is never empty before the loop starts.
    draw(chase.from, null, 1, 1);
    run();
    return () => {
      cancelAnimationFrame(raf);
      io?.disconnect();
      document.removeEventListener("visibilitychange", run);
    };
  }, [scene, chase, reduced, onLock, u, k]);

  const hunter = chase?.hunter ?? -1;
  const target = chase?.target ?? -1;
  return (
    <svg ref={svg} viewBox={`0 0 ${SIZE} ${SIZE}`} className="l-scene-svg" aria-hidden="true">
      <g data-ground>
        <circle cx={C} cy={C} r={R} className="l-zone" />
        <g className="l-ghosts">
          {ghosts.map((d, p) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: one path per player, in player order
            <path key={p} d={d} />
          ))}
        </g>
      </g>
      <g data-stage>
        {scene.players.map((_, p) => {
          const role = p === hunter ? "hunter" : p === target ? "target" : "crowd";
          const head = (role === "hunter" ? 9 : role === "target" ? 8 : 6) * u;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: one runner per player, in player order
            <g key={p} className={`l-runner l-${role}`}>
              {Array.from({ length: TRAIL + 1 }, (_, n) => {
                const i = TRAIL - n;
                const r = i === 0 ? head : head * (0.82 - (i / TRAIL) * 0.5);
                const opacity = i === 0 ? 1 : 0.42 * (1 - i / (TRAIL + 1));
                return (
                  <circle
                    key={i}
                    data-p={p}
                    data-i={i}
                    r={r}
                    opacity={opacity}
                    cx={C}
                    cy={C}
                    visibility="hidden"
                  />
                );
              })}
            </g>
          );
        })}
        {chase && (
          <circle
            data-ring
            cx={px(chase.at[0])}
            cy={py(chase.at[1])}
            r={10}
            className="l-ring"
            strokeWidth={3 * u}
            opacity={0}
          />
        )}
        {chase && (
          <g data-lock visibility="hidden">
            {lockSegments(LOCK_EPOCHS, LOCK_R, LOCK_R - 2, 6, 10).map((d, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
              <path key={i} data-seg d={d} className="l-seg-off" />
            ))}
          </g>
        )}
        {[hunter, target].map((p) =>
          p < 0 ? null : (
            <text key={p} data-label={p} className="l-scene-label" fontSize={15 * u} visibility="hidden">
              {scene.players[p]}
            </text>
          ),
        )}
      </g>
    </svg>
  );
}
