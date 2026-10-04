'use strict';
// Board microSD (XIAO ESP32-S3 Sense): import the board's unlimited detection
// log, and back the whole phone app up to / restore it from the card — handy
// for moving everything between phones. Talks the firmware's resend-safe
// protocol (see main.cpp "MICROSD"): every command is retried if its reply
// doesn't arrive, and the board ignores duplicate backup chunks.
// Loaded after pois.js; uses globals from app.js (send, dev, data, ingestDetection…).

const SD_KEY = 'fy.sd.v1';
const SD_CHUNK = 600;

opts.sdAutoImport = opts.sdAutoImport ?? true;

// offset: bytes of the board's log already imported. anchors: per power-up
// ("boot"), the epoch second at which that boot started, learned whenever the
// board reports its uptime — dates sightings logged before the clock was set.
let sdState = { offset: 0, anchors: {} };
try { sdState = { ...sdState, ...JSON.parse(localStorage.getItem(SD_KEY)) }; } catch {}
sdState.anchors = sdState.anchors || {};
const saveSdState = () => { try { localStorage.setItem(SD_KEY, JSON.stringify(sdState)); } catch {} };

// Every board-log line, kept for the Board log view: {k, o, t, ms, boot, mac, method, tier, rssi, ch, lat, lon, src}.
data.sdLog = data.sdLog || [];
const MAX_SDLOG = 8000;      // ~1 MB of browser storage
// Versions before the Board log threw SD lines away; re-read the card once to get them back.
if (!sdState.v2) { sdState.offset = 0; sdState.v2 = true; saveSdState(); }

let sdInfo = null, sdBusy = false;
const sdWaiters = [];
let sdDumpLines = [];

// ---------------------------------------------------------------- protocol

// Called by app.js for every JSON line; returns true when it was an SD reply.
function sdOnEvent(ev) {
  const e = ev.event;
  if (e === 'sd_det') { sdDumpLines.push(ev); return true; }
  if (!['sd_info', 'sd_end', 'sd_ack', 'sd_wok', 'sd_werr', 'sd_rd', 'time_ok'].includes(e)) return false;
  if (e === 'sd_info') { sdInfo = ev; paintSd(); }
  // Newer firmware reports uptime (ms) with these: remember when this boot started.
  if ((e === 'time_ok' || e === 'sd_info') && ev.boot && ev.ms != null) {
    sdState.anchors[ev.boot] = Math.round(Date.now() / 1000 - ev.ms / 1000);
    saveSdState();
  }
  for (let i = sdWaiters.length - 1; i >= 0; i--) {
    const w = sdWaiters[i];
    if ((w.event === e || (e === 'sd_werr' && w.event !== 'sd_info')) && (!w.check || e === 'sd_werr' || w.check(ev))) {
      sdWaiters.splice(i, 1); clearTimeout(w.timer); w.resolve(ev);
    }
  }
  return true;
}

function sdWait(event, check, ms) {
  return new Promise(resolve => {
    const w = { event, check, resolve };
    w.timer = setTimeout(() => { const i = sdWaiters.indexOf(w); if (i >= 0) sdWaiters.splice(i, 1); resolve(null); }, ms);
    sdWaiters.push(w);
  });
}

// Send a command and wait for its reply, resending if it goes unanswered.
async function sdRequest(obj, event, check, { tries = 4, ms = 1500 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (!dev) throw new Error('board not connected');
    const p = sdWait(event, check, ms);
    await send(obj);
    const ev = await p;
    if (ev && ev.event === 'sd_werr') throw new Error(ev.error || 'SD write failed');
    if (ev) return ev;
  }
  throw new Error('no reply from board');
}

// ---------------------------------------------------------------- connect

async function sdOnConnect() {
  try {
    await sdRequest({ cmd: 'set_time', epoch: Math.floor(Date.now() / 1000) }, 'time_ok');
    await sdRequest({ cmd: 'sd_info' }, 'sd_info');
    if (sdInfo?.ok && opts.sdAutoImport && sdInfo.log_bytes > sdState.offset) importSdLog(true);
  } catch (e) { log('[sd] ' + e.message); }
}

// ---------------------------------------------------------------- import log

// Time of a board-log line in epoch seconds: its own clock, else this boot's anchor.
const sdLineTime = l => l.t > 0 ? l.t : (sdState.anchors[l.boot] ? sdState.anchors[l.boot] + Math.floor((l.ms || 0) / 1000) : 0);

// Where was the phone at time ts (ms)? From the saved route and recorded drives:
// interpolate between the two points around it if they're close enough in time.
let sdTrackCache = null;
async function sdTrackPoints() {
  if (sdTrackCache && Date.now() - sdTrackCache.at < 60000) return sdTrackCache.pts;
  const pts = data.track.map(p => ({ t: p.ts, lat: p.lat, lon: p.lon }));
  try { for (const d of await driveDB.all()) for (const p of d.pts) pts.push({ t: p.t, lat: p.lat, lon: p.lon }); } catch {}
  pts.sort((a, b) => a.t - b.t);
  sdTrackCache = { at: Date.now(), pts };
  return pts;
}
function locateAt(pts, ts) {
  if (!pts.length || !ts) return null;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid].t < ts) lo = mid + 1; else hi = mid; }
  const b = pts[lo], a = pts[lo - 1];
  if (a && b && ts >= a.t && ts <= b.t && b.t - a.t <= 5 * 60e3) {
    const f = (ts - a.t) / Math.max(1, b.t - a.t);
    return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, acc: 50 };
  }
  const near = [a, b].filter(Boolean).sort((x, y) => Math.abs(x.t - ts) - Math.abs(y.t - ts))[0];
  return near && Math.abs(near.t - ts) <= 120e3 ? { lat: near.lat, lon: near.lon, acc: 100 } : null;
}

async function importSdLog(auto = false) {
  if (sdBusy || !dev) return;
  sdBusy = true;
  let lines = 0, located = 0, added = 0;
  try {
    const info = await sdRequest({ cmd: 'sd_info' }, 'sd_info');
    if (!info.ok) { if (!auto) toast('No SD card in the board'); return; }
    // Card swapped or log cleared: start over.
    if (info.log_bytes < sdState.offset) sdState.offset = 0;
    data.sdLog = data.sdLog || [];        // "Clear all data" replaces data
    const pts = await sdTrackPoints();
    const known = new Set(data.sdLog.map(x => x.k));
    while (sdState.offset < info.log_bytes) {
      sdDumpLines = [];
      const end = await sdRequest({ cmd: 'sd_dump', from: sdState.offset, max: 300 }, 'sd_end', null, { ms: 8000 });
      for (const l of sdDumpLines) {
        const k = `${l.boot}:${l.ms}:${l.mac}`;
        if (known.has(k)) continue;           // re-read after an upgrade: already have it
        known.add(k);
        const t = sdLineTime(l);
        // Location: the board's own GPS module, else the phone's track at that time.
        let loc = null, src = '';
        if (l.lat != null && l.lon != null) { loc = { lat: l.lat, lon: l.lon, acc: 10 }; src = 'board GPS'; }
        else if (t) { loc = locateAt(pts, t * 1000); if (loc) src = 'phone track'; }
        if (loc) located++;
        const before = Object.keys(data.devices).length;
        ingestDetection({ mac_address: l.mac, detection_method: l.method, detection_tier: l.tier, rssi: l.rssi,
          ch: l.ch, ssid: l.ssid, device_name: l.name, _ts: t ? t * 1000 : 0, _loc: loc }, 'sd');
        if (Object.keys(data.devices).length > before) added++;
        data.sdLog.push({ k, o: l.o, t, ms: l.ms, boot: l.boot, mac: l.mac, method: l.method, tier: l.tier, rssi: l.rssi, ch: l.ch,
          lat: loc ? +loc.lat.toFixed(6) : null, lon: loc ? +loc.lon.toFixed(6) : null, src });
        lines++;
      }
      if (data.sdLog.length > MAX_SDLOG) data.sdLog.splice(0, data.sdLog.length - MAX_SDLOG);
      if (!end.next || end.next <= sdState.offset) break;
      sdState.offset = end.next;
      saveSdState();
      paintSd(`Importing… ${Math.round(sdState.offset / Math.max(1, info.log_bytes) * 100)}%`);
    }
    save(); redrawMarkers(); updateCounts(); renderList();
    if (lines || !auto) toast(`Board log: ${lines} sightings read · ${located} placed on the map · ${added} new cameras`);
  } catch (e) {
    toast('SD import stopped: ' + e.message);
  } finally { sdBusy = false; paintSd(); }
}

// Re-match board-log lines without a location (e.g. after a drive was recorded
// or an anchor was learned) against the phone's tracks.
async function relocateSdLog() {
  const pts = await sdTrackPoints();
  let n = 0;
  for (const x of data.sdLog || []) {
    if (x.lat != null) continue;
    if (!x.t) { const t = sdLineTime(x); if (t) x.t = t; }
    const loc = x.t ? locateAt(pts, x.t * 1000) : null;
    if (!loc) continue;
    x.lat = +loc.lat.toFixed(6); x.lon = +loc.lon.toFixed(6); x.src = 'phone track';
    const d = data.devices[(x.mac || '').toLowerCase()];
    if (d && (!d.bestLoc || x.rssi > (d.bestLoc.rssi ?? -127))) d.bestLoc = { lat: x.lat, lon: x.lon, acc: 50, ts: x.t * 1000, rssi: x.rssi };
    data.hits.push({ ts: x.t * 1000, mac: x.mac, method: x.method, tier: x.tier, rssi: x.rssi, ch: x.ch, lat: x.lat, lon: x.lon, acc: 50, src: 'sd' });
    n++;
  }
  if (n) { save(); redrawMarkers(); renderList(); }
  return n;
}

// ---------------------------------------------------------------- backup / restore

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const toB64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
const fromB64 = b => Uint8Array.from(atob(b), c => c.charCodeAt(0));

async function backupToSd() {
  if (sdBusy) return;
  if (!dev) { toast('Connect the board first'); return; }
  sdBusy = true;
  try {
    const payload = new TextEncoder().encode(JSON.stringify({
      app: 'flockyou-mobile', v: 1, savedAt: Date.now(), opts, ...data,
      trip: typeof loadTrip === 'function' ? loadTrip() : null,
    }));
    await sdRequest({ cmd: 'sd_wopen' }, 'sd_ack', e => e.n === -1);
    const total = Math.ceil(payload.length / SD_CHUNK);
    for (let n = 0; n < total; n++) {
      const part = payload.subarray(n * SD_CHUNK, (n + 1) * SD_CHUNK);
      await sdRequest({ cmd: 'sd_w', n, d: toB64(part) }, 'sd_ack', e => e.n === n);
      if (n % 10 === 0) paintSd(`Backing up… ${Math.round(n / total * 100)}%`);
    }
    const crc = '0x' + crc32(payload).toString(16).toUpperCase().padStart(8, '0');
    await sdRequest({ cmd: 'sd_wclose', len: payload.length, crc }, 'sd_wok', null, { ms: 4000 });
    await sdRequest({ cmd: 'sd_info' }, 'sd_info');
    toast(`Backed up to the board's SD card (${fmtBytes(payload.length)}, checksum verified)`);
  } catch (e) {
    toast('SD backup failed: ' + e.message);
  } finally { sdBusy = false; paintSd(); }
}

async function restoreFromSd() {
  if (sdBusy) return;
  if (!dev) { toast('Connect the board first'); return; }
  sdBusy = true;
  try {
    const parts = [];
    let off = 0, size = null;
    do {
      const rd = await sdRequest({ cmd: 'sd_r', off, len: SD_CHUNK }, 'sd_rd', e => e.off === off);
      size = rd.size;
      if (!size) throw new Error('no backup on the card yet');
      const b = fromB64(rd.d);
      if (!b.length) break;
      parts.push(b); off += b.length;
      if (parts.length % 10 === 0) paintSd(`Restoring… ${Math.round(off / size * 100)}%`);
    } while (off < size);
    const all = new Uint8Array(off);
    let p = 0; for (const b of parts) { all.set(b, p); p += b.length; }
    const d = JSON.parse(new TextDecoder().decode(all));
    if (!d.devices) throw new Error('not a What the Flock! backup');
    if (!confirm(`Restore the backup from ${new Date(d.savedAt).toLocaleString()}? It is merged with what's on this phone; nothing here is deleted.`)) return;
    for (const [mac, dv] of Object.entries(d.devices)) {
      const cur = data.devices[mac];
      if (!cur || dv.hits > cur.hits) data.devices[mac] = { ...dv, note: dv.note || cur?.note || '', status: dv.status || cur?.status || '' };
    }
    data.hits = [...data.hits, ...(d.hits || [])].sort((a, b) => a.ts - b.ts).slice(-MAX_HITS);
    data.track = [...data.track, ...(d.track || [])].sort((a, b) => a.ts - b.ts).slice(-MAX_TRACK);
    // Saved places and the saved trip come across too.
    if (d.opts?.places) for (const pl of d.opts.places) if (!opts.places.some(x => x.lat === pl.lat && x.lon === pl.lon)) opts.places.push(pl);
    if (d.trip && typeof saveTrip === 'function' && !loadTrip()) { saveTrip({ ...d.trip }); paintTripSaved(); }
    saveOpts(); save(); redrawMarkers(); routeLine.setLatLngs(data.track.map(x => [x.lat, x.lon])); updateCounts(); renderList();
    if (typeof paintPlaces === 'function') paintPlaces();
    toast('Restored from the board SD card');
  } catch (e) {
    toast('SD restore failed: ' + e.message);
  } finally { sdBusy = false; paintSd(); }
}

async function clearSdLog() {
  if (!dev) { toast('Connect the board first'); return; }
  if (!confirm('Delete the detection log on the board\'s SD card? Anything already imported stays on this phone.')) return;
  try {
    await sdRequest({ cmd: 'sd_clear_log' }, 'sd_info');
    sdState.offset = 0; saveSdState();
    toast('Board SD log cleared');
  } catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------- UI

function paintSd(progress) {
  const el = $('sdStatus');
  if (!el) return;
  if (progress) { el.textContent = progress; return; }
  if (!dev) { el.textContent = 'Connect the board to use its SD card.'; return; }
  if (!sdInfo) { el.textContent = 'Checking…'; return; }
  if (!sdInfo.ok) { el.textContent = 'No SD card found in the board (the LED works instead).'; return; }
  el.textContent = `${fmtBytes(sdInfo.card_mb * 1048576)} card · ${fmtBytes(sdInfo.used_mb * 1048576)} used · ` +
    `log ${fmtBytes(sdInfo.log_bytes)} (${fmtBytes(Math.min(sdState.offset, sdInfo.log_bytes))} imported) · ` +
    `backup ${sdInfo.backup_bytes ? fmtBytes(sdInfo.backup_bytes) : 'none'}${sdInfo.time_set ? '' : ' · clock not set'}`;
}

// ---------------------------------------------------------------- Board log view (Cameras tab)

const fmtUptime = ms => { const m = Math.floor((ms || 0) / 60000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };
function renderBoardLog() {
  const el = $('boardLog');
  if (!el) return;
  const log = data.sdLog || [];
  const boots = new Map();
  for (const x of log) { const b = boots.get(x.boot) || []; b.push(x); boots.set(x.boot, b); }
  const groups = [...boots.entries()].sort((a, b) => b[0] - a[0]);
  const head = `<div class="bl-acts"><button id="blImport">⬇ Import from board</button><button id="blMatch">📍 Match to my tracks</button><button id="blCsv">CSV</button></div>
    <p class="mute small1" style="padding:0 12px">Every sighting the board logged to its SD card, including runs with no phone. Sightings get a location from a GPS module on the board, or by matching their time to your phone's saved route and drives.</p>`;
  if (!groups.length) { el.innerHTML = head + '<p class="mute" style="padding:16px">Nothing imported yet. Connect the board and tap Import.</p>'; bindBoardLog(); return; }
  el.innerHTML = head + groups.map(([boot, rows]) => {
    rows.sort((a, b) => (b.ms || 0) - (a.ms || 0));
    const times = rows.map(r => r.t).filter(Boolean);
    const span = times.length ? `${fmtTime(Math.min(...times) * 1000)} – ${new Date(Math.max(...times) * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'time unknown (board clock not set)';
    const onMap = rows.filter(r => r.lat != null).length;
    return `<div class="bl-group"><div class="bl-head"><b>Power-up #${boot}</b><span class="mute"> · ${span} · ${rows.length} sightings · ${onMap} on map</span></div>
      ${rows.slice(0, 200).map(r => `<div class="bl-row${r.lat != null ? ' loc' : ''}" ${r.lat != null ? `data-lat="${r.lat}" data-lon="${r.lon}"` : ''}>
        <span class="bl-t">${r.t ? new Date(r.t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '+' + fmtUptime(r.ms)}</span>
        <span class="tier t${r.tier}" style="width:22px;height:22px;border-radius:5px;display:grid;place-items:center;color:#000;font-weight:700;font-size:12px">${r.tier}</span>
        <span class="bl-m"><code>${esc(r.mac)}</code><br><span class="mute">${esc((r.method || '').replace(/^wifi_|^ble_/, ''))} · ${r.rssi} dBm</span></span>
        <span class="bl-l">${r.lat != null ? `📍<br><span class="mute">${esc(r.src || '')}</span>` : '<span class="mute">no location</span>'}</span>
      </div>`).join('')}${rows.length > 200 ? `<p class="mute small1" style="padding:4px 12px">…and ${rows.length - 200} older</p>` : ''}</div>`;
  }).join('');
  bindBoardLog();
}
function bindBoardLog() {
  $('blImport').onclick = async () => { await importSdLog(false); renderBoardLog(); };
  $('blMatch').onclick = async () => { const n = await relocateSdLog(); toast(n ? `Placed ${n} more sightings on the map` : 'No more sightings could be matched to your tracks'); renderBoardLog(); };
  $('blCsv').onclick = () => {
    const rows = [['boot', 'time', 'uptime_ms', 'mac', 'tier', 'method', 'rssi', 'channel', 'lat', 'lon', 'location_from']];
    for (const r of data.sdLog || []) rows.push([r.boot, r.t ? new Date(r.t * 1000).toISOString() : '', r.ms, r.mac, r.tier, r.method, r.rssi, r.ch, r.lat ?? '', r.lon ?? '', r.src || '']);
    download(`board-log-${stamp()}.csv`, 'text/csv', rows.map(r => r.map(csvCell).join(',')).join('\n'));
  };
  $('boardLog').onclick = e => {
    const row = e.target.closest('[data-lat]');
    if (!row) return;
    showTab('map'); setFollow(false); map.setView([+row.dataset.lat, +row.dataset.lon], 17);
  };
}

(function buildBoardLogUi() {
  const tab = $('tab-list');
  tab.insertAdjacentHTML('afterbegin', `<div class="seg list-seg"><button data-lv="cams" class="on">Cameras</button><button data-lv="log">Board log</button></div>`);
  tab.insertAdjacentHTML('beforeend', '<div id="boardLog" hidden></div>');
  tab.querySelector('.list-seg').onclick = e => {
    const b = e.target.closest('[data-lv]');
    if (!b) return;
    const log = b.dataset.lv === 'log';
    tab.querySelectorAll('.list-seg button').forEach(x => x.classList.toggle('on', x === b));
    $('boardLog').hidden = !log;
    $('devList').hidden = log; $('trip').hidden = log; tab.querySelector('.toolbar').hidden = log;
    if (log) renderBoardLog();
  };
})();

(function buildSdUi() {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h2>Board SD card</h2>
    <p class="mute">The XIAO Sense logs every detection to its microSD card with no limit, even with no phone attached. You can also keep a full backup of this app on the card and restore it on your other phone.</p>
    <p class="small1" id="sdStatus"></p>
    <button id="sdImport">Import board log</button>
    <button id="sdBackup">Back up phone to SD</button>
    <button id="sdRestore">Restore from SD</button>
    <button id="sdClear">Clear board log</button>
    <label class="sw"><input type="checkbox" id="optSdAuto"> Import the board log automatically when connected</label>`;
  document.querySelector('[data-dump="live"]').closest('.card').after(card);
  $('sdImport').onclick = () => importSdLog(false);
  $('sdBackup').onclick = backupToSd;
  $('sdRestore').onclick = restoreFromSd;
  $('sdClear').onclick = clearSdLog;
  bindOpt('optSdAuto', 'sdAutoImport');
  navigator.usb?.addEventListener('disconnect', () => { sdInfo = null; setTimeout(paintSd, 100); });
  paintSd();
})();
