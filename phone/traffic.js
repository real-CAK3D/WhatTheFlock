'use strict';
// Live traffic from TomTom (needs an API key: config.local.js or Settings → Traffic).
//   - Flow overlay: coloured congestion lines on both maps
//   - Incidents: accidents, jams, closures, road works around you, refreshed every 2 min
//   - Alerts: incidents ahead of you (or on your route while navigating), spoken
//   - Route delay: adds reported incident delays on the active route to the ETA
//   - Speed limits: fallback for speed.js when OpenStreetMap has none
// Loaded after speed.js.

const TT = 'https://api.tomtom.com';
const INC_REFRESH_MS = 120000;
const INC_BOX_KM = 20;
const INC_ALERT_M = 3000;       // warn this far ahead
const TT_DAILY_LOOKUPS = 2000;  // stay under the free tier for speed-limit lookups
const INC_TYPES = {
  0: ['Incident', '⚠️'], 1: ['Accident', '💥'], 2: ['Fog', '🌫️'], 3: ['Dangerous conditions', '⚠️'], 4: ['Rain', '🌧️'],
  5: ['Ice', '🧊'], 6: ['Traffic jam', '🚗'], 7: ['Lane closed', '🚧'], 8: ['Road closed', '⛔'], 9: ['Road works', '🚧'],
  10: ['Wind', '💨'], 11: ['Flooding', '🌊'], 14: ['Broken-down vehicle', '🚙'],
};
const DELAY_COLORS = { 0: '#8e8e93', 1: '#ffd60a', 2: '#ff9500', 3: '#ff3b30', 4: '#bf1e2e' };

opts.layers.flow = opts.layers.flow ?? true;
opts.layers.incidents = opts.layers.incidents ?? true;
opts.trafficAlerts = opts.trafficAlerts ?? true;
opts.tomtomKey = opts.tomtomKey || '';

const ttKey = () => opts.tomtomKey || window.FY_LOCAL?.tomtomKey || '';

// ---------------------------------------------------------------- flow overlay

let flow2D = null;
const flowUrl = () => `${TT}/traffic/map/4/tile/flow/${opts.night ? 'relative0-dark' : 'relative0'}/{z}/{x}/{y}.png?key=${ttKey()}&tileSize=256&thickness=6`;

function applyFlow() {
  const on = !!ttKey() && opts.layers.flow;
  if (flow2D) { flow2D.remove(); flow2D = null; }
  if (on) flow2D = L.tileLayer(flowUrl(), { zIndex: 5, opacity: 0.85, maxZoom: 19, maxNativeZoom: 18 }).addTo(map);
  if (typeof map3dReady !== 'undefined' && map3dReady) {
    if (map3d.getLayer('fy-flow')) map3d.removeLayer('fy-flow');
    if (map3d.getSource('fy-flow')) map3d.removeSource('fy-flow');
    if (on) {
      map3d.addSource('fy-flow', { type: 'raster', tiles: [flowUrl()], tileSize: 256, maxzoom: 18 });
      map3d.addLayer({ id: 'fy-flow', type: 'raster', source: 'fy-flow', paint: { 'raster-opacity': 0.85 } },
        map3d.getLayer('building-3d') ? 'building-3d' : undefined);
    }
  }
}

// ---------------------------------------------------------------- incidents

let incidents = [];     // [{id, cat, mag, desc, from, to, delay, roads, coords:[[lon,lat]...]}]
let incAt = 0, incFetching = false, incCenter = null;
const incLayer = L.layerGroup().addTo(map);

async function fetchIncidents(force = false) {
  if (!ttKey() || !navigator.onLine || incFetching) return;
  const c = fix || biasLL();
  // Refresh on a timer, or sooner once we've moved well away from the last box.
  const moved = !incCenter || distM(incCenter, c) > INC_BOX_KM * 400;
  if (!force && !moved && Date.now() - incAt < INC_REFRESH_MS) return;
  incCenter = { lat: c.lat, lon: c.lon };
  const dLat = INC_BOX_KM / 111, dLon = INC_BOX_KM / (111 * Math.cos(c.lat * Math.PI / 180));
  const bbox = [c.lon - dLon, c.lat - dLat, c.lon + dLon, c.lat + dLat].map(v => v.toFixed(4)).join(',');
  const fields = '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description},from,to,delay,roadNumbers}}}';
  incFetching = true;
  try {
    const u = `${TT}/traffic/services/5/incidentDetails?key=${ttKey()}&bbox=${bbox}&fields=${encodeURIComponent(fields)}&language=en-US&timeValidityFilter=present`;
    const d = await getJSON(u, 15000);
    incidents = (d.incidents || []).map(x => {
      const p = x.properties, g = x.geometry;
      return { id: p.id, cat: p.iconCategory, mag: p.magnitudeOfDelay ?? 0, desc: p.events?.[0]?.description || '',
        from: p.from || '', to: p.to || '', delay: p.delay || 0, roads: (p.roadNumbers || []).join(', '),
        coords: g.type === 'Point' ? [g.coordinates] : g.coordinates };
    });
    incAt = Date.now();
    drawIncidents();
    paintTT();
  } catch (e) { log('[traffic] ' + e.message); }
  finally { incFetching = false; }
}

function incTitle(i) { return (INC_TYPES[i.cat] || INC_TYPES[0])[0]; }
function incPopup(i) {
  return `<b>${(INC_TYPES[i.cat] || INC_TYPES[0])[1]} ${esc(incTitle(i))}</b><br>${esc(i.desc)}<br>
    ${i.roads ? esc(i.roads) + ' · ' : ''}${esc(i.from)}${i.to ? ' → ' + esc(i.to) : ''}<br>
    ${i.delay ? `Delay ${fmtDur(i.delay)}` : ''}${fix ? ' · ' + fmtDist(incDistance(i, fix).d) + ' away' : ''}`;
}

function drawIncidents() {
  incLayer.clearLayers();
  const on = opts.layers.incidents && ttKey();
  if (on) for (const i of incidents) {
    const col = DELAY_COLORS[i.mag] || DELAY_COLORS[0];
    if (i.coords.length > 1) L.polyline(i.coords.map(c => [c[1], c[0]]), { color: col, weight: 5, opacity: 0.8, dashArray: i.cat === 8 ? '6 6' : null })
      .bindPopup(() => incPopup(i)).addTo(incLayer);
    const [lon, lat] = i.coords[Math.floor(i.coords.length / 2)];
    L.marker([lat, lon], { icon: L.divIcon({ className: 'inc-ico', html: (INC_TYPES[i.cat] || INC_TYPES[0])[1], iconSize: [26, 26] }) })
      .bindPopup(() => incPopup(i)).addTo(incLayer);
  }
  drawIncidents3D(on);
}

function incOn3DReady() {
  map3d.addSource('fy-inc', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map3d.addLayer({ id: 'fy-inc-line', type: 'line', source: 'fy-inc', filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-color': ['get', 'color'], 'line-width': 6, 'line-opacity': 0.8 } });
  map3d.addLayer({ id: 'fy-inc-pt', type: 'circle', source: 'fy-inc', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 9, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  map3d.on('click', 'fy-inc-pt', e => {
    const i = incidents.find(x => x.id === e.features[0].properties.id);
    if (i) new maplibregl.Popup({ maxWidth: '260px' }).setLngLat(e.lngLat).setHTML(incPopup(i)).addTo(map3d);
  });
  applyFlow();
  drawIncidents();
}
function drawIncidents3D(on) {
  if (typeof map3dReady === 'undefined' || !map3dReady || !map3d.getSource('fy-inc')) return;
  const feats = [];
  if (on) for (const i of incidents) {
    const color = DELAY_COLORS[i.mag] || DELAY_COLORS[0];
    if (i.coords.length > 1) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: i.coords }, properties: { color } });
    feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: i.coords[Math.floor(i.coords.length / 2)] }, properties: { color, id: i.id } });
  }
  map3d.getSource('fy-inc').setData({ type: 'FeatureCollection', features: feats });
}

// Nearest point of an incident to a position: distance and bearing to it.
function incDistance(i, f) {
  let best = { d: Infinity, pt: null };
  for (const [lon, lat] of i.coords) { const d = distM(f, { lat, lon }); if (d < best.d) best = { d, pt: { lat, lon } }; }
  return best;
}

// ---------------------------------------------------------------- alerts + route delay

const incAlerted = new Map();
const INC_ALERT_GAP_MS = 90000;   // at most one traffic alert per 90 s
let lastIncAlert = 0;

function trafficOnFix(f) {
  if (!ttKey()) return;
  fetchIncidents();
  if (!opts.trafficAlerts || !f || f.acc > 80) return;
  if (Date.now() - lastIncAlert < INC_ALERT_GAP_MS) return;
  // Hundreds of incidents with many points each: check every 3 s, not every fix.
  if (Date.now() - (trafficOnFix.at || 0) < 3000) return;
  trafficOnFix.at = Date.now();
  const moving = f.spd != null && f.spd > 3 && f.hdg != null && !Number.isNaN(f.hdg);
  const onRoute = typeof nav !== 'undefined' && nav ? routeIncidents(nav.rt) : null;
  // Collect everything ahead, then announce only the nearest. A long jam arrives
  // as many short segments; the rest of the same stretch is marked as heard.
  const ahead = [];
  for (const i of incidents) {
    if (incAlerted.has(i.id)) continue;
    if (onRoute) {
      const r = onRoute.find(x => x.i === i);
      if (r && r.at > nav.along && r.at - nav.along < INC_ALERT_M) ahead.push({ i, d: r.at - nav.along });
    } else if (moving) {
      // Off-route, skip minor slowdowns; they are rarely worth a spoken alert.
      if (i.cat === 6 && i.mag <= 1) continue;
      const { d, pt } = incDistance(i, f);
      if (d < INC_ALERT_M && angDiff(bearingDeg(f, pt), f.hdg) < 35) ahead.push({ i, d });
    }
  }
  if (!ahead.length) return;
  ahead.sort((a, b) => a.d - b.d);
  const { i, d } = ahead[0];
  // Everything else ahead of the same kind on the same road counts as this alert.
  const sameStretch = ahead.filter(x => x.i.cat === i.cat && (x.i.roads === i.roads || x.i.from === i.from));
  for (const x of sameStretch) incAlerted.set(x.i.id, Date.now());
  const totalDelay = sameStretch.reduce((s, x) => s + (x.i.delay || 0), 0);
  lastIncAlert = Date.now();
  const what = incTitle(i);
  const delay = totalDelay >= 60 ? `, ${fmtDur(totalDelay)} delay` : '';
  toast(`${(INC_TYPES[i.cat] || INC_TYPES[0])[1]} ${what} ahead · ${fmtDist(d)}${delay}`, i.mag >= 2 || i.cat === 1 || i.cat === 8);
  if (!opts.muted) playSound('warble');
  announce('traffic', `${what} reported ahead in ${fmtDist(d)}${delay}`,
    { title: `${what} ahead`, body: `${i.desc} · ${fmtDist(d)}${delay}`, tag: 'fy-inc-' + i.id });
}

// Incidents lying on a route, with their position along it.
let routeIncCache = { rt: null, at: 0, list: [] };
function routeIncidents(rt) {
  if (routeIncCache.rt === rt && routeIncCache.at === incAt) return routeIncCache.list;
  const list = [];
  for (const i of incidents) {
    // Count an incident only if most of it runs along the route; a jam on a
    // cross street touches the route at one intersection and must not count.
    let bestAt = null, near = 0;
    for (const [lon, lat] of i.coords) {
      const q = rt.P(lat, lon);
      let hit = false;
      for (let k = 0; k < rt.xy.length - 1; k += 2) {
        const b = Math.min(k + 2, rt.xy.length - 1);
        const [d, t] = segDist(q, rt.xy[k], rt.xy[b]);
        if (d < 25) { hit = true; const at = rt.cum[k] + t * (rt.cum[b] - rt.cum[k]); if (bestAt == null || at < bestAt) bestAt = at; }
      }
      if (hit) near++;
    }
    const along = i.coords.length === 1 ? near === 1 : near >= 2 && near / i.coords.length >= 0.6;
    if (along) list.push({ i, at: bestAt });
  }
  routeIncCache = { rt, at: incAt, list };
  return list;
}
// Seconds of reported delay still ahead on a route (used for the ETA).
function routeDelayAhead(rt, along = 0) {
  if (!ttKey()) return 0;
  return routeIncidents(rt).filter(x => x.at > along).reduce((s, x) => s + (x.i.delay || 0), 0);
}

// ---------------------------------------------------------------- speed limits (for speed.js)

const ttLimits = new Map();   // wayId -> {v, est:false, src}
const ttMisses = new Map();   // wayId -> {n, next}: TomTom answers vary by exact point, so retry a few times
let ttLastLookup = 0;
function ttLimitFor(w) { return ttLimits.get(w.id) || null; }
function ttBudgetOk() {
  const day = new Date().toISOString().slice(0, 10);
  let b; try { b = JSON.parse(localStorage.getItem('fy.ttbudget')) || {}; } catch { b = {}; }
  if (b.day !== day) b = { day, n: 0 };
  if (b.n >= TT_DAILY_LOOKUPS) return false;
  b.n++; try { localStorage.setItem('fy.ttbudget', JSON.stringify(b)); } catch {}
  return true;
}
async function ttMaybeLookup(f, w) {
  if (!ttKey() || !navigator.onLine || parseMax(w.max) || ttLimits.has(w.id)) return;
  const miss = ttMisses.get(w.id);
  if (miss && (miss.n >= 3 || Date.now() < miss.next)) return;
  if (Date.now() - ttLastLookup < 8000 || !ttBudgetOk()) return;
  ttLastLookup = Date.now();
  ttMisses.set(w.id, { n: (miss?.n || 0) + 1, next: Date.now() + 20000 });
  try {
    const hdg = f.hdg != null && !Number.isNaN(f.hdg) ? `&heading=${Math.round(f.hdg)}` : '';
    const d = await getJSON(`${TT}/search/2/reverseGeocode/${f.lat.toFixed(6)},${f.lon.toFixed(6)}.json?key=${ttKey()}&returnSpeedLimit=true&radius=40${hdg}`, 8000);
    const s = d.addresses?.[0]?.address?.speedLimit;          // e.g. "35.00MPH" / "50.00KPH"
    const m = s && s.match(/([\d.]+)\s*(MPH|KPH|KMH)/i);
    if (m) {
      const n = Number(m[1]), mph = /MPH/i.test(m[2]);
      const v = opts.units === 'metric' ? Math.round(mph ? n * 1.60934 : n) : Math.round(mph ? n : n / 1.60934);
      ttLimits.set(w.id, { v, est: false, src: 'TomTom' });
    }
  } catch {}
}

// ---------------------------------------------------------------- UI

(function buildTrafficUi() {
  const panel = $('lyrPanel');
  panel.querySelector('.small0').insertAdjacentHTML('beforebegin', `
    <label class="lyr-row tt-only"><input type="checkbox" data-tt="flow"><span class="sw8" style="background:linear-gradient(90deg,#3fb950,#ffd60a,#ff3b30)"></span>Live traffic</label>
    <label class="lyr-row tt-only"><input type="checkbox" data-tt="incidents"><span class="sw8" style="background:#ff9500"></span>Accidents &amp; closures<span class="cnt" id="incCount">0</span></label>`);
  panel.querySelectorAll('[data-tt]').forEach(cb => {
    cb.checked = opts.layers[cb.dataset.tt] !== false;
    cb.onchange = () => { opts.layers[cb.dataset.tt] = cb.checked; saveOpts(); applyFlow(); drawIncidents(); };
  });

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h2>Traffic</h2>
    <p class="mute" id="ttStatus"></p>
    <label class="sw"><input type="checkbox" id="optTrafficAlerts"> Alert for accidents, jams &amp; closures ahead</label>
    <label class="sw">TomTom API key <input type="password" id="optTTKey" placeholder="${window.FY_LOCAL?.tomtomKey ? 'set in config file' : 'paste key'}" autocomplete="off" style="max-width:55%"></label>
    <button id="bTTRefresh">Refresh traffic now</button>
    <p class="mute small1">Live traffic, incidents and extra speed limits © TomTom. Free developer keys include a daily allowance.</p>`;
  $('slot-traffic').append(card);
  bindOpt('optTrafficAlerts', 'trafficAlerts');
  $('optTTKey').value = opts.tomtomKey;
  $('optTTKey').onchange = e => { opts.tomtomKey = e.target.value.trim(); saveOpts(); paintTT(); applyFlow(); fetchIncidents(true); };
  $('bTTRefresh').onclick = () => fetchIncidents(true).then(() => toast(`${incidents.length} traffic incidents nearby`));
  paintTT();
  applyFlow();
  setTimeout(() => fetchIncidents(true), 1500);
  map.on('moveend', () => { if (!fix) fetchIncidents(); });
  setInterval(() => { fetchIncidents(); paintTT(); }, 30000);
})();

// Dark traffic colours to match the night map.
$('optNight').addEventListener('change', applyFlow);

function paintTT() {
  const has = !!ttKey();
  document.querySelectorAll('.tt-only').forEach(el => { el.style.display = has ? '' : 'none'; });
  const c = $('incCount'); if (c) c.textContent = incidents.length;
  $('ttStatus').textContent = !has ? 'Add a TomTom key to turn on live traffic.'
    : `On · ${incidents.length} incidents within ${fmtDist(INC_BOX_KM * 1000)}${incAt ? ' · updated ' + ago(incAt) : ''}`;
}
