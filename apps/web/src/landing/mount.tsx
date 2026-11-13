// The front page's entry. Everything the first screen needs (the type, the match list, the
// hero's scene and its place's map, the demos) is fetched together and the page renders once
// with all of it, so nothing on screen moves when a font or a file arrives.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { featuredOf, mapUrl, matchesDir, type PublishedMatch, readIndex } from "../lib/published.ts";
import { type Demo, demosOf } from "./demos.ts";
import { Landing, type LandingData } from "./Landing.tsx";
import { type MapData, parseMap } from "./map.ts";
import { parseScene, type Scene } from "./scene.ts";
import { applyTheme, fontsReady, landOnHash } from "./theme.ts";
import "./landing.css";

const base = import.meta.env.BASE_URL;

async function json(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

const sceneAt = (url: string): Promise<Scene | null> => json(url).then(parseScene, () => null);
const mapAt = (name: string): Promise<MapData | null> => json(mapUrl(name, base)).then(parseMap, () => null);

/** The generated match is played on Boston Common, so its hero draws that map. */
export const DEMO_MAP = "boston-common";

export async function load(): Promise<LandingData> {
  const demoScene = sceneAt(`${base}fixtures/boston-common.scene.json`);
  const demoMap = mapAt(DEMO_MAP);
  const [index, demos] = await Promise.all([
    readIndex(base),
    json(`${base}fixtures/demos.json`).then(
      (j): Demo[] | null => demosOf(j),
      () => null,
    ),
  ]);
  const featured: PublishedMatch | null = index ? featuredOf(index) : null;
  // A published match's scene sits beside its bundle; without one, the hero plays the demo.
  const [scene, map] = featured
    ? await Promise.all([
        sceneAt(`${matchesDir(base)}${featured.id}.scene.json`),
        featured.map ? mapAt(featured.map) : null,
      ])
    : await Promise.all([demoScene, demoMap]);
  return { index, featured, demos, scene, map };
}

export function mount(el: HTMLElement) {
  applyTheme("landing");
  void Promise.all([load(), fontsReady()]).then(([data]) => {
    createRoot(el).render(
      <StrictMode>
        <Landing data={data} />
      </StrictMode>,
    );
    landOnHash();
  });
}
