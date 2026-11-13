// The site's frame, shared by the front page and the docs: the top bar and the footer.

import { markSvg } from "@tail/brand";
import { config } from "./config.ts";
import { siteOf } from "./site.ts";

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

/** The site's three ways on: the matches, the docs, the source. */
function links(current: "home" | "docs") {
  return [
    { text: "Matches", href: `${base}#matches` },
    { text: "Docs", href: config.docsUrl, current: current === "docs" },
    { text: "GitHub", href: config.repoUrl, external: true },
  ];
}

export function SiteTop({ current }: { current: "home" | "docs" }) {
  return (
    <header className="l-top">
      <a className="l-brand" href={base} aria-label="TAIL, home">
        <Mark />
        <span className="l-wordmark">TAIL</span>
      </a>
      <nav aria-label="Site" className="l-nav">
        {links(current).map((l) => (
          <a
            key={l.text}
            href={l.href}
            {...(l.current ? { "aria-current": "page" as const } : {})}
            {...(l.external ? { rel: "noopener" } : {})}
          >
            {l.text}
          </a>
        ))}
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="l-foot">
      <div className="l-foot-in">
        <a className="l-foot-brand" href={base}>
          <Mark size={22} />
          <span className="l-wordmark">TAIL</span>
          <span className="l-foot-site">{SITE.host}</span>
        </a>
        <ul className="l-foot-links">
          <li>
            <a className="l-foot-link" href={config.repoUrl} rel="noopener">
              GitHub
            </a>
          </li>
          <li>
            <a className="l-foot-link" href={config.docsUrl}>
              Docs
            </a>
          </li>
          <li>
            <a className="l-foot-link" href={`${base}#matches`}>
              Watch a match
            </a>
          </li>
        </ul>
      </div>
    </footer>
  );
}
