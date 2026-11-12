// Writes every static brand file from src/index.ts: SVGs, the iOS app icon PNGs, favicons.
// Run after changing the brand: `bun run --cwd packages/brand build`.

import { mkdirSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import { appIconSvg, colors, type IconName, iconSvg, icons, markSvg } from "../src/index.ts";

const out = new URL("../assets/", import.meta.url).pathname;
mkdirSync(`${out}icons`, { recursive: true });

const png = (svg: string, width: number) =>
  new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();

const files: Record<string, string | Uint8Array> = {
  "mark.svg": markSvg({ label: "TAIL" }),
  "mark-ink.svg": markSvg({ color: colors.ink, label: "TAIL" }),
  "mark-paper.svg": markSvg({ color: colors.paper, trailOpacity: 0.5, label: "TAIL" }),
  "app-icon.svg": appIconSvg("warm"),
  "app-icon-1024.png": png(appIconSvg("warm"), 1024),
  "app-icon-light-1024.png": png(appIconSvg("light"), 1024),
  // Favicons: the mark alone on transparent reads at 16 px; the touch icon needs a field.
  "favicon.svg": markSvg(),
  "favicon-32.png": png(markSvg({ size: 32 }), 32),
  "apple-touch-icon.png": png(appIconSvg("warm", 180), 180),
};
for (const name of Object.keys(icons) as IconName[])
  files[`icons/${name}.svg`] = iconSvg(name, { color: colors.ink });

for (const [name, data] of Object.entries(files)) writeFileSync(`${out}${name}`, data);
console.log(`wrote ${Object.keys(files).length} files to ${out}`);
