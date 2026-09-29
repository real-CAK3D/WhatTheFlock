# Flock You Mobile

A phone web app (Chrome on Android) that talks to the XIAO ESP32-S3 over USB-C
(WebUSB), tags every detection with the phone's GPS, and maps it. Installable
to the home screen; works with no cell service once set up.

## Files

| File | What it does |
|---|---|
| `app.js` | USB link, detection store, 2D map, camera list, trip stats, export/import |
| `layers.js` | Mapped cameras from OpenStreetMap/DeFlock (Overpass), proximity alerts |
| `map3d.js` | Optional 3D view (MapLibre + OpenFreeMap buildings, terrain) |
| `basemap.js` | Map / Satellite (Esri) / USGS imagery switch |
| `sounds.js` | Phone alert sounds (Web Audio), voice, vibration, notifications |
| `extras.js` | Setup & permissions checklist, camera finder, online indicator |
| `offline.js` | Offline map downloads and auto-switch when signal drops |
| `nav.js` | Address search, routing (fewest-cameras option), turn-by-turn voice guidance |
| `speed.js` | Speedometer, speed limit (OSM, TomTom, estimate), over-limit warning |
| `traffic.js` | TomTom live traffic, incidents, alerts, route delays |
| `config.local.js` | Git-ignored local keys (TomTom). Not committed. |
| `sw.js` | Service worker: offline app shell and tile caches |
| `test/sw-offline.test.mjs` | `node test/sw-offline.test.mjs` - offline cache behaviour |

## Serving

Served from the PC over Tailscale: a local `python -m http.server 8088
--bind 127.0.0.1 --directory phone` behind `tailscale serve --set-path /phone
http://127.0.0.1:8088`. Chrome needs HTTPS for USB/GPS, which Tailscale provides.
Once installed on the phone, the app runs from its own cache without the PC.

## Rolling back

Everything lives on the `phone-webapp` branch; `git checkout main` returns the
repo to upstream. Each feature is its own commit and can be reverted alone.

