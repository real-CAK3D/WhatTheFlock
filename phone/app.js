'use strict';
// Flock You Mobile — reads the XIAO ESP32-S3 over WebUSB (CDC-ACM), tags each
// detection with this phone's GPS, and keeps everything in localStorage.
// Wire protocol (see ../main.cpp): one JSON object per line.
//   device -> phone: {"event":"detection",...}, {"event":"config",...},
//                    {"event":"session_begin|session_det|session_end",...}
//   phone -> device: {"cmd":"get_config"}, {"cmd":"set_beep","tier":N,"on":0|1},
//                    {"cmd":"dump_session","source":"live|prev"}

const ESPRESSIF_VID = 0x303a;
const MAX_HITS = 10000;
const MAX_TRACK = 5000;
const GPS_STALE_MS = 30000;
const STORE_KEY = 'fy.data.v1';
const OPT_KEY = 'fy.opts.v1';
const TIER_NAMES = {
  4: 'IE fingerprint', 3: 'wildcard probe', 2: 'transmitter OUI / BLE',
  1: 'addr1/BSSID OUI', 0: 'SSID keyword',
};

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const fmtTime = ts => ts ? new Date(ts).toLocaleString() : '—';
const ago = ts => {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
};
const tierColor = t => getComputedStyle(document.documentElement).getPropertyValue('--t' + (t ?? 0)).trim();
// Distances are stored in metres; shown in feet/miles unless the user picks metric.
function fmtDist(m) {
  if (m == null || Number.isNaN(m)) return '—';
  if (opts.units === 'metric') return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
  const ft = m * 3.28084;
  return ft < 1000 ? Math.round(ft / 10) * 10 + ' ft' : (m / 1609.34).toFixed(m < 16093 ? 1 : 0) + ' mi';
}

// ---------------------------------------------------------------- storage

let data = { devices: {}, hits: [], track: [] };
let opts = { wake: true, vibe: true, track: true, minTier: 0, sort: 'last', follow: true,
  units: 'imperial', showIgnored: false, night: false, autoPull: false, shareExports: false };
// This app session (since the page opened) for the trip card.
const trip = { start: Date.now(), dist: 0, newCams: 0, hits: 0, mappedPassed: 0, lastPt: null };

function load() {
  try { const d = JSON.parse(localStorage.getItem(STORE_KEY)); if (d && d.devices) data = { devices: {}, hits: [], track: [], ...d }; } catch {}
  try { opts = { ...opts, ...JSON.parse(localStorage.getItem(OPT_KEY)) }; } catch {}
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); }
    catch (e) {
      // Quota: drop the oldest half of the raw hit log and route, keep devices.
      data.hits = data.hits.slice(-Math.floor(MAX_HITS / 2));
      data.track = data.track.slice(-Math.floor(MAX_TRACK / 2));
      try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch {}
      toast('Phone storage full — trimmed old hits');
    }
    updateStoreInfo();
  }, 800);
}
function saveOpts() { try { localStorage.setItem(OPT_KEY, JSON.stringify(opts)); } catch {} }

// ---------------------------------------------------------------- UI helpers

let toastTimer = null;
function toast(msg, alert = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (alert ? ' alert' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, alert ? 4000 : 2500);
}

const logEl = $('log');
let logLines = [];
function log(line, isDet = false) {
  logLines.push({ line, isDet });
  if (logLines.length > 600) logLines = logLines.slice(-400);
  if (document.querySelector('#tab-log.active')) renderLog();
}
function renderLog() {
  const d = $('logDet').checked, o = $('logOther').checked;
  logEl.textContent = logLines.filter(l => l.isDet ? d : o).map(l => l.line).join('\n');
  logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
}

function setStat(id, state, text) {
  const el = $(id);
  el.classList.toggle('on', state === 'on');
  el.classList.toggle('stale', state === 'stale');
  el.querySelector('.val').textContent = text;
}

function updateCounts() {
  const devs = visibleDevices();
  $('nDev').textContent = devs.length;
  $('nHits').textContent = data.hits.length;
}

function updateStoreInfo() {
  const n = Object.keys(data.devices).length;
  let kb = 0;
  try { kb = Math.round((localStorage.getItem(STORE_KEY) || '').length / 1024); } catch {}
  $('storeInfo').textContent = `${n} cameras, ${data.hits.length} hits, ${data.track.length} route points stored (${kb} KB).`;
}

// ---------------------------------------------------------------- GPS

let fix = null; // {lat, lon, acc, ts}
function startGps() {
  if (!('geolocation' in navigator)) { setStat('gpsStat', 'off', 'none'); return; }
  navigator.geolocation.watchPosition(p => {
    if (window.fyDemo) return;   // a demo drive (codriver.js) is feeding positions
    fix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy), ts: Date.now(),
      spd: p.coords.speed, hdg: p.coords.heading, alt: p.coords.altitude };
    setStat('gpsStat', 'on', '±' + fix.acc + 'm');
    onFix();
  }, e => {
    setStat('gpsStat', 'off', e.code === 1 ? 'denied' : 'no fix');
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  setInterval(() => {
    if (fix && Date.now() - fix.ts > GPS_STALE_MS) setStat('gpsStat', 'stale', 'stale');
  }, 5000);
}
function currentFix() {
  return fix && Date.now() - fix.ts <= GPS_STALE_MS ? fix : null;
}

function distM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function onFix() {
  if (fix.acc <= 50) {
    if (trip.lastPt) { const d = distM(trip.lastPt, fix); if (d >= 10) { trip.dist += d; trip.lastPt = fix; } }
    else trip.lastPt = fix;
  }
  if (opts.track && fix.acc <= 50) {
    const last = data.track[data.track.length - 1];
    if (!last || distM(last, fix) >= 15) {
      data.track.push({ lat: +fix.lat.toFixed(6), lon: +fix.lon.toFixed(6), ts: fix.ts });
      if (data.track.length > MAX_TRACK) data.track.splice(0, data.track.length - MAX_TRACK);
      routeLine && routeLine.addLatLng([fix.lat, fix.lon]);
      save();
    }
  }
  if (map) {
    const ll = [fix.lat, fix.lon];
    if (!meMarker) {
      meMarker = L.circleMarker(ll, { radius: 7, color: '#fff', weight: 2, fillColor: '#58a6ff', fillOpacity: 1 }).addTo(map);
      meAcc = L.circle(ll, { radius: fix.acc, color: '#58a6ff', weight: 1, fillOpacity: 0.08 }).addTo(map);
      map.setView(ll, 16);
    } else {
      meMarker.setLatLng(ll); meAcc.setLatLng(ll).setRadius(fix.acc);
      if (opts.follow) map.panTo(ll, { animate: true });
    }
  }
  if (typeof layersOnFix === 'function') layersOnFix(fix);
  if (typeof navOnFix === 'function') navOnFix(fix);
  if (typeof speedOnFix === 'function') speedOnFix(fix);
  if (typeof trafficOnFix === 'function') trafficOnFix(fix);
  if (typeof codriverOnFix === 'function') codriverOnFix(fix);
  if (typeof drivesOnFix === 'function') drivesOnFix(fix);
  if (typeof announceOnFix === 'function') announceOnFix(fix);
  if (typeof weatherOnFix === 'function') weatherOnFix(fix);
  if (typeof hazardsOnFix === 'function') hazardsOnFix(fix);
  mapChanged();
  if (typeof follow3D === 'function') follow3D();
}

// Tell the 3D view (map3d.js, if loaded) that something it mirrors changed.
function mapChanged() {
  if (typeof sync3D === 'function') sync3D();
}

// ---------------------------------------------------------------- detections

function ingestDetection(ev, source = 'live') {
  const mac = (ev.mac_address || ev.mac || '').toLowerCase();
  if (!mac) return;
  const now = Date.now();
  const tier = Number(ev.detection_tier ?? ev.tier ?? 0);
  const method = ev.detection_method || ev.method || 'unknown';
  const rssi = Number(ev.rssi ?? -127);
  const loc = source === 'live' ? currentFix() : null;

  let d = data.devices[mac];
  const isNew = !d;
  if (!d) {
    d = data.devices[mac] = {
      mac, oui: ev.oui || mac.slice(0, 8), tier, method, methods: {}, hits: 0,
      first: now, last: now, bestRssi: -127, bestLoc: null, lastLoc: null,
      ssid: '', name: '', protocol: ev.protocol || '', source,
    };
  }
  // Re-pulling the same board session must not inflate counts.
  if (source !== 'live' && !isNew) { save(); return; }
  d.hits += source === 'live' ? 1 : Number(ev.count || 1);
  d.methods[method] = (d.methods[method] || 0) + (source === 'live' ? 1 : Number(ev.count || 1));
  if (tier > d.tier || (tier === d.tier && d.method === 'unknown')) { d.tier = tier; d.method = method; }
  d.last = now;
  if (ev.ssid) d.ssid = ev.ssid;
  if (ev.device_name) d.name = ev.device_name;
  if (ev.protocol) d.protocol = ev.protocol;
  if (loc) {
    d.lastLoc = { lat: loc.lat, lon: loc.lon, acc: loc.acc, ts: now };
    // Best-signal position is the closest estimate of where the camera actually is.
    if (!d.bestLoc || rssi > d.bestRssi) d.bestLoc = { lat: loc.lat, lon: loc.lon, acc: loc.acc, ts: now, rssi };
  }
  if (rssi > d.bestRssi) d.bestRssi = rssi;

  if (source === 'live') {
    data.hits.push({
      ts: now, mac, method, tier, rssi, ch: ev.channel ?? null,
      lat: loc ? +loc.lat.toFixed(6) : null, lon: loc ? +loc.lon.toFixed(6) : null, acc: loc ? loc.acc : null,
    });
    if (data.hits.length > MAX_HITS) data.hits.splice(0, data.hits.length - MAX_HITS);
  }

  save();
  if (source === 'live') { trip.hits++; if (isNew) trip.newCams++; }
  if (source === 'live' && typeof findOnHit === 'function') findOnHit(mac, rssi);
  if (tier >= opts.minTier) {
    updateMarker(d);
    if (source === 'live' && d.status !== 'false') {
      // sounds.js owns alert sound/voice/vibration/notification; fall back to a toast.
      if (typeof onDetectionAlert === 'function') onDetectionAlert(d, isNew, tier, rssi);
      else if (isNew) toast(`New camera · tier ${tier} · ${mac}`, tier >= 3);
    }
  }
  updateCounts();
  scheduleListRender();
  mapChanged();
}

function visibleDevices() {
  return Object.values(data.devices).filter(d => d.tier >= opts.minTier && (opts.showIgnored || d.status !== 'false'));
}

// Nearest crowd-mapped plate reader (DeFlock/OSM, from layers.js) to a detection.
const DEFLOCK_MATCH_M = 150;
function nearestMapped(d) {
  if (!d.bestLoc || typeof allItems !== 'function') return null;
  let best = null;
  for (const p of allItems()) {
    if (p.kind !== 'alpr') continue;
    const m = distM(d.bestLoc, p);
    if (!best || m < best.m) best = { m, p };
  }
  return best;
}
function mappedBadge(d) {
  const n = nearestMapped(d);
  if (!d.bestLoc) return '';
  if (n && n.m <= DEFLOCK_MATCH_M) return `<span class="ok">On DeFlock map (${fmtDist(n.m)})</span>`;
  return `<span class="warn">Not on DeFlock map</span> · <a href="https://deflock.me" target="_blank" rel="noopener">report</a>`;
}

// ---------------------------------------------------------------- map

let map = null, meMarker = null, meAcc = null, routeLine = null, baseLayer = null;
const markers = {};

function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView([39.5, -98.35], 4);
  baseLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, zIndex: 1, attribution: '© OpenStreetMap',
  }).addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);
  routeLine = L.polyline(data.track.map(p => [p.lat, p.lon]), { color: '#58a6ff', weight: 3, opacity: 0.6 }).addTo(map);
  map.on('dragstart', () => setFollow(false));
  // Folding/unfolding the phone or rotating it resizes the viewport.
  window.addEventListener('resize', () => map.invalidateSize());
  for (const d of visibleDevices()) updateMarker(d);
  const pts = visibleDevices().filter(d => d.bestLoc).map(d => [d.bestLoc.lat, d.bestLoc.lon]);
  if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 16 });
}

function popupHtml(d) {
  const m = Object.entries(d.methods).map(([k, v]) => `${esc(k)} ×${v}`).join('<br>');
  return `<b>Tier ${d.tier}</b> · ${esc(TIER_NAMES[d.tier] || '')}<br>
    <code>${esc(d.mac)}</code><br>
    ${d.ssid ? 'SSID: ' + esc(d.ssid) + '<br>' : ''}${d.name ? 'Name: ' + esc(d.name) + '<br>' : ''}
    Best signal ${d.bestRssi} dBm · ${d.hits} hits<br>
    Last seen ${esc(ago(d.last))}${fix && d.bestLoc ? ' · ' + fmtDist(distM(fix, d.bestLoc)) + ' away' : ''}<br>
    ${d.status === 'confirmed' ? '<b class="ok">✓ Seen in person</b><br>' : d.status === 'false' ? '<b class="warn">Marked false positive</b><br>' : ''}
    ${d.note ? '📝 ' + esc(d.note) + '<br>' : ''}
    ${mappedBadge(d)}<br>
    <span style="color:#888">${m}</span>`;
}

function updateMarker(d) {
  if (!map || !d.bestLoc || opts.layers?.det === false) return;
  const ll = [d.bestLoc.lat, d.bestLoc.lon];
  let mk = markers[d.mac];
  const style = { radius: 9, color: '#000', weight: 1.5, fillColor: tierColor(d.tier), fillOpacity: 0.9 };
  if (!mk) {
    mk = markers[d.mac] = L.circleMarker(ll, style).addTo(map);
    mk.bindPopup(() => popupHtml(data.devices[d.mac]));
  } else {
    mk.setLatLng(ll).setStyle(style);
  }
  if (d.tier >= 3) mk.bringToFront();
}

function redrawMarkers() {
  for (const k in markers) { markers[k].remove(); delete markers[k]; }
  for (const d of visibleDevices()) updateMarker(d);
  mapChanged();
}

function setFollow(on) {
  opts.follow = on; saveOpts();
  $('bFollow').classList.toggle('on', on);
  if (on && fix && map) map.panTo([fix.lat, fix.lon]);
  if (on && typeof follow3D === 'function') follow3D();
}

// ---------------------------------------------------------------- list

let listTimer = null;
function scheduleListRender() {
  clearTimeout(listTimer);
  listTimer = setTimeout(() => { if (document.querySelector('#tab-list.active')) renderList(); }, 300);
}
function renderList() {
  const s = opts.sort;
  const devs = visibleDevices().sort((a, b) =>
    s === 'tier' ? (b.tier - a.tier) || (b.last - a.last) :
    s === 'rssi' ? b.bestRssi - a.bestRssi :
    s === 'hits' ? b.hits - a.hits : b.last - a.last);
  renderTrip();
  if (!devs.length) { $('devList').innerHTML = '<p class="mute" style="padding:16px">No cameras yet.</p>'; return; }
  $('devList').innerHTML = devs.map(d => {
    const mac = esc(d.mac);
    return `
    <div class="dev${d.status === 'false' ? ' ignored' : ''}">
      <div class="tier t${d.tier}">${d.tier}</div>
      <div class="body">
        <div class="mac">${mac}${d.status === 'confirmed' ? ' <span class="ok">✓</span>' : ''}</div>
        <div class="meta">${esc(TIER_NAMES[d.tier] || d.method)} · ${d.bestRssi} dBm · ${d.hits} hits · ${esc(ago(d.last))}${d.source !== 'live' ? ' · from board' : ''}${fix && d.bestLoc ? ' · ' + fmtDist(distM(fix, d.bestLoc)) : ''}</div>
        ${d.ssid || d.name ? `<div class="meta">${esc(d.ssid || d.name)}</div>` : ''}
        ${d.note ? `<div class="meta">📝 ${esc(d.note)}</div>` : ''}
        <div class="methods">${Object.entries(d.methods).map(([k, v]) => `${esc(k)} ×${v}`).join(' · ')}</div>
        <div class="methods">${mappedBadge(d)}</div>
        <div class="acts">
          ${d.bestLoc ? `<button data-act="map" data-mac="${mac}">Map</button>` : ''}
          <button data-act="find" data-mac="${mac}">Find</button>
          <button data-act="ok" data-mac="${mac}" class="${d.status === 'confirmed' ? 'sel' : ''}">✓ Seen</button>
          <button data-act="false" data-mac="${mac}" class="${d.status === 'false' ? 'sel' : ''}">✗ False +</button>
          <button data-act="note" data-mac="${mac}">Note</button>
        </div>
      </div>
    </div>`;
  }).join('');
}
$('devList').addEventListener('click', e => {
  const { act, mac } = e.target.dataset || {};
  if (!act || !mac) return;
  const d = data.devices[mac];
  if (act === 'map') {
    showTab('map');
    setFollow(false);
    if (typeof map3dActive === 'function' && map3dActive()) map3d.flyTo({ center: [d.bestLoc.lon, d.bestLoc.lat], zoom: 17.5 });
    else { map.setView([d.bestLoc.lat, d.bestLoc.lon], 18); markers[mac] && markers[mac].openPopup(); }
  } else if (act === 'find') {
    if (typeof openFinder === 'function') openFinder(mac);
  } else if (act === 'ok' || act === 'false') {
    const s = act === 'ok' ? 'confirmed' : 'false';
    d.status = d.status === s ? '' : s;
    save(); redrawMarkers(); updateCounts(); renderList();
  } else if (act === 'note') {
    const n = prompt('Note for ' + mac, d.note || '');
    if (n !== null) { d.note = n.trim(); save(); renderList(); }
  }
});

function renderTrip() {
  const mins = Math.round((Date.now() - trip.start) / 60000);
  const all = Object.values(data.devices);
  $('trip').innerHTML = `
    <div><b>${fmtDist(trip.dist)}</b><span>driven</span></div>
    <div><b>${trip.newCams}</b><span>new cams</span></div>
    <div><b>${trip.hits}</b><span>hits</span></div>
    <div><b>${mins < 60 ? mins + 'm' : (mins / 60).toFixed(1) + 'h'}</b><span>session</span></div>
    <div><b>${all.length}</b><span>all-time</span></div>
    <div><b>${all.filter(d => d.tier >= 3).length}</b><span>tier 3–4</span></div>`;
}

// ---------------------------------------------------------------- beep config

let beepMask = null;
function renderBeeps(cfg) {
  beepMask = cfg.beep_mask;
  $('beeps').innerHTML = (cfg.tiers || []).slice().reverse().map(t => `
    <label class="beep"><input type="checkbox" data-tier="${t.tier}" ${t.beep ? 'checked' : ''}>
      <span class="tier t${t.tier}" style="width:24px;height:24px;border-radius:6px;display:grid;place-items:center;color:#000;font-weight:700">${t.tier}</span>
      <span>${esc(TIER_NAMES[t.tier] || t.method)}</span></label>`).join('');
}
$('beeps').addEventListener('change', e => {
  const t = e.target.dataset.tier;
  if (t === undefined) return;
  send({ cmd: 'set_beep', tier: Number(t), on: e.target.checked ? 1 : 0 });
});

// ---------------------------------------------------------------- USB link

let dev = null, epIn = 1, epOut = 1, reading = false, lineBuf = '', dumpCount = 0;
const dec = new TextDecoder(), enc = new TextEncoder();

async function openDevice(d) {
  if (dev) return;
  try {
    await d.open();
    if (!d.configuration) await d.selectConfiguration(1);
    let ctrlIf = null, dataIf = null;
    for (const itf of d.configuration.interfaces) {
      const alt = itf.alternates[0];
      if (alt.interfaceClass === 0x02 && ctrlIf === null) ctrlIf = itf.interfaceNumber;
      if (alt.interfaceClass === 0x0a && dataIf === null) {
        dataIf = itf.interfaceNumber;
        for (const ep of alt.endpoints) {
          if (ep.type === 'bulk' && ep.direction === 'in') epIn = ep.endpointNumber;
          if (ep.type === 'bulk' && ep.direction === 'out') epOut = ep.endpointNumber;
        }
      }
    }
    if (dataIf === null) throw new Error('no CDC data interface on this device');
    if (ctrlIf !== null) await d.claimInterface(ctrlIf);
    await d.claimInterface(dataIf);
    const ctl = { requestType: 'class', recipient: 'interface', index: ctrlIf ?? dataIf };
    const lc = new DataView(new ArrayBuffer(7));
    lc.setUint32(0, 115200, true); lc.setUint8(6, 8);
    try { await d.controlTransferOut({ ...ctl, request: 0x20, value: 0 }, lc.buffer); } catch {}
    // DTR on, RTS off. Other DTR/RTS combinations drive the S3's reset/boot lines.
    try { await d.controlTransferOut({ ...ctl, request: 0x22, value: 0x01 }); } catch {}
    dev = d;
    setStat('usbStat', 'on', 'on');
    $('bConnect').textContent = 'Disconnect';
    log('[usb] connected');
    requestWake();
    readLoop();
    if (typeof playEvent === 'function') playEvent('usb');
    setTimeout(() => send({ cmd: 'get_config' }), 300);
    // The board keeps what it found while unplugged; pull it in without a tap.
    if (opts.autoPull) setTimeout(() => send({ cmd: 'dump_session', source: 'prev' }), 1200);
    // Give the board the time (for its SD log) and check its SD card.
    if (typeof sdOnConnect === 'function') setTimeout(sdOnConnect, 700);
  } catch (e) {
    log('[usb] open failed: ' + e.message);
    toast('USB: ' + e.message);
    try { await d.close(); } catch {}
  }
}

async function readLoop() {
  reading = true;
  while (dev && reading) {
    try {
      const r = await dev.transferIn(epIn, 512);
      if (r.data && r.data.byteLength) onText(dec.decode(r.data, { stream: true }));
    } catch (e) {
      log('[usb] read stopped: ' + e.message);
      break;
    }
  }
  closed();
}

function closed() {
  reading = false;
  if (dev && typeof playEvent === 'function') playEvent('usb');
  if (dev) { try { dev.close(); } catch {} }
  dev = null;
  setStat('usbStat', 'off', 'off');
  $('bConnect').textContent = 'Connect';
  releaseWake();
}

async function send(obj) {
  if (!dev) { toast('Board not connected'); return; }
  const s = JSON.stringify(obj);
  try { await dev.transferOut(epOut, enc.encode(s + '\n')); log('> ' + s); }
  catch (e) { log('[usb] send failed: ' + e.message); }
}

function onText(t) {
  lineBuf += t;
  let i;
  while ((i = lineBuf.indexOf('\n')) >= 0) {
    const line = lineBuf.slice(0, i).replace(/\r$/, '');
    lineBuf = lineBuf.slice(i + 1);
    if (line) onLine(line);
  }
  if (lineBuf.length > 4096) lineBuf = '';
}

function onLine(line) {
  let ev = null;
  if (line[0] === '{') { try { ev = JSON.parse(line); } catch {} }
  if (!ev) { log(line); return; }
  // Board SD-card replies are handled by sd.js (log dumps stay out of the log view).
  if (typeof sdOnEvent === 'function' && sdOnEvent(ev)) { if (ev.event !== 'sd_det' && ev.event !== 'sd_ack' && ev.event !== 'sd_rd') log(line); return; }
  switch (ev.event) {
    case 'detection':
      log(line, true);
      ingestDetection(ev, 'live');
      break;
    case 'config':
      log(line);
      renderBeeps(ev);
      break;
    case 'session_begin':
      log(line); dumpCount = 0;
      toast(`Pulling ${ev.count} saved detections…`);
      break;
    case 'session_det':
      dumpCount++;
      ingestDetection(ev, 'board');
      break;
    case 'session_end':
      log(line);
      toast(`Imported ${dumpCount} saved detections`);
      redrawMarkers(); renderList();
      break;
    case 'session_error':
      log(line); toast('Board: ' + (ev.error || 'no saved session'));
      break;
    default:
      log(line);
  }
}

$('bConnect').onclick = async () => {
  if (!('usb' in navigator)) { toast('This browser has no WebUSB — use Chrome on Android'); return; }
  if (dev) { reading = false; try { await dev.close(); } catch {} closed(); return; }
  try {
    const d = await navigator.usb.requestDevice({ filters: [{ vendorId: ESPRESSIF_VID }] });
    await openDevice(d);
  } catch (e) { if (e.name !== 'NotFoundError') toast(e.message); }
};

if ('usb' in navigator) {
  // Once permission has been granted, reconnect without the picker.
  navigator.usb.addEventListener('connect', e => { if (e.device.vendorId === ESPRESSIF_VID) openDevice(e.device); });
  navigator.usb.addEventListener('disconnect', e => { if (dev && e.device === dev) { log('[usb] unplugged'); closed(); } });
}

async function autoConnect() {
  if (!('usb' in navigator)) return;
  const list = await navigator.usb.getDevices();
  const d = list.find(x => x.vendorId === ESPRESSIF_VID);
  if (d) openDevice(d);
}

// ---------------------------------------------------------------- wake lock

let wake = null;
async function requestWake() {
  if (!opts.wake || !('wakeLock' in navigator) || wake) return;
  try { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } catch {}
}
function releaseWake() { if (wake) { wake.release(); wake = null; } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && dev) requestWake(); });

// ---------------------------------------------------------------- export / import

async function download(name, mime, text) {
  // Optional: hand the file to Android's share sheet (Drive, email, Messages…).
  if (opts.shareExports && navigator.canShare) {
    const file = new File([text], name, { type: mime });
    if (navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const csvCell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');

function exportCsv() {
  const rows = [['mac', 'oui', 'tier', 'method', 'methods', 'hits', 'best_rssi', 'lat', 'lon', 'accuracy_m', 'first_seen', 'last_seen', 'ssid', 'name', 'protocol', 'source']];
  for (const d of Object.values(data.devices)) {
    rows.push([d.mac, d.oui, d.tier, d.method, Object.entries(d.methods).map(([k, v]) => k + ':' + v).join(' '), d.hits, d.bestRssi,
      d.bestLoc?.lat, d.bestLoc?.lon, d.bestLoc?.acc, new Date(d.first).toISOString(), new Date(d.last).toISOString(), d.ssid, d.name, d.protocol, d.source]);
  }
  download(`flockyou-cameras-${stamp()}.csv`, 'text/csv', rows.map(r => r.map(csvCell).join(',')).join('\n'));
}
function exportHits() {
  const rows = [['time', 'mac', 'tier', 'method', 'rssi', 'channel', 'lat', 'lon', 'accuracy_m']];
  for (const h of data.hits) rows.push([new Date(h.ts).toISOString(), h.mac, h.tier, h.method, h.rssi, h.ch, h.lat, h.lon, h.acc]);
  download(`flockyou-hits-${stamp()}.csv`, 'text/csv', rows.map(r => r.map(csvCell).join(',')).join('\n'));
}
function exportKml() {
  const x = s => String(s ?? '').replace(/[<>&]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;' }[c]));
  const colors = { 4: 'ff303bff', 3: 'ff0095ff', 2: 'ff0ad6ff', 1: 'ffffa34a', 0: 'ff938e8e' };
  const styles = Object.entries(colors).map(([t, c]) =>
    `<Style id="t${t}"><IconStyle><color>${c}</color><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>`).join('');
  const pms = Object.values(data.devices).filter(d => d.bestLoc).map(d =>
    `<Placemark><name>${x(d.mac)} (T${d.tier})</name><styleUrl>#t${d.tier}</styleUrl><description>${x(d.method)}; ${d.hits} hits; best ${d.bestRssi} dBm; last ${x(new Date(d.last).toISOString())}${d.ssid ? '; SSID ' + x(d.ssid) : ''}</description><Point><coordinates>${d.bestLoc.lon},${d.bestLoc.lat},0</coordinates></Point></Placemark>`).join('');
  const route = data.track.length > 1
    ? `<Placemark><name>Route</name><LineString><tessellate>1</tessellate><coordinates>${data.track.map(p => p.lon + ',' + p.lat + ',0').join(' ')}</coordinates></LineString></Placemark>` : '';
  download(`flockyou-${stamp()}.kml`, 'application/vnd.google-earth.kml+xml',
    `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Flock You</name>${styles}${pms}${route}</Document></kml>`);
}
function exportJson() {
  download(`flockyou-backup-${stamp()}.json`, 'application/json', JSON.stringify({ app: 'flockyou-mobile', v: 1, opts, ...data }));
}
document.querySelectorAll('[data-exp]').forEach(b => b.onclick = () =>
  ({ csv: exportCsv, hits: exportHits, kml: exportKml, json: exportJson })[b.dataset.exp]());

$('importFile').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!d.devices) throw new Error('not a Flock You backup');
    // Merge: keep whichever copy of each device saw more hits.
    for (const [mac, dv] of Object.entries(d.devices)) {
      const cur = data.devices[mac];
      if (!cur || dv.hits > cur.hits) data.devices[mac] = { ...dv, note: dv.note || cur?.note || '', status: dv.status || cur?.status || '' };
    }
    data.hits = [...data.hits, ...(d.hits || [])].sort((a, b) => a.ts - b.ts).slice(-MAX_HITS);
    data.track = [...data.track, ...(d.track || [])].sort((a, b) => a.ts - b.ts).slice(-MAX_TRACK);
    save(); redrawMarkers(); routeLine.setLatLngs(data.track.map(p => [p.lat, p.lon])); updateCounts(); renderList();
    toast('Backup restored');
  } catch (err) { toast('Import failed: ' + err.message); }
  e.target.value = '';
};

$('bClear').onclick = () => {
  if (!confirm('Delete all cameras, hits and route stored on this phone? Export a backup first if you want to keep them.')) return;
  data = { devices: {}, hits: [], track: [] };
  save(); redrawMarkers(); routeLine.setLatLngs([]); updateCounts(); renderList();
  toast('Cleared');
};

document.querySelectorAll('[data-dump]').forEach(b => b.onclick = () => send({ cmd: 'dump_session', source: b.dataset.dump }));

// ---------------------------------------------------------------- tabs & options

function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'map' && map) setTimeout(() => { map.invalidateSize(); if (typeof map3d !== 'undefined' && map3d) map3d.resize(); }, 50);
  if (name === 'list') renderList();
  if (name === 'log') renderLog();
  if (name === 'set') updateStoreInfo();
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => showTab(b.dataset.tab));

$('bFollow').onclick = () => setFollow(!opts.follow);
$('bClearLog').onclick = () => { logLines = []; renderLog(); };
$('logDet').onchange = $('logOther').onchange = renderLog;
$('sortBy').onchange = e => { opts.sort = e.target.value; saveOpts(); renderList(); };

function bindOpt(id, key, after) {
  const el = $(id);
  if (el.type === 'checkbox') el.checked = !!opts[key]; else el.value = String(opts[key]);
  el.onchange = () => {
    opts[key] = el.type === 'checkbox' ? el.checked : Number(el.value);
    saveOpts(); after && after();
  };
}

// ---------------------------------------------------------------- boot

load();
bindOpt('optWake', 'wake', () => opts.wake && dev ? requestWake() : releaseWake());
bindOpt('optVibe', 'vibe');
bindOpt('optTrack', 'track');
bindOpt('optMinTier', 'minTier', () => { redrawMarkers(); updateCounts(); renderList(); });
bindOpt('optShowIgnored', 'showIgnored', () => { redrawMarkers(); updateCounts(); renderList(); });
bindOpt('optAutoPull', 'autoPull');
bindOpt('optShare', 'shareExports');
bindOpt('optNight', 'night', () => document.body.classList.toggle('night', opts.night));
$('optUnits').value = opts.units;
$('optUnits').onchange = e => { opts.units = e.target.value; saveOpts(); renderList(); if (typeof refreshDistLabels === 'function') refreshDistLabels(); };
document.body.classList.toggle('night', opts.night);
$('sortBy').value = opts.sort;
$('bFollow').classList.toggle('on', opts.follow);
initMap();
updateCounts();
startGps();
autoConnect();
setInterval(() => { if (document.querySelector('#tab-list.active')) renderList(); }, 15000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
