// What the front page and the docs share before their first render: the colours (palette.ts) as
// custom properties, the type loaded so nothing reflows when it arrives, and a shared link to a
// section (`#proof`) landing on that section once the page is there.

import { cssVars } from "./palette.ts";

export function applyTheme(page: "landing" | "docs") {
  const html = document.documentElement;
  html.dataset["page"] = page;
  for (const [k, v] of Object.entries(cssVars())) html.style.setProperty(k, v);
}

/** Every weight the first screen sets, so the page renders once in its own type. */
export const fontsReady = () =>
  Promise.all(
    ["500 16px", "600 16px", "700 16px", "800 16px", "900 16px"].map((f) =>
      document.fonts.load(`${f} "Archivo Variable"`).catch(() => []),
    ),
  );

export function landOnHash() {
  if (location.hash)
    requestAnimationFrame(() => document.getElementById(location.hash.slice(1))?.scrollIntoView());
}
