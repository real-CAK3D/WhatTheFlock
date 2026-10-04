'use strict';
// Alert center: everything the app says or notifies goes through announce().
//   - Per category: read aloud (🔊) and/or system notification (🔔)
//   - One speech queue with priorities (a turn or camera interrupts a
//     "coffee ahead"), voice choice, speed
//   - Places ahead: gas / rest areas / service plazas / food… on your route
//     or road ahead, with "last gas for N miles" on long empty stretches
//   - Warnings & tips: break reminders (naming the next rest area), GPS lost,
//     signal lost while navigating, board unplugged, low phone battery
//   - Custom alerts: a speed cap, and "alert me near here" pins
//   - Recent alerts list, to re-read anything you missed
// Loaded last; the other modules call announce(category, text, options).

const ANN_CATS = {
  directions: { label: 'Turn-by-turn directions', prio: 3, voice: true,  notify: false },
  codriver:   { label: 'Co-driver / curve calls',  prio: 3, voice: true,  notify: false },
  flock:      { label: 'Flock cameras (board)',    prio: 3, voice: true,  notify: true },
  cameras:    { label: 'Mapped cameras ahead',     prio: 2, voice: true,  notify: true },
  traffic:    { label: 'Traffic & incidents',      prio: 2, voice: true,  notify: true },
  weather:    { label: 'Weather on the route',     prio: 2, voice: true,  notify: true },
  hazards:    { label: 'Hazard & police reports',  prio: 2, voice: true,  notify: true },
  speed:      { label: 'Speed limits & speeding',  prio: 2, voice: true,  notify: false },
  custom:     { label: 'My alerts',                prio: 2, voice: true,  notify: true },
  places:     { label: 'Places ahead (gas, food…)', prio: 1, voice: true,  notify: false },
  board:      { label: 'Board, GPS & signal',      prio: 2, voice: true,  notify: true },
  tips:       { label: 'Tips & break reminders',   prio: 1, voice: true,  notify: false },
};
opts.ann = Object.fromEntries(Object.entries(ANN_CATS).map(([k, v]) => [k, { voice: v.voice, notify: v.notify, ...(opts.ann?.[k] || {}) }]));
opts.voiceName = opts.voiceName || '';
opts.voiceRate = opts.voiceRate ?? 1.0;
opts.placeAlerts = { fuel: true, rest: true, services: true, ev: false, food: false, fastfood: false, coffee: false, lodging: false, toilets: false, ...(opts.placeAlerts || {}) };
opts.placeAlertDist = opts.placeAlertDist ?? 4800;   // m
opts.breakEvery = opts.breakEvery ?? 2;              // hours, 0 = off
opts.speedCap = opts.speedCap ?? 0;                  // display units, 0 = off
opts.geoAlerts = opts.geoAlerts || [];               // [{name, lat, lon, r}]

// ---------------------------------------------------------------- speech queue

let annVoices = [], annSpeaking = null;
const annQueue = [];
function loadVoices() { annVoices = (speechSynthesis?.getVoices?.() || []).filter(v => /^en/i.test(v.lang)); paintVoicePicker(); }
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }

function annSpeakNow(item) {
  const text = item.text.replace(/ ft\b/g, ' feet').replace(/ mi\b/g, ' miles').replace(/ km\b/g, ' kilometres').replace(/ m\b/g, ' metres');
  const u = new SpeechSynthesisUtterance(text);
  const v = annVoices.find(x => x.name === opts.voiceName);
  if (v) u.voice = v;
  u.rate = (item.rate || 1) * opts.voiceRate;
  u.onend = u.onerror = () => { if (annSpeaking === item) annSpeaking = null; annNext(); };
  annSpeaking = item;
  speechSynthesis.speak(u);
}
function annNext() {
  if (annSpeaking || !annQueue.length) return;
  annQueue.sort((a, b) => b.prio - a.prio || a.at - b.at);
  const item = annQueue.shift();
  if (Date.now() - item.at > 20000) return annNext();   // stale by now
  annSpeakNow(item);
}
function annEnqueue(item) {
  if (!('speechSynthesis' in window)) return;
  // Something more urgent cuts in; equal/lower waits its turn.
  if (annSpeaking && item.prio > annSpeaking.prio) {
    annSpeaking = null; speechSynthesis.cancel();
    annSpeakNow(item); return;
  }
  // Only keep the latest of each category waiting (e.g. one pending direction).
  for (let i = annQueue.length - 1; i >= 0; i--) if (annQueue[i].cat === item.cat) annQueue.splice(i, 1);
  annQueue.push(item);
  if (annQueue.length > 4) annQueue.sort((a, b) => b.prio - a.prio).length = 4;
  annNext();
}

// ---------------------------------------------------------------- announce

const annLog = [];
// o: { title, body, tag, rate, force }
function announce(cat, text, o = {}) {
  const c = opts.ann[cat] || { voice: true, notify: false };
  annLog.unshift({ ts: Date.now(), cat, text: o.title ? `${o.title} — ${text}` : text });
  if (annLog.length > 40) annLog.length = 40;
  paintAnnLog();
  if (c.voice && (!opts.muted || cat === 'directions') && (cat !== 'directions' || opts.navVoice)) {
    annEnqueue({ cat, text, prio: ANN_CATS[cat]?.prio ?? 1, rate: o.rate, at: Date.now() });
  }
  if (c.notify && typeof notify === 'function') notify(o.title || ANN_CATS[cat]?.label || 'What the Flock!', o.body || text, o.tag || 'fy-' + cat);
}

// Route the older speaking functions through the queue.
say = text => announce('directions', text);
speak = text => announce('flock', text);
if (typeof cdSay === 'function') cdSay = text => announce('codriver', text, { rate: opts.codriver === 'rally' ? 1.2 : 1.05 });

// ---------------------------------------------------------------- places ahead

let placeAnnounced = new Map(), lastPlaceSay = 0, lastPlaceLoad = 0;
const catLastSaid = {};

function placesAheadOnFix(f) {
  if (!opts.ann.places.voice && !opts.ann.places.notify) return;
  if (!f || f.acc > 60 || typeof allPlaces !== 'function') return;
  const now = Date.now();
  if (now - lastPlaceSay < 60000) return;             // at most one place call a minute
  // Scanning every place against the route is heavy; every 5 s is plenty.
  if (now - (placesAheadOnFix.at || 0) < 5000) return;
  placesAheadOnFix.at = now;
  const cats = Object.keys(opts.placeAlerts).filter(k => opts.placeAlerts[k]);
  if (!cats.length) return;
  const navOn = typeof nav !== 'undefined' && nav;
  // Keep place data loaded along the route ahead.
  if (navOn && now - lastPlaceLoad > 5 * 60e3 && navigator.onLine) { lastPlaceLoad = now; ensurePlaceCells(routeAheadCells()).catch?.(() => {}); }
  let best = null;
  for (const cat of cats) {
    if (now - (catLastSaid[cat] || 0) < 5 * 60e3) continue;      // one per kind per 5 min
    let list;
    if (navOn) list = alongList(cat).map(x => ({ p: x.p, d: x.ahead, off: x.off }));
    else if (f.spd > 3 && f.hdg != null && !Number.isNaN(f.hdg)) {
      list = allPlaces().filter(p => p.cat === cat).map(p => ({ p, d: distM(f, p) }))
        .filter(x => x.d < opts.placeAlertDist && angDiff(bearingDeg(f, x.p), f.hdg) < 25).sort((a, b) => a.d - b.d);
    } else continue;
    const cand = list.find(x => x.d >= 800 && x.d <= opts.placeAlertDist && (x.off == null || x.off < 400) && !placeAnnounced.has(x.p.id));
    if (cand && (!best || cand.d < best.d)) best = { ...cand, cat, list };
  }
  if (!best) return;
  lastPlaceSay = now; catLastSaid[best.cat] = now;
  placeAnnounced.set(best.p.id, now);
  const c = PLACE_CATS[best.cat];
  let text = `${c.one} ahead in ${fmtDist(best.d)}: ${placeName(best.p)}${best.off != null && best.off > 150 ? `, ${fmtDist(best.off)} off the route` : ''}`;
  // Road-trip tip: warn when the next gas after this one is far away — but only
  // when place data is actually loaded for that stretch, so "last gas" is never a guess.
  if (best.cat === 'fuel' && navOn) {
    const next = best.list.find(x => x.d > best.d + 1000);
    const gapEnd = next ? next.d : nav.rt.total - nav.along;
    if (gapEnd - best.d > 40000 && routeCovered(nav.along + best.d, nav.along + gapEnd)) {
      text += next ? `. It's the last gas for ${fmtDist(next.d - best.d)}` : `. No more gas on your route after this`;
    }
  }
  announce('places', text, { title: `${c.emoji} ${placeName(best.p)}`, body: `${c.one} ahead · ${fmtDist(best.d)}` });
}

// True if place data is loaded for every cell the route passes between two points.
function routeCovered(from, to) {
  const rt = nav.rt;
  for (let s = from; s <= to; s += 2000) {
    let i = 0;
    while (i < rt.cum.length - 2 && rt.cum[i + 1] < s) i++;
    const [lon, lat] = rt.coords[i];
    if (!placeCells.has(cellKey(Math.floor(lat / CELL), Math.floor(lon / CELL)))) return false;
  }
  return true;
}

// ---------------------------------------------------------------- warnings & tips

let driveStartAt = null, lastBreakSay = 0, gpsLostSaid = false, lowBattSaid = false, speedCapAt = 0;
const geoInside = new Set();

function warningsOnFix(f) {
  if (!f) return;
  const now = Date.now();
  const moving = (f.spd ?? 0) > 4;
  // Break reminder after N hours of driving, naming the next rest area / service plaza.
  if (moving && !driveStartAt) driveStartAt = now;
  if (opts.breakEvery > 0 && driveStartAt && now - driveStartAt >= opts.breakEvery * 3600e3 && now - lastBreakSay > 30 * 60e3) {
    lastBreakSay = now;
    const hrs = Math.round((now - driveStartAt) / 3600e3 * 10) / 10;
    let where = '';
    if (typeof nav !== 'undefined' && nav && typeof alongList === 'function') {
      const r = [...alongList('rest'), ...alongList('services')].sort((a, b) => a.ahead - b.ahead)[0];
      if (r) where = ` ${PLACE_CATS[r.p.cat].one} in ${fmtDist(r.ahead)}: ${placeName(r.p)}.`;
    }
    announce('tips', `You've been driving about ${hrs} hours. Time for a break.${where}`, { title: 'Take a break' });
  }
  gpsLostSaid = false;
  // Custom: speed cap.
  if (opts.speedCap > 0 && f.spd != null) {
    const v = opts.units === 'metric' ? f.spd * 3.6 : f.spd * 2.23694;
    if (v > opts.speedCap && now - speedCapAt > 60000) { speedCapAt = now; announce('custom', `Over ${opts.speedCap}`, { title: 'Speed alert' }); }
  }
  // Custom: "alert me near here" pins (fire on the way in, re-arm after leaving).
  for (const g of opts.geoAlerts) {
    const key = g.lat + ',' + g.lon, d = distM(f, g);
    if (d <= g.r && !geoInside.has(key)) { geoInside.add(key); announce('custom', `Approaching ${g.name}, ${fmtDist(d)}`, { title: `📍 ${g.name}`, tag: 'fy-geo-' + key }); }
    else if (d > g.r * 2) geoInside.delete(key);
  }
}

// GPS lost (while navigating or recording), checked on a timer since no fixes arrive.
setInterval(() => {
  const active = (typeof nav !== 'undefined' && nav) || (typeof rec !== 'undefined' && rec);
  if (active && fix && !fix.demo && Date.now() - fix.ts > 30000 && !gpsLostSaid) {
    gpsLostSaid = true;
    announce('board', 'GPS signal lost. Directions will resume when it comes back.', { title: 'GPS signal lost' });
  }
  if (!active) driveStartAt = fix && (fix.spd ?? 0) > 4 ? driveStartAt : null;
}, 5000);

window.addEventListener('offline', () => {
  if (typeof nav !== 'undefined' && nav) announce('board', 'No signal. Directions continue from the saved route.', { title: 'Offline' });
});
navigator.usb?.addEventListener('disconnect', e => {
  if (e.device.vendorId === ESPRESSIF_VID) announce('board', 'Flock board disconnected', { title: 'Board unplugged' });
});
navigator.getBattery?.().then(b => {
  const chk = () => {
    if (b.level <= 0.15 && !b.charging && !lowBattSaid) { lowBattSaid = true; announce('board', `Phone battery at ${Math.round(b.level * 100)} percent`, { title: 'Battery low' }); }
    if (b.charging || b.level > 0.2) lowBattSaid = false;
  };
  b.addEventListener('levelchange', chk); b.addEventListener('chargingchange', chk); chk();
}).catch(() => {});

function announceOnFix(f) { placesAheadOnFix(f); warningsOnFix(f); }

// ---------------------------------------------------------------- "alert me near here"

function addGeoAlert(name, lat, lon) {
  const r = Number(prompt(`Alert when within how many ${opts.units === 'metric' ? 'metres' : 'feet'} of ${name}?`, opts.units === 'metric' ? '500' : '1500'));
  if (!r) return;
  opts.geoAlerts.push({ name, lat, lon, r: opts.units === 'metric' ? r : r / 3.28084 });
  saveOpts(); paintGeoAlerts();
  toast(`🔔 You'll be alerted near ${name}`);
}

// ---------------------------------------------------------------- UI

function paintVoicePicker() {
  const s = $('optVoiceName');
  if (!s) return;
  s.innerHTML = '<option value="">Phone default</option>' + annVoices.map(v => `<option value="${esc(v.name)}">${esc(v.name)}</option>`).join('');
  s.value = opts.voiceName;
}
function paintAnnLog() {
  const el = $('annLog');
  if (!el) return;
  el.innerHTML = annLog.length ? annLog.slice(0, 15).map(a => `<div class="al"><span class="mute">${new Date(a.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span> ${esc(a.text)}</div>`).join('') : '<p class="mute small1">Nothing yet.</p>';
}
function paintGeoAlerts() {
  const el = $('geoList');
  if (!el) return;
  el.innerHTML = opts.geoAlerts.map((g, i) => `<div class="setup-row"><span>📍</span><div class="setup-body"><b>${esc(g.name)}</b><div class="mute small1">within ${fmtDist(g.r)}</div></div><button data-geo="${i}">Remove</button></div>`).join('')
    || '<p class="mute small1">None. Add one from any place (🔔 in its details) or a dropped pin.</p>';
  el.querySelectorAll('[data-geo]').forEach(b => b.onclick = () => { opts.geoAlerts.splice(Number(b.dataset.geo), 1); saveOpts(); paintGeoAlerts(); });
}

(function buildAnnounceUi() {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h2>Voice &amp; alerts</h2>
    <p class="mute">Choose what's read aloud (🔊) and what sends a notification (🔔). Urgent things (turns, cameras) cut in ahead of places and tips.</p>
    <div class="ann-grid"><span></span><b>🔊</b><b>🔔</b>
      ${Object.entries(ANN_CATS).map(([k, v]) => `<span>${v.label}</span>
        <input type="checkbox" data-ann="${k}" data-kind="voice" ${opts.ann[k].voice ? 'checked' : ''}>
        <input type="checkbox" data-ann="${k}" data-kind="notify" ${opts.ann[k].notify ? 'checked' : ''}>`).join('')}
    </div>
    <label class="sw">Voice <select id="optVoiceName" style="max-width:60%"></select></label>
    <label class="sw">Speaking speed <input type="range" id="optVoiceRate" min="0.7" max="1.5" step="0.05" style="flex:1;max-width:55%"></label>
    <button id="annTest">▶ Test voice</button>

    <h3>Places ahead</h3>
    <p class="mute small1">Read out when one is coming up on your route (or the road ahead when not navigating).</p>
    <div class="place-grid">${Object.keys(opts.placeAlerts).map(k => `<label class="pchip"><input type="checkbox" data-palert="${k}" ${opts.placeAlerts[k] ? 'checked' : ''}><span>${PLACE_CATS[k].emoji} ${PLACE_CATS[k].label}</span></label>`).join('')}</div>
    <label class="sw">Announce when within
      <select id="optPlaceDist"><option value="1600"></option><option value="3200"></option><option value="4800"></option><option value="8000"></option><option value="16000"></option></select></label>

    <h3>Tips &amp; warnings</h3>
    <label class="sw">Break reminder
      <select id="optBreak"><option value="0">Off</option><option value="1">Every hour</option><option value="2">Every 2 hours</option><option value="3">Every 3 hours</option></select></label>

    <h3>My alerts</h3>
    <label class="sw">Warn above this speed (any road)
      <select id="optSpeedCap"><option value="0">Off</option>${[45, 55, 60, 65, 70, 75, 80, 85, 90, 100, 110, 120, 130].map(v => `<option value="${v}">${v}</option>`).join('')}</select></label>
    <div id="geoList"></div>

    <h3>Recent alerts</h3>
    <div id="annLog"></div>`;
  $('slot-sounds').before(card);

  card.querySelectorAll('[data-ann]').forEach(cb => cb.onchange = () => {
    opts.ann[cb.dataset.ann][cb.dataset.kind] = cb.checked; saveOpts();
    if (cb.checked && cb.dataset.kind === 'notify' && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  });
  paintVoicePicker();
  $('optVoiceName').onchange = e => { opts.voiceName = e.target.value; saveOpts(); announce('tips', 'This is the voice you picked.'); };
  $('optVoiceRate').value = opts.voiceRate;
  $('optVoiceRate').onchange = e => { opts.voiceRate = Number(e.target.value); saveOpts(); announce('tips', 'Speaking at this speed.'); };
  $('annTest').onclick = () => { audio(); annSpeakNow({ cat: 'tips', text: 'Plate reader ahead in 500 feet. Gas ahead in 2 miles.', prio: 3, at: Date.now() }); };
  card.querySelectorAll('[data-palert]').forEach(cb => cb.onchange = () => { opts.placeAlerts[cb.dataset.palert] = cb.checked; saveOpts(); });
  for (const o of $('optPlaceDist').options) o.textContent = fmtDist(Number(o.value));
  $('optPlaceDist').value = String(opts.placeAlertDist);
  $('optPlaceDist').onchange = e => { opts.placeAlertDist = Number(e.target.value); saveOpts(); };
  $('optBreak').value = String(opts.breakEvery);
  $('optBreak').onchange = e => { opts.breakEvery = Number(e.target.value); saveOpts(); };
  $('optSpeedCap').value = String(opts.speedCap);
  $('optSpeedCap').onchange = e => { opts.speedCap = Number(e.target.value); saveOpts(); };
  paintGeoAlerts(); paintAnnLog();
})();
