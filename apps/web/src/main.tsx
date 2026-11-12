import { colors, markSvg } from "@tail/brand";
import appleTouchIcon from "@tail/brand/assets/apple-touch-icon.png";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App.tsx";
import "./styles.css";

// Brand colours are the single source; CSS derives every other token from these in OKLCH.
const root = document.documentElement.style;
root.setProperty("--persimmon", colors.persimmon);
root.setProperty("--dusk", colors.dusk);
root.setProperty("--dusk-ink", colors.duskInk);
root.setProperty("--ink", colors.ink);

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

// The deck.gl text atlas is drawn with the web font, so load it before the first frame.
void document.fonts.load('700 16px "Archivo Variable"').finally(() => {
  const el = document.getElementById("root");
  if (el)
    createRoot(el).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
});
