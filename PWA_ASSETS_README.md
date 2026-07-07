# The Buy — PWA assets (prepared in advance)

These files are ready for whenever the app is moved out of Claude.ai and hosted
independently (the "②" migration path). They are NOT active yet — the app
still runs as a Claude.ai artifact today, which cannot install as a PWA on its
own.

## What's included

- `manifest.json` — the PWA's identity: name ("The Buy"), colors
  (black/white), icons, and standalone display mode.
- `icon-192.png`, `icon-512.png` — home-screen / app-list icons.
- `icon-apple-touch.png` — iOS home-screen icon (180x180, Apple's expected size).

## How to wire these in (for whoever does the Claude Code migration)

1. Place all four files in the web app's public root (next to `index.html`).
2. Add to `index.html`'s `<head>`:
   ```html
   <link rel="manifest" href="/manifest.json">
   <link rel="apple-touch-icon" href="/icon-apple-touch.png">
   <meta name="theme-color" content="#111110">
   <meta name="apple-mobile-web-app-capable" content="yes">
   <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
   <title>The Buy</title>
   ```
3. Add a minimal service worker (`sw.js`) for offline caching and register it:
   ```html
   <script>
     if ('serviceWorker' in navigator) {
       navigator.serviceWorker.register('/sw.js');
     }
   </script>
   ```
4. Once deployed over HTTPS, browsers will offer "Install The Buy"
   automatically — that's what makes it behave like a native Windows/Mac/
   mobile app (own window, own taskbar icon, own app-switcher entry).

## Design notes carried over from the current app

- Color theme: near-black ink (`#111110`) on off-white (`#FAFAF8`), no other
  accent colors — matches the app's existing minimalist black/white styling.
- The in-app splash screen (shown while data loads) already uses the same
  "The Buy" wordmark and can be reused as the PWA's actual launch splash once
  hosted independently (some platforms auto-generate a splash from the
  manifest's icon + background_color; others need a dedicated splash image,
  which can be produced from this same wordmark if needed).
