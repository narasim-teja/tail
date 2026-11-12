// The film loop: advances match time at the film's speed, raises event lines and flashes as the
// playhead crosses them, and hands each frame to the scene.

import { crossed, filmSpeed } from "../model/film.ts";
import type { Match } from "../model/match.ts";
import { computeFrame, FLASH_MS } from "../scene/frame.ts";
import type { SceneHandle } from "../scene/scene.ts";
import type { PlayStore } from "./state.ts";

/** How long an event line stays up, in real time. Handler lines need reading time. */
export const captionMs = (kind: string) => (kind === "hint" ? 7_500 : kind === "end" ? 12_000 : 4_500);

export function runFilm(m: Match, play: PlayStore, scene: () => SceneHandle | null): () => void {
  let raf = 0;
  let last = performance.now();
  let pausedAt: number | null = null;
  const loop = (now: number) => {
    const dt = Math.min(100, now - last);
    last = now;
    const s = play.get();
    let { t, caption, flashes, playing, ended, speed } = s;
    if (playing && !ended) {
      if (pausedAt !== null) {
        // Resume: event lines keep the time they had left.
        const gap = now - pausedAt;
        if (caption) caption = { ...caption, born: caption.born + gap };
        pausedAt = null;
      }
      speed = s.mode === "film" ? filmSpeed(m, t) : s.mode;
      const next = Math.min(m.durationMs, t + dt * speed);
      for (const e of crossed(m, t, next)) {
        if (e.kind === "checkpoint" || e.kind === "start") continue;
        caption = { event: e.index, born: now };
        if (e.kind === "tag" || e.kind === "forfeit") flashes = [...flashes, { event: e.index, born: now }];
      }
      t = next;
      if (t >= m.durationMs) {
        playing = false;
        ended = true;
      }
    } else if (pausedAt === null) pausedAt = now;
    if (caption && pausedAt === null) {
      const ev = m.events.find((e) => e.index === caption?.event);
      if (!ev || now - caption.born > captionMs(ev.kind)) caption = null;
    }
    const kept = flashes.filter((f) => now - f.born <= FLASH_MS);
    const same = kept.length === s.flashes.length && kept.every((f, i) => f === s.flashes[i]);
    play.set({ t, caption, flashes: same ? s.flashes : kept, playing, ended, speed });
    scene()?.frame(computeFrame(m, play.get(), now), dt);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(raf);
}
