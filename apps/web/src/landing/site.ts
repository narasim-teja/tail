// The site's canonical origin, from VITE_SITE_URL at build time (default https://playtail.app).
// Pure, so vite.config.ts can read it too.
// vite.config.ts writes the same value into index.html's canonical link and social cards, which
// need absolute URLs. `.app` is HTTPS only, so an origin that isn't https is refused.

export const DEFAULT_SITE_URL = "https://playtail.app";

export function siteOf(raw: string | undefined): { url: string; host: string } {
  const value = raw?.trim() || DEFAULT_SITE_URL;
  const u = new URL(value);
  if (u.protocol !== "https:") throw new Error(`VITE_SITE_URL must be https, not ${u.protocol}`);
  return { url: u.origin, host: u.host };
}
