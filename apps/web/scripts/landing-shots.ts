// Screenshots of the front page, whole and section by section, at laptop and phone sizes, with
// motion and with Reduce Motion, for review. Needs a running dev or preview server.
//
//   bunx vite --port 5317 &        (in apps/web)
//   bun apps/web/scripts/landing-shots.ts [baseUrl] [outDir]
//
// The page is scrolled through first, so every readout that climbs on view has climbed. Console
// errors are printed and make the script exit non-zero.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const BASE = process.argv[2] ?? "http://localhost:5317/";
const OUT = process.argv[3] ?? join(import.meta.dir, "..", "screenshots", "landing");
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = {
  laptop: { width: 1440, height: 900, deviceScaleFactor: 1 },
  phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
} as const;

const SECTIONS: Record<string, string> = {
  hero: ".l-hero",
  lock: ".l-beat-lock",
  heat: ".l-beat-heat",
  strike: ".l-strike",
  hints: ".l-beat-hints",
  money: ".l-money",
  proof: ".l-proof",
  matches: ".l-matches",
  footer: ".l-foot",
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const browser = await chromium.launch();
let errors = 0;
for (const [vp, opts] of Object.entries(VIEWPORTS)) {
  for (const motion of ["motion", "reduced"] as const) {
    const ctx = await browser.newContext({
      viewport: { width: opts.width, height: opts.height },
      ...opts,
      reducedMotion: motion === "reduced" ? "reduce" : "no-preference",
    });
    const page = await ctx.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") {
        errors++;
        console.error(`[${vp}/${motion}] ${m.text()}`);
      }
    });
    page.on("pageerror", (e) => {
      errors++;
      console.error(`[${vp}/${motion}] ${e.message}`);
    });
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForSelector(".l-hero");
    const name = `${vp}-${motion}`;
    // The first screen as a visitor sees it, the hero mid-chase.
    await wait(motion === "reduced" ? 300 : 7_500);
    await page.screenshot({ path: join(OUT, `${name}-first-screen.png`) });
    // Scroll through so each readout climbs, then back up.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += Math.round(opts.height * 0.6)) {
      await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), y);
      await wait(motion === "reduced" ? 60 : 450);
    }
    await wait(2_400);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await wait(300);
    await page.screenshot({ path: join(OUT, `${name}-full.png`), fullPage: true });
    for (const [section, sel] of Object.entries(SECTIONS)) {
      const el = page.locator(sel).first();
      if ((await el.count()) === 0) continue;
      await el.screenshot({ path: join(OUT, `${name}-${section}.png`) });
    }
    await ctx.close();
  }
}
await browser.close();
console.log(`wrote screenshots to ${OUT}`);
if (errors > 0) process.exit(1);
