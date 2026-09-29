'use strict';
// Mapped-camera layers from OpenStreetMap (Overpass API). DeFlock's crowd-sourced
// ALPR reports live in OSM as man_made=surveillance + surveillance:type=ALPR,
// so they show up here alongside speed/red-light cameras, CCTV and gunshot
// detectors. Results are cached per grid cell in IndexedDB for offline use.
// Loaded after app.js and uses its globals (map, opts, fix, toast, distM, esc…).

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',   // lags months behind; last resort
];
const OVERPASS_TIMEOUT_MS = 60000;
const CELL = 0.05;               // degrees (~5.5 km) per cache cell
const CELL_MAX_AGE = 7 * 86400e3;
const AUTO_MIN_ZOOM = 12;        // don't auto-query huge areas
const CONE_MIN_ZOOM = 15;

const KINDS = {
  alpr:    { label: 'Plate readers (ALPR / Flock)', color: '#bf5af2', r: 7, alert: true },
  enf:     { label: 'Speed & red-light cameras',     color: '#30d158', r: 7, alert: true },
  traffic: { label: 'Traffic cameras',               color: '#64d2ff', r: 5, alert: false },
  cctv:    { label: 'Other surveillance cameras',    color: '#d1d1d6', r: 4, alert: false },
  gun:     { label: 'Gunshot detectors',             color: '#ac8e68', r: 6, alert: false },
};

opts.layers = { det: true, alpr: true, enf: true, traffic: true, cctv: true, gun: true, ...(opts.layers || {}) };
opts.alertMapped = opts.alertMapped ?? true;
opts.alertDist = opts.alertDist ?? 250;

// ---------------------------------------------------------------- IndexedDB cache

const poiDB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('flockyou-poi', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('cells');
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction('cells', mode);
      const out = fn(t.objectStore('cells'));
      t.oncomplete = () => res(out && out.result);
      t.onerror = () => rej(t.error);
    });
  },
  get(k) { return this.tx('readonly', s => s.get(k)); },
  putMany(entries) { return this.tx('readwrite', s => { for (const [k, v] of entries) s.put(v, k); }); },
  count() { return this.tx('readonly', s => s.count()); },
  clear() { return this.tx('readwrite', s => s.clear()); },
};

// ---------------------------------------------------------------- classify

function classify(t) {
  const st = (t['surveillance:type'] || '').toLowerCase();
  if (st === 'alpr' || st === 'anpr') return 'alpr';
  if (st === 'gunshot_detector') return 'gun';
  if (t.highway === 'speed_camera' || t.type === 'enforcement' || t.enforcement) return 'enf';
  if (t.man_made === 'surveillance') return t['surveillance:zone'] === 'traffic' ? 'traffic' : 'cctv';
  return null;
}

const COMPASS = { N: 0, NNE: 22, NE: 45, ENE: 67, E: 90, ESE: 112, SE: 135, SSE: 157, S: 180, SSW: 202, SW: 225, WSW: 247, W: 270, WNW: 292, NW: 315, NNW: 337 };
function parseDirs(t) {
  const raw = t['camera:direction'] || t.direction || t['surveillance:direction'] || '';
  return String(raw).split(/[;,]/).map(s => s.trim().toUpperCase()).map(s =>
    s in COMPASS ? COMPASS[s] : /^-?\d+(\.\d+)?$/.test(s) ? ((Number(s) % 360) + 360) % 360 : null
  ).filter(v => v !== null).slice(0, 4);
}

const KEEP_TAGS = ['operator', 'manufacturer', 'brand', 'model', 'surveillance', 'surveillance:type',
  'surveillance:zone', 'camera:type', 'camera:mount', 'enforcement', 'maxspeed', 'name', 'description',
  'note', 'ref', 'start_date', 'check_date', 'survey:date', 'operator:wikidata', 'manufacturer:wikidata'];

function compact(el) {
  const t = el.tags || {};
  const kind = classify(t);
  if (!kind) return null;
  const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
  if (lat == null) return null;
  const tags = {};
  for (const k of KEEP_TAGS) if (t[k]) tags[k] = t[k];
  return { id: el.type[0] + el.id, lat, lon, kind, dirs: parseDirs(t), tags };
}

// ---------------------------------------------------------------- fetch

const cellKey = (i, j) => i + ':' + j;
const cellsFor = b => {
  const out = [];
  for (let i = Math.floor(b.s / CELL); i <= Math.floor(b.n / CELL); i++)
    for (let j = Math.floor(b.w / CELL); j <= Math.floor(b.e / CELL); j++) out.push([i, j]);
  return out;
};

async function overpass(b) {
  const q = `[out:json][timeout:90];(
    nwr["man_made"="surveillance"](${b.s},${b.w},${b.n},${b.e});
    node["highway"="speed_camera"](${b.s},${b.w},${b.n},${b.e});
    relation["type"="enforcement"](${b.s},${b.w},${b.n},${b.e});
  );out center tags;`;
  let lastErr;
  // GET, not POST: browser POSTs to overpass-api.de come back 504 while GETs succeed.
  const qs = '?data=' + encodeURIComponent(q.replace(/\s*\n\s*/g, ''));
  for (const url of OVERPASS) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), OVERPASS_TIMEOUT_MS);
    try {
      const r = await fetch(url + qs, { signal: ac.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return (await r.json()).elements || [];
    } catch (e) { lastErr = e.name === 'AbortError' ? new Error('timed out') : e; }
    finally { clearTimeout(timer); }
  }
  throw lastErr || new Error('no Overpass server reachable');
}

// Fetch every cell in `cells` with one bbox query and store per cell.
async function fetchCells(cells) {
  const s = Math.min(...cells.map(c => c[0])) * CELL, n = (Math.max(...cells.map(c => c[0])) + 1) * CELL;
  const w = Math.min(...cells.map(c => c[1])) * CELL, e = (Math.max(...cells.map(c => c[1])) + 1) * CELL;
  const els = await overpass({ s: +s.toFixed(5), w: +w.toFixed(5), n: +n.toFixed(5), e: +e.toFixed(5) });
  const buckets = new Map(cells.map(c => [cellKey(c[0], c[1]), []]));
  for (const el of els) {
    const p = compact(el);
    if (!p) continue;
    const k = cellKey(Math.floor(p.lat / CELL), Math.floor(p.lon / CELL));
    if (buckets.has(k)) buckets.get(k).push(p);
  }
  const now = Date.now();
  await poiDB.putMany([...buckets].map(([k, items]) => [k, { ts: now, items }]));
  for (const [k, items] of buckets) loadedCells.set(k, { ts: now, items });
  return els.length;
}

// ---------------------------------------------------------------- render

const loadedCells = new Map();   // key -> {ts, items}
const drawn = new Map();         // id -> [layers]
let mappedPane, canvasR, busy = false, pendingView = false;

function initLayers() {
  mappedPane = map.createPane('mapped');
  mappedPane.style.zIndex = 390; // below detection markers (overlayPane 400)
  canvasR = L.canvas({ pane: 'mapped', padding: 0.3 });
  buildPanel();
  map.on('moveend', () => { clearTimeout(initLayers.t); initLayers.t = setTimeout(onView, 700); });
  map.on('zoomend', () => redrawMapped(true));
  onView();
}

function allItems() {
  const out = [];
  for (const c of loadedCells.values()) for (const p of c.items) out.push(p);
  return out;
}

function popupFor(p) {
  const t = p.tags;
  const rows = Object.entries(t).map(([k, v]) => `<tr><td style="color:#888;padding-right:6px">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
  const osmType = { n: 'node', w: 'way', r: 'relation' }[p.id[0]];
  const dist = fix ? ` · ${Math.round(distM(fix, p))} m away` : '';
  return `<b>${esc(KINDS[p.kind].label)}</b>${dist}<br>
    ${p.dirs.length ? 'Facing ' + p.dirs.map(d => d + '°').join(', ') + '<br>' : ''}
    <table style="font-size:12px;margin-top:4px">${rows}</table>
    <a href="https://www.openstreetmap.org/${osmType}/${p.id.slice(1)}" target="_blank" rel="noopener">View on OpenStreetMap</a>`;
}

function cone(p, deg, len) {
  const R = 111320, pts = [[p.lat, p.lon]];
  for (let a = deg - 30; a <= deg + 30; a += 10) {
    const r = a * Math.PI / 180;
    pts.push([p.lat + (len * Math.cos(r)) / R, p.lon + (len * Math.sin(r)) / (R * Math.cos(p.lat * Math.PI / 180))]);
  }
  return pts;
}

function redrawMapped(force = false) {
  if (!map) return;
  const b = map.getBounds().pad(0.5);
  const z = map.getZoom();
  const showCones = z >= CONE_MIN_ZOOM;
  const want = new Set();
  const counts = Object.fromEntries(Object.keys(KINDS).map(k => [k, 0]));
  for (const p of allItems()) {
    if (!b.contains([p.lat, p.lon])) continue;
    counts[p.kind]++;
    if (!opts.layers[p.kind]) continue;
    // In dense cities thousands of CCTV dots bury everything else at low zoom.
    if (p.kind === 'cctv' && z < 14) continue;
    want.add(p.id);
    const have = drawn.get(p.id);
    if (have && !force) continue;
    if (have) have.forEach(l => l.remove());
    const k = KINDS[p.kind];
    const layers = [];
    if (showCones) for (const d of p.dirs) {
      layers.push(L.polygon(cone(p, d, p.kind === 'cctv' ? 25 : 60), { renderer: canvasR, pane: 'mapped',
        color: k.color, weight: 1, opacity: 0.6, fillOpacity: 0.18, interactive: false }).addTo(map));
    }
    const mk = L.circleMarker([p.lat, p.lon], { renderer: canvasR, pane: 'mapped', radius: k.r,
      color: '#111', weight: 1.5, fillColor: k.color, fillOpacity: 0.95 }).addTo(map);
    mk.bindPopup(() => popupFor(p));
    layers.push(mk);
    drawn.set(p.id, layers);
  }
  for (const [id, ls] of drawn) if (!want.has(id)) { ls.forEach(l => l.remove()); drawn.delete(id); }
  for (const [k, n] of Object.entries(counts)) {
    const el = document.querySelector(`#lyrPanel [data-count="${k}"]`);
    if (el) el.textContent = n;
  }
}

function status(msg) { const el = $('lyrStatus'); if (el) el.textContent = msg; }

async function onView() {
  if (busy) { pendingView = true; return; }
  busy = true;
  try {
    const b = map.getBounds();
    const cells = cellsFor({ s: b.getSouth(), n: b.getNorth(), w: b.getWest(), e: b.getEast() });
    // Pull anything cached for this view out of IndexedDB first — works offline.
    if (cells.length <= 400) {
      for (const [i, j] of cells) {
        const k = cellKey(i, j);
        if (!loadedCells.has(k)) { const c = await poiDB.get(k).catch(() => null); if (c) loadedCells.set(k, c); }
      }
    }
    redrawMapped();
    if (map.getZoom() < AUTO_MIN_ZOOM) { status('Zoom in to load mapped cameras'); return; }
    const stale = cells.filter(([i, j]) => { const c = loadedCells.get(cellKey(i, j)); return !c || Date.now() - c.ts > CELL_MAX_AGE; });
    if (!stale.length) { status(''); return; }
    if (!navigator.onLine) { status('Offline — showing saved cameras only'); return; }
    status('Loading mapped cameras…');
    await fetchCells(stale);
    status('');
    redrawMapped();
  } catch (e) {
    status('Map data: ' + e.message);
  } finally {
    busy = false;
    if (pendingView) { pendingView = false; onView(); }
  }
}

// ---------------------------------------------------------------- offline area download

async function saveArea(km) {
  if (!fix && !map) return;
  const c = fix ? { lat: fix.lat, lon: fix.lon } : map.getCenter();
  const dLat = km / 111, dLon = km / (111 * Math.cos(c.lat * Math.PI / 180));
  const cells = cellsFor({ s: c.lat - dLat, n: c.lat + dLat, w: (c.lon ?? c.lng) - dLon, e: (c.lon ?? c.lng) + dLon });
  toast(`Downloading cameras within ${km} km…`);
  try {
    // Chunk so one request never covers a whole metro area.
    const rows = new Map();
    for (const cl of cells) { const r = rows.get(cl[0]) || []; r.push(cl); rows.set(cl[0], r); }
    const groups = [];
    let cur = [];
    for (const r of rows.values()) { cur.push(...r); if (cur.length >= 36) { groups.push(cur); cur = []; } }
    if (cur.length) groups.push(cur);
    let n = 0;
    for (let g = 0; g < groups.length; g++) {
      status(`Downloading area ${g + 1}/${groups.length}…`);
      n += await fetchCells(groups[g]);
    }
    status('');
    toast(`Saved ${n} mapped cameras for offline`);
    redrawMapped();
    updateLayerInfo();
  } catch (e) { status(''); toast('Download failed: ' + e.message); }
}

// ---------------------------------------------------------------- proximity alerts

const alerted = new Set();
function layersOnFix(f) {
  if (!opts.alertMapped || !f || f.acc > 100) return;
  for (const p of allItems()) {
    if (!KINDS[p.kind].alert || !opts.layers[p.kind] || alerted.has(p.id)) continue;
    const d = distM(f, p);
    if (d > opts.alertDist) continue;
    alerted.add(p.id);
    const what = p.kind === 'alpr' ? 'Plate reader' : (p.tags.enforcement === 'traffic_signals' ? 'Red-light camera' : 'Speed camera');
    toast(`${what} ahead · ${Math.round(d)} m${p.tags.manufacturer ? ' · ' + p.tags.manufacturer : ''}`, true);
    if (opts.vibe && navigator.vibrate) navigator.vibrate([150, 80, 150]);
  }
}

// ---------------------------------------------------------------- UI

function buildPanel() {
  const btn = document.createElement('button');
  btn.id = 'bLayers'; btn.className = 'fab lyr'; btn.textContent = '☰';
  btn.title = 'Map layers';
  const panel = document.createElement('div');
  panel.id = 'lyrPanel';
  panel.innerHTML = `
    <label class="lyr-row"><input type="checkbox" data-lyr="det"><span class="sw8" style="background:var(--t4)"></span>Board detections</label>
    ${Object.entries(KINDS).map(([k, v]) => `
      <label class="lyr-row"><input type="checkbox" data-lyr="${k}"><span class="sw8" style="background:${v.color}"></span>${v.label}<span class="cnt" data-count="${k}">0</span></label>`).join('')}
    <div class="mute small0">Mapped data: © OpenStreetMap contributors, incl. DeFlock reports</div>`;
  $('tab-map').append(btn, panel);
  panel.querySelectorAll('[data-lyr]').forEach(cb => {
    cb.checked = opts.layers[cb.dataset.lyr] !== false;
    cb.onchange = () => {
      opts.layers[cb.dataset.lyr] = cb.checked; saveOpts();
      if (cb.dataset.lyr === 'det') redrawMarkers(); else redrawMapped(true);
    };
  });
  btn.onclick = () => panel.classList.toggle('open');
  const st = document.createElement('div');
  st.id = 'lyrStatus';
  $('tab-map').append(st);

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h2>Mapped cameras</h2>
    <p class="mute">From OpenStreetMap, including DeFlock's crowd-sourced plate-reader reports. Loads as you move; save an area ahead of a trip to have it offline.</p>
    <label class="sw"><input type="checkbox" id="optAlertMapped"> Alert near plate readers &amp; speed/red-light cameras</label>
    <label class="sw">Alert distance
      <select id="optAlertDist"><option value="150">150 m</option><option value="250">250 m</option><option value="400">400 m</option><option value="800">800 m</option></select>
    </label>
    <button data-area="10">Save 10 km around me</button>
    <button data-area="30">Save 30 km around me</button>
    <button data-area="60">Save 60 km around me</button>
    <p class="mute" id="lyrInfo"></p>
    <button id="bClearPoi">Clear saved map cameras</button>`;
  $('tab-set').insertBefore(card, $('tab-set').children[2]);
  bindOpt('optAlertMapped', 'alertMapped');
  bindOpt('optAlertDist', 'alertDist');
  card.querySelectorAll('[data-area]').forEach(b => b.onclick = () => saveArea(Number(b.dataset.area)));
  $('bClearPoi').onclick = async () => {
    await poiDB.clear(); loadedCells.clear();
    for (const ls of drawn.values()) ls.forEach(l => l.remove());
    drawn.clear(); updateLayerInfo(); toast('Cleared saved map cameras');
  };
  updateLayerInfo();
}

async function updateLayerInfo() {
  const n = await poiDB.count().catch(() => 0);
  let total = 0;
  for (const c of loadedCells.values()) total += c.items.length;
  const el = $('lyrInfo');
  if (el) el.textContent = `${n} areas saved (${total} cameras loaded in memory).`;
}

initLayers();
