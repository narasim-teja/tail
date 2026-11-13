// The hunt's readouts, redrawn for the web from the phone's (apps/mobile/src/ui/game.tsx): the
// lock is a segmented 270° arc round a giant numeral, heat a segmented bar with its own numeral.
// Never colour alone: filled segments are solid, empty ones outlined, and a number says the same.

import { iconSvg } from "@tail/brand";
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

/** The lock arc's segments, for a ring of radius r and width w. */
export function lockSegments(max: number, c: number, r: number, w: number, gap = 7): string[] {
  const seg = (ARC_SWEEP - gap * (max - 1)) / max;
  return Array.from({ length: max }, (_, i) => {
    const a0 = ARC_START + i * (seg + gap);
    return sectorPath(c, c, r - w, r, a0, a0 + seg);
  });
}

export function GameIcon({ name, size = 18 }: { name: Parameters<typeof iconSvg>[0]; size?: number }) {
  return (
    <span
      className="l-icon"
      aria-hidden="true"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: the brand's own static icon markup
      dangerouslySetInnerHTML={{ __html: iconSvg(name, { size }) }}
    />
  );
}

/**
 * Steps a readout from 0 up to `to` once it scrolls into view, one step per `ms`, then holds.
 * Reduced motion, and a page that can't watch for it, show `to` from the start.
 */
export function useClimb(to: number, reduced: boolean, ms = 520) {
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

export function LockArc({
  value,
  max,
  alt,
  tone = "day",
  label = "Lock",
}: {
  value: number;
  max: number;
  /** What the picture shows once it has climbed, for screen readers. */
  alt: string;
  /** strike: on the persimmon takeover the filled segments turn ink, as on the phone. */
  tone?: "day" | "strike";
  label?: string;
}) {
  const size = 320;
  const c = size / 2;
  const segs = lockSegments(max, c, c - 2, 34);
  return (
    <div className="l-lock" data-tone={tone} role="img" aria-label={alt}>
      <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        {segs.map((d, i) => (
          <path
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reorder
            key={i}
            d={d}
            className={i < value ? "l-seg-on" : "l-seg-off"}
          />
        ))}
      </svg>
      <div className="l-lock-face" aria-hidden="true">
        <span className="l-eyebrow">
          <GameIcon name="lock" size={16} />
          {label}
        </span>
        <span className="l-lock-num">
          {value}
          <span className="l-lock-of">/{max}</span>
        </span>
      </div>
    </div>
  );
}

export function HeatBar({
  value,
  max,
  alt,
  children,
}: {
  value: number;
  max: number;
  alt: string;
  children?: ReactNode;
}) {
  return (
    <div className="l-heat" role="img" aria-label={alt}>
      <div className="l-heat-head" aria-hidden="true">
        <span className="l-eyebrow">
          <GameIcon name="heat" size={16} />
          Heat
        </span>
        <span className="l-heat-num">{value}</span>
      </div>
      <div
        className="l-heat-bar"
        aria-hidden="true"
        data-hot={value >= max - 1 && value > 0 ? "" : undefined}
      >
        {Array.from({ length: max }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reorder
          <span key={i} className={`l-heat-seg ${i < value ? "l-heat-on" : "l-heat-off"}`} />
        ))}
      </div>
      {children}
    </div>
  );
}
