import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// Builds straight into the Worker's static assets. `npm run dev` proxies to `wrangler dev` on :8787.
export default defineConfig({
  plugins: [preact()],
  build: { outDir: "../worker/public", emptyOutDir: true, assetsDir: "a", sourcemap: false },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/hub": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
});
