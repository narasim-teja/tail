import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { siteOf } from "./src/landing/site.ts";

/**
 * Writes the site's canonical origin (VITE_SITE_URL, default https://playtail.app) into
 * index.html, where the canonical link and the social cards need absolute URLs.
 */
const siteUrl = (url: string): Plugin => ({
  name: "tail-site-url",
  transformIndexHtml: (html) => html.replaceAll("%SITE_URL%", url),
});

// RELAY_URL (dev only) is where `/relay/*` is proxied, so the page can read a relay that does
// not send CORS headers. A deployed page sets VITE_RELAY_URL instead (see README).
/**
 * @tail/protocol only declares (its modules run no code at load beyond building constants), but
 * its package.json doesn't say so, so a bundler keeps every module the barrel re-exports. Marked
 * pure here, the front page takes the pricing rule and the constants it uses and leaves the
 * crypto behind for the replay.
 */
const PROTOCOL_SRC = /[\\/]packages[\\/]protocol[\\/]src[\\/]/;
const pureProtocol = (): Plugin => ({
  name: "tail-pure-protocol",
  enforce: "pre",
  async resolveId(source, importer, options) {
    const fromProtocol = importer !== undefined && PROTOCOL_SRC.test(importer);
    if (source !== "@tail/protocol" && !fromProtocol) return null;
    const r = await this.resolve(source, importer, { ...options, skipSelf: true });
    return r && PROTOCOL_SRC.test(r.id) ? { ...r, moduleSideEffects: false } : r;
  },
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "");
  const relay = env["RELAY_URL"] || "http://localhost:8787";
  return {
    plugins: [pureProtocol(), react(), tailwindcss(), siteUrl(siteOf(env["VITE_SITE_URL"]).url)],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    server: {
      // Phones open the dev page by the Mac's Bonjour name (`<mac>.local`) on the LAN, or through
      // a Cloudflare quick tunnel (`*.trycloudflare.com`) from anywhere; Vite's DNS-rebinding
      // check blocks any host it is not told about. Vite listens on localhost only by default, so
      // it has to listen on every interface for a phone on the LAN to reach it at all.
      host: true,
      allowedHosts: [".local", ".trycloudflare.com"],
      proxy: { "/relay": { target: relay, changeOrigin: true, rewrite: (p) => p.replace(/^\/relay/, "") } },
    },
    worker: { format: "es" },
    build: { target: "es2022", chunkSizeWarningLimit: 2500 },
  };
});
