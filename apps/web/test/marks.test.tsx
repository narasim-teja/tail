import { describe, expect, test } from "bun:test";
import { icons } from "@tail/brand";
import { renderToStaticMarkup } from "react-dom/server";
import { markLabel } from "../src/replay/copy.ts";
import { GlyphIcon, Mark } from "../src/ui/icons.tsx";
import { type Check, overall, proofGlyph, STATUS_GLYPH } from "../src/ui/marks.ts";
import { summarize, type VerdictStatus } from "../src/verify/report.ts";

const STATUSES: VerdictStatus[] = ["verified", "unanchored", "mismatch", "pending"];
const CHECK_PATH = icons.verified;
const html = (s: VerdictStatus) => renderToStaticMarkup(<Mark status={s} />);

describe("verification marks", () => {
  test("only 'Matches NEAR' maps to the ringed check, and every status has its own glyph", () => {
    expect(STATUS_GLYPH).toEqual({
      verified: "check",
      unanchored: "hollow",
      mismatch: "bar",
      pending: "dashed",
    });
    expect(new Set(STATUSES.map((s) => STATUS_GLYPH[s])).size).toBe(STATUSES.length);
  });

  test("the rendered mark draws the brand check for verified and for nothing else", () => {
    expect(html("verified")).toContain(CHECK_PATH);
    for (const s of STATUSES.filter((x) => x !== "verified")) expect(html(s)).not.toContain(CHECK_PATH);
    expect(html("unanchored")).toContain('data-glyph="hollow"');
    expect(html("mismatch")).toContain('data-glyph="bar"');
    expect(html("pending")).toContain('data-glyph="dashed"');
  });

  test("marks are labelled with their status for screen readers", () => {
    expect(html("unanchored")).toContain('aria-label="Signed, not on NEAR"');
    // From the status alone a barred mark can't tell a local failure from NEAR disagreeing.
    expect(html("mismatch")).toContain('aria-label="Fails a check"');
  });

  test("a barred mark names NEAR only when NEAR was asked and holds something else", () => {
    expect(markLabel("mismatch", "mismatch")).toBe("Doesn't match NEAR");
    expect(markLabel("mismatch", "absent")).toBe("Fails a check");
    expect(markLabel("mismatch", undefined)).toBe("Fails a check");
    expect(markLabel("verified", "match")).toBe("Matches NEAR");
  });

  test("a proof row shows the ringed check only when it compares with NEAR and passes", () => {
    const checks: Check[] = ["pass", "fail", "pending", "info"];
    for (const c of checks) {
      expect(proofGlyph(c, false)).not.toBe("check");
      const out = renderToStaticMarkup(<GlyphIcon glyph={proofGlyph(c, false)} />);
      expect(out).not.toContain(CHECK_PATH);
    }
    expect(proofGlyph("pass", true)).toBe("check");
    expect(proofGlyph("info", true)).toBe("hollow");
  });

  test("the header's overall state: a fixture (not on NEAR) is hollow, never checked", () => {
    const fixture = summarize(new Array<VerdictStatus>(26).fill("unanchored"));
    expect(STATUS_GLYPH[overall(fixture, "absent")]).toBe("hollow");
    expect(STATUS_GLYPH[overall(fixture, "unreachable")]).toBe("hollow");
    const forged = summarize([...new Array<VerdictStatus>(25).fill("unanchored"), "mismatch"]);
    expect(STATUS_GLYPH[overall(forged, "absent")]).toBe("bar");
    const anchored = summarize(new Array<VerdictStatus>(26).fill("verified"));
    expect(STATUS_GLYPH[overall(anchored, "found")]).toBe("check");
    expect(STATUS_GLYPH[overall(anchored, "checking")]).toBe("dashed");
  });
});
