import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.VITE_DEV_API ?? "http://localhost:3000";
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig(({ command }) => ({
  base: "/app/",
  plugins: [react(), tailwindcss()],
  define: {
    // The bundle's own build stamp, so the page can tell a stale tab from the build the server is running. A dev
    // server has no build time: it is labelled as dev rather than with whenever it happened to start.
    __WEB_BUILD__: JSON.stringify({
      version: pkg.version,
      builtAt: command === "build" ? new Date().toISOString() : null,
      sha: process.env.GIT_SHA || null,
    }),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: api, changeOrigin: false },
      "/cdn": { target: api, changeOrigin: false },
    },
  },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1500 },
}));
