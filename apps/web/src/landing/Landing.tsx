// The front page: what TAIL is and whether it is real, in the ten seconds a visitor gives it,
// then the game, the money, the proof and the matches. Day to dusk: it opens on the app's
// daylight paper and darkens, as the visitor reads down, to the replay's dusk.

import { colors, markSvg } from "@tail/brand";
import { LOCK_EPOCHS } from "@tail/protocol";
import { useCallback, useEffect, useState } from "react";
import { clock, day } from "../lib/format.ts";
import type { PublishedMatch } from "../lib/published.ts";
import { Beats } from "./Beats.tsx";
import { config } from "./config.ts";
import { DossierSection } from "./DossierCard.tsx";
import type { Demo } from "./demos.ts";
import { HeroScene } from "./HeroScene.tsx";
import { demoHref, Matches, matchHref } from "./Matches.tsx";
import { Money } from "./Money.tsx";
import { Proof } from "./Proof.tsx";
import type { Scene } from "./scene.ts";
import { siteOf } from "./site.ts";

const SITE = siteOf(import.meta.env.VITE_SITE_URL);

export interface LandingData {
  /** The site's published matches; null when the list couldn't be read. */
  index: PublishedMatch[] | null;
  /** The match the hero plays and the main button opens: published, or null for the demo. */
  featured: PublishedMatch | null;
  demos: Demo[] | null;
  /** The hero's scene; null when it couldn't be read (the hero then shows the zone alone). */
  scene: Scene | null;
}

export function useReducedMotion() {
  const q = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setReduced(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return reduced;
}

function Mark({ size = 28 }: { size?: number }) {
  return (
    <span
      className="l-mark"
      aria-hidden="true"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: the brand's own static mark
      dangerouslySetInnerHTML={{ __html: markSvg({ size }) }}
    />
  );
}

function Readout({ scene, reduced }: { scene: Scene; reduced: boolean }) {
  const chase = scene.chase;
  const [state, setState] = useState(() => ({ n: 0, t: chase ? chase.from : 0 }));
  const onLock = useCallback((n: number, t: number) => setState({ n, t }), []);
  if (!chase) return <HeroScene scene={scene} reduced={reduced} />;
  const hunter = scene.players[chase.hunter];
  const target = scene.players[chase.target];
  return (
    <>
      <HeroScene scene={scene} reduced={reduced} onLock={onLock} />
      <p className="l-readout" aria-hidden="true">
        <span className="l-readout-who">
          <span className="l-dot l-dot-hunter" />
          {hunter} on <span className="l-dot l-dot-target" />
          {target}
        </span>
        <span className="l-readout-lock">
          Lock <b>{state.n}</b>/{LOCK_EPOCHS}
        </span>
        <span className="l-readout-clock">{clock(state.t * 100)}</span>
      </p>
    </>
  );
}

/** The browser's chrome follows the ground under it: paper by day, dusk once the proof turns. */
function useThemeColor() {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const dusk = document.querySelector(".l-proof-dusk");
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
  const { featured, scene } = data;
  const replayHref = featured ? matchHref(featured.id) : demoHref({ name: "boston-common", query: "" });
  const sceneLabel = featured
    ? `${featured.place}, ${day(Date.parse(featured.playedAt))}`
    : "A generated match on Boston Common";
  const chase = scene?.chase;
  const story =
    scene && chase
      ? `${scene.players[chase.hunter]} closes on ${scene.players[chase.target]} until the lock fills, then strikes.`
      : null;

  return (
    <div className="l-page">
      <a className="l-skip" href="#main">
        Skip to content
      </a>
      <header className="l-top">
        <a className="l-brand" href={import.meta.env.BASE_URL} aria-label="TAIL, home">
          <Mark />
          <span className="l-wordmark">TAIL</span>
        </a>
        <nav aria-label="Sections" className="l-nav">
          <a href="#proof">How it's checked</a>
          <a href="#matches">Matches</a>
          {config.repoUrl && (
            <a href={config.repoUrl} rel="noopener">
              Code
            </a>
          )}
        </nav>
      </header>

      <main id="main">
        <section className="l-hero" aria-labelledby="hero-title">
          <div className="l-hero-words">
            <h1 id="hero-title" className="l-hero-title">
              <span className="l-hero-a">Every location game gets spoofed.</span>{" "}
              <span className="l-hero-b">This one comes with proof.</span>
            </h1>
            <p className="l-hero-line">
              Real-world Assassin for 3 to 12 friends in a park. A tag counts only when two iPhones heard each
              other, and a contract on NEAR replays the match before any money moves.
            </p>
            <div className="l-actions">
              <a className="l-button" href={replayHref}>
                {featured ? "Watch a real match" : "Watch the demo match"}
                <span aria-hidden="true">→</span>
              </a>
              <a className="l-quiet" href="#proof">
                How it's checked
              </a>
            </div>
          </div>
          <figure className="l-scene">
            <div className="l-scene-box">
              {scene ? <Readout scene={scene} reduced={reduced} /> : <EmptyZone />}
            </div>
            <figcaption className="l-scene-caption">
              <span className="l-scene-label">{sceneLabel}</span>
              {story && <span className="l-scene-story">{story}</span>}
            </figcaption>
          </figure>
        </section>

        <Beats reduced={reduced} />
        <Money />
        <Proof replayHref={replayHref} />
        <Matches index={data.index} demos={data.demos} />
        {config.dossierAccount && <DossierSection account={config.dossierAccount} />}
      </main>

      <footer className="l-foot">
        <div className="l-foot-brand">
          <Mark size={22} />
          <span className="l-wordmark">TAIL</span>
          <span className="l-foot-site">{SITE.host}</span>
        </div>
        <p className="l-foot-built">
          Built with NEAR (the contract and the dossiers), OutLayer (the referee's enclave), NEAR AI Cloud
          (the Handler's voice), the Offline Protocol SDK (phone-to-phone carry, off by default) and Apple App
          Attest.
        </p>
        <ul className="l-foot-links">
          {config.repoUrl && (
            <li>
              <a className="l-foot-link" href={config.repoUrl} rel="noopener">
                Source code
              </a>
            </li>
          )}
          {config.docsUrl && (
            <li>
              <a className="l-foot-link" href={config.docsUrl} rel="noopener">
                Docs
              </a>
            </li>
          )}
          <li>
            <a className="l-foot-link" href={replayHref}>
              Replay
            </a>
          </li>
        </ul>
        <p className="l-foot-fine">
          Open source under AGPL-3.0-only. Type: Archivo (SIL OFL).
          {scene?.kind === "fixture" && " The demo match walks paths from OpenStreetMap contributors."}
        </p>
      </footer>
    </div>
  );
}

function EmptyZone() {
  return (
    <svg viewBox="0 0 640 640" className="l-scene-svg" aria-hidden="true">
      <circle cx={320} cy={320} r={300} className="l-zone" />
    </svg>
  );
}
