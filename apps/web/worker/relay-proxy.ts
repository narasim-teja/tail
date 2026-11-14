// The site's one piece of code on Cloudflare: `/relay/*` on the site's own origin is passed to the
// relay (RELAY_ORIGIN), with the prefix dropped, exactly as Vite's dev proxy does it
// (vite.config.ts). The replay reads a match the site hasn't published from `/relay/replay/:id`,
// and the relay sends no CORS headers, so the browser has to see it on the same origin. Every
// other path is a static file (wrangler.jsonc: run_worker_first covers only /relay/*). It forwards
// only to that one origin, so it is not an open proxy.

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  RELAY_ORIGIN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/relay/")) return env.ASSETS.fetch(request);
    const target = new URL(url.pathname.slice("/relay".length) + url.search, env.RELAY_ORIGIN);
    const headers = new Headers(request.headers);
    headers.delete("host");
    // The site's cookies are not the relay's business.
    headers.delete("cookie");
    const init: RequestInit = { method: request.method, headers, redirect: "manual" };
    if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
    return fetch(target, init);
  },
};
