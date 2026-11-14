import { colors, markSvg } from "@tail/brand";
import appleTouchIcon from "@tail/brand/assets/apple-touch-icon.png";
import { signInFromHash, takeSignIn } from "./replay/load.ts";
import { routeOf } from "./route.ts";

const route = routeOf(location.pathname, location.search, import.meta.env.BASE_URL);
// Which page this is, for the stylesheets: only the replay is a fixed full-screen stage; the
// dossier and presence pages scroll like the front page and the docs.
document.documentElement.dataset["page"] = route.kind;

// First, before any request or render: a private replay's sign-in leaves the address bar, so a
// copied or shared address carries no signature. On the front page and the docs a fragment is a
// section (`#proof`) and stays, unless it is a sign-in, which goes all the same.
const site = route.kind === "landing" || route.kind === "docs";
const signIn = !site || signInFromHash(location.hash) !== null ? takeSignIn(location, history) : null;

// Brand colours are the single source; CSS derives every other token from these in OKLCH.
const root = document.documentElement.style;
root.setProperty("--persimmon", colors.persimmon);
root.setProperty("--dusk", colors.dusk);
root.setProperty("--dusk-ink", colors.duskInk);
root.setProperty("--ink", colors.ink);

// The replay is dusk throughout; the front page sets its own as the visitor scrolls, the docs stay paper.
if (!site)
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", colors.dusk);

for (const [rel, href, type] of [
  ["icon", `data:image/svg+xml,${encodeURIComponent(markSvg({ size: 64 }))}`, "image/svg+xml"],
  ["apple-touch-icon", appleTouchIcon, "image/png"],
] as const) {
  const link = document.createElement("link");
  link.rel = rel;
  link.href = href;
  link.type = type;
  document.head.append(link);
}

// Each page loads only its own code: the front page and the docs never pull the replay's map,
// deck.gl or verifier, and the replay never waits on them.
const el = document.getElementById("root");
if (el) {
  if (route.kind === "landing") void import("./landing/mount.tsx").then((m) => m.mount(el));
  else if (route.kind === "docs") void import("./docs-page/mount.tsx").then((m) => m.mount(el));
  else void import("./replay/mount.tsx").then((m) => m.mount(el, signIn));
}
