// The docs' entry. It shares the front page's colours, type and instruments, and none of the
// replay's code: no map library, no verifier.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme, fontsReady, landOnHash } from "../landing/theme.ts";
import { Docs } from "./Docs.tsx";
import "../landing/landing.css";
import "./docs.css";

export function mount(el: HTMLElement) {
  applyTheme("docs");
  document.title = "TAIL docs: how it works and how to check it";
  void fontsReady().then(() => {
    createRoot(el).render(
      <StrictMode>
        <Docs />
      </StrictMode>,
    );
    landOnHash();
  });
}
