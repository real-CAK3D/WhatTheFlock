// Offline support.
//  - App shell: network first (so updates land when the PC is reachable), cache fallback.
//  - Map tiles: cache first. 'fy-offline' holds deliberately downloaded areas
//    (offline.js) and is never trimmed; 'fy-tiles' is a rolling cache of
//    whatever you've viewed.
//  - OpenFreeMap style/TileJSON: network first with a short timeout, cached copy offline.
const SHELL = 'fy-shell-v18';
const TILES = 'fy-tiles-v1';
const OFFLINE = 'fy-offline';
const MAX_TILES = 8000;
const FILES = ['./', 'index.html', 'app.js', 'layers.js', 'map3d.js', 'basemap.js', 'sounds.js', 'extras.js', 'offline.js', 'nav.js', 'speed.js', 'traffic.js', 'trip.js', 'pois.js', 'sd.js', 'codriver.js', 'drives.js', 'hud.js', 'announce.js', 'weather.js', 'hazards.js', 'quick.js', 'settings.js', 'diag.js',
  'style.css', 'manifest.webmanifest', 'icon.svg',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css'];
const TILE_HOSTS = ['tile.openstreetmap.org', 'tiles.openfreemap.org', 's3.amazonaws.com',
  'server.arcgisonline.com', 'basemap.nationalmap.gov'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== SHELL && k !== TILES && k !== OFFLINE).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});

async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

// /planet/<build>/z/x/y.pbf  ->  build-independent key used by offline.js
function ofmKey(url) {
  const m = url.pathname.match(/\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
  return m && url.pathname.startsWith('/planet/') ? `https://tiles.openfreemap.org/__offline/${m[1]}/${m[2]}/${m[3]}.pbf` : null;
}

async function tileFetch(req, url) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const k = url.hostname === 'tiles.openfreemap.org' ? ofmKey(url) : null;
  if (k) { const o = await caches.match(k); if (o) return o; }
  try {
    const res = await fetch(req);
    if (res.ok || res.type === 'opaque') {
      const c = await caches.open(TILES);
      c.put(req, res.clone()); trimTiles();
    }
    return res;
  } catch { return new Response('', { status: 504 }); }
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Live shared reports: always from the network, never cached.
  if (url.origin === self.location.origin && url.pathname.startsWith('/reports')) return;

  // Style and TileJSON (no file extension) point at the current tile build.
  if (url.hostname === 'tiles.openfreemap.org' && !/\.(pbf|png|webp|json)$/.test(url.pathname)) {
    e.respondWith(withTimeout(fetch(e.request), 5000).then(res => {
      if (res.ok) caches.open(TILES).then(c => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || new Response('', { status: 504 }))));
    return;
  }

  if (TILE_HOSTS.includes(url.hostname)) { e.respondWith(tileFetch(e.request, url)); return; }

  if (url.origin === self.location.origin) {
    // A server error (e.g. 502 when the PC's server is down) must fall back to
    // the saved copy too, not just a network failure.
    e.respondWith(withTimeout(fetch(e.request), 6000).then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      caches.open(SHELL).then(c => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })
      .then(r => r || caches.match('index.html'))));
  }
});

// Tapping an alert notification brings the app back to the front.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const w = list.find(c => c.url.includes('/phone/'));
    return w ? w.focus() : self.clients.openWindow('/phone/');
  }));
});
