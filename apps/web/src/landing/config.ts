// Build-time settings for the front page and the docs (README: Settings). The repository and the
// docs have built-in defaults; the dossier is left out unless a player is named.

export const DEFAULT_REPO_URL = "https://github.com/narasim-teja/tail";

const clean = (v: string | undefined) => {
  const s = v?.trim();
  return s ? s : null;
};

export interface SiteConfig {
  /** The source repository; the GitHub links and the docs' links to source files. */
  repoUrl: string;
  /** Where the docs live: the site's own /docs unless VITE_DOCS_URL says otherwise. */
  docsUrl: string;
  /** The player whose dossier the front page shows. */
  dossierAccount: string | null;
}

export function configOf(env: Record<string, string | undefined>, base = "/"): SiteConfig {
  const root = base.endsWith("/") ? base : `${base}/`;
  return {
    repoUrl: (clean(env["VITE_REPO_URL"]) ?? DEFAULT_REPO_URL).replace(/\/+$/, ""),
    docsUrl: clean(env["VITE_DOCS_URL"]) ?? `${root}docs`,
    dossierAccount: clean(env["VITE_DOSSIER_ACCOUNT"]),
  };
}

export const config = configOf(import.meta.env, import.meta.env.BASE_URL);

/** A file in the repository, on its default branch. */
export const repoFile = (path: string, repoUrl = config.repoUrl) => `${repoUrl}/blob/main/${path}`;
