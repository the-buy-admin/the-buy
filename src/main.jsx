import React from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App.jsx";
import AuthGate from "./auth/AuthGate.jsx";

// Poll for a new service worker instead of only checking once per page
// load - GitHub Pages caches sw.js for several minutes, so without this a
// plain reload right after deploying often still sees the old version.
const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(swUrl, registration) {
    if (!registration) return;
    setInterval(() => registration.update(), 60 * 1000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") registration.update();
    });
  },
  onNeedRefresh() {
    updateSW(true);
  },
});

createRoot(document.getElementById("root")).render(
  <AuthGate>
    <App />
  </AuthGate>
);
