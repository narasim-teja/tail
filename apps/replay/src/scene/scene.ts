import type { Match } from "../model/match.ts";
import type { PlayStore, Selection } from "../replay/state.ts";
import type { Frame } from "./frame.ts";

export interface SceneHandle {
  /** Draw one frame; `dt` is real milliseconds since the last one. */
  frame(f: Frame, dt: number): void;
  /** The viewer gave the camera back: continue the orbit from where it is. */
  resync(): void;
}

/** Space the chrome takes on each side, so the camera frames the action in what is left. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface SceneProps {
  match: Match;
  play: PlayStore;
  reduced: boolean;
  insets: Insets;
  onFail: (reason: string) => void;
  onPick: (sel: Selection) => void;
  /** The named park or place the zone sits in, read from the map tiles. */
  onPlace?: (name: string) => void;
}

/** MapLibre needs WebGL 2. `?gl=0` forces the flat map for testing. */
export function canUse3D(): boolean {
  if (new URLSearchParams(location.search).get("gl") === "0") return false;
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl2");
  } catch {
    return false;
  }
}
