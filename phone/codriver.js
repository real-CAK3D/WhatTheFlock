'use strict';
// Co-driver: reads the road ahead from the route geometry.
//   - Corner detection: curvature every 10 m, corners rated on the rally
//     scale 1 (tightest) … 6 (fastest), plus hairpins and square turns, with
//     "long", "tightens", "opens" and links ("into", "and", distances).
//   - Modes: "rally" = full pace notes; "curves" = only sharp corners, with a
//     comfortable speed for each ("Sharp right ahead, slow to 25").
//   - Demo drive: animated drive along a route with the callouts.
//   - GPX import (drive your own road), pace notes export (CSV),
//     "curviest" route choice.
// Needs a planned route (navigation or a saved trip), like dedicated rally
// apps. Loaded after sd.js; uses globals from app.js, nav.js, sounds.js.

const CD_STEP = 10;            // resample spacing (m)
const CD_WIN = 2;              // curvature window: 2 samples each side ≈ 30 m (50 m blurred Smugglers' Notch switchbacks from grade 1 to 2)
const CD_MIN_ANGLE = 18;       // ignore gentler bends (degrees)
const CD_MAX_R = 220;          // ignore bends wider than this (m)
const G = 9.81;

opts.codriver = opts.codriver ?? 'off';     // 'off' | 'curves' | 'rally'
opts.cdSpeed = opts.cdSpeed ?? true;        // include speed advice
opts.cdLatG = opts.cdLatG ?? 0.3;           // lateral grip used for speed advice (g)
opts.cdTiming = opts.cdTiming ?? 'normal';  // 'early' | 'normal' | 'late'
opts.demoSpeed = opts.demoSpeed ?? 50;      // mph / km/h for demo drive

// ---------------------------------------------------------------- analysis

function cdSamples(rt) {
  const out = [];
  let i = 0;
  for (let s = 0; s <= rt.total; s += CD_STEP) {
    while (i < rt.cum.length - 2 && rt.cum[i + 1] < s) i++;
    const seg = rt.cum[i + 1] - rt.cum[i] || 1, t = Math.min(1, Math.max(0, (s - rt.cum[i]) / seg));
    const [x0, y0] = rt.xy[i], [x1, y1] = rt.xy[i + 1];
    const [lo0, la0] = rt.coords[i], [lo1, la1] = rt.coords[i + 1];
    out.push({ at: s, x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, lat: la0 + (la1 - la0) * t, lon: lo0 + (lo1 - lo0) * t });
  }
  return out;
}
const wrapRad = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// Corners along a route (cached on the route object).
function cdCorners(rt) {
  if (rt._corners) return rt._corners;
  const S = cdSamples(rt), n = S.length;
  if (n < CD_WIN * 2 + 2) return (rt._corners = []);
  const hdg = [];
  for (let i = 0; i < n - 1; i++) hdg.push(Math.atan2(S[i + 1].x - S[i].x, S[i + 1].y - S[i].y));
  hdg.push(hdg[hdg.length - 1]);
  // Signed curvature over a ~30 m window (turn / distance); + = right.
  const k = new Array(n).fill(0);
  for (let i = CD_WIN; i < n - CD_WIN; i++) k[i] = wrapRad(hdg[i + CD_WIN - 1] - hdg[i - CD_WIN]) / (CD_STEP * (2 * CD_WIN - 1));
  const kMin = 1 / CD_MAX_R;
  const corners = [];
  let i = 0;
  while (i < n) {
    if (Math.abs(k[i]) < kMin) { i++; continue; }
    const sign = Math.sign(k[i]);
    let j = i, gap = 0;
    // Extend while curving the same way (tolerate 20 m of straighter road inside).
    while (j + 1 < n) {
      const nk = k[j + 1];
      if (Math.sign(nk) === sign && Math.abs(nk) >= kMin) { j++; gap = 0; }
      else if (gap < 2) { j++; gap++; }
      else break;
    }
    j -= gap;
    const angle = wrapRad(hdg[Math.min(n - 1, j + 1)] - hdg[Math.max(0, i - 1)]) * 180 / Math.PI;
    if (Math.abs(angle) >= CD_MIN_ANGLE) {
      let maxK = 0, apex = i;
      for (let q = i; q <= j; q++) if (Math.abs(k[q]) > maxK) { maxK = Math.abs(k[q]); apex = q; }
      const R = 1 / maxK, len = (j - i + 1) * CD_STEP, mid = (i + j) >> 1;
      let k1 = 0, k2 = 0;
      for (let q = i; q <= mid; q++) k1 = Math.max(k1, Math.abs(k[q]));
      for (let q = mid; q <= j; q++) k2 = Math.max(k2, Math.abs(k[q]));
      corners.push(cdGrade({ start: S[i].at, end: S[j].at, apexAt: S[apex].at, lat: S[apex].lat, lon: S[apex].lon,
        dir: sign > 0 ? 'right' : 'left', angle: Math.abs(angle), R, len, k1, k2 }));
    }
    i = j + 1;
  }
  return (rt._corners = corners.filter(c => c.sev != null));
}

function cdGrade(c) {
  const a = c.angle, R = c.R;
  if (a >= 150 && R < 35) c.sev = 'hairpin';
  else if (a >= 70 && a <= 115 && R < 22 && c.len < 50) c.sev = 'square';
  else if (R <= 20) c.sev = 1;
  else if (R <= 35) c.sev = 2;
  else if (R <= 55) c.sev = 3;
  else if (R <= 85) c.sev = 4;
  else if (R <= 130) c.sev = 5;
  else if (R <= CD_MAX_R) c.sev = 6;
  const mods = [];
  if (c.len > 120 && typeof c.sev === 'number') mods.push('long');
  if (c.k2 > c.k1 * 1.5 && c.len > 40) mods.push('tightens');
  else if (c.k1 > c.k2 * 1.5 && c.len > 40) mods.push('opens');
  c.mods = mods;
  c.vAdvice = Math.sqrt(G * opts.cdLatG * R);   // m/s, comfortable cornering speed
  return c;
}

// Twistiness for route choice: corners per 10 km, weighted by severity.
function cdCurviness(rt) {
  const cs = cdCorners(rt);
  const w = cs.reduce((s, c) => s + (typeof c.sev === 'number' ? 7 - c.sev : 7), 0);
  return w / Math.max(1, rt.total / 10000);
}

// ---------------------------------------------------------------- wording

const toUnitsV = ms => opts.units === 'metric' ? ms * 3.6 : ms * 2.23694;
function cdName(c, rally) {
  if (c.sev === 'hairpin') return `hairpin ${c.dir}`;
  if (c.sev === 'square') return `square ${c.dir}`;
  if (!rally) return `${c.sev <= 2 ? 'sharp' : c.sev === 3 ? 'tight' : ''} ${c.dir}`.trim();
  return `${c.dir} ${c.sev}`;
}
function cdCall(c, rally) {
  const parts = [cdName(c, rally)];
  if (rally) parts.push(...c.mods);
  return parts.join(' ');
}
function cdLink(gap) {
  if (gap < 25) return 'into';
  if (gap < 60) return 'and';
  const m = opts.units === 'metric' ? gap : gap * 1.09361;   // rally distances: metres (or yards)
  return String(Math.round(m / 50) * 50);
}
const cdShort = c => c.sev === 'hairpin' ? `HP${c.dir[0].toUpperCase()}` : c.sev === 'square' ? `Sq${c.dir[0].toUpperCase()}` : `${c.dir[0].toUpperCase()}${c.sev}`;

// ---------------------------------------------------------------- live callouts

let cdCalled = new Set(), cdRoute = null;

function cdWanted(c) {
  if (opts.codriver === 'rally') return true;
  // Curve-warning mode: sharp corners, or any bend you're going too fast for.
  if (c.sev === 'hairpin' || c.sev === 'square' || c.sev <= 3) return true;
  return fix && fix.spd && c.vAdvice < fix.spd - 4;
}

function cdSay(text) {
  if (!('speechSynthesis' in window) || opts.muted) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = opts.codriver === 'rally' ? 1.2 : 1.05;
  // Queue behind anything already talking, unless the queue is backed up.
  if (speechSynthesis.pending) speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

function codriverOnFix(f) {
  if (opts.codriver === 'off' || typeof nav === 'undefined' || !nav) { paintCdStrip(null); return; }
  const rt = nav.rt;
  if (cdRoute !== rt) { cdRoute = rt; cdCalled = new Set(); }
  const cs = cdCorners(rt), along = nav.along;
  const v = Math.max(8, f.spd || 0);
  const leadS = { early: 7, normal: 5, late: 3.5 }[opts.cdTiming] || 5;
  const lead = Math.max(opts.codriver === 'rally' ? 90 : 120, Math.min(450, v * leadS));
  const upcoming = cs.filter(c => c.end > along);
  paintCdStrip(upcoming.slice(0, 4));
  const first = upcoming.findIndex(c => !cdCalled.has(c) && cdWanted(c) && c.start - along <= lead && c.start - along > -15);
  if (first < 0) return;
  // Chain corners that follow closely, like a co-driver reading ahead.
  const group = [upcoming[first]];
  for (let q = first + 1; q < upcoming.length && group.length < 3; q++) {
    const gap = upcoming[q].start - group[group.length - 1].end;
    if (gap > (opts.codriver === 'rally' ? 150 : 60)) break;
    if (!cdWanted(upcoming[q])) continue;
    group.push(upcoming[q]);
  }
  group.forEach(c => cdCalled.add(c));
  const rally = opts.codriver === 'rally';
  let text = '';
  group.forEach((c, i) => {
    if (i) text += ` ${cdLink(c.start - group[i - 1].end)} `;
    text += cdCall(c, rally);
  });
  if (!rally) text = text.replace(/^(\w)/, m => m.toUpperCase()) + ' ahead';
  // Speed advice when the first corner needs slowing for.
  const c0 = group[0];
  if (opts.cdSpeed && f.spd && c0.vAdvice < f.spd - 2) {
    const adv = Math.max(10, Math.floor(toUnitsV(c0.vAdvice) / 5) * 5);
    text += rally ? `, ${adv}` : `, slow to ${adv}`;
  }
  cdSay(text);
  flashCdStrip();
}

// ---------------------------------------------------------------- UI: pace-note strip

function paintCdStrip(list) {
  const el = $('cdStrip');
  if (!el) return;
  el.hidden = !list || !list.length || opts.codriver === 'off';
  if (el.hidden) return;
  const along = nav.along;
  el.innerHTML = list.map((c, i) => `<span class="cd-c ${c.dir} s${typeof c.sev === 'number' ? c.sev : 0}">
      <b>${c.dir === 'left' ? '↰' : '↱'} ${cdShort(c)}</b>${c.mods.includes('tightens') ? '<i>tightens</i>' : c.mods.includes('opens') ? '<i>opens</i>' : ''}
      <small>${i === 0 ? fmtDist(Math.max(0, c.start - along)) : cdLink(c.start - list[i - 1].end)}</small></span>`).join('');
}
function flashCdStrip() { const el = $('cdStrip'); if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); } }

// ---------------------------------------------------------------- demo drive

let demo = null;
function demoStart(rt) {
  rt = rt || (typeof nav !== 'undefined' && nav ? nav.rt : routes[selIdx]);
  if (!rt) { toast('Plan a route first'); return; }
  demoStop();
  audio();
  if (!nav) { navDest = navDest || { name: 'End of route', lat: rt.coords.at(-1)[1], lon: rt.coords.at(-1)[0] }; startNav(rt); }
  const mps = (opts.demoSpeed || 50) / (opts.units === 'metric' ? 3.6 : 2.23694);
  demo = { rt, s: 0, mps, last: performance.now() };
  window.fyDemo = true;
  toast(`Demo drive at ${opts.demoSpeed} ${opts.units === 'metric' ? 'km/h' : 'mph'} — tap End to stop`);
  demo.timer = setInterval(() => {
    const now = performance.now(), dt = (now - demo.last) / 1000; demo.last = now;
    // Slow for corners like a driver would, so callouts and advice make sense.
    const cs = cdCorners(rt), c = cs.find(x => x.end > demo.s && x.start - demo.s < 60);
    const target = c ? Math.min(demo.mps, Math.max(6, c.vAdvice)) : demo.mps;
    demo.v = demo.v == null ? target : demo.v + Math.max(-3 * dt, Math.min(2 * dt, target - demo.v));
    demo.s += demo.v * dt;
    if (demo.s >= rt.total || !nav) { demoStop(); return; }
    let i = 0; while (i < rt.cum.length - 2 && rt.cum[i + 1] < demo.s) i++;
    const t = (demo.s - rt.cum[i]) / (rt.cum[i + 1] - rt.cum[i] || 1);
    const [lo0, la0] = rt.coords[i], [lo1, la1] = rt.coords[i + 1];
    const hd = (Math.atan2(rt.xy[i + 1][0] - rt.xy[i][0], rt.xy[i + 1][1] - rt.xy[i][1]) * 180 / Math.PI + 360) % 360;
    fix = { lat: la0 + (la1 - la0) * t, lon: lo0 + (lo1 - lo0) * t, acc: 5, ts: Date.now(), spd: demo.v, hdg: hd, alt: null, demo: true };
    setStat('gpsStat', 'on', 'demo');
    onFix();
  }, 250);
}
function demoStop() {
  if (!demo) return;
  clearInterval(demo.timer);
  demo = null; window.fyDemo = false;
}

// ---------------------------------------------------------------- GPX import / pace-note export

async function importGpx(file) {
  const doc = new DOMParser().parseFromString(await file.text(), 'application/xml');
  let pts = [...doc.querySelectorAll('trkpt')];
  if (pts.length < 2) pts = [...doc.querySelectorAll('rtept')];
  if (pts.length < 2) { toast('No track or route points in that GPX'); return; }
  const coords = pts.map(p => [Number(p.getAttribute('lon')), Number(p.getAttribute('lat'))]);
  const name = doc.querySelector('trk > name, rte > name, metadata > name')?.textContent?.trim() || file.name.replace(/\.gpx$/i, '');
  let dist = 0;
  for (let i = 1; i < coords.length; i++) dist += distM({ lat: coords[i - 1][1], lon: coords[i - 1][0] }, { lat: coords[i][1], lon: coords[i][0] });
  // A route with just depart/arrive steps: guidance is the co-driver plus the line.
  const loc = c => ({ location: c, bearing_after: 0 });
  const raw = { geometry: { type: 'LineString', coordinates: coords }, distance: dist, duration: dist / 17,
    legs: [{ steps: [
      { maneuver: { type: 'depart', ...loc(coords[0]) }, name, distance: dist, duration: dist / 17 },
      { maneuver: { type: 'arrive', ...loc(coords.at(-1)) }, name, distance: 0, duration: 0 },
    ] }] };
  const rt = prepRoute(raw);
  rt.cams = []; rt.camsCounted = true;
  navDest = { name, label: `GPX · ${fmtDist(dist)}`, lat: coords.at(-1)[1], lon: coords.at(-1)[0] };
  routes = [rt]; selIdx = 0; showPreview.fitted = false;
  showTab('map');
  showPreview();
  loadRouteCells(rt).then(() => { rt.cams = camerasOn(rt); if (!nav) showPreview(); }).catch(() => {});
  toast(`Loaded "${name}" · ${cdCorners(rt).length} corners`);
}

function exportPacenotes() {
  const rt = (typeof nav !== 'undefined' && nav) ? nav.rt : routes[selIdx];
  if (!rt) { toast('Plan or load a route first'); return; }
  const cs = cdCorners(rt);
  const rows = [['#', 'distance_from_start', 'call', 'direction', 'grade', 'modifiers', 'radius_m', 'angle_deg', 'length_m', 'link_to_next', 'advice_speed', 'lat', 'lon']];
  cs.forEach((c, i) => rows.push([i + 1, fmtDist(c.start), cdCall(c, true), c.dir, c.sev, c.mods.join(' '), Math.round(c.R), Math.round(c.angle),
    c.len, cs[i + 1] ? cdLink(cs[i + 1].start - c.end) : '', Math.floor(toUnitsV(c.vAdvice) / 5) * 5, c.lat.toFixed(6), c.lon.toFixed(6)]));
  download(`pacenotes-${stamp()}.csv`, 'text/csv', rows.map(r => r.map(csvCell).join(',')).join('\n'));
}

// ---------------------------------------------------------------- hooks + settings

(function buildCodriverUi() {
  $('tab-map').insertAdjacentHTML('beforeend', '<div id="cdStrip" hidden></div>');
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h2>Co-driver</h2>
    <p class="mute">Reads the corners ahead on your route. <b>Rally</b> calls every corner in pace-note style (grade 1 = tightest … 6 = fastest, hairpins, squares, "tightens", "into"). <b>Curve warnings</b> only calls sharp bends, with a comfortable speed.</p>
    <label class="sw">Mode
      <select id="optCodriver"><option value="off">Off</option><option value="curves">Curve warnings</option><option value="rally">Rally co-driver</option></select></label>
    <label class="sw">Call timing
      <select id="optCdTiming"><option value="early">Early</option><option value="normal">Normal</option><option value="late">Late</option></select></label>
    <label class="sw"><input type="checkbox" id="optCdSpeed"> Speed advice for corners</label>
    <label class="sw">Advice grip
      <select id="optCdLatG"><option value="0.2">Relaxed</option><option value="0.3">Normal</option><option value="0.4">Sporty</option></select></label>
    <label class="sw">Demo drive speed
      <select id="optDemoSpeed"><option value="30">30</option><option value="50">50</option><option value="70">70</option></select></label>
    <button id="cdDemo">Demo drive current route</button>
    <button id="cdExport">Export pace notes (CSV)</button>
    <label class="filebtn">Import GPX route<input type="file" id="cdGpx" accept=".gpx,application/gpx+xml,application/xml,text/xml"></label>
    <p class="mute small1">Speed advice is a guide from the road's shape only — road surface, weather and visibility matter more. Obey posted limits.</p>`;
  $('slot-traffic').before(card);
  $('optCodriver').value = opts.codriver;
  $('optCodriver').onchange = e => { opts.codriver = e.target.value; saveOpts(); cdCalled = new Set(); if (opts.codriver !== 'off') cdSay(opts.codriver === 'rally' ? 'Co-driver ready' : 'Curve warnings on'); };
  $('optCdTiming').value = opts.cdTiming;
  $('optCdTiming').onchange = e => { opts.cdTiming = e.target.value; saveOpts(); };
  bindOpt('optCdSpeed', 'cdSpeed');
  $('optCdLatG').value = String(opts.cdLatG);
  $('optCdLatG').onchange = e => { opts.cdLatG = Number(e.target.value); saveOpts(); for (const r of [...routes, nav?.rt].filter(Boolean)) r._corners = null; };
  $('optDemoSpeed').value = String(opts.demoSpeed);
  $('optDemoSpeed').onchange = e => { opts.demoSpeed = Number(e.target.value); saveOpts(); };
  $('cdDemo').onclick = () => { showTab('map'); demoStart(); };
  $('cdExport').onclick = exportPacenotes;
  $('cdGpx').onchange = e => { const f = e.target.files[0]; if (f) importGpx(f); e.target.value = ''; };

  // Route options: "Curviest" choice + corner count; demo button in the preview.
  const pref = $('optRoutePref');
  if (pref && !pref.querySelector('[value="curvy"]')) pref.insertAdjacentHTML('beforeend', '<option value="curvy">Curviest (driver\'s roads)</option>');
  pref.value = opts.routePref;

  // Stop the demo when navigation ends.
  const origEnd = endNav;
  endNav = function (byUser) { demoStop(); origEnd(byUser); paintCdStrip(null); };
})();

// Score routes after planning (called from nav.js).
function cdScoreRoutes(rts) {
  if (!rts.length) return;
  rts.forEach(r => { r.curvy = cdCurviness(r); r.cornerCount = cdCorners(r).length; });
  const curviest = rts.reduce((a, r, i) => r.curvy > rts[a].curvy ? i : a, 0);
  rts.forEach((r, i) => { r.isCurviest = rts.length > 1 && i === curviest && r.curvy > 0; });
  return curviest;
}
