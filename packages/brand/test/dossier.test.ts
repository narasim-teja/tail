import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DOSSIER_SVG_MAX, type DossierView, dossierSvg } from "../src/index.ts";
import vectors from "../vectors/dossier.json";

const cases = vectors as { name: string; view: DossierView; svg: string }[];

describe("dossier art", () => {
  test.each(cases.map((c) => [c.name, c] as const))("%s matches the golden vector", (_, c) => {
    expect(dossierSvg(c.view)).toBe(c.svg);
  });

  test("every vector is under the size limit, the maximal one included", () => {
    for (const c of cases)
      expect(new TextEncoder().encode(c.svg).length).toBeLessThanOrEqual(DOSSIER_SVG_MAX);
    expect(cases.some((c) => c.view.account_id.length === 64 && c.view.entries.length === 12)).toBe(true);
  });

  test("the seed is the SHA-256 of the account id", () => {
    for (const { view } of cases)
      expect(view.seed).toBe(createHash("sha256").update(view.account_id).digest("hex"));
  });

  test("each settled match adds one segment; the head moves with it", () => {
    const base = cases[2]?.view as DossierView;
    const fewer = { ...base, entries: base.entries.slice(1) };
    expect(dossierSvg(fewer)).not.toBe(dossierSvg(base));
    // Only the dotted route ahead changes length when a match is added.
    expect(dossierSvg(fewer)).toContain('stroke-dasharray="0 7"');
    expect(dossierSvg(base)).not.toContain('stroke-dasharray="0 7"');
  });

  test("refuses a seed or account id it could not draw safely", () => {
    const v = cases[0]?.view as DossierView;
    expect(() => dossierSvg({ ...v, seed: "zz" })).toThrow();
    expect(() => dossierSvg({ ...v, account_id: 'a"><script>' })).toThrow();
  });
});
