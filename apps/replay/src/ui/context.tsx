import { createContext, useContext, useEffect, useState } from "react";
import type { Match } from "../model/match.ts";
import type { Source } from "../replay/load.ts";
import type { PlayStore, Selection, VerifyStore } from "../replay/state.ts";
import type { DecodedBundle } from "../verify/bundle.ts";
import type { BatchCheck } from "../verify/checks.ts";

export interface Replay {
  match: Match;
  decoded: DecodedBundle;
  batches: BatchCheck;
  play: PlayStore;
  verify: VerifyStore;
  source: Source;
  reduced: boolean;
  /** Jump the playhead; `andPlay` resumes. */
  seek(t: number, andPlay?: boolean): void;
  select(sel: Selection | null): void;
  toggle(): void;
}

const Ctx = createContext<Replay | null>(null);
export const ReplayProvider = Ctx.Provider;

export function useReplay(): Replay {
  const r = useContext(Ctx);
  if (!r) throw new Error("useReplay outside ReplayProvider");
  return r;
}

export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const fn = () => setOn(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [query]);
  return on;
}
