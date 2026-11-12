import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// RELAY_URL (dev only) is where `/relay/*` is proxied, so the page can read a relay that does
// not send CORS headers. A deployed page sets VITE_RELAY_URL instead (see README).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "");
  const relay = env["RELAY_URL"] || "http://localhost:8787";
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    server: {
      proxy: { "/relay": { target: relay, changeOrigin: true, rewrite: (p) => p.replace(/^\/relay/, "") } },
    },
    worker: { format: "es" },
    build: { target: "es2022", chunkSizeWarningLimit: 2500 },
  };
});
