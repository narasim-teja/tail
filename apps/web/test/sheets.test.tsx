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
