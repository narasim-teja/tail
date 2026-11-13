// The cold open: as the map draws and the film starts, the place and the match line come up
// large in the middle, hold a moment, and hand over to the title in the corner. Never blocks a
// click, and leaves the page when its animation ends. Not shown with reduced motion, or when
// the link opens the film midway (`?t=`).

import { useState } from "react";
import { minutes, money } from "../lib/format.ts";
import { useStore } from "../lib/store.ts";
import { useReplay } from "./context.tsx";
import { TrailMark } from "./icons.tsx";

export function Intro({ place }: { place: string }) {
  const { match, verify } = useReplay();
  const decimals = useStore(verify, (s) => s.token.decimals);
  const [done, setDone] = useState(false);
  if (done) return null;
  return (
    <div
      aria-hidden="true"
      onAnimationEnd={(e) => e.target === e.currentTarget && setDone(true)}
      className="tail-intro pointer-events-none absolute inset-0 z-chrome grid place-items-center px-6"
      style={{
        background:
          "radial-gradient(ellipse 40rem 18rem at 50% 50%, oklch(from var(--scrim) l c h / 0.7), transparent 75%)",
      }}
    >
      <div className="flex flex-col items-center text-center">
        <TrailMark className="size-9" />
        <p className="over-map mt-4 text-[clamp(2.5rem,7vw,5.5rem)] font-bold leading-[0.95] tracking-[-0.025em] text-balance [font-stretch:112%]">
          {place}
        </p>
        <p className="over-map numeral mt-4 text-[clamp(0.9375rem,1.6vw,1.25rem)] text-text-2">
          {match.players.length} players · {minutes(match.durationMs)} · {money(match.stake, decimals)} USDC
          each
        </p>
      </div>
    </div>
  );
}
