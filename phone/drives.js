'use strict';
// Drive recorder + telemetry (in the spirit of DriveGo):
//   - Records each drive automatically once you're moving (or start/stop by hand)
//   - Live telemetry panel: speed, altitude, G-force (phone motion sensor), recording time
//   - Drives tab: history with distance, time, avg/max speed, max G, climb;
//     speed-coloured route on the map, speed + elevation charts, GPX export
// Stored in IndexedDB on the phone. Loaded after codriver.js.

const DRV_START_MPS = 4.5;       // ~10 mph for a few seconds starts a drive
const DRV_IDLE_STOP_MS = 5 * 60e3;
const DRV_MIN_SAVE_M = 300;

opts.autoRecord = opts.autoRecord ?? true;
opts.telemetry = opts.telemetry ?? false;

const driveDB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('flockyou-drives', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('drives', { keyPath: 'id' });
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => { const t = db.transaction('drives', mode); const q = fn(t.objectStore('drives')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); });
  },
  put(d) { return this.tx('readwrite', s => s.put(d)); },
  all() { return this.tx('readonly', s => s.getAll()); },
  del(id) { return this.tx('readwrite', s => s.delete(id)); },
};

// ---------------------------------------------------------------- G-force

let gNow = 0, gPeak = 0;
function onMotion(e) {
  const a = e.acceleration;
  let g;
  if (a && a.x != null) g = Math.hypot(a.x, a.y, a.z) / G;
  else if (e.accelerationIncludingGravity?.x != null) { const b = e.accelerationIncludingGravity; g = Math.abs(Math.hypot(b.x, b.y, b.z) - G) / G; }
  else return;
  gNow = gNow * 0.8 + g * 0.2;          // smooth out road buzz
  gPeak = Math.max(gPeak, gNow);
}
function startMotion() {
  if (startMotion.on || !('DeviceMotionEvent' in window)) return;
  const go = () => { window.addEventListener('devicemotion', onMotion); startMotion.on = true; };
  if (typeof DeviceMotionEvent.requestPermission === 'function') DeviceMotionEvent.requestPermission().then(s => s === 'granted' && go()).catch(() => {});
  else go();
}

// ---------------------------------------------------------------- recording

let rec = null, movingFixes = 0;

function drivesOnFix(f) {
  if (!f || f.acc > 50 || f.demo) return;   // demo drives aren't real drives
  const v = f.spd ?? 0;
  if (!rec) {
    movingFixes = v > DRV_START_MPS ? movingFixes + 1 : 0;
    if (opts.autoRecord && movingFixes >= 4) startDrive(true);
    paintTelem(f);
    return;
  }
  const last = rec.pts[rec.pts.length - 1];
  const moved = last ? distM(last, f) : Infinity;
  if (!last || moved >= 15 || f.ts - last.t >= 3000) {
    rec.pts.push({ t: f.ts, lat: +f.lat.toFixed(6), lon: +f.lon.toFixed(6), v: +v.toFixed(2), alt: f.alt != null ? Math.round(f.alt) : null, g: +gPeak.toFixed(2) });
    if (last && moved < 500) rec.dist += moved;      // skip GPS jumps
    rec.maxV = Math.max(rec.maxV, v); rec.maxG = Math.max(rec.maxG, gPeak);
    gPeak = gNow;
    if (rec.pts.length % 30 === 0) persistRec();
  }
  if (v > 1) rec.lastMove = f.ts;
  if (rec.auto && f.ts - rec.lastMove > DRV_IDLE_STOP_MS) stopDrive();
  paintTelem(f);
}

function startDrive(auto = false) {
  if (rec) return;
  startMotion();
  rec = { id: Date.now(), start: Date.now(), pts: [], dist: 0, maxV: 0, maxG: 0, lastMove: Date.now(), auto };
  gPeak = 0;
  if (!auto) toast('Recording drive');
  paintRecBtn();
}

async function stopDrive() {
  if (!rec) return;
  const r = rec; rec = null; movingFixes = 0;
  try { localStorage.removeItem('fy.rec'); } catch {}
  paintRecBtn(); paintTelem(fix);
  if (r.dist < DRV_MIN_SAVE_M) { toast('Drive too short to save'); return; }
  r.end = r.pts.at(-1)?.t || Date.now();
  r.stats = driveStats(r);
  r.name = `${new Date(r.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${new Date(r.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  await driveDB.put(r);
  toast(`Drive saved · ${fmtDist(r.stats.dist)} · ${fmtDur(r.stats.duration / 1000)}`);
  renderDrives();
}

// Keep an in-progress drive if the app is closed mid-drive.
function persistRec() { try { localStorage.setItem('fy.rec', JSON.stringify(rec)); } catch {} }
(function resumeRec() {
  try { const r = JSON.parse(localStorage.getItem('fy.rec')); if (r && Date.now() - (r.pts.at(-1)?.t || r.start) < 30 * 60e3) { rec = r; startMotion(); } } catch {}
})();

function driveStats(r) {
  const p = r.pts;
  let moving = 0, climb = 0, lastAlt = null, dist = 0;
  for (let i = 1; i < p.length; i++) {
    const d = distM(p[i - 1], p[i]);
    if (d < 500) dist += d;
    if (p[i].v > 1) moving += p[i].t - p[i - 1].t;
    if (p[i].alt != null) {
      if (lastAlt == null) lastAlt = p[i].alt;
      else if (Math.abs(p[i].alt - lastAlt) >= 3) { if (p[i].alt > lastAlt) climb += p[i].alt - lastAlt; lastAlt = p[i].alt; }
    }
  }
  const alts = p.map(x => x.alt).filter(a => a != null);
  return { dist, duration: (r.end || Date.now()) - r.start, moving, avgV: moving ? dist / (moving / 1000) : 0,
    maxV: Math.max(0, ...p.map(x => x.v)), maxG: Math.max(0, ...p.map(x => x.g || 0)), climb,
    minAlt: alts.length ? Math.min(...alts) : null, maxAlt: alts.length ? Math.max(...alts) : null };
}

// ---------------------------------------------------------------- live telemetry

const spdTxt = ms => Math.round(opts.units === 'metric' ? ms * 3.6 : ms * 2.23694);
const spdUnit = () => opts.units === 'metric' ? 'km/h' : 'mph';
const altTxt = m => m == null ? '—' : opts.units === 'metric' ? Math.round(m) + ' m' : Math.round(m * 3.28084) + ' ft';

function paintTelem(f) {
  const el = $('telem');
  if (!el) return;
  el.hidden = !opts.telemetry;
  if (!opts.telemetry) return;
  const recTxt = rec ? `<span class="rec-dot"></span>${fmtDur((Date.now() - rec.start) / 1000)} · ${fmtDist(rec.dist)}` : 'Not recording';
  el.innerHTML = `
    <div class="tl-row"><span>Speed</span><b>${f?.spd != null ? spdTxt(f.spd) : '—'} <small>${spdUnit()}</small></b></div>
    <div class="tl-row"><span>Altitude</span><b>${altTxt(f?.alt)}</b></div>
    <div class="tl-row"><span>G-force</span><b>${gNow.toFixed(2)} g</b></div>
    <div class="tl-g"><div style="width:${Math.min(100, gNow / 1.0 * 100)}%"></div></div>
    <div class="tl-row"><span>Max</span><b>${rec ? spdTxt(rec.maxV) + ' ' + spdUnit() + ' · ' + rec.maxG.toFixed(2) + ' g' : '—'}</b></div>
    <div class="tl-rec">${recTxt}</div>`;
}
setInterval(() => { if (opts.telemetry) paintTelem(fix); }, 1000);

// ---------------------------------------------------------------- history + analysis

const driveLayer = L.layerGroup().addTo(map);

async function renderDrives() {
  const el = $('driveList');
  if (!el) return;
  const list = (await driveDB.all().catch(() => [])).sort((a, b) => b.start - a.start);
  const tot = list.reduce((s, d) => s + d.stats.dist, 0);
  $('driveTotals').textContent = list.length ? `${list.length} drives · ${fmtDist(tot)} total` : '';
  el.innerHTML = list.length ? list.map(d => `
    <div class="dev drive" data-drive="${d.id}">
      <div class="body">
        <div class="mac">${esc(d.name)}</div>
        <div class="meta">${fmtDist(d.stats.dist)} · ${fmtDur(d.stats.duration / 1000)} · avg ${spdTxt(d.stats.avgV)} · max ${spdTxt(d.stats.maxV)} ${spdUnit()}${d.stats.maxG ? ' · ' + d.stats.maxG.toFixed(2) + ' g' : ''}</div>
      </div>
      <button data-drive="${d.id}">View</button>
    </div>`).join('') : '<p class="mute" style="padding:16px">No drives yet. They record automatically when you start driving (Settings → Drives), or tap Record.</p>';
}

async function openDrive(id) {
  const d = (await driveDB.all()).find(x => x.id === Number(id));
  if (!d) return;
  const s = d.stats;
  $('driveDetail').innerHTML = `
    <div class="ns-head"><b>${esc(d.name)}</b><button id="ddClose">✕</button></div>
    <div class="trip dd-stats">
      <div><b>${fmtDist(s.dist)}</b><span>distance</span></div>
      <div><b>${fmtDur(s.duration / 1000)}</b><span>time</span></div>
      <div><b>${spdTxt(s.avgV)}</b><span>avg ${spdUnit()}</span></div>
      <div><b>${spdTxt(s.maxV)}</b><span>max ${spdUnit()}</span></div>
      <div><b>${s.maxG ? s.maxG.toFixed(2) : '—'}</b><span>max g</span></div>
      <div><b>${altTxt(s.climb).replace(/ .*/, '') || '—'}</b><span>climb ${opts.units === 'metric' ? 'm' : 'ft'}</span></div>
    </div>
    <p class="mute small1">Speed</p><canvas id="ddSpeed" height="90"></canvas>
    <p class="mute small1">Elevation${s.minAlt != null ? ` (${altTxt(s.minAlt)} – ${altTxt(s.maxAlt)})` : ' — not reported by this phone\'s GPS'}</p><canvas id="ddAlt" height="70"></canvas>
    <div class="ns-acts"><button id="ddMap" class="primary">Show on map</button><button id="ddGpx">Export GPX</button><button id="ddDel" class="danger">Delete</button></div>`;
  $('driveDetail').hidden = false;
  const t0 = d.pts[0]?.t || d.start;
  drawChart($('ddSpeed'), d.pts.map(p => (p.t - t0) / 60000), d.pts.map(p => spdTxt(p.v)), '#58a6ff');
  const ap = d.pts.filter(p => p.alt != null);
  if (ap.length > 1) drawChart($('ddAlt'), ap.map(p => (p.t - t0) / 60000), ap.map(p => opts.units === 'metric' ? p.alt : p.alt * 3.28084), '#3fb950');
  $('ddClose').onclick = () => { $('driveDetail').hidden = true; };
  $('ddMap').onclick = () => showDriveOnMap(d);
  $('ddGpx').onclick = () => exportDriveGpx(d);
  $('ddDel').onclick = async () => { if (!confirm('Delete this drive?')) return; await driveDB.del(d.id); $('driveDetail').hidden = true; driveLayer.clearLayers(); renderDrives(); };
}

function drawChart(cv, xs, ys, color) {
  const w = cv.width = cv.clientWidth * devicePixelRatio, h = cv.height = cv.clientHeight * devicePixelRatio;
  const c = cv.getContext('2d');
  if (xs.length < 2) return;
  const x0 = xs[0], x1 = xs.at(-1) || 1, y0 = Math.min(...ys), y1 = Math.max(...ys) || 1;
  const X = x => (x - x0) / (x1 - x0 || 1) * (w - 8) + 4, Y = y => h - 6 - (y - y0) / (y1 - y0 || 1) * (h - 16);
  c.strokeStyle = color; c.lineWidth = 2 * devicePixelRatio; c.beginPath();
  xs.forEach((x, i) => i ? c.lineTo(X(x), Y(ys[i])) : c.moveTo(X(x), Y(ys[i])));
  c.stroke();
  c.fillStyle = getComputedStyle(document.body).color; c.font = `${10 * devicePixelRatio}px system-ui`;
  c.fillText(Math.round(y1), 4, 10 * devicePixelRatio); c.fillText(Math.round(y0), 4, h - 2);
}

// Speed "heat map": each stretch coloured from slow (blue) to fast (red).
function showDriveOnMap(d) {
  driveLayer.clearLayers();
  const vmax = Math.max(1, ...d.pts.map(p => p.v));
  for (let i = 1; i < d.pts.length; i++) {
    const a = d.pts[i - 1], b = d.pts[i], r = b.v / vmax;
    const col = `hsl(${Math.round(220 - 220 * r)},90%,55%)`;
    L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: col, weight: 6, opacity: 0.9 }).addTo(driveLayer);
  }
  if (d.pts.length) {
    $('driveDetail').hidden = true;
    showTab('map'); setFollow(false);
    if (opts.view3d && typeof set3D === 'function') set3D(false);
    map.fitBounds(d.pts.map(p => [p.lat, p.lon]), { padding: [40, 40] });
    toast('Blue = slow · red = fast. Pan the map or tap ◎ to go back to live.');
  }
}

function exportDriveGpx(d) {
  const pts = d.pts.map(p => `<trkpt lat="${p.lat}" lon="${p.lon}">${p.alt != null ? `<ele>${p.alt}</ele>` : ''}<time>${new Date(p.t).toISOString()}</time><extensions><speed>${p.v}</speed></extensions></trkpt>`).join('');
  download(`drive-${new Date(d.start).toISOString().slice(0, 16).replace(/[T:]/g, '-')}.gpx`, 'application/gpx+xml',
    `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="What the Flock!" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${esc(d.name)}</name><trkseg>${pts}</trkseg></trk></gpx>`);
}

// ---------------------------------------------------------------- UI

function paintRecBtn() {
  const b = $('bRec');
  if (b) { b.textContent = rec ? '■ Stop recording' : '● Record a drive'; b.classList.toggle('danger', !!rec); }
}

(function buildDrivesUi() {
  // Drives tab.
  const tab = document.createElement('section');
  tab.id = 'tab-drives'; tab.className = 'tab';
  tab.innerHTML = `
    <div class="toolbar"><button id="bRec" style="margin-left:0">● Record a drive</button><span class="mute small1" id="driveTotals"></span></div>
    <div id="driveList"></div>
    <div id="driveDetail" class="card" hidden></div>`;
  $('tab-set').before(tab);
  const btn = document.createElement('button');
  btn.dataset.tab = 'drives'; btn.textContent = 'Drives';
  document.querySelector('nav [data-tab="set"]').before(btn);
  btn.onclick = () => { showTab('drives'); renderDrives(); };
  $('bRec').onclick = () => rec ? stopDrive() : startDrive(false);
  $('driveList').addEventListener('click', e => { const t = e.target.closest('[data-drive]'); if (t) openDrive(t.dataset.drive); });
  paintRecBtn();

  // Live telemetry panel on the map.
  $('tab-map').insertAdjacentHTML('beforeend', '<div id="telem" hidden></div>');

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h2>Drives &amp; telemetry</h2>
    <label class="sw"><input type="checkbox" id="optAutoRecord"> Record drives automatically</label>
    <label class="sw"><input type="checkbox" id="optTelemetry"> Show live telemetry on the map (speed, altitude, G-force)</label>
    <p class="mute small1">G-force uses the phone's motion sensor; mount the phone firmly for sensible numbers.</p>`;
  $('slot-traffic').before(card);
  bindOpt('optAutoRecord', 'autoRecord');
  bindOpt('optTelemetry', 'telemetry', () => { if (opts.telemetry) startMotion(); paintTelem(fix); });
  if (opts.telemetry) startMotion();
  paintTelem(fix);
})();
