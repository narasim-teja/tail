// Build-time settings for the front page (README: Settings). Unset means the link or section it
// feeds is left out, never a placeholder.

const clean = (v: string | undefined) => {
  const s = v?.trim();
  return s ? s : null;
};

export const config = {
  /** The source repository; links to it (README, ARCHITECTURE.md, the licence) need it. */
  repoUrl: clean(import.meta.env.VITE_REPO_URL)?.replace(/\/+$/, "") ?? null,
  /** Where the docs live. */
  docsUrl: clean(import.meta.env.VITE_DOCS_URL),
  /** The player whose dossier the front page shows. */
  dossierAccount: clean(import.meta.env.VITE_DOSSIER_ACCOUNT),
};

/** A file in the repository, on its default branch. */
export const repoFile = (path: string) => (config.repoUrl ? `${config.repoUrl}/blob/main/${path}` : null);
