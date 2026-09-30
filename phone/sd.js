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

let sdState = { offset: 0 };
try { sdState = { ...sdState, ...JSON.parse(localStorage.getItem(SD_KEY)) }; } catch {}
const saveSdState = () => { try { localStorage.setItem(SD_KEY, JSON.stringify(sdState)); } catch {} };

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

async function importSdLog(auto = false) {
  if (sdBusy || !dev) return;
  sdBusy = true;
  let added = 0, lines = 0;
  try {
    const info = await sdRequest({ cmd: 'sd_info' }, 'sd_info');
    if (!info.ok) { if (!auto) toast('No SD card in the board'); return; }
    // Card swapped or log cleared: start over.
    if (info.log_bytes < sdState.offset) sdState.offset = 0;
    while (sdState.offset < info.log_bytes) {
      sdDumpLines = [];
      const end = await sdRequest({ cmd: 'sd_dump', from: sdState.offset, max: 300 }, 'sd_end', null, { ms: 8000 });
      for (const l of sdDumpLines) {
        const before = Object.keys(data.devices).length;
        ingestDetection({ mac_address: l.mac, detection_method: l.method, detection_tier: l.tier, rssi: l.rssi,
          channel: l.ch, ssid: l.ssid, device_name: l.name, count: 1 }, 'sd');
        const d = data.devices[(l.mac || '').toLowerCase()];
        if (d && l.t > 0) {   // real timestamps when the board knew the time
          d.first = Math.min(d.first, l.t * 1000);
          // Cameras known only from the SD log: "last seen" is the log's, not now.
          if (d.source === 'sd') { d.sdLast = Math.max(d.sdLast || 0, l.t * 1000); d.last = d.sdLast; }
        }
        if (Object.keys(data.devices).length > before) added++;
        lines++;
      }
      if (!end.next || end.next <= sdState.offset) break;
      sdState.offset = end.next;
      saveSdState();
      paintSd(`Importing… ${Math.round(sdState.offset / Math.max(1, info.log_bytes) * 100)}%`);
    }
    save(); redrawMarkers(); updateCounts(); renderList();
    if (lines || !auto) toast(`Board SD log: ${lines} detections read, ${added} new cameras`);
  } catch (e) {
    toast('SD import stopped: ' + e.message);
  } finally { sdBusy = false; paintSd(); }
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
    if (!d.devices) throw new Error('not a Flock You backup');
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
