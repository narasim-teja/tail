// The hero: the line, and the phone's hunt screen opened out beside it, playing a real recorded
// match from the hunter's side. The top strip (target, time left), the lock arc, the head and
// the heat bar read the same moment as the map panel under them. On a phone it stacks into the
// app's own hunt screen.

import { LOCK_EPOCHS } from "@tail/protocol";
import { useCallback, useState } from "react";
import { clock, day, money } from "../lib/format.ts";
import { HeroMap, type Reading, readingAt, stillTime } from "./HeroMap.tsx";
import { Eyebrow, HeadValue, HeatBar, LockArc } from "./instruments.tsx";
import type { LandingData } from "./Landing.tsx";
import type { MapData } from "./map.ts";
import { STAKE, usdc } from "./rules.ts";
import type { Scene } from "./scene.ts";

export function Hero({
  data,
  reduced,
  replayHref,
}: {
  data: LandingData;
  reduced: boolean;
  replayHref: string;
}) {
  const { featured, scene, map } = data;
  const label = featured
    ? `${featured.place}, ${day(Date.parse(featured.playedAt))}`
    : "A generated match on Boston Common";
  return (
    <section className="l-hero" aria-labelledby="hero-title">
      <div className="l-hero-words">
        <p className="l-eyebrow l-eyebrow-muted l-hero-kicker">Real-world tag</p>
        <h1 id="hero-title" className="l-hero-title">
          One of your friends is hunting&nbsp;you.
        </h1>
        <p className="l-hero-line">
          Everyone puts ${usdc(STAKE).replace(/\.00$/, "")} on their own head and gets one secret target. Find
          them, stay close until your lock fills, then strike to take their money. A tag only counts when both
          phones pick up each other's Bluetooth, so faking your GPS won't help.
        </p>
        <div className="l-actions">
          <a className="l-button" href={replayHref}>
            {featured ? "Watch a real match" : "Watch the demo match"}
          </a>
          <a className="l-button l-button-sand" href="#proof">
            Why it can't be faked
          </a>
        </div>
      </div>
      <figure className="l-hunt" aria-label={label}>
        {scene ? <Hunt scene={scene} map={map} reduced={reduced} /> : <div className="l-hunt-map" />}
      </figure>
    </section>
  );
}

function Hunt({ scene, map, reduced }: { scene: Scene; map: MapData | null; reduced: boolean }) {
  const chase = scene.chase;
  const [r, setR] = useState<Reading | null>(() =>
    chase ? readingAt(chase, reduced ? stillTime(chase) : chase.from) : null,
  );
  const onReading = useCallback((next: Reading) => setR(next), []);
  return (
    <div className="l-hunt-screen">
      {chase && r && (
        <>
          <div className="l-hunt-top" aria-hidden="true">
            <div>
              <Eyebrow muted>Target</Eyebrow>
              <span className="l-hunt-target">{scene.players[chase.target]}</span>
            </div>
            <span className="l-figure">{clock(Math.max(0, scene.plannedMs - r.t * 100))} left</span>
          </div>
          <div className="l-hunt-lock">
            <LockArc value={r.lock} max={LOCK_EPOCHS} />
          </div>
          <div className="l-hunt-head">
            <HeadValue value={`$${money(r.head, scene.decimals)}`} />
          </div>
          <div className="l-hunt-heat">
            <HeatBar value={r.heat} max={LOCK_EPOCHS} />
          </div>
        </>
      )}
      <div className="l-hunt-map">
        <HeroMap scene={scene} map={map} reduced={reduced} onReading={onReading} />
      </div>
    </div>
  );
}
