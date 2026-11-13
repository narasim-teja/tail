// The Chase on dusk: the brand's ambient scene (geometry from @tail/brand, shared with the
// phone app). You, persimmon with a fading trail, tail your target round a track inside a
// dotted zone; once a lap the gap closes and a ring lands. Used where a page would otherwise be
// one line of text (loading, private, not finished, missing, broken).
//
// One requestAnimationFrame loop writes the dots' attributes directly, so React does no work
// per frame. Reduced motion holds a still frame. Decorative: hidden from screen readers.

import { type ChaseTrack, chase, chaseGap, chasePoint } from "@tail/brand";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

const TRAIL = 7;
/** Phase step between trail dots, target and hunter. */
const STEP = { target: 0.012, hunter: 0.014 };
/** How long the tag ring stays up, as a share of a lap. */
const RING = 0.09;
/** The still frame: the hunter just behind the target, nearing the crossing. */
const STILL = 0.42;

const wrap = (u: number) => ((u % 1) + 1) % 1;

export function Chase({
  width = 400,
  height = 220,
  track = "eight",
  crowd = 3,
  reduced,
  className,
}: {
  width?: number;
  height?: number;
  track?: ChaseTrack;
  crowd?: number;
  reduced: boolean;
  className?: string;
}) {
  const svg = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const root = svg.current;
    if (!root) return;
    const q = (sel: string) => [...root.querySelectorAll<SVGCircleElement>(sel)];
    // Head first (data-i 0), whatever the paint order.
    const byIndex = (els: SVGCircleElement[]) =>
      els.sort((a, b) => Number(a.dataset["i"]) - Number(b.dataset["i"]));
    const targets = byIndex(q("[data-target]"));
    const hunters = byIndex(q("[data-hunter]"));
    const crowds = q("[data-crowd]");
    const ring = root.querySelector<SVGCircleElement>("[data-ring]");
    const at = (track_: ChaseTrack, u: number) => chasePoint(track_, wrap(u), width, height);
    const place = (el: SVGCircleElement | undefined, p: { x: number; y: number }) => {
      el?.setAttribute("cx", p.x.toFixed(2));
      el?.setAttribute("cy", p.y.toFixed(2));
    };
    const draw = (u: number) => {
      // Index 0 is the head; the rest trail behind it.
      for (const [i, el] of targets.entries()) place(el, at(track, u - i * STEP.target));
      for (const [i, el] of hunters.entries()) {
        const v = u - i * STEP.hunter;
        place(el, at(track, v - chaseGap(wrap(v))));
      }
      // The crowd walks a smaller copy of the other track, the other way round.
      const other: ChaseTrack = track === "eight" ? "loop" : "eight";
      for (const [k, el] of crowds.entries()) {
        const p = at(other, -u + k / Math.max(1, crowds.length) + 0.13);
        place(el, { x: width / 2 + (p.x - width / 2) * 0.62, y: height / 2 + (p.y - height / 2) * 0.62 });
      }
      if (ring) {
        const d = wrap(u - chase.tagAt);
        const on = d < RING;
        const k = d / RING;
        ring.setAttribute("opacity", on ? (0.9 * (1 - k)).toFixed(3) : "0");
        ring.setAttribute("r", on ? (9 * (1 + 2.4 * k)).toFixed(2) : "9");
      }
    };
    if (reduced) {
      draw(STILL);
      return;
    }
    const t0 = performance.now() - STILL * chase.lapMs;
    let raf = 0;
    const frame = (now: number) => {
      draw(((now - t0) / chase.lapMs) % 1);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [reduced, track, width, height]);

  const tagged = chasePoint(track, chase.tagAt, width, height);
  return (
    <svg
      ref={svg}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("block h-auto w-full overflow-visible", className)}
      aria-hidden="true"
    >
      <ellipse
        cx={width / 2}
        cy={height / 2}
        rx={width / 2 - 3}
        ry={height / 2 - 3}
        fill="none"
        stroke="var(--text-3)"
        strokeOpacity={0.6}
        strokeWidth={2}
        strokeDasharray="0.1 7"
        strokeLinecap="round"
      />
      {Array.from({ length: crowd }, (_, k) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the crowd is positional and fixed
        <circle key={k} data-crowd r={5.5} fill="var(--text)" opacity={0.18} />
      ))}
      <Runner kind="target" head={7} tint="var(--text)" />
      <circle
        data-ring
        cx={tagged.x}
        cy={tagged.y}
        r={9}
        fill="none"
        stroke="var(--persimmon)"
        strokeWidth={2}
        opacity={0}
      />
      <Runner kind="hunter" head={9} tint="var(--persimmon)" />
    </svg>
  );
}

/** A head and its fading trail; drawn tail first so the head sits on top. */
function Runner({ kind, head, tint }: { kind: "target" | "hunter"; head: number; tint: string }) {
  const data = kind === "target" ? { "data-target": "" } : { "data-hunter": "" };
  return (
    <>
      {Array.from({ length: TRAIL + 1 }, (_, n) => {
        const i = TRAIL - n;
        const r = i === 0 ? head : head * (0.85 - (i / TRAIL) * 0.55);
        const opacity = i === 0 ? 1 : 0.38 * (1 - i / (TRAIL + 1));
        return <circle key={i} {...data} data-i={i} r={r} fill={tint} opacity={opacity} />;
      })}
    </>
  );
}
