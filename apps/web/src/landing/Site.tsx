// The site's frame, shared by the front page and the docs: the top bar and the footer.

import { markSvg } from "@tail/brand";
import { config } from "./config.ts";
import { Logo } from "./logos.tsx";
import { siteOf } from "./site.ts";
import { TECH } from "./tech.ts";

const SITE = siteOf(import.meta.env.VITE_SITE_URL);
const base = import.meta.env.BASE_URL;

export function Mark({ size = 28 }: { size?: number }) {
  return (
    <span
      className="l-mark"
      aria-hidden="true"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: the brand's own static mark
      dangerouslySetInnerHTML={{ __html: markSvg({ size }) }}
    />
  );
}

export function SiteTop({ current }: { current: "home" | "docs" }) {
  return (
    <header className="l-top">
      <a className="l-brand" href={base} aria-label="TAIL, home">
        <Mark />
        <span className="l-wordmark">TAIL</span>
      </a>
      <nav aria-label="Site" className="l-nav">
        <a href={`${base}#matches`}>Matches</a>
        <a href={config.docsUrl} {...(current === "docs" ? { "aria-current": "page" as const } : {})}>
          Docs
        </a>
        <a className="l-nav-icon" href={config.repoUrl} rel="noopener" aria-label="Source on GitHub">
          <Logo name="github" size={22} />
        </a>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="l-foot">
      <div className="l-foot-in">
        <div className="l-foot-built">
          <p className="l-eyebrow l-foot-label">Built on</p>
          <ul className="l-foot-tech">
            {TECH.map((t) => (
              <li key={t.name}>
                <a className="l-foot-link" href={t.href} rel="noopener">
                  <Logo name={t.logo} size={18} />
                  {t.name}
                </a>
              </li>
            ))}
          </ul>
        </div>
        <div className="l-foot-row">
          <a className="l-foot-brand" href={base}>
            <Mark size={22} />
            <span className="l-wordmark">TAIL</span>
            <span className="l-foot-site">{SITE.host}</span>
          </a>
          <ul className="l-foot-links">
            <li>
              <a className="l-foot-link" href={`${base}#matches`}>
                Watch a match
              </a>
            </li>
            <li>
              <a className="l-foot-link" href={config.docsUrl}>
                Docs
              </a>
            </li>
            <li>
              <a className="l-foot-link" href={config.repoUrl} rel="noopener">
                <Logo name="github" size={18} />
                GitHub
              </a>
            </li>
          </ul>
        </div>
      </div>
    </footer>
  );
}
