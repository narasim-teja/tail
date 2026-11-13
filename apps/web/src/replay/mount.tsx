// The replay, the presence page and the dossier page (ui/App.tsx), loaded on their own so the
// front page never carries the map, deck.gl or the verifier.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../ui/App.tsx";
import type { SignIn } from "./load.ts";
import "../styles.css";

export function mount(el: HTMLElement, signIn: SignIn | null) {
  // The deck.gl text atlas is drawn with the web font, so load it before the first frame.
  void document.fonts.load('700 16px "Archivo Variable"').finally(() =>
    createRoot(el).render(
      <StrictMode>
        <App signIn={signIn} />
      </StrictMode>,
    ),
  );
}
