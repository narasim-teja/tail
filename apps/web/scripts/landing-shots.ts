// Screenshots of the front page and the docs, whole and section by section, at laptop and phone
// sizes (and the two in between), with motion and with Reduce Motion, for review. Needs a running
// dev or preview server.
//
//   bunx vite --port 5317 &        (in apps/web)
//   bun apps/web/scripts/landing-shots.ts [baseUrl] [outDir]
//
// The page is scrolled through first, so every readout that climbs on view has climbed. Console
// errors are printed and make the script exit non-zero; so does a page wider than its viewport.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const BASE = process.argv[2] ?? "http://localhost:5317/";
const OUT = process.argv[3] ?? join(import.meta.dir, "..", "screenshots", "landing");
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = {
  laptop: { width: 1440, height: 900, deviceScaleFactor: 1 },
  tablet: { width: 1024, height: 768, deviceScaleFactor: 1 },
  portrait: { width: 768, height: 1024, deviceScaleFactor: 1 },
  phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
} as const;
/** Section by section only at the two sizes the page is designed around. */
const DETAILED = new Set(["laptop", "phone"]);

const PAGES: Record<string, { path: string; sections: Record<string, string> }> = {
  landing: {
    path: "",
    sections: {
      hero: ".l-hero",
      hunt: ".l-hunt",
      "lock-heat": ".l-fold-pair",
      strike: ".l-strike",
      hints: ".l-fold-hints",
      proof: ".l-proof",
      matches: ".l-matches",
      footer: ".l-foot",
    },
  },
  docs: {
    path: "docs",
    sections: {
      top: ".d-header",
      rules: "#rules",
      money: "#money",
      proof: "#proof",
      check: "#check",
      dossier: "#dossier",
      limits: "#limits",
      today: "#today",
      "built-on": "#built-on",
    },
  },
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const browser = await chromium.launch();
let errors = 0;
for (const [pageName, spec] of Object.entries(PAGES)) {
  for (const [vp, opts] of Object.entries(VIEWPORTS)) {
    for (const motion of ["motion", "reduced"] as const) {
      if (!DETAILED.has(vp) && motion === "reduced") continue;
      const ctx = await browser.newContext({
        viewport: { width: opts.width, height: opts.height },
        ...opts,
        reducedMotion: motion === "reduced" ? "reduce" : "no-preference",
      });
      const page = await ctx.newPage();
      const tag = `${pageName}/${vp}/${motion}`;
      page.on("console", (m) => {
        if (m.type() === "error") {
          errors++;
          console.error(`[${tag}] ${m.text()}`);
        }
      });
      page.on("pageerror", (e) => {
        errors++;
        console.error(`[${tag}] ${e.message}`);
      });
      await page.goto(`${BASE}${spec.path}`, { waitUntil: "networkidle" });
      await page.waitForSelector(".l-foot");
      const name = `${pageName}-${vp}-${motion}`;
      // The first screen as a visitor sees it (the hero mid-chase).
      await wait(motion === "reduced" ? 300 : 7_000);
      await page.screenshot({ path: join(OUT, `${name}-first-screen.png`) });
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (wide > 0) {
        errors++;
        console.error(`[${tag}] the page is ${wide}px wider than the viewport`);
      }
      // Scroll through so each readout climbs, then back up.
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      for (let y = 0; y < height; y += Math.round(opts.height * 0.6)) {
        await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), y);
        await wait(motion === "reduced" ? 60 : 420);
      }
      await wait(2_600);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await wait(300);
      await page.screenshot({ path: join(OUT, `${name}-full.png`), fullPage: true });
      if (DETAILED.has(vp))
        for (const [section, sel] of Object.entries(spec.sections)) {
          const el = page.locator(sel).first();
          if ((await el.count()) === 0) continue;
          await el.screenshot({ path: join(OUT, `${name}-${section}.png`) });
        }
      await ctx.close();
    }
  }
}
await browser.close();
console.log(`wrote screenshots to ${OUT}`);
if (errors > 0) process.exit(1);
