// Draws the social card, public/og.png (1200 × 630), from the brand: the front page's line on
// daylight paper, and on the dusk side the generated Boston Common match's walked paths inside
// its dotted zone, the hunter's Trail mark and the strike ring where its first tag landed. Run
// after make-fixture.ts (it reads the scene); the PNG is committed.
//
//   bun apps/web/scripts/og-image.ts

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { colors, markSvg } from "@tail/brand";
import { css, text } from "../src/landing/palette.ts";
import { parseScene } from "../src/landing/scene.ts";
import { siteOf } from "../src/landing/site.ts";

const W = 1200;
const H = 630;
const here = import.meta.dir;
const scene = parseScene(
  JSON.parse(readFileSync(join(here, "..", "public", "fixtures", "boston-common.scene.json"), "utf8")),
);
const require = createRequire(import.meta.url);
const font = readFileSync(
  require.resolve("@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2"),
).toString("base64");

// The zone and its paths, in a square on the right.
const S = 520;
const R = 236;
const k = R / scene.radius;
const px = (x: number) => S / 2 + x * k;
const py = (y: number) => S / 2 - y * k;
const paths = scene.tracks
  .map((tr) => {
    if (!tr) return "";
    let d = "";
    let prev = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < tr.length; i += 3) {
      d += `${(tr[i] as number) - prev > scene.gap ? "M" : "L"}${px(tr[i + 1] as number).toFixed(1)} ${py(tr[i + 2] as number).toFixed(1)}`;
      prev = tr[i] as number;
    }
    return `<path d="${d}"/>`;
  })
  .join("");
const at = scene.chase?.at ?? [0, 0];
const zone = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
  <circle cx="${S / 2}" cy="${S / 2}" r="${R}" fill="none" stroke="${colors.duskInk}" stroke-opacity="0.55" stroke-width="3" stroke-dasharray="0.1 10" stroke-linecap="round"/>
  <g fill="none" stroke="${colors.duskInk}" stroke-opacity="0.22" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">${paths}</g>
  <circle cx="${px(at[0])}" cy="${py(at[1])}" r="34" fill="none" stroke="${colors.persimmon}" stroke-width="3" opacity="0.7"/>
  <circle cx="${px(at[0])}" cy="${py(at[1])}" r="10" fill="${colors.persimmon}"/>
</svg>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "Archivo"; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 100 900; font-stretch: 62% 125%; }
html, body { margin: 0; width: ${W}px; height: ${H}px; }
body { display: grid; grid-template-columns: 660px 540px; font-family: "Archivo"; -webkit-font-smoothing: antialiased; }
.day { background: ${colors.paper}; color: ${colors.ink}; padding: 56px 0 52px 64px; display: flex; flex-direction: column; }
.brand { display: flex; align-items: center; gap: 12px; font-weight: 900; font-stretch: 118%; font-size: 30px; letter-spacing: 0.06em; }
h1 { margin: auto 0 0; font-size: 82px; line-height: 0.9; letter-spacing: -0.025em; }
.a { display: block; font-weight: 640; font-stretch: 72%; color: ${css(text.inkSoft)}; }
.b { display: block; margin-top: 6px; font-weight: 900; font-stretch: 80%; }
.site { margin-top: 30px; font-size: 24px; font-weight: 650; color: ${css(text.inkSoft)}; }
.dusk { background: ${colors.dusk}; display: grid; place-items: center; }
</style></head><body>
<div class="day">
  <div class="brand">${markSvg({ size: 44 })}<span>TAIL</span></div>
  <h1><span class="a">Every location game gets spoofed.</span><span class="b">This one comes with proof.</span></h1>
  <div class="site">${siteOf(process.env["VITE_SITE_URL"]).host}</div>
</div>
<div class="dusk">${zone}</div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
const out = join(here, "..", "public", "og.png");
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
