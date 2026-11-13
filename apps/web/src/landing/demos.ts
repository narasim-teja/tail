// The generated demo matches the front page offers while the site publishes no real one:
// `public/fixtures/demos.json` (written by scripts/make-fixture.ts) lists the fixtures that were
// built, with facts read from each bundle by the replay's own model. The words for each live here.

export interface DemoFacts {
  /** The fixture's name, as `/?fixture=<name>` reads it. */
  name: string;
  players: number;
  minutes: number;
  survivors: number;
}

export interface Demo extends DemoFacts {
  title: string;
  /** What the replay shows for it, in one line. */
  note: string;
  /** Extra query for the link (the economy view). */
  query: string;
}

/** The demos worth a viewer's minute, in order. Any other fixture is not offered. */
export const DEMO_WORDS: Record<string, { title: string; note: string; query?: string }> = {
  "boston-common": { title: "Boston Common", note: "The honest match: every signature, root and tag holds." },
  "boston-common-tampered": {
    title: "One tag rewritten",
    note: "A tag was changed after the referee signed it. Watch the check fail.",
  },
  "boston-common-tampered-log": {
    title: "History rewritten",
    note: "The referee rewrote its own log and re-signed it. The checkpoints catch it.",
  },
  "boston-common-economy": {
    title: "Twelve players, an hour",
    note: "Played through the real rules engine. Opens on the money.",
    query: "&view=economy",
  },
};

const whole = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** The demos file, keeping only fixtures this page has words for, in DEMO_WORDS order. */
export function demosOf(json: unknown): Demo[] {
  if (!Array.isArray(json)) throw new Error("the demo list isn't a list");
  const facts = new Map<string, DemoFacts>();
  for (const raw of json) {
    const e = (raw ?? {}) as Record<string, unknown>;
    if (typeof e["name"] === "string" && whole(e["players"]) && whole(e["minutes"]) && whole(e["survivors"]))
      facts.set(e["name"], e as unknown as DemoFacts);
  }
  return Object.entries(DEMO_WORDS).flatMap(([name, w]) => {
    const f = facts.get(name);
    return f ? [{ ...f, title: w.title, note: w.note, query: w.query ?? "" }] : [];
  });
}
