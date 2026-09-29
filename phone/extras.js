'use strict';
// Setup checklist (permissions: location, notifications, persistent storage,
// USB, install, sound), the camera finder ("hot/cold" RSSI + Geiger clicks),
// and the online indicator. Loaded after sounds.js.

// ---------------------------------------------------------------- install prompt

let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; refreshSetup(); });
window.addEventListener('appinstalled', () => { installEvt = null; refreshSetup(); });
const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// ---------------------------------------------------------------- checklist

async function permState(name) {
  try { return (await navigator.permissions.query({ name })).state; } catch { return 'unknown'; }
}
const fmtBytes = b => b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(0) + ' MB' : Math.round(b / 1e3) + ' KB';

async function setupItems() {
  const geo = await permState('geolocation');
  const notif = 'Notification' in window ? Notification.permission : 'unsupported';
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
  const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
  const usbPaired = 'usb' in navigator ? (await navigator.usb.getDevices()).some(d => d.vendorId === ESPRESSIF_VID) : false;
  const soundOk = !!(actx && actx.state === 'running');
  return [
    { id: 'geo', key: true, title: 'Location (GPS)',
      ok: geo === 'granted', state: geo === 'granted' ? 'Allowed' : geo === 'denied' ? 'Blocked' : 'Not asked yet',
      help: geo === 'denied' ? 'Blocked in Chrome. Tap the lock/tune icon left of the address → Permissions → Location → Allow. Also make sure phone Location is on and set to Precise.' : 'Tags every detection with where you were and runs the map and alerts. Works with no cell service.',
      btn: geo === 'denied' ? null : 'Allow',
      act: () => new Promise(r => navigator.geolocation.getCurrentPosition(r, r, { enableHighAccuracy: true, timeout: 20000 })) },
    { id: 'store', key: true, title: 'Save to phone (keep data)',
      ok: persisted, state: (persisted ? 'Protected' : 'Not protected') + (est ? ` · ${fmtBytes(est.usage || 0)} used of ${fmtBytes(est.quota || 0)}` : ''),
      help: persisted ? 'Android will not auto-delete your detections, offline maps or settings.' : 'Asks Android not to clear this app\'s data when storage runs low. Chrome grants this more readily once the app is installed and notifications are allowed.',
      btn: persisted ? null : 'Protect',
      act: async () => { const ok = await navigator.storage.persist(); toast(ok ? 'Storage protected' : 'Chrome declined for now — install the app and allow notifications, then try again'); } },
    { id: 'usb', key: true, title: 'XIAO board (USB)',
      ok: usbPaired, state: dev ? 'Connected' : usbPaired ? 'Allowed — reconnects when plugged in' : 'Not allowed yet',
      help: 'Plug the board into the phone\'s USB-C port, tap Allow and pick the Espressif device. After that it connects automatically.',
      btn: dev ? null : 'Allow', act: () => $('bConnect').click() },
    { id: 'install', key: true, title: 'Installed as an app',
      ok: isInstalled(), state: isInstalled() ? 'Installed' : 'Running in a browser tab',
      help: 'Installing lets it open full-screen from your home screen and work with no internet.' + (installEvt ? '' : ' If the button does nothing: Chrome ⋮ menu → Add to Home screen → Install.'),
      btn: isInstalled() ? null : 'Install',
      act: async () => { if (installEvt) { installEvt.prompt(); await installEvt.userChoice; installEvt = null; } else toast('Chrome ⋮ menu → Add to Home screen'); } },
    { id: 'notif', key: false, title: 'Notifications',
      ok: notif === 'granted', state: notif === 'granted' ? 'Allowed' : notif === 'denied' ? 'Blocked' : notif === 'unsupported' ? 'Not supported' : 'Not asked yet',
      help: notif === 'denied' ? 'Blocked. Android Settings → Apps → Chrome (or Flock You) → Notifications.' : 'Alerts you when a camera is found while you are in another app.',
      btn: notif === 'default' ? 'Allow' : null, act: () => Notification.requestPermission() },
    { id: 'sound', key: false, title: 'Sound',
      ok: soundOk, state: soundOk ? 'Ready' : 'Tap Test once to enable',
      help: 'Browsers only play sound after you tap something. Also check the phone\'s media volume.',
      btn: 'Test', act: () => { audio(); playSound(opts.sounds.t4); } },
    { id: 'wake', key: false, title: 'Keep screen on',
      ok: 'wakeLock' in navigator, state: 'wakeLock' in navigator ? (opts.wake ? 'On while the board is connected' : 'Off (Phone settings below)') : 'Not supported',
      help: 'Chrome pauses the app when the screen turns off, so the screen stays on while logging.', btn: null },
  ];
}

async function refreshSetup() {
  const items = await setupItems();
  const box = $('setupList');
  if (box) box.innerHTML = items.map(i => `
    <div class="setup-row">
      <span class="dot ${i.ok ? 'on' : ''}"></span>
      <div class="setup-body"><b>${i.title}</b> <span class="mute">· ${esc(i.state)}</span><div class="mute small1">${esc(i.help)}</div></div>
      ${i.btn ? `<button data-setup="${i.id}">${i.btn}</button>` : ''}
    </div>`).join('');
  box && box.querySelectorAll('[data-setup]').forEach(b => b.onclick = async () => {
    const it = items.find(x => x.id === b.dataset.setup);
    try { await it.act(); } catch (e) { toast(e.message); }
    setTimeout(refreshSetup, 400);
  });
  const missing = items.filter(i => i.key && !i.ok);
  const banner = $('setupBanner');
  banner.hidden = !missing.length || opts.setupDismissed;
  $('setupBannerText').textContent = `Setup: ${missing.map(i => i.title.split(' (')[0]).join(', ')} still needed`;
}

(function buildSetupUi() {
  const card = document.createElement('div');
  card.className = 'card';
  card.id = 'setupCard';
  card.innerHTML = `<h2>Setup &amp; permissions</h2><div id="setupList"></div>
    <label class="sw"><input type="checkbox" id="optSetupHide"> Hide the setup reminder banner</label>`;
  $('slot-setup').append(card);
  bindOpt('optSetupHide', 'setupDismissed', refreshSetup);
  $('bSetupGo').onclick = () => { showTab('set'); refreshSetup(); card.scrollIntoView({ behavior: 'smooth' }); };
  for (const n of ['geolocation', 'notifications']) {
    navigator.permissions?.query({ name: n }).then(s => { s.onchange = refreshSetup; }).catch(() => {});
  }
  document.querySelector('nav [data-tab="set"]').addEventListener('click', refreshSetup);
  navigator.usb?.addEventListener('connect', () => setTimeout(refreshSetup, 800));
  refreshSetup();
})();

// ---------------------------------------------------------------- online indicator

function paintNet() { $('netStat').classList.toggle('on', navigator.onLine); }
window.addEventListener('online', paintNet);
window.addEventListener('offline', paintNet);
paintNet();

// ---------------------------------------------------------------- finder

let finderMac = null, finderRssi = null, finderPrev = null, finderAt = 0, finderTimer = null, clickAcc = 0;

function openFinder(mac) {
  finderMac = mac;
  const h = [...data.hits].reverse().find(x => x.mac === mac);
  finderRssi = h ? h.rssi : null; finderPrev = null; finderAt = h ? h.ts : 0;
  $('finderMac').textContent = mac;
  $('finder').hidden = false;
  audio();
  paintFinder();
  clearInterval(finderTimer);
  finderTimer = setInterval(finderTick, 50);
  if (!dev) toast('Connect the board to get live signal readings');
}
function closeFinder() {
  $('finder').hidden = true; finderMac = null; clearInterval(finderTimer);
}
function findOnHit(mac, rssi) {
  if (mac !== finderMac) return;
  finderPrev = finderRssi; finderRssi = rssi; finderAt = Date.now();
  paintFinder();
  if (opts.vibe && navigator.vibrate) navigator.vibrate(40);
}
function paintFinder() {
  const r = finderRssi;
  $('finderRssi').textContent = r == null ? 'waiting…' : r + ' dBm';
  const pct = r == null ? 0 : Math.max(0, Math.min(100, (r + 100) / 70 * 100));
  $('finderFill').style.width = pct + '%';
  $('finderFill').style.background = pct > 66 ? 'var(--t4)' : pct > 33 ? 'var(--t3)' : 'var(--t1)';
  const trend = finderPrev == null || r == null ? '' : r > finderPrev + 2 ? '▲ getting closer' : r < finderPrev - 2 ? '▼ getting farther' : '• about the same';
  $('finderInfo').textContent = [trend, finderAt ? 'last heard ' + ago(finderAt) : 'not heard yet'].filter(Boolean).join(' · ');
}
// Click rate rises with signal strength; fades out if the camera goes quiet.
let finderTicks = 0;
function finderTick() {
  if (++finderTicks % 20 === 0) paintFinder();   // refresh "last heard" once a second
  if (!$('finderSound').checked || finderRssi == null || opts.muted || !actx) return;
  const age = (Date.now() - finderAt) / 1000;
  const strength = Math.max(0, Math.min(1, (finderRssi + 100) / 60));
  const perSec = (0.5 + strength * 14) * Math.max(0.1, 1 - age / 30);
  clickAcc += perSec * 0.05;
  if (Math.random() < clickAcc) { clickAcc = 0; click(actx.currentTime + 0.01); }
}
$('bFinderClose').onclick = closeFinder;
