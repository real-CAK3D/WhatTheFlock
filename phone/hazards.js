'use strict';
// Shared hazard & police reports (Waze-style) between your phones, through the
// small server on the PC (reports/reports_server.py, /reports on Tailscale).
//   - Report police, accident, hazard, object on road, pothole, construction,
//     closure, speed camera or Flock camera with one tap (Quick actions ⚡)
//   - See everyone's reports on the map; spoken warning when one is ahead
//   - "Still there?" when you pass one: 👍 keeps it, 👎 removes it faster
//   - Reports made with no signal are queued and sent later
// Loaded after weather.js.

const REPORTS_URL = '/reports/';
const HZ_POLL_MS = 60000;
const HZ_BOX_KM = 30;
const HZ_WARN_M = 1600;
const HZ_TYPES = {
  police:       { label: 'Police',           emoji: '🚓' },
  accident:     { label: 'Accident',         emoji: '💥' },
  hazard:       { label: 'Hazard',           emoji: '⚠️' },
  object:       { label: 'Object on road',   emoji: '🪨' },
  pothole:      { label: 'Pothole',          emoji: '🕳️' },
  construction: { label: 'Construction',     emoji: '🚧' },
  closure:      { label: 'Road closed',      emoji: '⛔' },
  weather:      { label: 'Bad road weather', emoji: '🧊' },
  camera:       { label: 'Speed camera',     emoji: '📸' },
  flock:        { label: 'Flock camera',     emoji: '📷' },
};

let hzReports = [], hzAt = 0, hzCenter = null;
let devId = localStorage.getItem('fy.dev') || Math.random().toString(36).slice(2, 10);
try { localStorage.setItem('fy.dev', devId); } catch {}
let hzQueue = [];
try { hzQueue = JSON.parse(localStorage.getItem('fy.hzq')) || []; } catch {}
const saveQueue = () => { try { localStorage.setItem('fy.hzq', JSON.stringify(hzQueue)); } catch {} };

// ---------------------------------------------------------------- server

async function hzFetch(force = false) {
  if (!navigator.onLine) return;
  const c = fix || biasLL();
  const moved = !hzCenter || distM(hzCenter, c) > HZ_BOX_KM * 300;
  if (!force && !moved && Date.now() - hzAt < HZ_POLL_MS) return;
  hzCenter = { lat: c.lat, lon: c.lon };
  const dLat = HZ_BOX_KM / 111, dLon = dLat / Math.cos(c.lat * Math.PI / 180);
  try {
    const d = await getJSON(`${REPORTS_URL}?bbox=${(c.lat - dLat).toFixed(4)},${(c.lon - dLon).toFixed(4)},${(c.lat + dLat).toFixed(4)},${(c.lon + dLon).toFixed(4)}`, 10000);
    hzReports = d.reports || [];
    hzAt = Date.now();
    drawHazards();
  } catch {}
  flushQueue();
}

async function hzPost(path, body) {
  const r = await fetch(REPORTS_URL + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function flushQueue() {
  if (!navigator.onLine || !hzQueue.length) return;
  const q = hzQueue; hzQueue = []; saveQueue();
  for (const item of q) {
    try { await hzPost(item.path, item.body); } catch { hzQueue.push(item); }
  }
  saveQueue();
  if (!hzQueue.length && q.length) { toast(`Sent ${q.length} queued report${q.length === 1 ? '' : 's'}`); hzFetch(true); }
}
window.addEventListener('online', flushQueue);

async function reportHazard(type) {
  if (!fix) { toast('Waiting for GPS'); return; }
  const t = HZ_TYPES[type];
  // Put the report a little ahead of you when moving (you tap after passing it… or just before).
  const body = { type, lat: +fix.lat.toFixed(6), lon: +fix.lon.toFixed(6), dev: devId };
  try {
    if (!navigator.onLine) throw new Error('offline');
    const r = await hzPost('', body);
    toast(`${t.emoji} ${t.label} reported${r.merged ? ' (confirmed an existing report)' : ''}`);
    hzFetch(true);
  } catch {
    hzQueue.push({ path: '', body }); saveQueue();
    toast(`${t.emoji} ${t.label} saved — will send when there's signal`);
  }
  if (typeof playSound === 'function') playSound('blip');
}

async function voteHazard(id, up) {
  try { await hzPost(`${id}/vote`, { up, dev: devId }); }
  catch { hzQueue.push({ path: `${id}/vote`, body: { up, dev: devId } }); saveQueue(); }
  hzVoted.add(id);
  hzFetch(true);
}

// ---------------------------------------------------------------- map

const hzLayer = L.layerGroup().addTo(map);
opts.layers.hazards = opts.layers.hazards ?? true;

function hzPopup(r) {
  const t = HZ_TYPES[r.type] || { label: r.type, emoji: '⚠️' };
  return `<b>${t.emoji} ${t.label}</b><br><span class="mute">reported ${ago(r.ts * 1000)}${r.up ? ` · ${r.up} confirmed` : ''}${fix ? ' · ' + fmtDist(distM(fix, r)) + ' away' : ''}</span>
    ${r.note ? '<br>' + esc(r.note) : ''}
    <div class="pp-acts"><button onclick="voteHazard('${r.id}', true)">👍 Still there</button><button onclick="voteHazard('${r.id}', false)">👎 Gone</button></div>`;
}
function drawHazards() {
  hzLayer.clearLayers();
  if (opts.layers.hazards === false) { drawHazards3D([]); return; }
  for (const r of hzReports) {
    const t = HZ_TYPES[r.type] || { emoji: '⚠️' };
    L.marker([r.lat, r.lon], { icon: L.divIcon({ className: 'hz-ico', html: t.emoji, iconSize: [30, 30] }), zIndexOffset: 500 })
      .bindPopup(() => hzPopup(r), { maxWidth: 240 }).addTo(hzLayer);
  }
  drawHazards3D(hzReports);
}
function hazardsOn3DReady() {
  map3d.addSource('fy-hz', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map3d.addLayer({ id: 'fy-hz', type: 'circle', source: 'fy-hz',
    paint: { 'circle-radius': 10, 'circle-color': '#ff9f0a', 'circle-stroke-color': '#000', 'circle-stroke-width': 2 } });
  map3d.on('click', 'fy-hz', e => {
    const r = hzReports.find(x => x.id === e.features[0].properties.id);
    if (r) new maplibregl.Popup({ maxWidth: '240px' }).setLngLat(e.lngLat).setHTML(hzPopup(r)).addTo(map3d);
  });
  drawHazards3D(hzReports);
}
function drawHazards3D(list) {
  if (typeof map3dReady === 'undefined' || !map3dReady || !map3d.getSource('fy-hz')) return;
  map3d.getSource('fy-hz').setData({ type: 'FeatureCollection', features: (opts.layers.hazards === false ? [] : list).map(r => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] }, properties: { id: r.id } })) });
}

// ---------------------------------------------------------------- warnings + "still there?"

const hzWarned = new Set(), hzAsked = new Set(), hzVoted = new Set();
function hazardsOnFix(f) {
  hzFetch();
  if (!f || f.acc > 60 || !hzReports.length) return;
  const moving = f.spd > 3 && f.hdg != null && !Number.isNaN(f.hdg);
  for (const r of hzReports) {
    if (r.dev === devId) continue;
    const d = distM(f, r);
    // Warn once when it's ahead.
    if (!hzWarned.has(r.id) && d < HZ_WARN_M && (!moving || angDiff(bearingDeg(f, r), f.hdg) < 40)) {
      hzWarned.add(r.id);
      const t = HZ_TYPES[r.type] || { label: 'Hazard', emoji: '⚠️' };
      toast(`${t.emoji} ${t.label} reported ahead · ${fmtDist(d)}`, true);
      announce('hazards', `${t.label} reported ahead, ${fmtDist(d)}`, { title: `${t.emoji} ${t.label} ahead`, body: `Reported ${ago(r.ts * 1000)}`, tag: 'fy-hz-' + r.id });
    }
    // Just passed it: ask if it's still there.
    if (!hzAsked.has(r.id) && !hzVoted.has(r.id) && d < 120) { hzAsked.add(r.id); askStillThere(r); }
  }
}
function askStillThere(r) {
  const t = HZ_TYPES[r.type] || { label: 'Hazard', emoji: '⚠️' };
  const el = $('hzAsk');
  el.innerHTML = `<span>${t.emoji} ${t.label} still there?</span><button data-v="1">👍</button><button data-v="0">👎</button>`;
  el.hidden = false;
  el.onclick = e => { const b = e.target.closest('[data-v]'); if (!b) return; voteHazard(r.id, b.dataset.v === '1'); el.hidden = true; };
  clearTimeout(askStillThere.t);
  askStillThere.t = setTimeout(() => { el.hidden = true; }, 15000);
}

(function buildHazardUi() {
  $('tab-map').insertAdjacentHTML('beforeend', '<div id="hzAsk" hidden></div>');
  // ☰ panel toggle.
  $('lyrPanel').querySelector('.lyr-sub').insertAdjacentHTML('beforebegin',
    `<label class="lyr-row"><input type="checkbox" id="lyrHz" ${opts.layers.hazards !== false ? 'checked' : ''}><span class="sw8" style="background:#ff9f0a"></span>Hazard &amp; police reports</label>`);
  $('lyrHz').onchange = e => { opts.layers.hazards = e.target.checked; saveOpts(); drawHazards(); };
  map.on('moveend', () => { if (!fix) hzFetch(); });
  setTimeout(() => hzFetch(true), 2000);
})();
