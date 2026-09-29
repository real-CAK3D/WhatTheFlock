'use strict';
// Turn-by-turn navigation.
//   Search:  Photon (komoot, OSM data) for type-ahead, Nominatim as a fallback
//            on Enter, Photon reverse for long-press pins.
//   Routing: OSRM on routing.openstreetmap.de (FOSSGIS) for car/bike/foot,
//            router.project-osrm.org as a car fallback. Alternatives are scored
//            by how many mapped plate readers / speed cameras sit on them.
//   Guidance runs locally from the route geometry, so a route planned on
//   Wi-Fi keeps guiding with no signal; only re-routing needs internet.
// Loaded after offline.js; uses globals from app.js, layers.js, map3d.js, sounds.js.

const PHOTON = 'https://photon.komoot.io';
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const ROUTERS = {
  car:  ['https://routing.openstreetmap.de/routed-car/route/v1/driving', 'https://router.project-osrm.org/route/v1/driving'],
  bike: ['https://routing.openstreetmap.de/routed-bike/route/v1/driving'],
  foot: ['https://routing.openstreetmap.de/routed-foot/route/v1/driving'],
};
const NAV_KEY = 'fy.nav.v1';
const ON_ROUTE_M = 40;          // a camera this close to the line counts as "on the route"
const OFF_ROUTE_M = 45;         // further than this from the line = off route
const OFF_ROUTE_FIXES = 3;      // consecutive off-route fixes before re-routing
const REROUTE_GAP_MS = 15000;
const ARRIVE_M = 30;
const MAX_ROUTE_CELLS = 160;    // camera lookup cap (~ 800 km of route)

opts.places = opts.places || [];       // saved: [{name, label, lat, lon}]
opts.recent = opts.recent || [];       // recent destinations
opts.navMode = opts.navMode || 'car';
opts.routePref = opts.routePref || 'fastest';   // 'fastest' | 'fewest'
opts.navVoice = opts.navVoice ?? true;
opts.nav3d = opts.nav3d ?? true;

let navDest = null;       // {name, label, lat, lon}
let routes = [];          // prepared routes for preview
let selIdx = 0;
let nav = null;           // active navigation state
const navLayer = L.layerGroup().addTo(map);

// ---------------------------------------------------------------- formatting

const fmtDur = s => {
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const fmtClock = ts => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const ORD = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10 < 4 ? n % 10 : 0] || 'th');
const COMPASS8 = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const ARROWS = { straight: '↑', 'slight left': '↖', left: '←', 'sharp left': '↙', 'slight right': '↗', right: '→', 'sharp right': '↘', uturn: '↶' };

function placeLabel(p) {
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const name = p.name || street || p.city || 'Dropped pin';
  const rest = [p.name && street ? street : '', p.city || p.town || p.village || p.district || p.county, p.state, p.postcode]
    .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
  return { name, label: rest };
}

function stepText(s) {
  const m = s.maneuver, mod = m.modifier || '';
  const road = s.name || s.ref || '';
  const onto = road ? ` onto ${road}` : '';
  const side = mod.includes('left') ? 'left' : 'right';
  const toward = s.destinations ? ` toward ${s.destinations.split(':').pop().split(',')[0].trim()}` : '';
  switch (m.type) {
    case 'depart': return `Head ${COMPASS8[Math.round((m.bearing_after || 0) / 45) % 8]}${road ? ' on ' + road : ''}`;
    case 'arrive':
      if (s._via) return `You've reached your stop${road ? ' on ' + road : ''}, continue on the route`;
      return mod === 'left' || mod === 'right' ? `Arrive at your destination on the ${mod}` : 'Arrive at your destination';
    case 'turn': case 'end of road':
      if (mod === 'uturn') return `Make a U-turn${onto}`;
      if (mod === 'straight') return `Continue straight${onto}`;
      return `Turn ${mod}${onto}`;
    case 'new name': case 'continue':
      return mod && mod !== 'straight' ? `Keep ${mod}${onto}` : `Continue${onto}`;
    case 'merge': return `Merge ${side}${onto}`;
    case 'on ramp': return `Take the ramp on the ${side}${road ? ' to ' + road : ''}${toward}`;
    case 'off ramp': return `Take the exit on the ${side}${s.exits ? ' (exit ' + s.exits.split(';')[0] + ')' : ''}${toward}`;
    case 'fork': return `Keep ${side} at the fork${onto}${toward}`;
    case 'roundabout': case 'rotary': case 'roundabout turn':
      return m.exit ? `At the roundabout, take the ${ORD(m.exit)} exit${onto}` : `Enter the roundabout${onto}`;
    case 'exit roundabout': case 'exit rotary': return `Exit the roundabout${onto}`;
    default: return `Continue${onto}`;
  }
}
function stepArrow(s) {
  const t = s.maneuver.type;
  if (t === 'arrive') return s._via ? '📍' : '🏁';
  if (t.includes('roundabout') || t.includes('rotary')) return '⟳';
  return ARROWS[s.maneuver.modifier] || '↑';
}

// ---------------------------------------------------------------- geometry

// Local flat projection (metres) around a reference latitude — accurate enough for snapping.
function proj(lat0) {
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  return (lat, lon) => [lon * kx, lat * ky];
}
// Closest point on segment a-b to p (all [x,y]); returns [dist, t].
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return [Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy), t];
}

// Pre-compute everything guidance needs from an OSRM route.
function prepRoute(r) {
  const coords = r.geometry.coordinates;             // [lon, lat]
  const P = proj(coords[0][1]);
  const xy = coords.map(([lon, lat]) => P(lat, lon));
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  // Arrivals at intermediate stops are not the destination.
  const steps = r.legs.flatMap((l, li) => l.steps.map(s => { if (li < r.legs.length - 1 && s.maneuver.type === 'arrive') s._via = true; return s; }));
  let from = 0;
  for (const s of steps) {
    const [lon, lat] = s.maneuver.location, q = P(lat, lon);
    let best = from, bd = Infinity;
    for (let i = from; i < xy.length; i++) {
      const d = Math.hypot(xy[i][0] - q[0], xy[i][1] - q[1]);
      if (d < bd) { bd = d; best = i; }
      if (bd < 3 && d > 50) break;
    }
    s._at = cum[best]; from = best;
  }
  return { raw: r, coords, xy, cum, P, steps, total: cum[cum.length - 1], duration: r.duration, cams: [], camsCounted: false };
}

// Mapped cameras within ON_ROUTE_M of the line, with their position along it.
function camerasOn(rt) {
  const lats = rt.coords.map(c => c[1]), lons = rt.coords.map(c => c[0]);
  const pad = 0.001;
  const s = Math.min(...lats) - pad, n = Math.max(...lats) + pad, w = Math.min(...lons) - pad, e = Math.max(...lons) + pad;
  // Thin very long lines so the check stays quick on a phone.
  const stride = Math.max(1, Math.floor(rt.xy.length / 3000));
  const out = [];
  for (const p of allItems()) {
    if ((p.kind !== 'alpr' && p.kind !== 'enf') || p.lat < s || p.lat > n || p.lon < w || p.lon > e) continue;
    const q = rt.P(p.lat, p.lon);
    let bd = Infinity, at = 0;
    for (let i = 0; i + stride < rt.xy.length; i += stride) {
      const [d, t] = segDist(q, rt.xy[i], rt.xy[i + stride]);
      if (d < bd) { bd = d; at = rt.cum[i] + t * (rt.cum[i + stride] - rt.cum[i]); }
    }
    if (bd <= ON_ROUTE_M) out.push({ p, at });
  }
  return out.sort((a, b) => a.at - b.at);
}

// Make sure mapped-camera data covers the route corridor (cache first, then Overpass).
async function loadRouteCells(rt) {
  const seen = new Set(), cells = [];
  for (const [lon, lat] of rt.coords) {
    const i = Math.floor(lat / CELL), j = Math.floor(lon / CELL), k = cellKey(i, j);
    if (!seen.has(k)) { seen.add(k); cells.push([i, j]); }
    if (cells.length >= MAX_ROUTE_CELLS) break;
  }
  const missing = [];
  for (const [i, j] of cells) {
    const k = cellKey(i, j);
    if (loadedCells.has(k)) continue;
    const c = await poiDB.get(k).catch(() => null);
    if (c) loadedCells.set(k, c); else missing.push([i, j]);
  }
  if (missing.length && navigator.onLine) {
    // Consecutive cells along a route are neighbours, so chunked bboxes stay small.
    for (let x = 0; x < missing.length; x += 12) await fetchCells(missing.slice(x, x + 12)).catch(() => {});
  }
  return cells.length >= MAX_ROUTE_CELLS;
}

// ---------------------------------------------------------------- network

async function getJSON(url, ms = 15000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

function biasLL() {
  if (fix) return { lat: fix.lat, lon: fix.lon };
  const c = (typeof map3dActive === 'function' && map3dActive()) ? map3d.getCenter() : map.getCenter();
  return { lat: c.lat, lon: c.lng };
}

let searchAC = null;
async function photonSearch(q) {
  const b = biasLL();
  const d = await getJSON(`${PHOTON}/api/?q=${encodeURIComponent(q)}&limit=7&lang=en&lat=${b.lat.toFixed(4)}&lon=${b.lon.toFixed(4)}`, 10000);
  return d.features.map(f => ({ ...placeLabel(f.properties), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }));
}
async function nominatimSearch(q) {
  const b = biasLL();
  const d = await getJSON(`${NOMINATIM}/search?format=jsonv2&addressdetails=1&limit=6&q=${encodeURIComponent(q)}&viewbox=${b.lon - 1},${b.lat + 1},${b.lon + 1},${b.lat - 1}`, 12000);
  return d.map(x => {
    const a = x.address || {};
    return { ...placeLabel({ name: x.name, housenumber: a.house_number, street: a.road, city: a.city || a.town || a.village, state: a.state, postcode: a.postcode }), lat: +x.lat, lon: +x.lon };
  });
}
async function reverseLabel(lat, lon) {
  try {
    const d = await getJSON(`${PHOTON}/reverse?lat=${lat}&lon=${lon}&lang=en`, 8000);
    if (d.features[0]) return placeLabel(d.features[0].properties);
  } catch {}
  return { name: 'Dropped pin', label: `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
}

async function osrm(from, to) {
  const path = `/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=true&alternatives=true`;
  let last;
  for (const base of ROUTERS[opts.navMode] || ROUTERS.car) {
    try {
      const d = await getJSON(base + path, 20000);
      if (d.code !== 'Ok' || !d.routes?.length) throw new Error(d.message || d.code || 'no route');
      return d.routes;
    } catch (e) { last = e; }
  }
  throw last;
}

// ---------------------------------------------------------------- UI build

const ui = {};
(function buildNavUi() {
  const tab = $('tab-map');
  tab.insertAdjacentHTML('beforeend', `
    <div id="navSearch">
      <input id="navQ" type="search" placeholder="Search address or place" autocomplete="off" enterkeyhint="search">
      <button id="navQClear" title="Clear">✕</button>
      <div id="navResults" hidden></div>
    </div>
    <div id="navSheet" hidden></div>
    <div id="navBanner" hidden>
      <div class="nb-arrow" id="nbArrow">↑</div>
      <div class="nb-main"><div class="nb-dist" id="nbDist"></div><div class="nb-text" id="nbText"></div></div>
      <div class="nb-then" id="nbThen" hidden></div>
    </div>
    <div id="navBar" hidden>
      <div class="nv-eta"><b id="nvEta"></b><span id="nvLeft"></span></div>
      <div class="nv-cam" id="nvCam"></div>
      <button id="nvVoice" title="Voice directions"></button>
      <button id="nvEnd" class="danger">End</button>
    </div>`);
  for (const id of ['navQ', 'navQClear', 'navResults', 'navSheet', 'navBanner', 'nbArrow', 'nbDist', 'nbText', 'nbThen', 'navBar', 'nvEta', 'nvLeft', 'nvCam', 'nvVoice', 'nvEnd'])
    ui[id] = $(id);

  let t = null;
  ui.navQ.addEventListener('input', () => {
    clearTimeout(t);
    const q = ui.navQ.value.trim();
    if (q.length < 3) { showSuggestions(); return; }
    t = setTimeout(() => runSearch(q, false), 350);
  });
  ui.navQ.addEventListener('focus', () => { if (ui.navQ.value.trim().length < 3) showSuggestions(); });
  ui.navQ.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runSearch(ui.navQ.value.trim(), true); } });
  ui.navQClear.onclick = () => { ui.navQ.value = ''; ui.navResults.hidden = true; ui.navQ.blur(); };
  ui.navResults.addEventListener('click', e => {
    const el = e.target.closest('[data-i]');
    if (!el) return;
    const p = lastResults[Number(el.dataset.i)];
    ui.navResults.hidden = true; ui.navQ.blur();
    if (p.trip) { ui.navQ.value = ''; navigateSavedTrip(); return; }
    ui.navQ.value = p.name;
    selectPlace(p);
  });
  ui.nvEnd.onclick = () => endNav(true);
  ui.nvVoice.onclick = () => { opts.navVoice = !opts.navVoice; saveOpts(); paintVoiceBtn(); if (opts.navVoice) say('Voice directions on'); };
  paintVoiceBtn();

  // Long-press (contextmenu) to drop a destination pin, on either map.
  map.on('contextmenu', e => dropPin(e.latlng.lat, e.latlng.lng));

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h2>Navigation</h2>
    <p class="mute">Search needs internet. A route planned on Wi-Fi keeps giving directions with no signal; re-routing after a wrong turn needs signal again.</p>
    <label class="sw">Travel by
      <select id="optNavMode"><option value="car">Car</option><option value="bike">Bike</option><option value="foot">Walking</option></select></label>
    <label class="sw">Pick route by
      <select id="optRoutePref"><option value="fastest">Fastest</option><option value="fewest">Fewest cameras</option></select></label>
    <label class="sw"><input type="checkbox" id="optNavVoice"> Spoken directions</label>
    <label class="sw"><input type="checkbox" id="optNav3d"> Navigate in 3D, map turns with you</label>
    <div id="placesList"></div>
    <p class="mute small1">Search © OpenStreetMap contributors via Photon &amp; Nominatim · Routing: OSRM / FOSSGIS</p>`;
  $('slot-nav').append(card);
  $('optNavMode').value = opts.navMode;
  $('optNavMode').onchange = e => { opts.navMode = e.target.value; saveOpts(); };
  $('optRoutePref').value = opts.routePref;
  $('optRoutePref').onchange = e => { opts.routePref = e.target.value; saveOpts(); };
  bindOpt('optNavVoice', 'navVoice', paintVoiceBtn);
  bindOpt('optNav3d', 'nav3d');
  paintPlaces();
})();

function paintVoiceBtn() { ui.nvVoice.textContent = opts.navVoice ? '🔊' : '🔇'; }

function paintPlaces() {
  const el = $('placesList');
  if (!el) return;
  el.innerHTML = opts.places.length
    ? '<p class="mute small1">Saved places</p>' + opts.places.map((p, i) => `
      <div class="setup-row"><span>★</span><div class="setup-body"><b>${esc(p.name)}</b><div class="mute small1">${esc(p.label || '')}</div></div>
      <button data-del="${i}">Remove</button></div>`).join('')
    : '<p class="mute small1">No saved places yet. Search for one and tap ★ Save.</p>';
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { opts.places.splice(Number(b.dataset.del), 1); saveOpts(); paintPlaces(); });
}

// ---------------------------------------------------------------- search

let lastResults = [];
function showSuggestions() {
  const trip = typeof loadTrip === 'function' ? loadTrip() : null;
  const list = [
    ...(trip ? [{ name: trip.name, label: 'Saved trip · directions work offline', trip: true, lat: trip.dest.lat, lon: trip.dest.lon }] : []),
    ...opts.places.map(p => ({ ...p, star: true })),
    ...opts.recent.filter(r => !opts.places.some(p => p.lat === r.lat && p.lon === r.lon)),
  ].slice(0, 10);
  if (!list.length) { ui.navResults.hidden = true; return; }
  renderResults(list);
}
function renderResults(list) {
  lastResults = list;
  const here = fix || null;
  ui.navResults.innerHTML = list.map((p, i) => `
    <div class="nr" data-i="${i}"><span class="nr-ico">${p.trip ? '🧳' : p.star ? '★' : p.recent ? '🕘' : '📍'}</span>
      <div class="nr-body"><b>${esc(p.name)}</b><div class="mute small1">${esc(p.label || '')}</div></div>
      ${here ? `<span class="nr-d mute">${fmtDist(distM(here, p))}</span>` : ''}</div>`).join('') || '<div class="nr mute">No results</div>';
  ui.navResults.hidden = false;
}
async function runSearch(q, enter) {
  if (!q) return;
  const ll = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (ll) { const lat = +ll[1], lon = +ll[2]; if (enter) { ui.navResults.hidden = true; selectPlace({ name: 'Coordinates', label: `${lat}, ${lon}`, lat, lon }); } return; }
  if (!navigator.onLine) { renderResults([]); toast('Search needs internet — pick a saved place or connect to Wi-Fi'); return; }
  try {
    let r = await photonSearch(q);
    if (!r.length && enter) r = await nominatimSearch(q);
    if (ui.navQ.value.trim() !== q && !enter) return;   // user kept typing
    renderResults(r);
    if (enter && r.length === 1) { ui.navResults.hidden = true; selectPlace(r[0]); }
  } catch (e) {
    if (enter) { try { renderResults(await nominatimSearch(q)); return; } catch {} }
    toast('Search failed: ' + e.message);
  }
}

async function dropPin(lat, lon) {
  if (nav) return;
  const lbl = navigator.onLine ? await reverseLabel(lat, lon) : { name: 'Dropped pin', label: `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
  selectPlace({ ...lbl, lat, lon });
}

// ---------------------------------------------------------------- place + preview

function selectPlace(p) {
  navDest = { name: p.name, label: p.label || '', lat: p.lat, lon: p.lon };
  routes = [];
  drawNav();
  setFollow(false);
  if (typeof map3dActive === 'function' && map3dActive()) map3d.flyTo({ center: [p.lon, p.lat], zoom: 15.5 });
  else map.setView([p.lat, p.lon], 16);
  const saved = opts.places.some(x => x.lat === p.lat && x.lon === p.lon);
  ui.navSheet.innerHTML = `
    <div class="ns-head"><div><b>${esc(p.name)}</b><div class="mute small1">${esc(p.label || '')}${fix ? ' · ' + fmtDist(distM(fix, p)) + ' away' : ''}</div></div>
      <button id="nsClose">✕</button></div>
    <div class="ns-acts">
      <button id="nsGo" class="primary">Directions</button>
      <button id="nsSave">${saved ? '★ Saved' : '☆ Save'}</button>
    </div>`;
  ui.navSheet.hidden = false;
  $('nsClose').onclick = clearDest;
  $('nsGo').onclick = () => planRoute();
  $('nsSave').onclick = () => {
    if (saved) return;
    const name = prompt('Name this place (e.g. Home, Work)', p.name);
    if (!name) return;
    opts.places.push({ name: name.trim(), label: p.label || '', lat: p.lat, lon: p.lon });
    saveOpts(); paintPlaces(); $('nsSave').textContent = '★ Saved';
  };
}

function clearDest() {
  navDest = null; routes = [];
  ui.navSheet.hidden = true;
  drawNav();
}

async function planRoute(silent = false) {
  if (!navDest) return;
  const from = currentFix() || fix;
  if (!from) { toast('Waiting for GPS — step outside or check Location permission'); return; }
  if (!navigator.onLine) { toast('Routing needs internet (Wi-Fi or hotspot)'); return; }
  if (!silent) { ui.navSheet.innerHTML = '<div class="ns-head"><b>Finding routes…</b></div>'; ui.navSheet.hidden = false; showPreview.fitted = false; }
  try {
    const raw = await osrm(from, navDest);
    const mine = routes = raw.map(prepRoute);
    const fastest = routes.reduce((a, r, i) => r.duration < routes[a].duration ? i : a, 0);
    routes.forEach((r, i) => { r.isFastest = i === fastest; });
    selIdx = fastest;
    // Show the routes straight away; camera counts fill in once the corridor's
    // camera data is loaded (from cache, or Overpass when online).
    if (!silent) showPreview();
    let capped = false;
    for (const [i, r] of routes.entries()) { const c = await loadRouteCells(r); if (i === 0) capped = c; }
    if (routes !== mine) return;   // user moved on while we were counting
    for (const r of routes) { r.cams = camerasOn(r); r.camsCounted = true; r.capped = capped; }
    const fewest = routes.reduce((a, r, i) => r.cams.length < routes[a].cams.length || (r.cams.length === routes[a].cams.length && r.duration < routes[a].duration) ? i : a, 0);
    routes.forEach((r, i) => { r.isFewest = i === fewest && routes.length > 1 && r.cams.length < routes[fastest].cams.length; });
    if (opts.routePref === 'fewest') selIdx = fewest;
    if (silent) return routes[selIdx];
    if (!nav && !ui.navSheet.hidden && $('nsRoutes')) showPreview();
  } catch (e) {
    if (silent) throw e;
    toast('No route: ' + e.message);
    selectPlace(navDest);
  }
}

function camSummary(r) {
  if (!r.camsCounted) return '<span class="mute">Checking for cameras on this route…</span>';
  const a = r.cams.filter(c => c.p.kind === 'alpr').length, s = r.cams.length - a;
  if (!r.cams.length) return '<span class="ok">No mapped cameras</span>';
  return `<span class="warn">📷 ${a} plate reader${a === 1 ? '' : 's'}${s ? ` · ${s} speed/red-light` : ''}</span>`;
}

function showPreview() {
  const mode = { car: '🚗', bike: '🚲', foot: '🚶' }[opts.navMode];
  ui.navSheet.innerHTML = `
    <div class="ns-head"><div><b>${mode} To ${esc(navDest.name)}</b><div class="mute small1">${esc(navDest.label)}</div></div><button id="nsClose">✕</button></div>
    <div id="nsRoutes">${routes.map((r, i) => `
      <div class="rt${i === selIdx ? ' sel' : ''}" data-r="${i}">
        <div><b>${fmtDur(r.duration + (typeof routeDelayAhead === 'function' ? routeDelayAhead(r) : 0))}</b> · ${fmtDist(r.total)}
          ${typeof routeDelayAhead === 'function' && routeDelayAhead(r) >= 60 ? `<span class="chip late">+${fmtDur(routeDelayAhead(r))} traffic</span>` : ''}
          ${r.isFastest ? '<span class="chip">Fastest</span>' : ''}${r.isFewest ? '<span class="chip ok">Fewest cameras</span>' : ''}</div>
        <div class="small1">${camSummary(r)}${r.capped ? ' <span class="mute">(first part of route)</span>' : ''}</div>
      </div>`).join('')}</div>
    <div class="ns-acts"><button id="nsStart" class="primary">Start</button><button id="nsBack">Back</button></div>`;
  $('nsClose').onclick = clearDest;
  $('nsBack').onclick = () => selectPlace(navDest);
  $('nsStart').onclick = () => startNav(routes[selIdx]);
  $('nsRoutes').onclick = e => {
    const el = e.target.closest('[data-r]');
    if (!el) return;
    selIdx = Number(el.dataset.r);
    showPreview(); drawNav();
  };
  drawNav();
  if (!showPreview.fitted) fitRoute(routes[selIdx]);
  showPreview.fitted = true;
}

function fitRoute(r) {
  const lats = r.coords.map(c => c[1]), lons = r.coords.map(c => c[0]);
  const b = [[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]];
  if (typeof map3dActive === 'function' && map3dActive())
    map3d.fitBounds([[b[0][1], b[0][0]], [b[1][1], b[1][0]]], { padding: { top: 90, bottom: 260, left: 40, right: 40 }, pitch: 0, bearing: 0 });
  else map.fitBounds(b, { paddingTopLeft: [30, 90], paddingBottomRight: [30, 260] });
}

// ---------------------------------------------------------------- drawing

function routeLines() {
  if (nav) return { sel: nav.rt, alts: [] };
  return { sel: routes[selIdx] || null, alts: routes.filter((_, i) => i !== selIdx) };
}

function drawNav() {
  navLayer.clearLayers();
  const { sel, alts } = routeLines();
  for (const r of alts) {
    const ll = r.coords.map(c => [c[1], c[0]]);
    L.polyline(ll, { color: '#6b7280', weight: 6, opacity: 0.8 }).on('click', () => { selIdx = routes.indexOf(r); showPreview(); }).addTo(navLayer);
  }
  if (sel) {
    const ll = sel.coords.map(c => [c[1], c[0]]);
    L.polyline(ll, { color: '#fff', weight: 10, opacity: 0.9, interactive: false }).addTo(navLayer);
    L.polyline(ll, { color: '#1a73e8', weight: 6, opacity: 1, interactive: false }).addTo(navLayer);
  }
  if (navDest) {
    L.circleMarker([navDest.lat, navDest.lon], { radius: 10, color: '#fff', weight: 3, fillColor: '#ea4335', fillOpacity: 1 })
      .bindPopup(esc(navDest.name)).addTo(navLayer);
  }
  drawNav3D();
}

function navOn3DReady() {
  for (const id of ['fy-nav-alts', 'fy-nav-route', 'fy-nav-dest']) map3d.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const before = map3d.getLayer('fy-cones') ? 'fy-cones' : undefined;
  map3d.addLayer({ id: 'fy-nav-alts', type: 'line', source: 'fy-nav-alts', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#6b7280', 'line-width': 7, 'line-opacity': 0.8 } }, before);
  map3d.addLayer({ id: 'fy-nav-casing', type: 'line', source: 'fy-nav-route', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 12 } }, before);
  map3d.addLayer({ id: 'fy-nav-route', type: 'line', source: 'fy-nav-route', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#1a73e8', 'line-width': 8 } }, before);
  map3d.addLayer({ id: 'fy-nav-dest', type: 'circle', source: 'fy-nav-dest',
    paint: { 'circle-radius': 10, 'circle-color': '#ea4335', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
  drawNav3D();
}
function drawNav3D() {
  if (typeof map3dReady === 'undefined' || !map3dReady || !map3d.getSource('fy-nav-route')) return;
  const { sel, alts } = routeLines();
  const line = r => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: r.coords }, properties: {} });
  map3d.getSource('fy-nav-route').setData({ type: 'FeatureCollection', features: sel ? [line(sel)] : [] });
  map3d.getSource('fy-nav-alts').setData({ type: 'FeatureCollection', features: alts.map(line) });
  map3d.getSource('fy-nav-dest').setData({ type: 'FeatureCollection', features: navDest
    ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [navDest.lon, navDest.lat] }, properties: {} }] : [] });
}

// ---------------------------------------------------------------- guidance

function say(text) {
  if (!opts.navVoice || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text.replace(/ ft\b/g, ' feet').replace(/ mi\b/g, ' miles').replace(/ km\b/g, ' kilometres').replace(/ m\b/g, ' metres'));
  u.rate = 1.0;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
// Announcement distances before a maneuver: further out at highway speed.
function thresholds() {
  const fast = fix && fix.spd != null && fix.spd > 20;
  return opts.navMode === 'foot' ? [150, 30] : fast ? [3200, 800, 250] : [800, 200, 60];
}

async function startNav(rt) {
  nav = { rt, dest: navDest, stepIdx: 1, idx: 0, along: 0, off: 0, lastReroute: 0, said: {}, started: Date.now() };
  persistNav();
  ui.navSheet.hidden = true;
  $('navSearch').hidden = true;
  ui.navBanner.hidden = false; ui.navBar.hidden = false;
  document.body.classList.add('navigating');
  opts.recent = [{ ...navDest, recent: true }, ...opts.recent.filter(r => !(r.lat === navDest.lat && r.lon === navDest.lon))].slice(0, 8);
  saveOpts();
  requestWake();
  audio();
  drawNav();
  if (opts.nav3d && typeof set3D === 'function') {
    if (!opts.view3d) await set3D(true);
    if (map3dReady && fix) map3d.jumpTo({ center: [fix.lon, fix.lat], zoom: 17, pitch: 55 });
  }
  setFollow(true);
  const first = rt.steps[0];
  say(`${stepText(first)}. ${rt.cams.length ? rt.cams.length + ' mapped cameras on this route.' : ''}`);
  if (fix) navOnFix(fix); else paintBanner();
}

function endNav(byUser) {
  if (!nav) return;
  nav = null;
  persistNav();
  ui.navBanner.hidden = true; ui.navBar.hidden = true;
  $('navSearch').hidden = false;
  document.body.classList.remove('navigating');
  if (!dev) releaseWake();
  if (byUser) { navDest = null; routes = []; }
  drawNav();
  if (typeof map3dActive === 'function' && map3dActive()) map3d.easeTo({ pitch: 45 });
}

function persistNav() {
  try {
    if (nav) localStorage.setItem(NAV_KEY, JSON.stringify({ raw: nav.rt.raw, dest: nav.dest, cams: nav.rt.cams.map(c => ({ at: c.at, p: c.p })) }));
    else localStorage.removeItem(NAV_KEY);
  } catch {}
}

// Snap a position onto the route near where we last were; returns [offDistance, along, index].
function snap(rt, f, fromIdx) {
  const q = rt.P(f.lat, f.lon);
  let bd = Infinity, bAlong = 0, bIdx = fromIdx;
  const scan = (a, b) => {
    for (let i = Math.max(0, a); i < Math.min(rt.xy.length - 1, b); i++) {
      const [d, t] = segDist(q, rt.xy[i], rt.xy[i + 1]);
      if (d < bd) { bd = d; bIdx = i; bAlong = rt.cum[i] + t * (rt.cum[i + 1] - rt.cum[i]); }
    }
  };
  scan(fromIdx - 10, fromIdx + 400);
  if (bd > OFF_ROUTE_M) scan(0, rt.xy.length);   // jumped (tunnel, GPS glitch): search everything
  return [bd, bAlong, bIdx];
}

async function navOnFix(f) {
  if (!nav || !f || f.acc > 80) return;
  const rt = nav.rt;
  const [off, along, idx] = snap(rt, f, nav.idx);

  // Off route: confirm over a few fixes, then re-route if we can.
  if (off > OFF_ROUTE_M) {
    nav.off++;
    if (nav.off >= OFF_ROUTE_FIXES && Date.now() - nav.lastReroute > REROUTE_GAP_MS) {
      nav.lastReroute = Date.now();
      if (!navigator.onLine) { ui.nbText.textContent = 'Off route — no signal to re-route. Head back to the blue line.'; return; }
      say('Rerouting');
      ui.nbText.textContent = 'Re-routing…';
      try {
        navDest = nav.dest;
        const r = await planRoute(true);
        if (r && nav) { nav.rt = r; nav.idx = 0; nav.stepIdx = 1; nav.said = {}; nav.off = 0; persistNav(); drawNav(); navOnFix(fix); }
      } catch { ui.nbText.textContent = 'Could not re-route — head back to the blue line'; }
    }
    return;
  }
  nav.off = 0;
  nav.idx = idx; nav.along = along;

  // Arrived?
  const toDest = distM(f, nav.dest);
  if (rt.total - along < ARRIVE_M || toDest < ARRIVE_M) {
    say(`You have arrived at ${nav.dest.name}`);
    toast(`Arrived at ${nav.dest.name}`);
    endNav(true);
    return;
  }

  // Next maneuver = first step starting ahead of us.
  let k = nav.stepIdx;
  while (k < rt.steps.length - 1 && rt.steps[k]._at <= along + 5) k++;
  if (k !== nav.stepIdx) { nav.stepIdx = k; }
  const step = rt.steps[k];
  const dist = Math.max(0, step._at - along);

  // Spoken prompts at each threshold, once per step.
  const said = nav.said[k] || (nav.said[k] = new Set());
  const stepLen = step._at - (rt.steps[k - 1]?._at ?? 0);
  for (const th of thresholds()) {
    if (dist <= th && !said.has(th) && (stepLen > th * 1.2 || th === thresholds().at(-1))) {
      thresholds().filter(x => x >= th).forEach(x => said.add(x));
      const next = rt.steps[k + 1];
      const lc = s => s[0].toLowerCase() + s.slice(1);   // keep street names capitalised
      const soon = next && next._at - step._at < 150 && next.maneuver.type !== 'arrive' ? `, then ${lc(stepText(next))}` : '';
      say(th === thresholds().at(-1) ? stepText(step) + soon : `In ${fmtDist(dist)}, ${lc(stepText(step))}`);
      break;
    }
  }
  paintBanner(step, dist, rt.steps[k + 1]);
}

function paintBanner(step, dist, next) {
  if (!nav) return;
  const rt = nav.rt;
  step = step || rt.steps[nav.stepIdx];
  dist = dist ?? step._at - nav.along;
  ui.nbArrow.textContent = stepArrow(step);
  ui.nbDist.textContent = fmtDist(dist);
  ui.nbText.textContent = stepText(step);
  const thenClose = next && next._at - step._at < 250 && next.maneuver.type !== 'arrive';
  ui.nbThen.hidden = !thenClose;
  if (thenClose) ui.nbThen.textContent = 'Then ' + stepArrow(next);
  const left = Math.max(0, rt.total - nav.along);
  // Reported incident delays still ahead on the route (traffic.js, needs a TomTom key).
  const delay = typeof routeDelayAhead === 'function' ? routeDelayAhead(rt, nav.along) : 0;
  const secs = rt.duration * (left / rt.total) + delay;
  ui.nvEta.textContent = fmtClock(Date.now() + secs * 1000);
  ui.nvEta.classList.toggle('late', delay >= 300);
  ui.nvLeft.textContent = `${fmtDur(secs)} · ${fmtDist(left)}${delay >= 60 ? ` · +${fmtDur(delay)} traffic` : ''}`;
  const ahead = rt.cams.filter(c => c.at > nav.along - 20);
  ui.nvCam.innerHTML = ahead.length
    ? `📷 ${fmtDist(Math.max(0, ahead[0].at - nav.along))}<span class="mute"> · ${ahead.length} left</span>`
    : '<span class="ok">No cameras ahead</span>';
}

// Resume a route after the app was closed or reloaded.
(function restoreNav() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(NAV_KEY)); } catch {}
  if (!s || !s.raw) return;
  navDest = s.dest;
  const rt = prepRoute(s.raw);
  rt.cams = s.cams || [];
  setTimeout(() => { if (confirm(`Resume directions to ${s.dest.name}?`)) startNav(rt); else { localStorage.removeItem(NAV_KEY); navDest = null; drawNav(); } }, 800);
})();
