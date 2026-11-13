// The front page's entry. Everything the first screen needs (the type, the match list, the
// hero's scene, the demos) is fetched together and the page renders once with all of it, so
// nothing on screen moves when a font or a file arrives.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { featuredOf, matchesDir, type PublishedMatch, readIndex } from "../lib/published.ts";
import { type Demo, demosOf } from "./demos.ts";
import { Landing, type LandingData } from "./Landing.tsx";
import { cssVars } from "./palette.ts";
import { parseScene, type Scene } from "./scene.ts";
import "./landing.css";

const base = import.meta.env.BASE_URL;

async function json(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

const sceneAt = (url: string): Promise<Scene | null> => json(url).then(parseScene, () => null);

export async function load(): Promise<LandingData> {
  const demoScene = sceneAt(`${base}fixtures/boston-common.scene.json`);
  const [index, demos] = await Promise.all([
    readIndex(base),
    json(`${base}fixtures/demos.json`).then(
      (j): Demo[] | null => demosOf(j),
      () => null,
    ),
  ]);
  const featured: PublishedMatch | null = index ? featuredOf(index) : null;
  // A published match's scene sits beside its bundle; without one, the hero plays the demo.
  const scene = featured ? await sceneAt(`${matchesDir(base)}${featured.id}.scene.json`) : await demoScene;
  return { index, featured, demos, scene };
}

export function mount(el: HTMLElement) {
  const html = document.documentElement;
  html.dataset["page"] = "landing";
  for (const [k, v] of Object.entries(cssVars())) html.style.setProperty(k, v);
  void Promise.all([load(), document.fonts.load('800 16px "Archivo Variable"').catch(() => [])]).then(
    ([data]) => {
      createRoot(el).render(
        <StrictMode>
          <Landing data={data} />
        </StrictMode>,
      );
      // A shared link to a section (`/#proof`) lands on it once the page is there.
      if (location.hash)
        requestAnimationFrame(() => document.getElementById(location.hash.slice(1))?.scrollIntoView());
    },
  );
}
