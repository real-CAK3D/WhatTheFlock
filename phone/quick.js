'use strict';
// Quick actions (⚡): one-tap while driving — find gas/food/rest along the
// way, report police/hazards, save or find your parked car, share your ETA
// or location, go home, mute, HUD. Also parking memory (auto-saved when a
// recorded drive ends). Loaded after hazards.js.

opts.parking = opts.parking || null;         // {lat, lon, ts}
opts.autoPark = opts.autoPark ?? true;

// ---------------------------------------------------------------- parking

let parkMarker = null;
function drawParking() {
  if (parkMarker) { parkMarker.remove(); parkMarker = null; }
  if (!opts.parking) return;
  parkMarker = L.marker([opts.parking.lat, opts.parking.lon], { icon: L.divIcon({ className: 'hz-ico park', html: '🚗', iconSize: [30, 30] }), zIndexOffset: 400 })
    .bindPopup(() => `<b>🚗 Your car</b><br><span class="mute">parked ${ago(opts.parking.ts)}${fix ? ' · ' + fmtDist(distM(fix, opts.parking)) + ' away' : ''}</span>
      <div class="pp-acts"><button onclick="walkToCar()">Walk there</button><button onclick="clearParking()">Clear</button></div>`).addTo(map);
}
function saveParking(p = fix, quiet = false) {
  if (!p) { toast('Waiting for GPS'); return; }
  opts.parking = { lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6), ts: Date.now() };
  saveOpts(); drawParking();
  if (!quiet) toast('🚗 Parking spot saved');
}
function clearParking() { opts.parking = null; saveOpts(); drawParking(); map.closePopup(); toast('Parking spot cleared'); }
function walkToCar() {
  if (!opts.parking) { toast('No parking spot saved'); return; }
  map.closePopup();
  opts.navMode = 'foot'; saveOpts();
  if ($('optNavMode')) $('optNavMode').value = 'foot';
  selectPlace({ name: 'Your car', label: `parked ${ago(opts.parking.ts)}`, lat: opts.parking.lat, lon: opts.parking.lon });
  planRoute();
}
// A recorded drive ended where you stopped: that's where the car is.
if (typeof stopDrive === 'function') {
  const _stop = stopDrive;
  stopDrive = async function () {
    const last = rec?.pts?.at(-1);
    await _stop();
    if (opts.autoPark && last) saveParking(last, true);
  };
}

// ---------------------------------------------------------------- sharing

async function shareText(title, text, url) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(`${text} ${url}`); toast('Copied — paste it into a message'); }
  catch { prompt('Copy this:', `${text} ${url}`); }
}
function mapLink(lat, lon) { return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(5)},${lon.toFixed(5)}`; }

function shareEta() {
  if (!fix) { toast('Waiting for GPS'); return; }
  const navOn = typeof nav !== 'undefined' && nav;
  if (navOn) {
    const left = Math.max(0, nav.rt.total - nav.along);
    const delay = typeof routeDelayAhead === 'function' ? routeDelayAhead(nav.rt, nav.along) : 0;
    const eta = Date.now() + (nav.rt.duration * (left / nav.rt.total) + delay) * 1000;
    shareText('My ETA', `Heading to ${nav.dest.name}, arriving around ${fmtClock(eta)} (${fmtDist(left)} to go). I'm here:`, mapLink(fix.lat, fix.lon));
  } else {
    shareText('My location', `I'm here (${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}):`, mapLink(fix.lat, fix.lon));
  }
}

// ---------------------------------------------------------------- quick menu

const QUICK = [
  { k: 'fuel', icon: '⛽', label: 'Gas', go: () => openFind('fuel') },
  { k: 'food', icon: '🍔', label: 'Food', go: () => openFind('fastfood') },
  { k: 'coffee', icon: '☕', label: 'Coffee', go: () => openFind('coffee') },
  { k: 'rest', icon: '🅿️', label: 'Rest area', go: () => openFind('rest') },
  { k: 'services', icon: '🛣️', label: 'Services', go: () => openFind('services') },
  { k: 'toilets', icon: '🚻', label: 'Restroom', go: () => openFind('toilets') },
  { k: 'r-police', icon: '🚓', label: 'Police', go: () => reportHazard('police'), report: true },
  { k: 'r-accident', icon: '💥', label: 'Accident', go: () => reportHazard('accident'), report: true },
  { k: 'r-hazard', icon: '⚠️', label: 'Hazard', go: () => reportHazard('hazard'), report: true },
  { k: 'r-object', icon: '🪨', label: 'Object', go: () => reportHazard('object'), report: true },
  { k: 'r-construction', icon: '🚧', label: 'Work zone', go: () => reportHazard('construction'), report: true },
  { k: 'r-camera', icon: '📸', label: 'Speed cam', go: () => reportHazard('camera'), report: true },
  { k: 'r-flock', icon: '📷', label: 'Flock cam', go: () => reportHazard('flock'), report: true },
  { k: 'r-weather', icon: '🧊', label: 'Icy road', go: () => reportHazard('weather'), report: true },
  { k: 'park', icon: '🚗', label: 'Save parking', go: () => saveParking() },
  { k: 'car', icon: '📍', label: 'Find my car', go: walkToCar },
  { k: 'eta', icon: '📤', label: 'Share ETA', go: shareEta },
  { k: 'home', icon: '🏠', label: 'Go home', go: goHome },
  { k: 'mute', icon: '🔇', label: 'Mute', go: () => $('bMute').click() },
  { k: 'hud', icon: '🖥️', label: 'HUD', go: () => hudOpen() },
];

function goHome() {
  const h = opts.places.find(p => /^home$/i.test(p.name)) || opts.places[0];
  if (!h) { toast('Save a place named "Home" first (search it, tap ☆ Save)'); return; }
  opts.navMode = 'car'; saveOpts();
  selectPlace(h); planRoute();
}

function openQuick() {
  const el = $('quick');
  el.innerHTML = `<div class="q-box">
      <div class="q-head"><b>Quick actions</b><button id="qClose">✕</button></div>
      <div class="q-sub">Find</div>
      <div class="q-grid">${QUICK.filter(q => !q.report && ['fuel', 'food', 'coffee', 'rest', 'services', 'toilets'].includes(q.k)).map(qBtn).join('')}</div>
      <div class="q-sub">Report for everyone</div>
      <div class="q-grid">${QUICK.filter(q => q.report).map(qBtn).join('')}</div>
      <div class="q-sub">More</div>
      <div class="q-grid">${QUICK.filter(q => ['park', 'car', 'eta', 'home', 'mute', 'hud'].includes(q.k)).map(qBtn).join('')}</div>
    </div>`;
  el.hidden = false;
  $('qClose').onclick = () => { el.hidden = true; };
  el.onclick = e => {
    if (e.target === el) { el.hidden = true; return; }
    const b = e.target.closest('[data-q]');
    if (!b) return;
    el.hidden = true;
    audio();
    QUICK.find(q => q.k === b.dataset.q).go();
  };
}
const qBtn = q => `<button class="q-btn${q.report ? ' rep' : ''}" data-q="${q.k}"><span>${q.icon}</span>${q.label}</button>`;

(function buildQuickUi() {
  document.body.insertAdjacentHTML('beforeend', '<div id="quick" hidden></div>');
  const fab = document.createElement('button');
  fab.id = 'bQuick'; fab.className = 'fab quickfab'; fab.textContent = '⚡'; fab.title = 'Quick actions';
  fab.onclick = openQuick;
  $('tab-map').append(fab);
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h2>Parking &amp; sharing</h2>
    <label class="sw"><input type="checkbox" id="optAutoPark"> Remember where I parked when a drive ends</label>
    <button id="qPark">🚗 Save parking here</button> <button id="qCar">📍 Find my car</button> <button id="qEta">📤 Share ETA / location</button>`;
  $('slot-traffic').before(card);
  bindOpt('optAutoPark', 'autoPark');
  $('qPark').onclick = () => saveParking();
  $('qCar').onclick = () => { showTab('map'); walkToCar(); };
  $('qEta').onclick = shareEta;
  drawParking();
})();
