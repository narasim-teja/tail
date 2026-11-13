import type { Timers } from "../src/proximity/epoch";

/** A fake clock whose timers fire when time is advanced past them. */
export function fakeTime(start: number) {
  let now = start;
  let jobs: { at: number; fn: () => void; id: number }[] = [];
  let id = 0;
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      jobs.push({ at: now + ms, fn, id: ++id });
      return id;
    },
    clearTimeout: (h) => {
      jobs = jobs.filter((j) => j.id !== h);
    },
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      jobs.sort((a, b) => a.at - b.at);
      const j = jobs[0];
      if (!j || j.at > until) break;
      jobs.shift();
      now = Math.max(now, j.at);
      j.fn();
    }
    now = until;
  };
  return { timers, advance, now: () => now, set: (t: number) => (now = t) };
}
