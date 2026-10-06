# Teleprompter

A teleprompter and camera recorder for iPhone, built as a Progressive Web App.
Plain HTML, CSS and JavaScript with no build step.

**Live app:** https://markadams88.github.io/Teleprompt-Recorder-/

## Features

- Script screen with automatic saving (localStorage).
- Full-screen recording screen: live camera preview, smooth `requestAnimationFrame` scrolling,
  reading line a third of the way down (near the front camera).
- Text size, speed, play/pause, reset, front/back camera, mirror preview (preview only),
  optional 3-2-1 countdown. Controls hide after 3 seconds; tap to show them again.
  Tap the text to pause or play; drag the text to move it by hand.
- Records the raw camera stream (no text in the video) as MP4/H.264 where supported,
  at 16 Mbps for 4K and 10 Mbps for 1080p, with 192 kbps audio and voice processing turned off.
- Shows the actual capture resolution and frame rate in the top-right corner.
- Save to Photos through the share sheet, with a download fallback.
- Works offline once opened (service worker) and installs to the Home Screen.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The three screens |
| `styles.css` | Layout, safe areas, portrait and landscape |
| `app.js` | Script storage, scrolling, camera, recording, saving |
| `sw.js` | Offline cache: bump `VERSION` when you change the app |
| `manifest.webmanifest` | Home Screen app settings |
| `icons/` | App icons (180, 192, 512 px) |

## Hosting

Served by GitHub Pages from the `main` branch root
(Settings > Pages > Build and deployment > Source: *Deploy from a branch*, Branch: `main`, folder `/ (root)`).
