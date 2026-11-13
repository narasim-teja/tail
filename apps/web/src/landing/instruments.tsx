// The hunt's readouts, drawn as the phone draws them (apps/mobile/src/ui/game.tsx): the lock is a
// 270° arc of segments 7° apart round a giant numeral, its ring 24/232 of the arc's size wide;
// heat is a row of 22-point segments, 6 apart, radius 6, with its own numeral; each carries its
// brand icon and tracked caps label. Sizes scale from the phone's by one factor (--u in the
// stylesheet), so a bigger instrument is the same instrument. Never colour alone: filled segments
// are solid, empty ones outlined, and a number says the same.

import { type IconName, iconSvg } from "@tail/brand";
import { type ReactNode, useEffect, useRef, useState } from "react";

/** SVG path of an annular sector between two angles (degrees, 0 = north, clockwise). */
export function sectorPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => {
    const t = ((a - 90) * Math.PI) / 180;
    return `${(cx + r * Math.cos(t)).toFixed(2)} ${(cy + r * Math.sin(t)).toFixed(2)}`;
  };
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}

const ARC_START = -135;
const ARC_SWEEP = 270;
const GAP = 7;
/** The phone's arc: 232 points, its ring from 26 to 2 in from the edge. */
const ARC = 232;

/** The lock arc's segments, on the phone's 232-unit box. */
export function lockSegments(max: number): string[] {
  const c = ARC / 2;
  const seg = (ARC_SWEEP - GAP * (max - 1)) / max;
  return Array.from({ length: max }, (_, i) => {
    const a0 = ARC_START + i * (seg + GAP);
    return sectorPath(c, c, c - 26, c - 2, a0, a0 + seg);
  });
}

export function GameIcon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <span
      className="l-icon"
      aria-hidden="true"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: the brand's own static icon markup
      dangerouslySetInnerHTML={{ __html: iconSvg(name, { size }) }}
    />
  );
}

/** The phone's caps label with its icon: LOCK, HEAT, HEAD. */
export function Eyebrow({
  icon,
  children,
  muted,
}: {
  icon?: IconName;
  children: ReactNode;
  muted?: boolean;
}) {
  return (
    <span className={muted ? "l-eyebrow l-eyebrow-muted" : "l-eyebrow"}>
      {icon && <GameIcon name={icon} />}
      {children}
    </span>
  );
}

/**
 * Steps a readout from 0 up to `to` once it scrolls into view, one step per `ms`, then holds.
 * Reduced motion, and a page that can't watch for it, show `to` from the start.
 */
export function useClimb(to: number, reduced: boolean, ms = 560) {
  const ref = useRef<HTMLDivElement>(null);
  const [n, setN] = useState(reduced ? to : 0);
  useEffect(() => {
    const el = ref.current;
    if (reduced || !el || typeof IntersectionObserver === "undefined") {
      setN(to);
      return;
    }
    let timer: ReturnType<typeof setInterval> | undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        let k = 0;
        setN(0);
        timer = setInterval(() => {
          k += 1;
          setN(k);
          if (k >= to) clearInterval(timer);
        }, ms);
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      clearInterval(timer);
    };
  }, [to, reduced, ms]);
  return { ref, n };
}

/** LOCK: your grip on your target. `alt` is what a screen reader hears; omit it inside a group that speaks. */
export function LockArc({ value, max, alt }: { value: number; max: number; alt?: string }) {
  return (
    <div className="l-lock" {...(alt ? { role: "img", "aria-label": alt } : { "aria-hidden": true })}>
      <svg viewBox={`0 0 ${ARC} ${ARC}`} aria-hidden="true">
        {lockSegments(max).map((d, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reorder
          <path key={i} d={d} className={i < value ? "l-seg-on" : "l-seg-off"} />
        ))}
      </svg>
      <div className="l-lock-face" aria-hidden="true">
        <Eyebrow icon="lock">Lock</Eyebrow>
        <span className="l-lock-num">
          {value}
          <span className="l-lock-of">/{max}</span>
        </span>
      </div>
    </div>
  );
}

/** HEAT: someone's grip on you. */
export function HeatBar({ value, max, alt }: { value: number; max: number; alt?: string }) {
  return (
    <div className="l-heat" {...(alt ? { role: "img", "aria-label": alt } : { "aria-hidden": true })}>
      <div className="l-heat-head" aria-hidden="true">
        <Eyebrow icon="heat">Heat</Eyebrow>
        <span className="l-number">{value}</span>
      </div>
      <div
        className="l-heat-bar"
        aria-hidden="true"
        data-hot={value >= max - 1 && value > 0 ? "" : undefined}
      >
        {Array.from({ length: max }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reorder
          <span key={i} className={i < value ? "l-heat-seg l-heat-on" : "l-heat-seg"} />
        ))}
      </div>
    </div>
  );
}

/** HEAD: what you are worth right now. */
export function HeadValue({ value }: { value: string }) {
  return (
    <div className="l-head" aria-hidden="true">
      <Eyebrow icon="head">Head</Eyebrow>
      <span className="l-number">{value}</span>
    </div>
  );
}
