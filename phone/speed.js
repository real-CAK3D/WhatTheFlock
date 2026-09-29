'use strict';
// Speedometer + posted speed limit + current road name + over-limit warning.
// Limit sources, best first:
//   1. OpenStreetMap maxspeed on the matched road (Overpass, cached per ~1 km cell)
//   2. TomTom reverse geocode speedLimit (only when a TomTom key is set; traffic.js)
//   3. Estimate by road class (shown with a dashed sign and "est.")
// Loaded after nav.js; uses globals from app.js, layers.js, sounds.js.

const ROAD_CELL = 0.01;                     // ~1.1 km
const ROAD_MAX_AGE = 30 * 86400e3;
const MATCH_M = 30;                         // ignore roads further than this
const DRIVABLE = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';
// Rough US defaults when a road has no posted limit in the data (mph).
const EST_MPH = { motorway: 65, trunk: 55, primary: 45, secondary: 40, tertiary: 35, unclassified: 35, residential: 25,
  living_street: 15, motorway_link: 45, trunk_link: 40, primary_link: 35, secondary_link: 30, tertiary_link: 30 };

opts.showSpeed = opts.showSpeed ?? true;
opts.speedWarn = opts.speedWarn ?? 5;       // warn this many units over the limit; -1 = off
opts.estLimits = opts.estLimits ?? true;

// ---------------------------------------------------------------- road cache (IndexedDB)

const roadDB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('flockyou-roads', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('cells');
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async get(k) {
    const db = await this.open();
    return new Promise(res => { const q = db.transaction('cells').objectStore('cells').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
  },
  async putMany(entries) {
    const db = await this.open();
    return new Promise(res => { const t = db.transaction('cells', 'readwrite'); for (const [k, v] of entries) t.objectStore('cells').put(v, k); t.oncomplete = res; t.onerror = res; });
  },
};

const roadCells = new Map();  // key -> {ts, ways:[{id, hw, max, name, ref, oneway, pts:[[lat,lon]...]}]}
let roadFetching = false;

function parseMax(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?/i);
  if (!m) return null;
  const n = Number(m[1]), mph = /mph/i.test(m[2] || '');
  return { kmh: mph ? n * 1.60934 : n, raw: n, unit: mph ? 'mph' : 'kmh' };
}

async function fetchRoads(cells) {
  const s = Math.min(...cells.map(c => c[0])) * ROAD_CELL, n = (Math.max(...cells.map(c => c[0])) + 1) * ROAD_CELL;
  const w = Math.min(...cells.map(c => c[1])) * ROAD_CELL, e = (Math.max(...cells.map(c => c[1])) + 1) * ROAD_CELL;
  const q = `[out:json][timeout:40];way["highway"~"^(${DRIVABLE})$"](${s.toFixed(4)},${w.toFixed(4)},${n.toFixed(4)},${e.toFixed(4)});out tags geom;`;
  let d = null, err;
  for (const url of OVERPASS) {
    try {
      const ac = new AbortController(), t = setTimeout(() => ac.abort(), 45000);
      const r = await fetch(url + '?data=' + encodeURIComponent(q), { signal: ac.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      d = await r.json(); break;
    } catch (x) { err = x; }
  }
  if (!d) throw err;
  const buckets = new Map(cells.map(c => [c[0] + ':' + c[1], []]));
  for (const el of d.elements) {
    if (!el.geometry) continue;
    const t = el.tags || {};
    const way = { id: el.id, hw: t.highway, max: t.maxspeed || t['maxspeed:forward'] || '', name: t.name || '', ref: t.ref || '',
      oneway: t.oneway === 'yes' || t.highway === 'motorway' || t.junction === 'roundabout', pts: el.geometry.map(g => [g.lat, g.lon]) };
    // File the way under every cell its points touch, so matching near a cell edge still finds it.
    const keys = new Set(way.pts.map(([la, lo]) => Math.floor(la / ROAD_CELL) + ':' + Math.floor(lo / ROAD_CELL)));
    for (const k of keys) if (buckets.has(k)) buckets.get(k).push(way);
  }
  const now = Date.now();
  for (const [k, ways] of buckets) roadCells.set(k, { ts: now, ways });
  await roadDB.putMany([...buckets].map(([k, ways]) => [k, { ts: now, ways }]));
}

// Make sure the 3x3 block of cells around a position is loaded.
async function ensureRoads(f) {
  const i0 = Math.floor(f.lat / ROAD_CELL), j0 = Math.floor(f.lon / ROAD_CELL);
  const need = [];
  for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) {
    const k = i + ':' + j;
    if (roadCells.has(k) && Date.now() - roadCells.get(k).ts < ROAD_MAX_AGE) continue;
    const c = await roadDB.get(k);
    if (c && Date.now() - c.ts < ROAD_MAX_AGE) roadCells.set(k, c); else need.push([i, j]);
  }
  if (need.length && navigator.onLine && !roadFetching) {
    roadFetching = true;
    try { await fetchRoads(need); } catch {} finally { roadFetching = false; }
  }
}

// ---------------------------------------------------------------- map matching

let lastWay = null;
function matchRoad(f) {
  const i0 = Math.floor(f.lat / ROAD_CELL), j0 = Math.floor(f.lon / ROAD_CELL);
  const P = proj(f.lat), q = P(f.lat, f.lon);
  const moving = f.hdg != null && !Number.isNaN(f.hdg) && (f.spd ?? 0) > 2;
  let best = null, bs = Infinity;
  const seen = new Set();
  for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) {
    const c = roadCells.get(i + ':' + j);
    if (!c) continue;
    for (const w of c.ways) {
      if (seen.has(w.id)) continue;
      seen.add(w.id);
      for (let k = 0; k < w.pts.length - 1; k++) {
        const a = P(...w.pts[k]), b = P(...w.pts[k + 1]);
        const [d] = segDist(q, a, b);
        if (d > MATCH_M) continue;
        let score = d;
        if (moving) {
          const brg = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI + 360) % 360;
          const diff = w.oneway ? angDiff(brg, f.hdg) : Math.min(angDiff(brg, f.hdg), angDiff((brg + 180) % 360, f.hdg));
          score += diff * 0.4;                 // 90° off ≈ 36 m penalty
        }
        if (lastWay && w.id === lastWay.id) score -= 8;   // stick to the road we're on
        if (score < bs) { bs = score; best = w; }
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------- speed

let spdEMA = null, prevFix = null, overSince = 0, lastOverWarn = 0, limitNow = null;
const toUnits = kmh => opts.units === 'metric' ? kmh : kmh / 1.60934;
const unitLabel = () => opts.units === 'metric' ? 'km/h' : 'mph';

function currentSpeedKmh(f) {
  let ms = f.spd;
  if ((ms == null || Number.isNaN(ms)) && prevFix && f.ts - prevFix.ts > 500 && f.ts - prevFix.ts < 10000)
    ms = distM(prevFix, f) / ((f.ts - prevFix.ts) / 1000);
  prevFix = f;
  if (ms == null || Number.isNaN(ms)) return null;
  const kmh = Math.max(0, ms * 3.6);
  spdEMA = spdEMA == null ? kmh : spdEMA * 0.4 + kmh * 0.6;
  return spdEMA < 2 ? 0 : spdEMA;
}

// The limit to show for a matched road, in the display units.
function limitFor(w) {
  if (!w) return null;
  const p = parseMax(w.max);
  if (p) return { v: Math.round(opts.units === 'metric' ? p.kmh : (p.unit === 'mph' ? p.raw : p.kmh / 1.60934)), est: false, src: 'OSM' };
  const tt = typeof ttLimitFor === 'function' ? ttLimitFor(w) : null;
  if (tt) return tt;
  if (!opts.estLimits || !EST_MPH[w.hw]) return null;
  const mph = EST_MPH[w.hw];
  return { v: opts.units === 'metric' ? Math.round(mph * 1.60934 / 10) * 10 : mph, est: true, src: 'estimate' };
}

async function speedOnFix(f) {
  if (!opts.showSpeed || !f || f.acc > 60) return;
  const kmh = currentSpeedKmh(f);
  ensureRoads(f);   // background; next fix benefits
  const w = matchRoad(f);
  if (w) lastWay = w;
  limitNow = limitFor(w);
  if (w && typeof ttMaybeLookup === 'function') ttMaybeLookup(f, w);
  paintSpeed(kmh, w);
  checkOver(kmh);
}

function paintSpeed(kmh, w) {
  const v = kmh == null ? '–' : Math.round(toUnits(kmh));
  $('spdVal').textContent = v;
  $('spdUnit').textContent = unitLabel();
  const sign = $('limSign');
  sign.hidden = !limitNow;
  if (limitNow) {
    sign.classList.toggle('est', limitNow.est);
    sign.classList.toggle('metric', opts.units === 'metric');
    $('limVal').textContent = limitNow.v;
    sign.title = 'Speed limit (' + limitNow.src + ')';
  }
  $('roadName').textContent = w ? (w.name || w.ref || '') : '';
  $('roadName').hidden = !w || !(w.name || w.ref);
}

function checkOver(kmh) {
  const box = $('speedo');
  if (kmh == null || !limitNow || opts.speedWarn < 0) { box.classList.remove('over'); overSince = 0; return; }
  const over = toUnits(kmh) > limitNow.v + opts.speedWarn;
  box.classList.toggle('over', over);
  if (!over) { overSince = 0; return; }
  if (!overSince) overSince = Date.now();
  // Only nag after 3 s over, and at most every 45 s.
  if (Date.now() - overSince > 3000 && Date.now() - lastOverWarn > 45000) {
    lastOverWarn = Date.now();
    if (!opts.muted) playSound('double');
    if (typeof say === 'function' && opts.navVoice) say(`Speed limit ${limitNow.v}`);
  }
}

// ---------------------------------------------------------------- UI

(function buildSpeedUi() {
  $('tab-map').insertAdjacentHTML('beforeend', `
    <div id="speedo" ${opts.showSpeed ? '' : 'hidden'}>
      <div class="spd"><b id="spdVal">–</b><span id="spdUnit">mph</span></div>
      <div id="limSign" hidden><span class="lim-top">SPEED<br>LIMIT</span><b id="limVal"></b><span class="lim-est">est.</span></div>
      <div id="roadName" hidden></div>
    </div>`);
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h2>Speed</h2>
    <label class="sw"><input type="checkbox" id="optShowSpeed"> Show speedometer &amp; speed limit</label>
    <label class="sw">Warn when over the limit by
      <select id="optSpeedWarn"><option value="-1">Never</option><option value="0">Any amount</option><option value="5">5</option><option value="10">10</option><option value="15">15</option></select></label>
    <label class="sw"><input type="checkbox" id="optEstLimits"> Estimate the limit when a road has none listed</label>
    <p class="mute small1">Limits come from OpenStreetMap, then TomTom if you add a key under Traffic, then a road-type estimate (dashed sign, "est."). Always obey the posted signs.</p>`;
  $('slot-traffic').before(card);
  bindOpt('optShowSpeed', 'showSpeed', () => { $('speedo').hidden = !opts.showSpeed; });
  bindOpt('optSpeedWarn', 'speedWarn');
  bindOpt('optEstLimits', 'estLimits');
})();
