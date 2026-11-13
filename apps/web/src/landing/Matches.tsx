// The matches this site publishes, newest first, each opening its replay, with how the pinned
// contract settled it read live from NEAR. Until one is published, the generated demos stand in,
// labelled as generated, as the replay labels a fixture.

import { useEffect, useRef, useState } from "react";
import { day } from "../lib/format.ts";
import type { PublishedMatch } from "../lib/published.ts";
import { say } from "./Beats.tsx";
import type { Demo } from "./demos.ts";
import { ROW_WORDS, type RowState, readRows } from "./near.ts";

const base = import.meta.env.BASE_URL;
export const matchHref = (id: string) => `${base}?match=${id}`;
export const demoHref = (d: Pick<Demo, "name" | "query">) => `${base}?fixture=${d.name}${d.query}`;

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const ending = (survivors: number | undefined, players: number) =>
  survivors === undefined
    ? null
    : survivors === 1
      ? "One left standing"
      : `${capital(say(survivors))} of ${say(players)} survived`;

/** Asks NEAR about each row once the list comes near the screen. */
function useRows(ids: string[]) {
  const ref = useRef<HTMLElement>(null);
  const [states, setStates] = useState<Map<string, RowState>>(new Map());
  const key = ids.join(",");
  useEffect(() => {
    const el = ref.current;
    if (!el || key === "") return;
    let live = true;
    const go = () => {
      void readRows(key.split(",")).then((m) => {
        if (live) setStates(m);
      });
    };
    if (typeof IntersectionObserver === "undefined") go();
    else {
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            io.disconnect();
            go();
          }
        },
        { rootMargin: "600px 0px" },
      );
      io.observe(el);
      return () => {
        live = false;
        io.disconnect();
      };
    }
    return () => {
      live = false;
    };
  }, [key]);
  return { ref, states };
}

function NearMark({ state }: { state: RowState }) {
  return (
    <span className="l-near" data-state={state}>
      <span className="l-near-glyph" aria-hidden="true" />
      {ROW_WORDS[state]}
    </span>
  );
}

export function Matches({
  index,
  demos,
}: {
  /** null: the site's list couldn't be read. */
  index: PublishedMatch[] | null;
  demos: Demo[] | null;
}) {
  const list = index ?? [];
  const { ref, states } = useRows(list.map((m) => m.id));
  return (
    <section className="l-matches" id="matches" aria-labelledby="matches-title" ref={ref}>
      <h2 id="matches-title" className="l-h2">
        Watch a match
      </h2>
      {list.length > 0 ? (
        <>
          <p className="l-lede">
            Each replay re-checks the match in your browser against NEAR. The mark here is how the contract
            settled it.
          </p>
          <ol className="l-rows">
            {list.map((m, i) => (
              <li key={m.id} className={i === 0 ? "l-row l-row-first" : "l-row"}>
                <a href={matchHref(m.id)} className="l-row-link">
                  <span className="l-row-date">{day(Date.parse(m.playedAt))}</span>
                  <span className="l-row-place">{m.place}</span>
                  <span className="l-row-facts">
                    {[`${m.players} players`, `${m.minutes} min`, ending(m.survivors, m.players)]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  <NearMark state={states.get(m.id) ?? "checking"} />
                  <span className="l-row-go" aria-hidden="true">
                    →
                  </span>
                </a>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <>
          <p className="l-lede">
            {index === null
              ? "The list of matches couldn't be read."
              : "No real match is published here yet."}{" "}
            These are generated: real Boston Common paths, signed with public test keys, never sent to NEAR.
            The replay checks them the same way and says so.
          </p>
          {demos && demos.length > 0 ? (
            <ol className="l-rows">
              {demos.map((d, i) => (
                <li key={d.name} className={i === 0 ? "l-row l-row-first" : "l-row"}>
                  <a href={demoHref(d)} className="l-row-link">
                    <span className="l-row-date">Generated</span>
                    <span className="l-row-place">{d.title}</span>
                    <span className="l-row-facts">
                      {[`${d.players} players`, `${d.minutes} min`, ending(d.survivors, d.players)]
                        .filter(Boolean)
                        .join(" · ")}
                      <span className="l-row-note">{d.note}</span>
                    </span>
                    <NearMark state="absent" />
                    <span className="l-row-go" aria-hidden="true">
                      →
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          ) : (
            <p className="l-lede">
              <a href={demoHref({ name: "boston-common", query: "" })}>
                Watch the generated Boston Common match
              </a>
            </p>
          )}
        </>
      )}
    </section>
  );
}
