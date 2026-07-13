import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // Served from https://the-buy-admin.github.io/the-buy/ (a GitHub Pages
  // project site), so every asset path needs this subpath prefix.
  base: "/the-buy/",
  plugins: [
    react(),
    VitePWA({
      // We ship our own hand-written public/manifest.json as-is.
      manifest: false,
      registerType: "autoUpdate",
      // Registered manually (src/main.jsx) so we can poll for updates
      // instead of only checking once per page load - GitHub Pages caches
      // sw.js for several minutes, so a plain reload right after deploying
      // often still sees the old service worker.
      injectRegister: false,
      includeAssets: ["icon-192.png", "icon-512.png", "icon-apple-touch.png"],
      workbox: {
        // App shell is cached for offline/instant loads. Firebase calls (auth +
        // database) are never intercepted here, since the data must always be
        // fetched live/synced from the network.
        globPatterns: ["**/*.{js,css,html,png,svg,ico}"],
      },
    }),
  ],
});
