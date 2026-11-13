// Screenshots of the replay in its key states at phone, laptop and TV sizes, for review and the
// README. Needs a running dev or preview server.
//
//   bunx vite --port 5317 &        (in apps/web)
//   bun apps/web/scripts/shots.ts [baseUrl] [only-state]
//
// Console errors are printed and make the script exit non-zero.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";

const BASE = process.argv[2] ?? "http://localhost:5317/";
const ONLY = process.argv[3];
const OUT = join(import.meta.dir, "..", "screenshots");
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = {
  phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  laptop: { width: 1440, height: 900, deviceScaleFactor: 1 },
  tv: { width: 1920, height: 1080, deviceScaleFactor: 1 },
} as const;

type Step = (page: Page) => Promise<void>;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const settled = async (page: Page) => {
  await page.waitForSelector("main[aria-busy]", { state: "detached", timeout: 20_000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector("[aria-label='Players']"), null, {
    timeout: 20_000,
  });
};
const tick = (page: Page, nth: number) => page.locator("ol[aria-label='Events'] button").nth(nth);

const STATES: Record<string, { query: string; steps: Step; reduced?: boolean }> = {
  verifying: {
    query: "?fixture=boston-common",
    steps: async (page) => {
      await settled(page);
      await wait(1_900);
    },
  },
  playing: {
    // In the first chase, as Ana's lock on Bo fills.
    query: "?t=372",
    steps: async (page) => {
      await settled(page);
      await wait(4_500);
    },
  },
  "paused-inspector": {
    query: "?fixture=boston-common",
    steps: async (page) => {
      await settled(page);
      await tick(page, 1).click();
      await wait(16_000);
      await page.keyboard.press("Space");
      await wait(600);
    },
  },
  mismatch: {
    // The tampered fixture: the second tag was rewritten to credit Dee after it was signed.
    query: "?fixture=boston-common-tampered",
    steps: async (page) => {
      await settled(page);
      await tick(page, 4).click();
      await wait(16_000);
      await page.keyboard.press("Space");
      await wait(600);
    },
  },
  "mismatch-summary": {
    query: "?fixture=boston-common-tampered",
    steps: async (page) => {
      await settled(page);
      await wait(4_000);
      await page.locator("header button").first().click();
      await wait(900);
    },
  },
  "no-trails": {
    query: "?fixture=boston-common-no-trails",
    steps: async (page) => {
      await settled(page);
      await tick(page, 1).click();
      await page.keyboard.press("Escape");
      await wait(9_000);
    },
  },
  flat: {
    query: "?gl=0",
    steps: async (page) => {
      await settled(page);
      await tick(page, 1).click();
      await page.keyboard.press("Escape");
      await wait(10_000);
    },
  },
  "reduced-motion": {
    query: "?fixture=boston-common",
    reduced: true,
    steps: async (page) => {
      await settled(page);
      await tick(page, 3).click();
      await page.keyboard.press("Escape");
      await wait(8_000);
    },
  },
  handler: {
    // Eli's second hint: the Handler's line on screen.
    query: "?t=890",
    steps: async (page) => {
      await settled(page);
      await page.waitForSelector("q", { timeout: 20_000 });
      await wait(800);
    },
  },
  ended: {
    query: "?t=1170",
    steps: async (page) => {
      await settled(page);
      await page.waitForSelector("[aria-label='Watch again']", { timeout: 30_000 });
      await wait(1_200);
    },
  },
  private: {
    query: "?match=00000000000000000000000000000403&relay=/__state/403",
    steps: async () => wait(1_500),
  },
  "not-finished": {
    query: "?match=00000000000000000000000000000409&relay=/__state/409",
    steps: async () => wait(2_500),
  },
};

// The GPU where there is one (Metal on a Mac): SwiftShader runs WebGL at a frame or two a
// second, which no viewer would ever see.
const browser = await chromium.launch({
  args:
    process.platform === "darwin"
      ? ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"]
      : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
let errors = 0;
for (const [state, s] of Object.entries(STATES)) {
  if (ONLY && state !== ONLY) continue;
  for (const [vp, opts] of Object.entries(VIEWPORTS)) {
    const ctx = await browser.newContext({
      viewport: { width: opts.width, height: opts.height },
      ...opts,
      ...(s.reduced ? { reducedMotion: "reduce" as const } : {}),
    });
    const page = await ctx.newPage();
    // The page/state routes stand in for a relay answering 403 and 409.
    await page.route("**/__state/403/**", (r) =>
      r.fulfill({ status: 403, body: '{"error":"this replay is for the match\'s players"}' }),
    );
    await page.route("**/__state/409/**", (r) =>
      r.fulfill({ status: 409, body: '{"error":"the replay opens when the match has ended"}' }),
    );
    page.on("console", (m) => {
      // The stand-in relay's 403 and 409 are the point of those two states.
      if (/status of 40[39]/.test(m.text()) && (state === "private" || state === "not-finished")) return;
      if (m.type() === "error") {
        errors++;
        console.error(`[${state}/${vp}] console: ${m.text()}`);
      }
    });
    page.on("pageerror", (e) => {
      errors++;
      console.error(`[${state}/${vp}] page error: ${e.message}`);
    });
    await page.goto(BASE + s.query, { waitUntil: "domcontentloaded" });
    await s.steps(page);
    const file = join(OUT, `${state}-${vp}.png`);
    await page.screenshot({ path: file });
    console.log(`saved ${file}`);
    await ctx.close();
  }
}
await browser.close();
if (errors) {
  console.error(`${errors} console error(s)`);
  process.exit(1);
}
