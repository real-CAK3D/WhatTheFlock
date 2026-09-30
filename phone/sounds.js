'use strict';
// Phone-side alerts: synthesized sounds (Web Audio — no audio files, works
// offline, plays through car Bluetooth if the phone is connected), spoken
// alerts (speechSynthesis), vibration and system notifications.
// Loaded after basemap.js; app.js/layers.js call onDetectionAlert/onMappedAlert.

const SLOTS = {
  t4:     { label: 'Tier 4 (fingerprint)',  def: 'siren' },
  t3:     { label: 'Tier 3 (wildcard probe)', def: 'chirp' },
  t2:     { label: 'Tier 2 (OUI / BLE)',     def: 'double' },
  t1:     { label: 'Tier 1 & 0 (weak)',      def: 'beep' },
  mapped: { label: 'Mapped camera ahead',    def: 'chime' },
  usb:    { label: 'Board connect / unplug', def: 'blip' },
};

let actx = null, master = null;
function audio() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    actx = new AC();
    master = actx.createGain();
    master.connect(actx.destination);
  }
  if (actx.state === 'suspended') actx.resume();
  master.gain.value = (opts.volume ?? 80) / 100;
  return actx;
}
// Browsers only allow audio after a user gesture; unlock on the first touch.
['pointerdown', 'keydown'].forEach(ev => window.addEventListener(ev, () => audio(), { once: true, capture: true }));

// One oscillator note with an attack/decay envelope, optional pitch slide.
function note(t0, freq, dur, { type = 'sine', vol = 0.6, slideTo = null, decay = false } = {}) {
  const a = actx, o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.linearRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
  if (decay) g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  else { g.gain.setValueAtTime(vol, t0 + Math.max(dur - 0.02, 0.01)); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); }
  o.connect(g); g.connect(master);
  o.start(t0); o.stop(t0 + dur + 0.02);
}
function click(t0) {
  const a = actx, len = Math.floor(a.sampleRate * 0.004);
  const buf = a.createBuffer(1, len, a.sampleRate), ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const s = a.createBufferSource(), g = a.createGain();
  g.gain.value = 0.9; s.buffer = buf; s.connect(g); g.connect(master); s.start(t0);
}

const SOUNDS = {
  none:   { label: 'Silent',       play: () => {} },
  beep:   { label: 'Beep',         play: t => note(t, 1000, 0.15) },
  double: { label: 'Double beep',  play: t => { note(t, 1200, 0.1); note(t + 0.16, 1200, 0.1); } },
  chirp:  { label: 'Chirp',        play: t => { note(t, 1400, 0.09); note(t + 0.11, 1800, 0.12); } },
  siren:  { label: 'Siren',        play: t => { note(t, 650, 0.5, { type: 'sawtooth', vol: 0.35, slideTo: 1450 }); note(t + 0.5, 1450, 0.5, { type: 'sawtooth', vol: 0.35, slideTo: 650 }); } },
  sonar:  { label: 'Sonar ping',   play: t => { note(t, 1150, 1.2, { decay: true, vol: 0.7 }); note(t + 0.35, 1150, 0.8, { decay: true, vol: 0.2 }); } },
  chime:  { label: 'Chime',        play: t => { note(t, 1047, 0.6, { decay: true }); note(t + 0.15, 1319, 0.6, { decay: true }); note(t + 0.3, 1568, 0.9, { decay: true }); } },
  alarm:  { label: 'Alarm pulses', play: t => { for (let i = 0; i < 6; i++) note(t + i * 0.12, 2000, 0.07, { type: 'square', vol: 0.3 }); } },
  warble: { label: 'Warble',       play: t => { for (let i = 0; i < 6; i++) note(t + i * 0.1, i % 2 ? 1300 : 900, 0.1, { type: 'triangle' }); } },
  geiger: { label: 'Geiger',       play: t => { for (let i = 0; i < 10; i++) click(t + i * 0.05 + Math.random() * 0.04); } },
  blip:   { label: 'Soft blip',    play: t => note(t, 660, 0.12, { vol: 0.35, decay: true }) },
};

opts.sounds = { ...Object.fromEntries(Object.entries(SLOTS).map(([k, v]) => [k, v.def])), ...(opts.sounds || {}) };
opts.volume = opts.volume ?? 80;
opts.output = opts.output ?? 'both';        // 'both' | 'phone' | 'board'
opts.soundWhen = opts.soundWhen ?? 'new';   // 'new' | 'every'
opts.voice = opts.voice ?? false;
opts.notify = opts.notify ?? true;
opts.muted = opts.muted ?? false;

function playSound(name) {
  const s = SOUNDS[name];
  if (!s || !audio()) return;
  s.play(actx.currentTime + 0.02);
}
function playEvent(slot) {
  if (opts.muted || opts.output === 'board') return;
  playSound(opts.sounds[slot]);
}

function speak(text) {
  if (!opts.voice || opts.muted || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text.replace(/ ft\b/g, ' feet').replace(/ mi\b/g, ' miles').replace(/ km\b/g, ' kilometres').replace(/ m\b/g, ' metres'));
  u.rate = 1.05;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

async function notify(title, body, tag) {
  if (!opts.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return;   // the in-app toast already shows it
  if (window.fyNativeNotify) return window.fyNativeNotify(title, body, tag);   // Android app (native.js)
  try {
    const reg = await navigator.serviceWorker?.ready;
    const o = { body, tag, renotify: true, icon: 'icon.svg', badge: 'icon.svg', vibrate: opts.vibe ? [200, 100, 200] : undefined };
    if (reg) reg.showNotification(title, o); else new Notification(title, o);
  } catch {}
}

const lastAlertAt = new Map();
const tierSlot = t => t >= 4 ? 't4' : t === 3 ? 't3' : t === 2 ? 't2' : 't1';
const VIBES = { t4: [300, 100, 300, 100, 300], t3: [250, 100, 250], t2: [200], t1: [80] };
const signalWord = r => r >= -60 ? 'strong' : r >= -75 ? 'medium' : 'weak';

function onDetectionAlert(d, isNew, tier, rssi) {
  if (!isNew && opts.soundWhen === 'new') return;
  const now = Date.now();
  if (!isNew && now - (lastAlertAt.get(d.mac) || 0) < 4000) return;
  lastAlertAt.set(d.mac, now);
  const slot = tierSlot(tier);
  playEvent(slot);
  if (opts.vibe && !opts.muted && navigator.vibrate) navigator.vibrate(VIBES[slot]);
  if (isNew) {
    toast(`New camera · tier ${tier} · ${d.mac}`, tier >= 3);
    // Voice + notification per the Voice & alerts settings (announce.js).
    announce('flock', `Flock camera detected. Tier ${tier}. ${signalWord(rssi)} signal.`,
      { title: `New camera · tier ${tier}`, body: `${d.mac} · ${rssi} dBm · ${TIER_NAMES[tier] || d.method}`, tag: 'fy-' + d.mac });
  }
}

function onMappedAlert(p, what, dist, msg) {
  toast(msg, true);
  playEvent('mapped');
  if (opts.vibe && !opts.muted && navigator.vibrate) navigator.vibrate([150, 80, 150]);
  announce('cameras', `${what} ahead. ${fmtDist(dist)}.`, { title: `${what} ahead`, body: msg, tag: 'fy-map-' + p.id });
}

// Board buzzer follows the output choice: 'phone' silences it, others restore
// the mask that was on the board before (or all tiers).
function applyOutputToBoard() {
  if (!dev) return;
  if (opts.output === 'phone') {
    if (beepMask && beepMask !== 0) { opts.savedBoardMask = beepMask; saveOpts(); }
    send({ cmd: 'set_beep_mask', mask: 0 });
  } else {
    send({ cmd: 'set_beep_mask', mask: opts.savedBoardMask ?? 31 });
  }
}

// ---------------------------------------------------------------- UI

(function buildSoundUi() {
  const opt = sel => Object.entries(SOUNDS).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v.label}</option>`).join('');
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h2>Sounds &amp; alerts</h2>
    <p class="mute">Phone sounds play through the speaker, headphones or car Bluetooth.</p>
    <label class="sw">Alerts play on
      <select id="optOutput"><option value="both">Phone + board</option><option value="phone">Phone only (board silent)</option><option value="board">Board buzzer only</option></select>
    </label>
    <label class="sw">Play a sound for
      <select id="optSoundWhen"><option value="new">New cameras only</option><option value="every">Every detection</option></select>
    </label>
    <label class="sw">Volume <input type="range" id="optVolume" min="0" max="100" step="5" style="flex:1;max-width:55%"></label>
    <div class="snd-grid">
      ${Object.entries(SLOTS).map(([k, v]) => `
        <span>${v.label}</span>
        <select data-slot="${k}">${opt(opts.sounds[k])}</select>
        <button data-test="${k}" title="Play">▶</button>`).join('')}
    </div>
    <label class="sw"><input type="checkbox" id="optNotify"> Allow notifications when the app is in the background</label>
    <p class="mute small1">What gets read aloud is set per kind of alert under Voice &amp; alerts.</p>`;
  $('slot-sounds').append(card);

  $('optOutput').value = opts.output;
  $('optOutput').onchange = e => { opts.output = e.target.value; saveOpts(); applyOutputToBoard(); };
  $('optSoundWhen').value = opts.soundWhen;
  $('optSoundWhen').onchange = e => { opts.soundWhen = e.target.value; saveOpts(); };
  $('optVolume').value = opts.volume;
  $('optVolume').oninput = e => { opts.volume = Number(e.target.value); if (master) master.gain.value = opts.volume / 100; saveOpts(); };
  bindOpt('optNotify', 'notify', () => { if (opts.notify && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission(); });
  card.querySelectorAll('[data-slot]').forEach(s => s.onchange = () => { opts.sounds[s.dataset.slot] = s.value; saveOpts(); playSound(s.value); });
  card.querySelectorAll('[data-test]').forEach(b => b.onclick = () => playSound(opts.sounds[b.dataset.test]));

  // Quick mute on the map.
  const mute = document.createElement('button');
  mute.id = 'bMute'; mute.className = 'fab mute';
  const paint = () => { mute.textContent = opts.muted ? '🔕' : '🔔'; mute.classList.toggle('on', !opts.muted); };
  mute.onclick = () => { opts.muted = !opts.muted; saveOpts(); paint(); toast(opts.muted ? 'Phone alerts muted' : 'Phone alerts on'); if (!opts.muted) playEvent('usb'); };
  paint();
  $('tab-map').append(mute);
})();

// Re-apply the output choice whenever the board (re)connects and reports its config.
const _renderBeeps = renderBeeps;
let outputApplied = false;
renderBeeps = function (cfg) {
  _renderBeeps(cfg);
  if (!outputApplied) { outputApplied = true; if (opts.output === 'phone' && cfg.beep_mask !== 0) applyOutputToBoard(); }
};
navigator.usb?.addEventListener('disconnect', () => { outputApplied = false; });
