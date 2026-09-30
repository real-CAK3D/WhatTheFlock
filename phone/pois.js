'use strict';
// Places: gas, EV charging, rest areas, service plazas, tolls, food, coffee,
// hotels, restrooms, hospitals and more, from OpenStreetMap (Overpass).
//   - Map layer with per-category toggles (☰ panel), tap for details
//   - Find nearby / along the route (search bar chips, or 🔍 while navigating)
//   - "Add stop" re-routes through a place and on to the destination
//   - Toll points on a route are counted in the route options
//   - Saved with trip and area downloads for offline use
// Loaded after trip.js; uses globals from app.js, layers.js, nav.js, trip.js.

const PLACE_CATS = {
  fuel:     { label: 'Gas',            emoji: '⛽', color: '#ff9f0a', on: true,  words: 'gas fuel petrol diesel station' },
  ev:       { label: 'EV charging',    emoji: '🔌', color: '#30d158', on: true,  words: 'ev charging charger electric tesla supercharger' },
  rest:     { label: 'Rest areas',     emoji: '🅿️', color: '#0a84ff', on: true,  words: 'rest area stop' },
  services: { label: 'Service plazas', emoji: '🛣️', color: '#5e5ce6', on: true,  words: 'service plaza travel center truck stop services' },
  toll:     { label: 'Tolls',          emoji: '💰', color: '#ffd60a', on: true,  words: 'toll booth gantry' },
  food:     { label: 'Restaurants',    emoji: '🍽️', color: '#ff453a', on: true,  words: 'restaurant food dinner lunch eat diner' },
  fastfood: { label: 'Fast food',      emoji: '🍔', color: '#ff6b3d', on: true,  words: 'fast food burger pizza drive thru mcdonalds' },
  coffee:   { label: 'Coffee',         emoji: '☕', color: '#a2845e', on: true,  words: 'coffee cafe dunkin starbucks' },
  lodging:  { label: 'Hotels',         emoji: '🏨', color: '#bf5af2', on: true,  words: 'hotel motel lodging inn stay' },
  hospital: { label: 'Hospitals',      emoji: '🏥', color: '#ff2d55', on: true,  words: 'hospital emergency er' },
  toilets:  { label: 'Restrooms',      emoji: '🚻', color: '#64d2ff', on: false, words: 'restroom bathroom toilet' },
  store:    { label: 'Convenience',    emoji: '🏪', color: '#ffcc00', on: false, words: 'convenience store' },
  grocery:  { label: 'Groceries',      emoji: '🛒', color: '#32d74b', on: false, words: 'grocery supermarket' },
  pharmacy: { label: 'Pharmacy',       emoji: '💊', color: '#ff375f', on: false, words: 'pharmacy drugstore cvs walgreens' },
  money:    { label: 'ATM / Bank',     emoji: '🏧', color: '#8e8e93', on: false, words: 'atm bank cash' },
  repair:   { label: 'Auto repair',    emoji: '🔧', color: '#98989d', on: false, words: 'repair mechanic tire tyre car wash' },
  police:   { label: 'Police',         emoji: '🚓', color: '#0040dd', on: false, words: 'police' },
  camping:  { label: 'Camping',        emoji: '⛺', color: '#34c759', on: false, words: 'camping campground camp' },
  sights:   { label: 'Sights',         emoji: '📸', color: '#ff9500', on: false, words: 'attraction viewpoint scenic sight' },
};
const QUICK_CATS = ['fuel', 'food', 'fastfood', 'coffee', 'rest', 'services', 'ev', 'lodging', 'toilets'];
const PLACE_MAX_AGE = 30 * 86400e3;
const ALONG_ROUTE_M = 1200;     // "along the route" = within this of the line
const MAX_PLACE_MARKERS = 250;

opts.placeCats = { ...Object.fromEntries(Object.entries(PLACE_CATS).map(([k, v]) => [k, v.on])), ...(opts.placeCats || {}) };

function placeCat(t) {
  const a = t.amenity, h = t.highway, tr = t.tourism, s = t.shop;
  if (a === 'fuel') return 'fuel';
  if (a === 'charging_station') return 'ev';
  if (h === 'rest_area') return 'rest';
  if (h === 'services') return 'services';
  if (h === 'toll_gantry' || t.barrier === 'toll_booth') return 'toll';
  if (a === 'restaurant') return 'food';
  if (a === 'fast_food') return 'fastfood';
  if (a === 'cafe') return 'coffee';
  if (tr === 'hotel' || tr === 'motel') return 'lodging';
  if (a === 'hospital') return 'hospital';
  if (a === 'toilets') return 'toilets';
  if (s === 'convenience') return 'store';
  if (s === 'supermarket') return 'grocery';
  if (a === 'pharmacy') return 'pharmacy';
  if (a === 'atm' || a === 'bank') return 'money';
  if (a === 'car_repair' || a === 'car_wash' || s === 'tyres') return 'repair';
  if (a === 'police') return 'police';
  if (tr === 'camp_site') return 'camping';
  if (tr === 'attraction' || tr === 'viewpoint') return 'sights';
  return null;
}
const PLACE_TAGS = ['name', 'brand', 'operator', 'opening_hours', 'phone', 'website', 'cuisine', 'addr:housenumber', 'addr:street',
  'addr:city', 'fuel:diesel', 'fuel:e85', 'fuel:lpg', 'socket:type2', 'socket:type1_combo', 'socket:chademo', 'socket:tesla_supercharger',
  'capacity', 'drive_through', 'toilets', 'wheelchair', 'stars', 'emergency', 'payment:e_zpass', 'fee', 'description'];

// ---------------------------------------------------------------- cache

const placeDB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('flockyou-places', 1);
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
  async clear() {
    const db = await this.open();
    return new Promise(res => { const t = db.transaction('cells', 'readwrite'); t.objectStore('cells').clear(); t.oncomplete = res; });
  },
};
const placeCells = new Map();   // cellKey -> {ts, items}

async function fetchPlaceCells(cells) {
  const s = Math.min(...cells.map(c => c[0])) * CELL, n = (Math.max(...cells.map(c => c[0])) + 1) * CELL;
  const w = Math.min(...cells.map(c => c[1])) * CELL, e = (Math.max(...cells.map(c => c[1])) + 1) * CELL;
  const bb = `${s.toFixed(4)},${w.toFixed(4)},${n.toFixed(4)},${e.toFixed(4)}`;
  const q = `[out:json][timeout:90];(` +
    `nwr["amenity"~"^(fuel|charging_station|restaurant|fast_food|cafe|toilets|hospital|pharmacy|atm|bank|car_repair|car_wash|police)$"](${bb});` +
    `nwr["highway"~"^(rest_area|services)$"](${bb});node["highway"="toll_gantry"](${bb});node["barrier"="toll_booth"](${bb});` +
    `nwr["tourism"~"^(hotel|motel|camp_site|attraction|viewpoint)$"](${bb});nwr["shop"~"^(convenience|supermarket|tyres)$"](${bb});` +
    `);out center tags;`;
  let d = null, err;
  for (const url of OVERPASS) {
    try {
      const ac = new AbortController(), t = setTimeout(() => ac.abort(), 90000);
      const r = await fetch(url + '?data=' + encodeURIComponent(q), { signal: ac.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      d = await r.json(); break;
    } catch (x) { err = x; }
  }
  if (!d) throw err || new Error('no Overpass server reachable');
  const buckets = new Map(cells.map(c => [cellKey(c[0], c[1]), []]));
  for (const el of d.elements) {
    const t = el.tags || {};
    const cat = placeCat(t);
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (!cat || lat == null) continue;
    const k = cellKey(Math.floor(lat / CELL), Math.floor(lon / CELL));
    if (!buckets.has(k)) continue;
    const tags = {};
    for (const x of PLACE_TAGS) if (t[x]) tags[x] = t[x];
    buckets.get(k).push({ id: el.type[0] + el.id, lat, lon, cat, tags });
  }
  const now = Date.now();
  for (const [k, items] of buckets) placeCells.set(k, { ts: now, items });
  await placeDB.putMany([...buckets].map(([k, items]) => [k, { ts: now, items }]));
}

async function havePlaceCell([i, j]) {
  const k = cellKey(i, j);
  if (placeCells.has(k)) return true;
  const c = await placeDB.get(k);
  if (c) { placeCells.set(k, c); return true; }
  return false;
}

// Load cached cells for an area; fetch what's missing when online.
// `span`: max cells per query side — wide for a compact area (one query),
// narrow for a thin route corridor (so each query stays small).
async function ensurePlaceCells(cells, fetchMissing = true, span = 4) {
  const missing = [];
  for (const c of cells) {
    const k = cellKey(c[0], c[1]);
    const have = placeCells.get(k) || await placeDB.get(k);
    if (have) { placeCells.set(k, have); if (Date.now() - have.ts < PLACE_MAX_AGE) continue; }
    missing.push(c);
  }
  if (fetchMissing && missing.length && navigator.onLine) {
    for (const ch of chunkCells(missing, span)) await fetchPlaceCells(ch).catch(() => {});
  }
}

function allPlaces() {
  const out = [];
  for (const c of placeCells.values()) for (const p of c.items) out.push(p);
  return out;
}

// ---------------------------------------------------------------- map layer

const placeLayer = L.layerGroup().addTo(map);
let placeBusy = false;

function placeName(p) { return p.tags.name || p.tags.brand || p.tags.operator || PLACE_CATS[p.cat].label.replace(/s$/, ''); }
function placeAddr(p) { return [[p.tags['addr:housenumber'], p.tags['addr:street']].filter(Boolean).join(' '), p.tags['addr:city']].filter(Boolean).join(', '); }

function placePopup(p) {
  const c = PLACE_CATS[p.cat], t = p.tags;
  const extras = [];
  if (t.cuisine) extras.push(t.cuisine.replace(/_/g, ' ').replace(/;/g, ', '));
  if (t['fuel:diesel'] === 'yes') extras.push('diesel');
  if (t['fuel:e85'] === 'yes') extras.push('E85');
  const sockets = ['socket:tesla_supercharger', 'socket:type1_combo', 'socket:chademo', 'socket:type2'].filter(k => t[k]).map(k => k.split(':')[1].replace(/_/g, ' '));
  if (sockets.length) extras.push('plugs: ' + sockets.join(', '));
  if (t.drive_through === 'yes') extras.push('drive-thru');
  if (t['payment:e_zpass'] === 'yes') extras.push('E-ZPass');
  if (t.emergency === 'yes') extras.push('emergency room');
  const navOn = typeof nav !== 'undefined' && nav;
  return `<b>${c.emoji} ${esc(placeName(p))}</b><br><span class="mute">${esc(c.label.replace(/s$/, ''))}${fix ? ' · ' + fmtDist(distM(fix, p)) + ' away' : ''}</span>
    ${placeAddr(p) ? '<br>' + esc(placeAddr(p)) : ''}
    ${extras.length ? '<br>' + esc(extras.join(' · ')) : ''}
    ${t.opening_hours ? '<br>🕘 ' + esc(t.opening_hours === '24/7' ? 'Open 24 hours' : t.opening_hours) : ''}
    ${t.phone ? `<br>📞 <a href="tel:${esc(t.phone.replace(/[^\d+]/g, ''))}">${esc(t.phone)}</a>` : ''}
    ${t.website ? `<br><a href="${esc(t.website.startsWith('http') ? t.website : 'https://' + t.website)}" target="_blank" rel="noopener">Website</a>` : ''}
    <div class="pp-acts"><button onclick="placeGo('${p.id}')">Directions</button>${navOn ? `<button onclick="placeStop('${p.id}')">Add stop</button>` : ''}</div>`;
}

function renderPlaces() {
  placeLayer.clearLayers();
  const z = map.getZoom();
  if (z >= 13) {
    const b = map.getBounds().pad(0.2), c = map.getCenter();
    const inView = allPlaces().filter(p => opts.placeCats[p.cat] && b.contains([p.lat, p.lon]));
    // Keep the map readable: important kinds first, then nearest to the centre.
    const rank = cat => ['fuel', 'services', 'rest', 'toll', 'ev', 'hospital'].includes(cat) ? 0 : 1;
    inView.sort((a, q) => rank(a.cat) - rank(q.cat) || distM({ lat: c.lat, lon: c.lng }, a) - distM({ lat: c.lat, lon: c.lng }, q));
    for (const p of inView.slice(0, MAX_PLACE_MARKERS)) {
      L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'place-ico', html: PLACE_CATS[p.cat].emoji, iconSize: [24, 24] }), zIndexOffset: -100 })
        .bindPopup(() => placePopup(p), { maxWidth: 260 }).addTo(placeLayer);
    }
  }
  renderPlaces3D();
}

function placesOn3DReady() {
  map3d.addSource('fy-places', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map3d.addLayer({ id: 'fy-places', type: 'circle', source: 'fy-places', minzoom: 12,
    paint: { 'circle-radius': 6, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
  map3d.on('click', 'fy-places', e => {
    const p = placeById(e.features[0].properties.id);
    if (p) new maplibregl.Popup({ maxWidth: '260px' }).setLngLat(e.lngLat).setHTML(placePopup(p)).addTo(map3d);
  });
  map3d.on('moveend', () => { if (opts.view3d) { clearTimeout(placesOn3DReady.t); placesOn3DReady.t = setTimeout(placesOnView, 800); } });
  renderPlaces3D();
}
function renderPlaces3D() {
  if (typeof map3dReady === 'undefined' || !map3dReady || !map3d.getSource('fy-places')) return;
  map3d.getSource('fy-places').setData({ type: 'FeatureCollection', features: allPlaces().filter(p => opts.placeCats[p.cat]).map(p => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { id: p.id, color: PLACE_CATS[p.cat].color } })) });
}

function placeById(id) { for (const c of placeCells.values()) for (const p of c.items) if (p.id === id) return p; return null; }

async function placesOnView() {
  if (placeBusy) return;
  const v = viewBox();
  const cells = cellsFor(v);
  if (cells.length > 60) { renderPlaces(); return; }
  placeBusy = true;
  try { await ensurePlaceCells(cells, v.zoom >= 12); } finally { placeBusy = false; }
  renderPlaces();
}

// ---------------------------------------------------------------- directions / stops

function placeGo(id) {
  const p = placeById(id);
  if (!p) return;
  map.closePopup();
  if (typeof nav !== 'undefined' && nav) endNav(true);
  selectPlace({ name: placeName(p), label: placeAddr(p) || PLACE_CATS[p.cat].label, lat: p.lat, lon: p.lon });
}

// Re-route through a place and on to the current destination.
async function placeStop(id) {
  const p = placeById(id);
  if (!p || !nav) return;
  map.closePopup();
  if (!navigator.onLine) { toast('Adding a stop needs internet to re-route'); return; }
  const from = fix, dest = nav.dest;
  try {
    const path = [from, p, dest].map(x => `${x.lon.toFixed(5)},${x.lat.toFixed(5)}`).join(';');
    const d = await getJSON(`${(ROUTERS[opts.navMode] || ROUTERS.car)[0]}/${path}?overview=full&geometries=geojson&steps=true`, 30000);
    if (d.code !== 'Ok') throw new Error(d.message || d.code);
    const rt = prepRoute(d.routes[0]);
    await loadRouteCells(rt).catch(() => {});
    rt.cams = camerasOn(rt); rt.camsCounted = true;
    nav.rt = rt; nav.idx = 0; nav.stepIdx = 1; nav.said = {}; nav.off = 0;
    persistNav(); drawNav(); navOnFix(fix);
    toast(`Stop added: ${placeName(p)}`);
    if (typeof say === 'function') say(`Adding a stop at ${placeName(p)}`);
  } catch (e) { toast('Could not add stop: ' + e.message); }
}

// ---------------------------------------------------------------- find nearby / along route

async function openFind(cat) {
  const c = PLACE_CATS[cat];
  const navOn = typeof nav !== 'undefined' && nav;
  ui.navResults.hidden = true;
  ui.navSheet.innerHTML = `<div class="ns-head"><b>${c.emoji} ${c.label} ${navOn ? 'along your route' : 'nearby'}</b><button id="nsClose">✕</button></div><div id="findList" class="mute small1">Searching…</div>`;
  ui.navSheet.hidden = false;
  $('nsClose').onclick = () => { ui.navSheet.hidden = true; };
  const token = openFind.token = {};
  // Show what's already loaded straight away, then again once missing areas arrive.
  const build = () => navOn ? alongList(cat) : nearbyList(cat);
  renderFind(cat, build(), navOn, false);
  if (navOn) await ensurePlaceCells(routeAheadCells());
  else await ensurePlaceCells(cellsFor(areaBox(fix || biasLL(), 12)), true, 10);
  if (openFind.token === token) renderFind(cat, build(), navOn, true);
}

function routeAheadCells() {
  const rt = nav.rt, seen = new Set(), cells = [];
  // Up to ~100 km ahead along the route.
  for (let i = nav.idx; i < rt.coords.length && rt.cum[i] <= nav.along + 100000; i++) {
    const [lon, lat] = rt.coords[i];
    for (const di of [-1, 0, 1]) for (const dj of [-1, 0, 1]) {
      const a = Math.floor(lat / CELL) + di, b = Math.floor(lon / CELL) + dj, k = a + ':' + b;
      if (!seen.has(k)) { seen.add(k); cells.push([a, b]); }
    }
    if (cells.length > 150) break;
  }
  return cells;
}
function nearbyList(cat) {
  const here = fix || biasLL();
  return allPlaces().filter(p => p.cat === cat).map(p => ({ p, d: distM(here, p) })).filter(x => x.d < 25000).sort((a, b) => a.d - b.d).slice(0, 40);
}
function alongList(cat) {
  const rt = nav.rt, list = [];
  for (const p of allPlaces()) {
    if (p.cat !== cat) continue;
    const q = rt.P(p.lat, p.lon);
    let bd = Infinity, at = 0;
    for (let k = Math.max(0, nav.idx - 1); k < rt.xy.length - 1; k += 2) {
      const b = Math.min(k + 2, rt.xy.length - 1);
      const [d, t] = segDist(q, rt.xy[k], rt.xy[b]);
      if (d < bd) { bd = d; at = rt.cum[k] + t * (rt.cum[b] - rt.cum[k]); }
    }
    if (bd <= ALONG_ROUTE_M && at > nav.along) list.push({ p, ahead: at - nav.along, off: bd });
  }
  return list.sort((a, b) => a.ahead - b.ahead).slice(0, 40);
}

function renderFind(cat, list, navOn, final) {
  const c = PLACE_CATS[cat], el = $('findList');
  if (!el) return;
  if (!list.length) {
    el.className = 'mute small1';
    el.textContent = !final ? 'Searching…' : navigator.onLine ? 'Nothing found in the map data.' : 'Nothing saved for this area — download it for offline first.';
    return;
  }
  el.className = '';
  el.innerHTML = list.map(x => `
    <div class="nr" data-id="${x.p.id}"><span class="nr-ico">${c.emoji}</span>
      <div class="nr-body"><b>${esc(placeName(x.p))}</b><div class="mute small1">${esc(placeAddr(x.p) || (x.p.tags.cuisine || '').replace(/_/g, ' '))}${x.p.tags.opening_hours === '24/7' ? ' · 24 h' : ''}</div></div>
      <span class="nr-d">${navOn ? `in ${fmtDist(x.ahead)}${x.off > 150 ? `<br><span class="mute">${fmtDist(x.off)} off</span>` : ''}` : fmtDist(x.d)}</span></div>`).join('')
    + (final ? '' : '<div class="nr mute small1">Loading more…</div>');
  el.onclick = e => {
    const row = e.target.closest('[data-id]');
    if (!row) return;
    const p = placeById(row.dataset.id);
    ui.navSheet.hidden = true;
    if (navOn) {
      // Offer: add as a stop, or just look at it.
      if (confirm(`Add ${placeName(p)} as a stop on your route?`)) placeStop(p.id);
      else if (typeof map3dActive === 'function' && map3dActive()) map3d.flyTo({ center: [p.lon, p.lat], zoom: 16 });
      else { setFollow(false); map.setView([p.lat, p.lon], 17); }
    } else {
      selectPlace({ name: placeName(p), label: placeAddr(p) || c.label, lat: p.lat, lon: p.lon });
    }
  };
}

// Category chips shown in the search dropdown and the in-navigation finder.
function catChips() {
  return `<div class="chips">${QUICK_CATS.map(k => `<button class="cchip" data-cat="${k}">${PLACE_CATS[k].emoji} ${PLACE_CATS[k].label}</button>`).join('')}</div>`;
}

// Toll points (booths / gantries) on each route option. One small Overpass
// query for just toll nodes in the routes' bounding box — fast even for long
// routes — falling back to already-saved places when offline.
async function countRouteTolls(rts) {
  const lats = rts.flatMap(r => r.coords.map(c => c[1])), lons = rts.flatMap(r => r.coords.map(c => c[0]));
  const bb = `${(Math.min(...lats) - 0.01).toFixed(4)},${(Math.min(...lons) - 0.01).toFixed(4)},${(Math.max(...lats) + 0.01).toFixed(4)},${(Math.max(...lons) + 0.01).toFixed(4)}`;
  let pts = allPlaces().filter(p => p.cat === 'toll').map(p => ({ lat: p.lat, lon: p.lon }));
  if (navigator.onLine) {
    const q = `[out:json][timeout:30];(node["highway"="toll_gantry"](${bb});node["barrier"="toll_booth"](${bb}););out;`;
    for (const url of OVERPASS) {
      try {
        const d = await getJSON(url + '?data=' + encodeURIComponent(q), 30000);
        pts = d.elements.map(e => ({ lat: e.lat, lon: e.lon }));
        break;
      } catch {}
    }
  }
  for (const rt of rts) {
    let n = 0;
    for (const p of pts) {
      const q = rt.P(p.lat, p.lon);
      for (let k = 0; k < rt.xy.length - 1; k += 3) {
        const b = Math.min(k + 3, rt.xy.length - 1);
        if (segDist(q, rt.xy[k], rt.xy[b])[0] < 60) { n++; break; }
      }
    }
    rt.tolls = n;
  }
}

// ---------------------------------------------------------------- UI wiring

(function buildPlacesUi() {
  // ☰ panel: category toggles.
  const panel = $('lyrPanel');
  panel.querySelector('.small0').insertAdjacentHTML('beforebegin', `
    <div class="lyr-sub">Places</div>
    <div class="pset">
      <button data-pset="all">All</button><button data-pset="none">None</button>
      <button data-pset="trip">Road trip</button><button data-pset="food">Food</button><button data-pset="fuel">Fuel</button>
    </div>
    <div class="place-grid">${Object.entries(PLACE_CATS).map(([k, v]) => `
      <div class="pchip"><label><input type="checkbox" data-pcat="${k}" ${opts.placeCats[k] ? 'checked' : ''}><span>${v.emoji} ${v.label}</span></label>
        <button class="ponly" data-only="${k}" title="Show only this">only</button></div>`).join('')}</div>`);
  const PRESETS = {
    all: Object.keys(PLACE_CATS), none: [],
    trip: ['fuel', 'ev', 'rest', 'services', 'toll', 'food', 'fastfood', 'coffee', 'lodging', 'toilets'],
    food: ['food', 'fastfood', 'coffee'], fuel: ['fuel', 'ev', 'services'],
  };
  const setCats = keys => {
    for (const k of Object.keys(PLACE_CATS)) opts.placeCats[k] = keys.includes(k);
    panel.querySelectorAll('[data-pcat]').forEach(cb => { cb.checked = !!opts.placeCats[cb.dataset.pcat]; });
    saveOpts(); renderPlaces();
  };
  panel.querySelectorAll('[data-pset]').forEach(b => b.onclick = () => setCats(PRESETS[b.dataset.pset]));
  panel.querySelectorAll('[data-only]').forEach(b => b.onclick = () => setCats([b.dataset.only]));
  panel.querySelectorAll('[data-pcat]').forEach(cb => cb.onchange = () => { opts.placeCats[cb.dataset.pcat] = cb.checked; saveOpts(); renderPlaces(); });

  // Search dropdown: category chips on top; category words jump straight to "nearby".
  const origShow = showSuggestions;
  showSuggestions = function () {
    origShow();
    ui.navResults.insertAdjacentHTML('afterbegin', catChips());
    ui.navResults.hidden = false;
  };
  ui.navResults.addEventListener('click', e => {
    const b = e.target.closest('[data-cat]');
    if (b) { e.stopPropagation(); ui.navQ.blur(); openFind(b.dataset.cat); }
  }, true);
  ui.navQ.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const q = ui.navQ.value.trim().toLowerCase();
    const hit = Object.entries(PLACE_CATS).find(([k, v]) => v.label.toLowerCase() === q || v.words.split(' ').includes(q));
    if (hit) { e.stopImmediatePropagation(); e.preventDefault(); ui.navQ.value = ''; ui.navQ.blur(); openFind(hit[0]); }
  }, true);

  // While navigating: 🔍 opens the finder (along the route).
  const findBtn = document.createElement('button');
  findBtn.id = 'nvFind'; findBtn.textContent = '🔍'; findBtn.title = 'Find along route';
  ui.navBar.insertBefore(findBtn, ui.nvVoice);
  findBtn.onclick = () => {
    ui.navSheet.innerHTML = `<div class="ns-head"><b>Find along your route</b><button id="nsClose">✕</button></div>${catChips()}`;
    ui.navSheet.hidden = false;
    $('nsClose').onclick = () => { ui.navSheet.hidden = true; };
  };
  ui.navSheet.addEventListener('click', e => { const b = e.target.closest('[data-cat]'); if (b) openFind(b.dataset.cat); });

  map.on('moveend', () => { clearTimeout(buildPlacesUi.t); buildPlacesUi.t = setTimeout(placesOnView, 800); });
  if (typeof map3dReady !== 'undefined' && map3dReady) placesOn3DReady();   // 3D was already open at load
  placesOnView();
})();
