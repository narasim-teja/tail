// What the details sheet, the header and the finale say, rendered from real bundles: every row's
// glyph and title must follow from what its check showed.

import { describe, expect, test } from "bun:test";
import { forgedFixture, makeFixtures } from "../scripts/fixture.ts";
import { Inspector } from "../src/ui/Inspector.tsx";
import { html, replayOf, row } from "./render.tsx";

const fx = makeFixtures();
const summary = (bundle: unknown, o: Parameters<typeof replayOf>[1] = {}) =>
  html(replayOf(bundle, { ...o, selection: { kind: "summary" } }), <Inspector compact={false} />);

describe("the summary sheet", () => {
  test("counts every tag against the lock rule, and a tag that breaks it fails the row", () => {
    expect(row(summary(fx.full), "Every tag's evidence fits the lock rule")).toMatchObject({
      glyph: "Checked",
    });
    const bad = row(summary(forgedFixture("evidence")), "1 of 2 tags break the lock rule");
    expect(bad.glyph).toBe("Failed");
    expect(bad.detail).toStartWith("1 of 2 tags meet the rule");
  });
});

describe("a forfeit's sheet", () => {
  const base = replayOf(fx.full);
  const ev = base.match.events.find((e) => e.kind === "forfeit");
  if (!ev || ev.a === undefined) throw new Error("the fixture has a forfeit");
  const who = ev.a;
  const sheet = (r: typeof base) => {
    r.play.set({ selection: { kind: "event", index: ev.index } });
    return html(r, <Inspector compact={false} />);
  };

  test("states the dark rule as cumulative and claims no check of it", () => {
    const h = sheet(replayOf(fx.full));
    const quiet = row(h, "What the log shows");
    expect(quiet.glyph).toBe("Not checked");
    expect(quiet.detail).toContain("adds up to 3 minutes over the match");
    expect(h).toContain("dark time added up to 3 minutes");
  });

  test("a forfeit whose last position is outside the zone, seconds before, isn't shown as failed", () => {
    // Out of the zone counts as dark while the phone still reports, so the last fix can be
    // seconds before the forfeit (as in the economy fixture's "left the zone").
    const r = replayOf(fx.full);
    const tr = r.match.tracks[who];
    if (!tr) throw new Error("the fixture has trails");
    const out = r.match.zone.lat + (2 * r.match.zone.radiusM) / 111_320;
    const tracks = [...r.match.tracks];
    tracks[who] = {
      t: Float64Array.from([...tr.t, ev.t - 2_000]),
      lon: Float64Array.from([...tr.lon, r.match.zone.lon]),
      lat: Float64Array.from([...tr.lat, out]),
    };
    const events = r.match.events.map((e) => (e.index === ev.index ? { ...e, leftZone: true } : e));
    const quiet = row(sheet({ ...r, match: { ...r.match, tracks, events } }), "What the log shows");
    expect(quiet.glyph).toBe("Not checked");
    expect(quiet.detail).toStartWith(
      "Its last released position is from 0:02 before the forfeit, outside the zone.",
    );
  });
});
