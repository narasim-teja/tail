// Bottom: play/pause, the match clock, the scrubber with the match's events on it, and the speed.
// Tags are the only persimmon ticks. Each event tick shows its verification mark once checked.

import { Pause, Play, RotateCcw } from "lucide-react";
import { useRef } from "react";
import { cn } from "@/lib/utils";
import { Button } from "../components/ui/button.tsx";
import { Slider } from "../components/ui/slider.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.tsx";
import { clock } from "../lib/format.ts";
import { useStore } from "../lib/store.ts";
import type { MatchEvent } from "../model/match.ts";
import { eventLine, statusLabel } from "../replay/copy.ts";
import type { SpeedMode } from "../replay/state.ts";
import { useReplay } from "./context.tsx";
import { GameIcon, Mark } from "./icons.tsx";

const MODES: SpeedMode[] = ["film", 1, 10, 60];
/** Jump a little before an event so the lead-up plays. */
export const leadIn = (e: MatchEvent) => (e.kind === "tag" ? 30_000 : e.kind === "forfeit" ? 20_000 : 4_000);

export function Timeline({ compact }: { compact: boolean }) {
  const { match, play, seek, toggle } = useReplay();
  const playing = useStore(play, (s) => s.playing);
  const ended = useStore(play, (s) => s.ended);
  const mode = useStore(play, (s) => s.mode);
  const speed = useStore(play, (s) => Math.round(s.speed));
  const second = useStore(play, (s) => Math.floor(s.t / 1000));
  const dur = match.durationMs;

  const cycle = () => {
    const i = MODES.indexOf(play.get().mode);
    play.set({ mode: MODES[(i + 1) % MODES.length] as SpeedMode });
  };

  const playButton = (
    <Button
      variant="solid"
      size="icon"
      onClick={() => (ended ? seek(0, true) : toggle())}
      aria-label={ended ? "Watch again" : playing ? "Pause" : "Play"}
      aria-keyshortcuts="Space"
      className="size-11"
    >
      {ended ? (
        <RotateCcw />
      ) : playing ? (
        <Pause className="fill-current" />
      ) : (
        <Play className="ml-0.5 fill-current" />
      )}
    </Button>
  );
  const clockText = (
    <span
      className="over-map numeral w-[4.5ch] shrink-0 text-right text-[1.25rem] font-semibold"
      aria-hidden="true"
    >
      {clock(second * 1000)}
    </span>
  );
  const speedButton = (
    <Button
      variant="ghost"
      size="sm"
      onClick={cycle}
      aria-label={
        mode === "film"
          ? `Speed: film, now ${speed} times. Change speed`
          : `Speed: ${mode} times. Change speed`
      }
      className="numeral min-w-[4.75rem] justify-center px-2.5"
    >
      {mode === "film" ? (
        <>
          <span className="text-text">{speed}×</span>
          <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-text-3">auto</span>
        </>
      ) : (
        <span className="text-text">{mode}×</span>
      )}
    </Button>
  );

  if (compact)
    return (
      <div className="pointer-events-auto flex flex-col gap-1">
        <Rail compact />
        <div className="flex items-center gap-3">
          {playButton}
          {clockText}
          <span className="over-map numeral -ml-1 text-[0.875rem] text-text-3" aria-hidden="true">
            / {clock(dur)}
          </span>
          <span className="flex-1" />
          {speedButton}
        </div>
      </div>
    );
  return (
    <div className="pointer-events-auto flex items-center gap-4">
      {playButton}
      {clockText}
      <Rail compact={false} />
      <span className="over-map numeral w-[4.5ch] shrink-0 text-[0.9375rem] text-text-3" aria-hidden="true">
        {clock(dur)}
      </span>
      {speedButton}
    </div>
  );
}

/** The scrubber with event ticks above it and minute checkpoints below. */
function Rail({ compact }: { compact: boolean }) {
  const { match, verify, seek, select } = useReplay();
  const statuses = useStore(verify, (s) => s.statuses);
  const dur = match.durationMs;
  const marked = match.events.filter((e) => e.kind === "tag" || e.kind === "hint" || e.kind === "forfeit");
  const checkpoints = match.events.filter((e) => e.kind === "checkpoint");
  return (
    <div className="relative min-w-0 flex-1 pt-6">
      <Scrubber />
      <ol aria-label="Events" className="pointer-events-none absolute inset-x-0 top-0 h-6">
        {checkpoints.map((e) => (
          <li
            key={e.index}
            aria-hidden="true"
            className="absolute bottom-[-0.875rem] h-[7px] w-px bg-rail"
            style={{ left: `${(100 * e.t) / dur}%` }}
          />
        ))}
        {marked.map((e) => (
          <li
            key={e.index}
            className="absolute bottom-0 -translate-x-1/2"
            style={{ left: `${(100 * e.t) / dur}%` }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => {
                    seek(Math.max(0, e.t - leadIn(e)), true);
                    select({ kind: "event", index: e.index });
                  }}
                  aria-label={`${eventLine(match, e)} at ${clock(e.t)}. ${statusLabel[statuses[e.index] ?? "pending"]}.`}
                  className={cn(
                    "pointer-events-auto relative grid size-6 place-items-center rounded-full outline-none transition-transform duration-150 ease-out-quart hover:scale-115 focus-visible:outline-2 focus-visible:outline-text",
                    "after:absolute after:-inset-2.5 after:content-['']",
                    e.kind === "tag" ? "text-persimmon" : "text-text-2",
                  )}
                >
                  <GameIcon
                    name={e.kind === "tag" ? "strike" : e.kind === "hint" ? "handler" : "dark"}
                    className="size-[1.125rem]"
                  />
                  {!compact && (
                    <Mark
                      status={statuses[e.index] ?? "pending"}
                      labelled={false}
                      className="absolute -top-2.5 -right-2.5 size-3 rounded-full bg-scrim"
                    />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <span className="font-semibold">{eventLine(match, e)}</span>
                <span className="numeral ml-2 text-text-2">{clock(e.t)}</span>
              </TooltipContent>
            </Tooltip>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Scrubber() {
  const { match, play, seek } = useReplay();
  const t = useStore(play, (s) => Math.round(s.t / 250) * 250);
  const wasPlaying = useRef<boolean | null>(null);
  return (
    <Slider
      min={0}
      max={match.durationMs}
      step={5_000}
      value={[t]}
      label="Match time"
      valueText={`${clock(t)} of ${clock(match.durationMs)}`}
      onValueChange={([v]) => {
        if (wasPlaying.current === null) {
          wasPlaying.current = play.get().playing;
          play.set({ playing: false });
        }
        seek(v ?? 0);
      }}
      onValueCommit={() => {
        if (wasPlaying.current) play.set({ playing: true });
        wasPlaying.current = null;
      }}
    />
  );
}
