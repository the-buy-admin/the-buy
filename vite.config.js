import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // We ship our own hand-written public/manifest.json as-is.
      manifest: false,
      registerType: "autoUpdate",
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
