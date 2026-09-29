'use strict';
// Offline maps: downloads OpenFreeMap vector tiles (street map + 3D buildings,
// which OpenFreeMap permits bulk use of), the style/fonts/icons they need,
// optional terrain, and the mapped-camera data for an area. Everything goes in
// the 'fy-offline' cache, which sw.js checks before the network and never
// trims. The 2D OSM/satellite tiles are not bulk-downloaded (their providers
// forbid it), so with no signal the app switches to the 3D engine laid flat.
// Loaded last; uses globals from app.js, layers.js, map3d.js.

const OFFLINE_CACHE = 'fy-offline';
const AREAS_KEY = 'fy.areas.v1';
const OFM_TILEJSON = 'https://tiles.openfreemap.org/planet';
const OFM_MAXZOOM = 14;       // vector tiles are overzoomed past this
const NE_MAXZOOM = 6;         // low-zoom shaded relief in the Liberty style
const TERRAIN_MAXZOOM = 12;
const FONT_RANGES = ['0-255', '256-511', '8192-8447'];
const PARALLEL = 6;
const AVG_TILE_KB = 45;       // rough estimate for the size preview

opts.autoOffline = opts.autoOffline ?? true;

let areas = [];
try { areas = JSON.parse(localStorage.getItem(AREAS_KEY)) || []; } catch {}
const saveAreas = () => { try { localStorage.setItem(AREAS_KEY, JSON.stringify(areas)); } catch {} };

// Cache key for a vector tile regardless of OpenFreeMap's weekly build folder,
// so a newer TileJSON still finds the tiles downloaded from an older build.
const ofmKey = (z, x, y) => `https://tiles.openfreemap.org/__offline/${z}/${x}/${y}.pbf`;

function tileXY(lat, lon, z) {
  const n = 2 ** z, r = lat * Math.PI / 180;
  return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2 * n)];
}
function tilesFor(b, zmin, zmax) {
  const out = [];
  for (let z = zmin; z <= zmax; z++) {
    const [x0, y0] = tileXY(b.n, b.w, z), [x1, y1] = tileXY(b.s, b.e, z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
  }
  return out;
}
function areaBox(c, km) {
  const dLat = km / 111, dLon = km / (111 * Math.cos(c.lat * Math.PI / 180));
  return { s: c.lat - dLat, n: c.lat + dLat, w: c.lon - dLon, e: c.lon + dLon };
}
function areaCenter() {
  if (fix) return { lat: fix.lat, lon: fix.lon, src: 'your GPS position' };
  if (typeof map3dActive === 'function' && map3dActive()) { const c = map3d.getCenter(); return { lat: c.lat, lon: c.lng, src: 'the map centre' }; }
  const c = map.getCenter(); return { lat: c.lat, lon: c.lng, src: 'the map centre' };
}

// ---------------------------------------------------------------- download

let job = null;   // { ac, done, total, bytes }

async function putUrl(cache, url, key = url, signal) {
  if (await cache.match(key)) return 0;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.split('/').slice(2, 4).join('/')}`);
  const blob = await r.blob();
  await cache.put(key, new Response(blob, { headers: { 'Content-Type': r.headers.get('Content-Type') || 'application/octet-stream' } }));
  return blob.size;
}

async function styleAssets(cache, signal) {
  const urls = [OFM_TILEJSON, STYLE_URL];
  const style = await (await fetch(STYLE_URL, { signal })).json();
  const tj = await (await fetch(OFM_TILEJSON, { signal })).json();
  if (style.sprite) for (const s of ['', '@2x']) urls.push(style.sprite + s + '.json', style.sprite + s + '.png');
  const stacks = new Set();
  for (const l of style.layers) {
    const f = l.layout && l.layout['text-font'];
    if (Array.isArray(f) && f.every(s => typeof s === 'string')) stacks.add(f.join(','));
  }
  if (style.glyphs) for (const st of stacks) for (const r of FONT_RANGES)
    // Same encoding MapLibre's request ends up with: spaces escaped, commas kept.
    urls.push(style.glyphs.replace('{fontstack}', st.split(',').map(encodeURIComponent).join(',')).replace('{range}', r));
  let bytes = 0;
  // Style/TileJSON are stored fresh even if already cached, so they match the tiles.
  await cache.delete(OFM_TILEJSON); await cache.delete(STYLE_URL);
  for (const u of urls) bytes += await putUrl(cache, u, u, signal).catch(() => 0);
  return { tpl: tj.tiles[0], bytes };
}

async function runPool(items, worker, signal) {
  let i = 0;
  const next = async () => {
    while (i < items.length) {
      if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
      const it = items[i++];
      await worker(it).catch(e => { if (e.name === 'AbortError') throw e; job.failed++; });
      job.done++; paintJob();
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, next));
}

async function downloadArea() {
  if (job) return;
  if (!navigator.onLine) { toast('Connect to Wi-Fi first'); return; }
  const km = Number($('offKm').value);
  const c = areaCenter();
  const b = areaBox(c, km);
  const vec = tilesFor(b, 0, OFM_MAXZOOM);
  const ne = tilesFor(b, 0, NE_MAXZOOM);
  const dem = $('offTerrain').checked ? tilesFor(b, 0, TERRAIN_MAXZOOM) : [];
  navigator.storage?.persist?.();
  job = { ac: new AbortController(), done: 0, total: vec.length + ne.length + dem.length, bytes: 0, failed: 0, phase: 'Map style & fonts' };
  paintJob();
  const signal = job.ac.signal;
  try {
    const cache = await caches.open(OFFLINE_CACHE);
    const sa = await styleAssets(cache, signal);
    job.bytes += sa.bytes;
    job.phase = 'Street map & 3D buildings';
    await runPool(vec, async ([z, x, y]) => {
      job.bytes += await putUrl(cache, sa.tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y), ofmKey(z, x, y), signal);
    }, signal);
    job.phase = 'Overview relief';
    await runPool(ne, async ([z, x, y]) => {
      job.bytes += await putUrl(cache, `https://tiles.openfreemap.org/natural_earth/ne2sr/${z}/${x}/${y}.png`, undefined, signal);
    }, signal);
    if (dem.length) {
      job.phase = 'Terrain';
      await runPool(dem, async ([z, x, y]) => {
        job.bytes += await putUrl(cache, TERRAIN_TILES.replace('{z}', z).replace('{x}', x).replace('{y}', y), undefined, signal);
      }, signal);
    }
    if ($('offCams').checked) {
      job.phase = 'Mapped cameras'; paintJob(); await saveArea(km);
      if (typeof ensurePlaceCells === 'function') { job.phase = 'Gas, food, rest stops & places'; paintJob(); await ensurePlaceCells(cellsFor(b)); }
    }
    areas.push({ id: Date.now(), lat: +c.lat.toFixed(4), lon: +c.lon.toFixed(4), km, tiles: job.total, bytes: job.bytes, terrain: dem.length > 0, ts: Date.now() });
    saveAreas();
    toast(`Offline map saved · ${fmtBytes(job.bytes)}${job.failed ? ` · ${job.failed} tiles failed (run again to retry)` : ''}`);
  } catch (e) {
    toast(e.name === 'AbortError' ? 'Download cancelled (what finished is kept)' : 'Download failed: ' + e.message);
  } finally {
    job = null; paintJob(); paintAreas();
  }
}

function estimate() {
  const km = Number($('offKm').value);
  const c = areaCenter();
  const b = areaBox(c, km);
  let n = tilesFor(b, 0, OFM_MAXZOOM).length;
  let kb = n * AVG_TILE_KB;
  if ($('offTerrain').checked) { const t = tilesFor(b, 0, TERRAIN_MAXZOOM).length; n += t; kb += t * 60; }
  $('offEst').textContent = `Around ${c.src}: ${fmtDist(km * 1000)} each way · ${n.toLocaleString()} tiles · roughly ${fmtBytes(kb * 1000)} (cities are larger, countryside smaller).`;
}

function paintJob() {
  const on = !!job;
  $('offGo').hidden = on; $('offCancel').hidden = !on; $('offProg').hidden = !on;
  if (!on) return;
  const pct = job.total ? Math.round(job.done / job.total * 100) : 0;
  $('offFill').style.width = pct + '%';
  $('offProgText').textContent = `${job.phase} · ${job.done.toLocaleString()}/${job.total.toLocaleString()} · ${fmtBytes(job.bytes)}`;
}

async function paintAreas() {
  const el = $('offAreas');
  if (!el) return;
  if (!areas.length) { el.innerHTML = '<p class="mute">No offline maps saved yet.</p>'; return; }
  const total = areas.reduce((s, a) => s + (a.bytes || 0), 0);
  el.innerHTML = areas.map(a => `
    <div class="setup-row"><span class="dot on"></span>
      <div class="setup-body"><b>${a.name ? esc(a.name) + ` (${fmtDist(a.km * 1000)} each side)` : `${fmtDist(a.km * 1000)} around ${a.lat}, ${a.lon}`}</b>
      <div class="mute small1">${new Date(a.ts).toLocaleDateString()} · ${fmtBytes(a.bytes)}${a.terrain ? ' · terrain' : ''}</div></div>
      <button data-goto="${a.id}">View</button></div>`).join('') +
    `<p class="mute">Total ${fmtBytes(total)}.</p>`;
  el.querySelectorAll('[data-goto]').forEach(b => b.onclick = async () => {
    const a = areas.find(x => String(x.id) === b.dataset.goto);
    showTab('map'); setFollow(false);
    if (!opts.view3d) await set3D(true);
    map3d.jumpTo({ center: [a.lon, a.lat], zoom: 12, pitch: 0 });
  });
}

async function clearOffline() {
  if (!confirm('Delete all downloaded offline maps? Your detections are not affected.')) return;
  await caches.delete(OFFLINE_CACHE);
  areas = []; saveAreas(); paintAreas();
  toast('Offline maps deleted');
}

// ---------------------------------------------------------------- auto switch

let autoSwitched = false;
async function onOffline() {
  if (!opts.autoOffline || opts.view3d || !areas.length) return;
  autoSwitched = true;
  await set3D(true);
  if (map3dReady) map3d.easeTo({ pitch: 0, duration: 0 });
  toast('No signal — showing your offline map');
}
async function onOnline() {
  if (autoSwitched && opts.view3d) { autoSwitched = false; await set3D(false); toast('Back online — normal map'); }
}
window.addEventListener('offline', onOffline);
window.addEventListener('online', onOnline);

// ---------------------------------------------------------------- UI

(function buildOfflineUi() {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h2>Offline maps</h2>
    <p class="mute">Download the street map and 3D buildings for an area while on Wi-Fi, so the map works with no cell service. Centred on your GPS position (or the map if there's no fix yet).</p>
    <label class="sw">Distance each way
      <select id="offKm"><option value="5"></option><option value="15"></option><option value="30" selected></option><option value="60"></option><option value="100"></option></select>
    </label>
    <label class="sw"><input type="checkbox" id="offCams" checked> Include mapped cameras and places (gas, food, rest stops…)</label>
    <label class="sw"><input type="checkbox" id="offTerrain"> Include terrain (bigger download)</label>
    <p class="mute small1" id="offEst"></p>
    <button id="offGo" class="primary">Download</button>
    <button id="offCancel" hidden>Cancel</button>
    <div id="offProg" hidden><div class="finder-bar"><div id="offFill"></div></div><div class="mute small1" id="offProgText"></div></div>
    <label class="sw"><input type="checkbox" id="optAutoOffline"> Switch to the offline map automatically when signal drops</label>
    <div id="offAreas"></div>
    <button id="offClear">Delete all offline maps</button>`;
  $('slot-offline').append(card);
  for (const o of $('offKm').options) o.textContent = fmtDist(Number(o.value) * 1000);
  $('offKm').onchange = estimate;
  $('offTerrain').onchange = estimate;
  $('offGo').onclick = downloadArea;
  $('offCancel').onclick = () => job && job.ac.abort();
  $('offClear').onclick = clearOffline;
  bindOpt('optAutoOffline', 'autoOffline');
  document.querySelector('nav [data-tab="set"]').addEventListener('click', estimate);
  estimate();
  paintAreas();
  if (!navigator.onLine) setTimeout(onOffline, 500);
})();
