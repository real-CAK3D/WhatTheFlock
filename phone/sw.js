// Offline support: app shell is cached on install; map tiles are cached as
// you view them so areas you've driven through still render without signal.
const SHELL = 'fy-shell-v1';
const TILES = 'fy-tiles-v1';
const MAX_TILES = 4000;
const FILES = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icon.svg',
  'vendor/leaflet.js', 'vendor/leaflet.css'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});

async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  if (url.hostname === 'tile.openstreetmap.org') {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      try {
        const res = await fetch(e.request);
        if (res.ok || res.type === 'opaque') { c.put(e.request, res.clone()); trimTiles(); }
        return res;
      } catch { return new Response('', { status: 504 }); }
    }));
    return;
  }

  if (url.origin === self.location.origin) {
    // Network first so updates land when the PC is reachable; cache when it isn't.
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok) caches.open(SHELL).then(c => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })
      .then(r => r || caches.match('index.html'))));
  }
});
