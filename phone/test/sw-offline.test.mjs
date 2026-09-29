// Offline test harness for phone/sw.js: fake Cache Storage, network always down.
import fs from 'node:fs';
const src = fs.readFileSync('G:/flock-you/phone/sw.js', 'utf8');

const stores = new Map();
const keyOf = r => (typeof r === 'string' ? r : r.url);
const mkCache = () => {
  const m = new Map();
  return {
    match: async r => m.get(keyOf(r)),
    put: async (r, res) => { m.set(keyOf(r), res); },
    keys: async () => [...m.keys()].map(url => ({ url })),
    delete: async r => m.delete(keyOf(r)),
    addAll: async () => {},
  };
};
globalThis.caches = {
  open: async n => { if (!stores.has(n)) stores.set(n, mkCache()); return stores.get(n); },
  match: async r => { for (const c of stores.values()) { const h = await c.match(r); if (h) return h; } },
  keys: async () => [...stores.keys()],
  delete: async n => stores.delete(n),
};
globalThis.fetch = async () => { throw new TypeError('offline'); };
const handlers = {};
globalThis.self = { addEventListener: (t, f) => { handlers[t] = f; }, location: { origin: 'https://nukebox.tailac984b.ts.net' } };
new Function(src)();

const run = async url => {
  let p;
  handlers.fetch({ request: { url, method: 'GET' }, respondWith: x => { p = x; } });
  const res = await p;
  return res && (res.status ?? 200) + ' ' + (typeof res.body === 'string' ? res.body : '');
};
const R = (body, status = 200) => ({ body, status, clone() { return this; } });

const off = await caches.open('fy-offline');
await off.put('https://tiles.openfreemap.org/__offline/14/4350/6550.pbf', R('TILE'));
await off.put('https://tiles.openfreemap.org/planet', R('TILEJSON'));
await off.put('https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf', R('FONT'));
await off.put('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/10/271/408.png', R('DEM'));
const shell = await caches.open('fy-shell-v5');
await shell.put('https://nukebox.tailac984b.ts.net/phone/app.js', R('APP'));

const tests = [
  ['vector tile from a NEWER build falls back to downloaded tile', 'https://tiles.openfreemap.org/planet/20991231_000000_pt/14/4350/6550.pbf', '200 TILE'],
  ['TileJSON served from cache when offline', 'https://tiles.openfreemap.org/planet', '200 TILEJSON'],
  ['font glyphs from offline cache', 'https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf', '200 FONT'],
  ['terrain tile from offline cache', 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/10/271/408.png', '200 DEM'],
  ['missing tile returns 504, not a hang', 'https://tiles.openfreemap.org/planet/x/14/1/1.pbf', '504 '],
  ['app shell offline', 'https://nukebox.tailac984b.ts.net/phone/app.js', '200 APP'],
];
let fail = 0;
for (const [name, url, want] of tests) {
  const got = await run(url);
  const ok = got === want;
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : `  (got "${got}", want "${want}")`));
}
process.exit(fail ? 1 : 0);

