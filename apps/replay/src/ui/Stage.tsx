// The replay itself: the map as the whole stage, three thin layers over it (roster, timeline,
// inspector), the title and verification line top-right, and the event line above the timeline.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "../components/ui/button.tsx";
import { useStore } from "../lib/store.ts";
import { type Match, snapshotAt } from "../model/match.ts";
import { runFilm } from "../replay/film.ts";
import type { Source } from "../replay/load.ts";
import { createPlayStore, createVerifyStore, type Selection } from "../replay/state.ts";
import { runVerification } from "../replay/verify.ts";
import { Scene2D } from "../scene/Scene2D.tsx";
import { Scene3D } from "../scene/Scene3D.tsx";
import { canUse3D, type Insets, type SceneHandle } from "../scene/scene.ts";
import type { DecodedBundle } from "../verify/bundle.ts";
import { nearReader } from "../verify/chain.ts";
import type { BatchCheck } from "../verify/checks.ts";
import { Caption } from "./Caption.tsx";
import { type Replay, ReplayProvider, useMedia } from "./context.tsx";
import { Header } from "./Header.tsx";
import { Inspector } from "./Inspector.tsx";
import { TrailMark } from "./icons.tsx";
import { Roster } from "./Roster.tsx";
import { ProgressLine } from "./States.tsx";
import { Timeline } from "./Timeline.tsx";

const USDC_GUESS = { symbol: "USDC", decimals: 6 };

export function Stage(props: { decoded: DecodedBundle; match: Match; batches: BatchCheck; source: Source }) {
  const { decoded, match, batches, source } = props;
  const reduced = useMedia("(prefers-reduced-motion: reduce)");
  const compact = !useMedia("(min-width: 768px)");
  // `?t=<seconds>` opens the film at a moment (for linking a scene while reviewing).
  const play = useMemo(() => {
    const t = Number(new URLSearchParams(location.search).get("t")) * 1000;
    return createPlayStore(Number.isFinite(t) ? Math.max(0, Math.min(match.durationMs - 1, t)) : 0);
  }, [match]);
  const verify = useMemo(() => createVerifyStore(decoded.verdicts.length, USDC_GUESS), [decoded]);
  const scene = useRef<SceneHandle | null>(null);
  const [three, setThree] = useState(canUse3D);
  // undefined while the map looks for the park's name; null once it has given up.
  const [place, setPlace] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const h = setTimeout(() => setPlace((p) => (p === undefined ? null : p)), 4_000);
    return () => clearTimeout(h);
  }, []);
  const progress = useStore(verify, (s) => s.progress);
  const selection = useStore(play, (s) => s.selection);
  const camera = useStore(play, (s) => s.camera);

  useEffect(
    () => runVerification(decoded, verify, nearReader(match.network)),
    [decoded, verify, match.network],
  );
  useEffect(() => runFilm(match, play, () => scene.current), [match, play]);

  const seek = useCallback(
    (t: number, andPlay?: boolean) => {
      const c = Math.max(0, Math.min(match.durationMs, t));
      play.set({
        t: c,
        caption: null,
        flashes: [],
        ended: c >= match.durationMs,
        ...(andPlay ? { playing: c < match.durationMs } : {}),
      });
    },
    [match, play],
  );
  // Choosing a player also follows them (when there is a path to follow); closing their sheet
  // hands the camera back to the director.
  const select = useCallback(
    (sel: Selection | null) => {
      if (sel?.kind === "player") {
        const alive = snapshotAt(match, play.get().t).alive[sel.index];
        play.set({
          selection: sel,
          ...(match.hasTrails && alive ? { follow: sel.index, camera: "follow" as const } : {}),
        });
      } else play.set({ selection: sel, follow: null });
    },
    [play, match],
  );
  const toggle = useCallback(() => {
    const s = play.get();
    if (s.ended) seek(0, true);
    else play.set({ playing: !s.playing });
  }, [play, seek]);

  // Space plays and pauses, arrows step ten seconds, Esc closes the sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el?.closest("input, textarea, [contenteditable]");
      const control = el?.closest("button, a, [role=slider], summary");
      if (e.key === "Escape" && play.get().selection) {
        e.preventDefault();
        select(null);
        return;
      }
      if (typing || control) return;
      if (e.key === " ") {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        seek(play.get().t + (e.key === "ArrowRight" ? 10_000 : -10_000));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [play, select, toggle, seek]);

  const insets: Insets = compact
    ? selection
      ? { top: 24, right: 0, bottom: Math.round(window.innerHeight * 0.64), left: 0 }
      : { top: 200, right: 0, bottom: 200, left: 0 }
    : { top: 150, right: selection ? 440 : 40, bottom: 150, left: 300 };

  const onFail = useCallback(() => setThree(false), []);
  const onPick = useCallback((sel: Selection) => select(sel), [select]);

  const ctx: Replay = { match, decoded, batches, play, verify, source, reduced, seek, select, toggle };
  const SceneView = three ? Scene3D : Scene2D;

  return (
    <ReplayProvider value={ctx}>
      <ProgressLine value={progress} />
      <main className="relative h-dvh w-full overflow-hidden bg-dusk">
        <SceneView
          ref={scene}
          match={match}
          play={play}
          reduced={reduced}
          insets={insets}
          onFail={onFail}
          onPick={onPick}
          onPlace={setPlace}
        />

        {/* Soft dusk at the edges so the chrome reads without boxes. */}
        <div
          aria-hidden="true"
          className={cn("pointer-events-none absolute inset-0 z-chrome", compact && selection && "hidden")}
          style={{
            background: compact
              ? "linear-gradient(to bottom, oklch(from var(--scrim) l c h / 0.88), transparent 30%), linear-gradient(to top, oklch(from var(--scrim) l c h / 0.92), transparent 32%)"
              : "radial-gradient(ellipse 34rem 26rem at 0% 0%, oklch(from var(--scrim) l c h / 0.82), transparent 70%), radial-gradient(ellipse 30rem 14rem at 100% 0%, oklch(from var(--scrim) l c h / 0.75), transparent 70%), linear-gradient(to top, oklch(from var(--scrim) l c h / 0.9), transparent 26%)",
          }}
        />

        <div
          className={cn(
            "pointer-events-none absolute inset-0 z-chrome flex flex-col",
            compact ? "px-4 pt-[max(1rem,env(safe-area-inset-top))]" : "px-7 pt-6",
          )}
        >
          {compact ? (
            // With the sheet up on a phone, the map above it is all the room there is: the
            // sheet carries the details, so the rest of the chrome steps aside.
            <div className={cn("flex flex-col gap-3", selection && "invisible")}>
              <Header place={place} compact />
              <Roster compact />
            </div>
          ) : (
            <div
              className={cn(
                "flex items-start justify-between gap-8 transition-[padding] duration-300",
                selection && "pr-[27rem]",
              )}
            >
              <Roster compact={false} />
              <Header place={place} compact={false} />
            </div>
          )}

          <div className="flex-1" />

          <div
            className={cn(
              "flex flex-col",
              compact ? "gap-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]" : "gap-3 pb-6",
              !compact && selection && "pr-[27rem]",
              compact && selection && "invisible",
            )}
          >
            <Caption compact={compact} />
            {camera === "free" && (
              <Button
                variant="quiet"
                size="sm"
                className="pointer-events-auto mx-auto"
                onClick={() => {
                  scene.current?.resync();
                  play.set({ camera: "follow" });
                }}
              >
                <TrailMark className="size-4" />
                {match.hasTrails ? "Follow the chase" : "Reset the view"}
              </Button>
            )}
            <Timeline compact={compact} />
          </div>
        </div>

        <Inspector compact={compact} />
      </main>
    </ReplayProvider>
  );
}
