// What the details sheet, the header and the finale say, rendered from real bundles: every row's
// glyph and title must follow from what its check showed.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { forgedFixture, makeFixtures } from "../scripts/fixture.ts";
import { displayName } from "../src/model/match.ts";
import { Finale } from "../src/ui/Finale.tsx";
import { Header } from "../src/ui/Header.tsx";
import { Inspector } from "../src/ui/Inspector.tsx";
import { Outcome } from "../src/ui/Presence.tsx";
import { anchoredRoots } from "../src/verify/history.ts";
import { PINS } from "../src/verify/pins.ts";
import { checkPresence, presenceFor } from "../src/verify/presence.ts";
import { chainFor } from "./chain.ts";
import { html, replayOf, row, text } from "./render.tsx";

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

describe("who signed, beside the verdict line", () => {
  const relay = (bundle: typeof fx.full) => ({
    kind: "match" as const,
    from: "relay" as const,
    matchId: bundle.match.id,
    url: "x",
  });
  const chips = (h: string) => [...h.matchAll(/tracking-\[0\.08em\][^>]*>([^<]+)</g)].map((m) => m[1]);

  test("a match NEAR pins to the local test referee carries a Test referee chip, header and finale", () => {
    const r = replayOf(fx.full, { source: relay(fx.full), signer: "local" });
    const header = html(r, <Header place="Boston Common" compact={false} />);
    expect(header).toContain("All 27 verdicts match NEAR");
    expect(chips(header)).toEqual(["Test referee"]);
    expect(chips(html(r, <Finale compact={false} />))).toEqual(["Test referee"]);
  });

  test("an enclave or an unknown key gets none; a fixture is labelled Fixture", () => {
    for (const signer of ["enclave", "unknown"] as const) {
      const r = replayOf(fx.full, { source: relay(fx.full), signer });
      expect(chips(html(r, <Header place="Boston Common" compact={false} />))).toEqual([]);
      expect(chips(html(r, <Finale compact={false} />))).toEqual([]);
    }
    const f = replayOf(fx.full);
    expect(chips(html(f, <Header place="Boston Common" compact={false} />))).toEqual(["Fixture"]);
  });
});

describe("the Handler lines' signatures", () => {
  const relay = { kind: "match" as const, matchId: fx.full.match.id, url: "x", from: "relay" as const };
  const sheet = (r: ReturnType<typeof replayOf>) => {
    r.play.set({ selection: { kind: "summary" } });
    return html(r, <Inspector compact={false} />);
  };

  test("a fixture's lines carry its public test key, never called NEAR AI's", () => {
    const line = row(sheet(replayOf(fx.full)), "Handler lines:");
    expect(line.title).toBe("Handler lines: 3 of 3 carry the fixture's test-key signature");
    expect(`${line.title} ${line.detail}`).not.toContain("NEAR AI chat signature");
  });

  test("a real match's signed lines are counted; template lines leave the count at 0, unpassed", () => {
    const r = replayOf(fx.full, { source: relay, signer: "unknown" });
    expect(row(sheet(r), "Handler lines:")).toMatchObject({
      glyph: "Checked",
      title: "Handler lines: 3 of 3 carry a NEAR AI signature",
    });
    const events = r.match.events.map((e) =>
      e.handler?.signature
        ? {
            ...e,
            handler: { ...e.handler, signature: { ...e.handler.signature, signature: "unsigned" as const } },
          }
        : e,
    );
    const t = row(sheet({ ...r, match: { ...r.match, events } }), "Handler lines:");
    expect(t).toMatchObject({
      glyph: "Not checked",
      title: "Handler lines: 0 of 3 carry a NEAR AI signature",
    });
    expect(t.detail).toContain("template line");
  });
});

describe("NEAR unreachable is not NEAR saying no", () => {
  const relay = { kind: "match" as const, matchId: fx.full.match.id, url: "x", from: "relay" as const };
  const tag = (r: ReturnType<typeof replayOf>) => {
    const ev = r.match.events.find((e) => e.kind === "tag");
    r.play.set({ selection: { kind: "event", index: ev?.index ?? -1 } });
    return html(r, <Inspector compact={false} />);
  };

  test("an unreachable NEAR leaves the referee key unread, and the contact paths unchecked by NEAR", () => {
    const h = tag(replayOf(fx.full, { source: relay, chain: { kind: "unreachable", reason: "offline" } }));
    const signed = row(h, "Signed by the referee");
    expect(signed.detail).toBe(
      "NEAR couldn't be reached, so this page didn't learn which referee key the match uses.",
    );
    expect(text(h)).not.toContain("isn't one this page knows");
    expect(text(h)).toContain("NEAR couldn't be reached, so it couldn't check the path.");
    expect(text(h)).not.toContain("NEAR holds no root");
  });

  test("a NEAR that has no such match says so", () => {
    const h = tag(replayOf(fx.full, { source: relay, chain: { kind: "absent" } }));
    expect(row(h, "Signed by the referee").detail).toBe(
      "NEAR has no match with this id, so there is no referee key to compare.",
    );
    expect(text(h)).toContain(
      "NEAR has no match with this id, so it holds no root to check the path against.",
    );
  });
});

describe("the presence page", () => {
  const d = replayOf(fx.full);
  const chain = chainFor(d.decoded);
  const at = d.match.contacts[10]?.logIndex as number;
  const proof = presenceFor(d.decoded, at, anchoredRoots(d.decoded, chain).roots);
  if (!proof) throw new Error("no proof");
  const outcome = (c: typeof chain) =>
    text(
      renderToStaticMarkup(
        <Outcome
          result={{ kind: "done", proof, chain: c, check: checkPresence(proof, c, PINS.contract) }}
          nearCheck={null}
          onAskNear={() => {}}
        />,
      ),
    );

  test("says the referee logged the contact, and names the test referee when NEAR's key is its", () => {
    const [a, b] = proof.accounts.map(displayName);
    const plain = outcome(chain);
    expect(plain).toContain(`The referee logged ${a} and ${b} near each other`);
    expect(plain).not.toContain("Test referee");
    const local = outcome({
      ...chain,
      match: { ...chain.match, referee_pk: PINS.localRefereePks[0] as string },
    });
    expect(local).toContain("Test referee");
    expect(local).toContain("NEAR's referee key for this match is the local test referee's");
  });
});

describe("the append-only row", () => {
  test("says what the consistency proofs show: each anchored root extends the last, over this bundle's log", () => {
    const h = summary(fx.full);
    const r = row(h, "Each checkpoint extends the previous one");
    expect(r.detail).toStartWith("Over this bundle's log, each root NEAR holds extends the one before it");
    expect(r.detail).not.toContain("computed here");
  });
});
