'use strict';
// Trip downloads: plan a long route (start, optional stops, destination) and
// save everything needed to drive it with no signal:
//   - street map + 3D buildings in a corridor either side of the route (z10–14)
//   - a low-detail overview of the whole region (z0–9)
//   - mapped cameras (ALPR, speed…) along the corridor
//   - speed-limit road data along the route itself
//   - the route, so turn-by-turn works offline ("Navigate saved trip")
// Resumable: re-running skips anything already saved. Loaded after traffic.js;
// reuses offline.js (job, runPool, putUrl, styleAssets…), layers.js, speed.js, nav.js.

const TRIP_KEY = 'fy.trip.v1';
const TRIP_DETAIL_Z = [10, 14];
const TRIP_OVERVIEW_MAX_Z = 9;
const TRIP_AVG_KB = 22;

let tripPlan = null;       // {raw, name, dest, tiles:[[z,x,y]], camCells, roadCells}
const tripPicks = {};      // input id -> {name, lat, lon}

// ---------------------------------------------------------------- corridor maths

// Tiles within `km` of the route at detail zooms, plus a region overview.
function corridorTiles(coords, km) {
  const set = new Set(), out = [];
  const add = (z, x, y) => { const k = z + '/' + x + '/' + y; if (!set.has(k)) { set.add(k); out.push([z, x, y]); } };
  const samples = sampleRoute(coords, Math.max(0.5, km / 2));
  for (let z = TRIP_DETAIL_Z[0]; z <= TRIP_DETAIL_Z[1]; z++) {
    for (const [lon, lat] of samples) {
      const dLat = (km + km / 4) / 111, dLon = dLat / Math.cos(lat * Math.PI / 180);
      const [x0, y0] = tileXY(lat + dLat, lon - dLon, z), [x1, y1] = tileXY(lat - dLat, lon + dLon, z);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) add(z, x, y);
    }
  }
  const lats = coords.map(c => c[1]), lons = coords.map(c => c[0]);
  const box = { n: Math.max(...lats) + 0.5, s: Math.min(...lats) - 0.5, w: Math.min(...lons) - 0.5, e: Math.max(...lons) + 0.5 };
  for (const t of tilesFor(box, 0, TRIP_OVERVIEW_MAX_Z)) add(...t);
  return out;
}

// Points every `stepKm` along the route.
function sampleRoute(coords, stepKm) {
  const out = [coords[0]];
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    acc += distM({ lat: coords[i - 1][1], lon: coords[i - 1][0] }, { lat: coords[i][1], lon: coords[i][0] });
    if (acc >= stepKm * 1000) { out.push(coords[i]); acc = 0; }
  }
  out.push(coords[coords.length - 1]);
  return out;
}

// Grid cells (camera cells or road cells) touched by the corridor, in route order.
function corridorCells(coords, km, cellDeg) {
  const seen = new Set(), out = [];
  for (const [lon, lat] of sampleRoute(coords, Math.max(0.3, Math.min(km, cellDeg * 50)))) {
    const dLat = km / 111, dLon = dLat / Math.cos(lat * Math.PI / 180);
    for (let i = Math.floor((lat - dLat) / cellDeg); i <= Math.floor((lat + dLat) / cellDeg); i++)
      for (let j = Math.floor((lon - dLon) / cellDeg); j <= Math.floor((lon + dLon) / cellDeg); j++) {
        const k = i + ':' + j;
        if (!seen.has(k)) { seen.add(k); out.push([i, j]); }
      }
  }
  return out;
}

// Group route-ordered cells into runs whose bounding box stays within
// `maxSpan` cells each way, so one Overpass query covers a stretch of road.
function chunkCells(cells, maxSpan) {
  const out = [];
  let cur = [], i0, i1, j0, j1;
  for (const c of cells) {
    if (cur.length) {
      const ni0 = Math.min(i0, c[0]), ni1 = Math.max(i1, c[0]), nj0 = Math.min(j0, c[1]), nj1 = Math.max(j1, c[1]);
      if (ni1 - ni0 >= maxSpan || nj1 - nj0 >= maxSpan) { out.push(cur); cur = []; }
    }
    if (!cur.length) { i0 = i1 = c[0]; j0 = j1 = c[1]; }
    cur.push(c);
    i0 = Math.min(i0, c[0]); i1 = Math.max(i1, c[0]); j0 = Math.min(j0, c[1]); j1 = Math.max(j1, c[1]);
  }
  if (cur.length) out.push(cur);
  return out;
}
const pause = ms => new Promise(r => setTimeout(r, ms));
const TRIP_CAM_KM = 3.2;    // cameras within ~2 mi of the route
const TRIP_ROAD_KM = 0.25;  // speed-limit roads: the route itself plus a margin

// ---------------------------------------------------------------- plan

async function planTrip() {
  const from = tripPicks.tripFrom || (fix ? { name: 'My location', lat: fix.lat, lon: fix.lon } : null);
  const to = tripPicks.tripTo;
  if (!from) { toast('Pick a start (or wait for GPS)'); return; }
  if (!to) { toast('Pick a destination'); return; }
  if (!navigator.onLine) { toast('Planning a trip needs internet — use Wi-Fi'); return; }
  const vias = ['tripVia1', 'tripVia2', 'tripVia3'].map(id => tripPicks[id]).filter(Boolean);
  const pts = [from, ...vias, to];
  $('tripSummary').textContent = 'Planning route…';
  try {
    const path = pts.map(p => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(';');
    const d = await getJSON(`${ROUTERS.car[0]}/${path}?overview=full&geometries=geojson&steps=true`, 45000);
    if (d.code !== 'Ok') throw new Error(d.message || d.code);
    const raw = d.routes[0];
    const km = Number($('tripWidth').value) * 1.609;
    const tiles = corridorTiles(raw.geometry.coordinates, km);
    tripPlan = {
      raw, km, tiles,
      name: `${from.name} → ${to.name}`,
      dest: { name: to.name, label: to.label || '', lat: to.lat, lon: to.lon },
      camCells: corridorCells(raw.geometry.coordinates, Math.min(km, TRIP_CAM_KM), CELL),
      roadCells: corridorCells(raw.geometry.coordinates, TRIP_ROAD_KM, ROAD_CELL),
    };
    tripPlan.camChunks = chunkCells(tripPlan.camCells, 4);
    tripPlan.roadChunks = chunkCells(tripPlan.roadCells, 12);
    const mb = tiles.length * TRIP_AVG_KB / 1024;
    $('tripSummary').innerHTML = `<b>${esc(tripPlan.name)}</b><br>${fmtDist(raw.distance)} · ${fmtDur(raw.duration)} driving${vias.length ? ` · via ${vias.map(v => esc(v.name)).join(', ')}` : ''}<br>
      Download: ${tiles.length.toLocaleString()} map tiles (~${mb < 1024 ? Math.round(mb) + ' MB' : (mb / 1024).toFixed(1) + ' GB'})
      ${$('tripCams').checked ? ` · cameras (${tripPlan.camChunks.length} lookups)` : ''}${$('tripPlaces').checked ? ` · places (${tripPlan.camChunks.length} lookups)` : ''}${$('tripRoads').checked ? ` · speed limits (${tripPlan.roadChunks.length} lookups)` : ''}.
      Keep the screen on and stay on Wi-Fi; if it stops, tap Download again and it continues where it left off.`;
    $('tripGo').hidden = false;
    // Show it on the map.
    routes = [prepRoute(raw)]; selIdx = 0; navDest = tripPlan.dest; showPreview.fitted = false; drawNav(); fitRoute(routes[0]);
  } catch (e) {
    $('tripSummary').textContent = 'Could not plan: ' + e.message;
  }
}

// ---------------------------------------------------------------- download

async function downloadTrip() {
  if (!tripPlan || job) return;
  if (!navigator.onLine) { toast('Connect to Wi-Fi first'); return; }
  navigator.storage?.persist?.();
  requestWake();
  saveTrip(tripPlan);   // the route is useful even if the download is interrupted
  job = { ac: new AbortController(), done: 0, total: tripPlan.tiles.length, bytes: 0, failed: 0, phase: 'Map style & fonts' };
  paintJob();
  const signal = job.ac.signal;
  let finished = false;
  try {
    const cache = await caches.open(OFFLINE_CACHE);
    const sa = await styleAssets(cache, signal);
    job.bytes += sa.bytes;
    job.phase = 'Street map & 3D buildings along the route';
    await runPool(tripPlan.tiles, async ([z, x, y]) => {
      job.bytes += await putUrl(cache, sa.tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y), ofmKey(z, x, y), signal);
      if (z <= NE_MAXZOOM) job.bytes += await putUrl(cache, `https://tiles.openfreemap.org/natural_earth/ne2sr/${z}/${x}/${y}.png`, undefined, signal).catch(() => 0);
    }, signal);
    // Cameras and speed-limit roads come from the free Overpass server: one
    // query per stretch of route, skipping stretches already saved, with a
    // pause between queries to stay within its fair-use limits.
    const overpassPhase = async (label, chunks, have, fetcher) => {
      const todo = [];
      for (const ch of chunks) {
        const missing = [];
        for (const c of ch) if (!(await have(c))) missing.push(c);
        if (missing.length) todo.push(missing);
      }
      job.phase = label; job.done = 0; job.total = todo.length; paintJob();
      for (const ch of todo) {
        if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
        await fetcher(ch).catch(() => { job.failed++; });
        job.done++; paintJob();
        await pause(700);
      }
    };
    if ($('tripCams').checked) await overpassPhase('Mapped cameras', tripPlan.camChunks,
      async ([i, j]) => loadedCells.has(cellKey(i, j)) || !!(await poiDB.get(cellKey(i, j)).catch(() => null)), fetchCells);
    if ($('tripPlaces').checked) await overpassPhase('Gas, food, rest stops & places', tripPlan.camChunks, havePlaceCell, fetchPlaceCells);
    if ($('tripRoads').checked) await overpassPhase('Speed-limit road data', tripPlan.roadChunks,
      async ([i, j]) => !!(await roadDB.get(i + ':' + j)), fetchRoads);
    finished = true;
    const c = tripPlan.raw.geometry.coordinates;
    areas = areas.filter(a => a.name !== tripPlan.name);
    areas.push({ id: Date.now(), name: 'Trip: ' + tripPlan.name, lat: +c[0][1].toFixed(4), lon: +c[0][0].toFixed(4),
      km: tripPlan.km, tiles: tripPlan.tiles.length, bytes: job.bytes, ts: Date.now(), trip: true });
    saveAreas();
    toast(`Trip saved for offline${job.failed ? ` · ${job.failed} items failed — tap Download again to retry` : ''}`, true);
    if (typeof playSound === 'function') playSound('chime');
  } catch (e) {
    toast(e.name === 'AbortError' ? 'Paused — tap Download to continue' : 'Stopped: ' + e.message + ' — tap Download to continue');
  } finally {
    job = null; paintJob(); paintAreas(); paintTripSaved();
    if (!dev && !(typeof nav !== 'undefined' && nav)) releaseWake();
    if (finished) $('tripGo').hidden = true;
  }
}

// ---------------------------------------------------------------- saved trip → offline navigation

function saveTrip(p) {
  try { localStorage.setItem(TRIP_KEY, JSON.stringify({ name: p.name, dest: p.dest, raw: p.raw, ts: Date.now() })); } catch (e) {
    toast('Could not save the route: ' + e.message);
  }
}
function loadTrip() { try { return JSON.parse(localStorage.getItem(TRIP_KEY)); } catch { return null; } }

async function navigateSavedTrip() {
  const t = loadTrip();
  if (!t) { toast('No saved trip'); return; }
  navDest = t.dest;
  const rt = prepRoute(t.raw);
  await loadRouteCells(rt).catch(() => {});
  rt.cams = camerasOn(rt); rt.camsCounted = true;
  showTab('map');
  startNav(rt);
}

function paintTripSaved() {
  const t = loadTrip();
  $('tripSaved').innerHTML = t
    ? `<div class="setup-row"><span>🧳</span><div class="setup-body"><b>${esc(t.name)}</b>
        <div class="mute small1">${fmtDist(t.raw.distance)} · saved ${new Date(t.ts).toLocaleDateString()} · works offline</div></div>
        <button id="tripNav" class="primary">Navigate</button></div>`
    : '';
  if (t) $('tripNav').onclick = navigateSavedTrip;
}

// ---------------------------------------------------------------- place pickers

function placePicker(id, label, placeholder) {
  return `<div class="tp"><label class="mute small1" for="${id}">${label}</label>
    <input id="${id}" type="search" placeholder="${placeholder}" autocomplete="off">
    <div class="tp-res" id="${id}Res" hidden></div></div>`;
}
function bindPicker(id) {
  const inp = $(id), res = $(id + 'Res');
  let t = null, list = [];
  inp.addEventListener('input', () => {
    delete tripPicks[id]; $('tripGo').hidden = true;
    clearTimeout(t);
    const q = inp.value.trim();
    if (q.length < 3) { res.hidden = true; return; }
    t = setTimeout(async () => {
      try { list = await photonSearch(q); } catch { list = []; }
      res.innerHTML = list.map((p, i) => `<div class="nr" data-i="${i}"><div class="nr-body"><b>${esc(p.name)}</b><div class="mute small1">${esc(p.label)}</div></div></div>`).join('') || '<div class="nr mute">No results</div>';
      res.hidden = false;
    }, 350);
  });
  res.addEventListener('click', e => {
    const el = e.target.closest('[data-i]');
    if (!el) return;
    const p = list[Number(el.dataset.i)];
    tripPicks[id] = p; inp.value = p.name + (p.label ? ', ' + p.label.split(',')[0] : ''); res.hidden = true;
  });
}

(function buildTripUi() {
  const box = document.createElement('div');
  box.className = 'trip-box';
  box.innerHTML = `
    <h3>Download a whole trip</h3>
    <p class="mute small1">For long drives: saves the map in a band along your route, an overview of the whole region, cameras and speed limits, and the route itself so directions work with no signal. Add stops to force the route through places (e.g. through New Hampshire and Vermont instead of Canada).</p>
    ${placePicker('tripFrom', 'From (leave empty for my location)', 'Start town or address')}
    ${placePicker('tripVia1', 'Through (optional)', 'e.g. Gorham, NH')}
    ${placePicker('tripVia2', 'Through (optional)', 'e.g. Montpelier, VT')}
    ${placePicker('tripVia3', 'Through (optional)', '')}
    ${placePicker('tripTo', 'To', 'Destination town or address')}
    <label class="sw">Detail on each side of the route
      <select id="tripWidth"><option value="3">3 mi</option><option value="5">5 mi</option><option value="10" selected>10 mi</option><option value="25">25 mi</option></select></label>
    <label class="sw"><input type="checkbox" id="tripCams" checked> Mapped cameras along the route</label>
    <label class="sw"><input type="checkbox" id="tripPlaces" checked> Gas, food, rest stops, tolls &amp; other places</label>
    <label class="sw"><input type="checkbox" id="tripRoads" checked> Speed limits along the route</label>
    <button id="tripPlan">Plan trip</button>
    <p class="small1" id="tripSummary"></p>
    <button id="tripGo" class="primary" hidden>Download trip</button>
    <div id="tripSaved"></div>`;
  $('offAreas').before(box);
  for (const id of ['tripFrom', 'tripVia1', 'tripVia2', 'tripVia3', 'tripTo']) bindPicker(id);
  $('tripWidth').onchange = () => { if (tripPlan) planTrip(); };
  $('tripPlan').onclick = planTrip;
  $('tripGo').onclick = downloadTrip;
  paintTripSaved();
})();
