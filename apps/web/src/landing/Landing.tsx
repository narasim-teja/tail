// The front page: what TAIL is and whether it is real, glanceable in three scrolls. The hero is
// the phone's hunt screen opened out over a real recorded match on its park's map; then the game
// in three folds, how a tag is checked, and the matches. Day to dusk: it opens on the app's
// daylight paper and darkens, as the visitor reads down, to the replay's dusk.

import { colors } from "@tail/brand";
import { useEffect } from "react";
import type { PublishedMatch } from "../lib/published.ts";
import { Beats } from "./Beats.tsx";
import { config } from "./config.ts";
import { DossierSection } from "./DossierCard.tsx";
import type { Demo } from "./demos.ts";
import { Hero } from "./Hero.tsx";
import { demoHref, Matches, matchHref } from "./Matches.tsx";
import type { MapData } from "./map.ts";
import { useReducedMotion } from "./motion.ts";
import { ProofStrip } from "./Proof.tsx";
import { SiteFooter, SiteTop } from "./Site.tsx";
import type { Scene } from "./scene.ts";

export interface LandingData {
  /** The site's published matches; null when the list couldn't be read. */
  index: PublishedMatch[] | null;
  /** The match the hero plays and the main button opens: published, or null for the demo. */
  featured: PublishedMatch | null;
  demos: Demo[] | null;
  /** The hero's scene; null when it couldn't be read (the hero then shows the zone alone). */
  scene: Scene | null;
  /** The scene's place drawn from OpenStreetMap; null draws the plain zone. */
  map: MapData | null;
}

/** The browser's chrome follows the ground under it: paper by day, dusk once the matches come up. */
function useThemeColor() {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const dusk = document.querySelector(".l-matches");
    if (!meta || !dusk) return;
    const [day, night] = [colors.paper, colors.dusk];
    let raf = 0;
    const set = () => {
      raf = 0;
      meta.content = dusk.getBoundingClientRect().top < 48 ? night : day;
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(set);
    };
    set();
    addEventListener("scroll", on, { passive: true });
    return () => {
      removeEventListener("scroll", on);
      cancelAnimationFrame(raf);
    };
  }, []);
}

export function Landing({ data }: { data: LandingData }) {
  const reduced = useReducedMotion();
  useThemeColor();
  const { featured } = data;
  const replayHref = featured ? matchHref(featured.id) : demoHref({ name: "boston-common", query: "" });
  return (
    <div className="l-page">
      <a className="l-skip" href="#main">
        Skip to content
      </a>
      <SiteTop current="home" />
      <main id="main">
        <Hero data={data} reduced={reduced} replayHref={replayHref} />
        <Beats reduced={reduced} />
        <ProofStrip />
        <div className="l-sunset" aria-hidden="true" />
        <Matches index={data.index} demos={data.demos} />
        <DossierSection account={config.dossierAccount} />
      </main>
      <SiteFooter />
    </div>
  );
}
