'use strict';
// HUD: on-map speedometer styles, and a full-screen driving HUD — big speed,
// limit, next turn, next corner (co-driver), next camera — with a mirror mode
// for reflecting off the windshield at night, and colour themes.
// Loaded after drives.js; reads state from speed.js (speedNowKmh, limitNow,
// overNow), nav.js (nav), codriver.js and layers.js.

opts.hudStyle = opts.hudStyle || 'classic';   // on-map speedometer: classic | compact | big
opts.hudColor = opts.hudColor || 'green';     // full HUD: green | white | amber | cyan
opts.hudMirror = opts.hudMirror ?? false;
const HUD_COLORS = ['green', 'white', 'amber', 'cyan'];

// ---------------------------------------------------------------- on-map speedometer style

function applyHudStyle() {
  const s = $('speedo');
  if (!s) return;
  s.classList.remove('st-classic', 'st-compact', 'st-big');
  s.classList.add('st-' + opts.hudStyle);
}

// ---------------------------------------------------------------- full-screen HUD

let hudTimer = null, hudFlash = null;

function hudOpen() {
  const el = $('hud');
  el.hidden = false;
  paintHudTheme();
  requestWake();
  // Full screen hides the status and navigation bars; ignored where unsupported.
  document.documentElement.requestFullscreen?.().catch(() => {});
  clearInterval(hudTimer);
  hudTimer = setInterval(paintHud, 300);
  paintHud();
}
function hudClose() {
  $('hud').hidden = true;
  clearInterval(hudTimer);
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  if (!dev && !(typeof nav !== 'undefined' && nav)) releaseWake();
}
function paintHudTheme() {
  const el = $('hud');
  HUD_COLORS.forEach(c => el.classList.toggle('c-' + c, c === opts.hudColor));
  el.classList.toggle('mirror', !!opts.hudMirror);
}

// Nearest mapped plate reader / speed camera ahead when not navigating.
function hudCameraAhead() {
  if (typeof nav !== 'undefined' && nav) {
    const c = nav.rt.cams.find(x => x.at > nav.along - 20);
    return c ? { d: c.at - nav.along, kind: c.p.kind } : null;
  }
  if (!fix || typeof allItems !== 'function') return null;
  const moving = fix.spd > 3 && fix.hdg != null && !Number.isNaN(fix.hdg);
  let best = null;
  for (const p of allItems()) {
    if (p.kind !== 'alpr' && p.kind !== 'enf') continue;
    const d = distM(fix, p);
    if (d > 3000 || (moving && angDiff(bearingDeg(fix, p), fix.hdg) > 45)) continue;
    if (!best || d < best.d) best = { d, kind: p.kind };
  }
  return best;
}

function paintHud() {
  if ($('hud').hidden) return;
  const units = opts.units === 'metric' ? 'km/h' : 'mph';
  const v = speedNowKmh == null ? null : Math.round(opts.units === 'metric' ? speedNowKmh : speedNowKmh / 1.60934);
  $('hudSpeed').textContent = v == null ? '--' : v;
  $('hudUnit').textContent = units;
  $('hud').classList.toggle('over', !!overNow);
  const lim = $('hudLimit');
  lim.hidden = !limitNow;
  if (limitNow) lim.innerHTML = `<small>LIMIT</small>${limitNow.v}${limitNow.est ? '<i>est</i>' : ''}`;
  const hint = $('spdHint');
  $('hudHint').textContent = hint && !hint.hidden ? hint.textContent : '';

  // Next turn (navigating).
  const navOn = typeof nav !== 'undefined' && nav;
  const turn = $('hudTurn');
  if (navOn) {
    const st = nav.rt.steps[nav.stepIdx];
    const d = Math.max(0, st._at - nav.along);
    const road = st.name || st.ref || '';
    turn.innerHTML = `<b>${stepArrow(st)}</b><span>${fmtDist(d)}</span><em>${esc(road || stepText(st))}</em>`;
    const left = Math.max(0, nav.rt.total - nav.along);
    $('hudEta').textContent = `${fmtClock(Date.now() + nav.rt.duration * (left / nav.rt.total) * 1000)} · ${fmtDist(left)}`;
  } else { turn.innerHTML = ''; $('hudEta').textContent = ''; }

  // Next corner (co-driver on).
  const corner = $('hudCorner');
  if (navOn && opts.codriver !== 'off' && typeof cdCorners === 'function') {
    const c = cdCorners(nav.rt).find(x => x.end > nav.along && x.start - nav.along < 600);
    corner.innerHTML = c ? `<b>${c.dir === 'left' ? '↰' : '↱'} ${cdShort(c)}</b><span>${fmtDist(Math.max(0, c.start - nav.along))}</span>${c.mods.length ? `<em>${c.mods.join(' ')}</em>` : ''}` : '';
  } else corner.innerHTML = '';

  // Next camera.
  const cam = hudCameraAhead();
  $('hudCam').innerHTML = cam ? `<b>📷</b><span>${fmtDist(cam.d)}</span><em>${cam.kind === 'alpr' ? 'plate reader' : 'speed camera'}</em>` : '';

  $('hudClock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  // Live detection from the board: big banner for a few seconds.
  const fl = $('hudAlert');
  fl.hidden = !(hudFlash && Date.now() < hudFlash.until);
  if (!fl.hidden) fl.textContent = hudFlash.text;
}

// Show live board detections and mapped-camera alerts on the HUD too.
const _onDet = onDetectionAlert;
onDetectionAlert = function (d, isNew, tier, rssi) {
  _onDet(d, isNew, tier, rssi);
  if (isNew || tier >= 3) hudFlash = { text: `FLOCK · TIER ${tier}`, until: Date.now() + 6000 };
};
const _onMapped = onMappedAlert;
onMappedAlert = function (p, what, dist, msg) {
  _onMapped(p, what, dist, msg);
  hudFlash = { text: `${what.toUpperCase()} · ${fmtDist(dist)}`, until: Date.now() + 5000 };
};

// ---------------------------------------------------------------- UI

(function buildHudUi() {
  document.body.insertAdjacentHTML('beforeend', `
    <div id="hud" hidden>
      <div class="hud-in">
        <div class="hud-top"><span id="hudClock"></span><span id="hudEta"></span></div>
        <div class="hud-alert" id="hudAlert" hidden></div>
        <div class="hud-main">
          <div class="hud-speed"><div id="hudSpeed">--</div><div id="hudUnit">mph</div></div>
          <div class="hud-side"><div id="hudLimit" hidden></div><div id="hudHint"></div></div>
        </div>
        <div class="hud-row" id="hudTurn"></div>
        <div class="hud-row" id="hudCorner"></div>
        <div class="hud-row" id="hudCam"></div>
      </div>
      <div class="hud-ctl">
        <button id="hudMirrorBtn" title="Mirror for windshield reflection">⇋ Mirror</button>
        <button id="hudColorBtn">Color</button>
        <button id="hudExit">✕ Close</button>
      </div>
    </div>`);
  $('hudExit').onclick = hudClose;
  $('hudMirrorBtn').onclick = () => { opts.hudMirror = !opts.hudMirror; saveOpts(); paintHudTheme(); syncHudCard(); };
  $('hudColorBtn').onclick = () => { opts.hudColor = HUD_COLORS[(HUD_COLORS.indexOf(opts.hudColor) + 1) % HUD_COLORS.length]; saveOpts(); paintHudTheme(); syncHudCard(); };

  const fab = document.createElement('button');
  fab.id = 'bHud'; fab.className = 'fab hudfab'; fab.textContent = 'HUD'; fab.title = 'Full-screen driving HUD';
  fab.onclick = hudOpen;
  $('tab-map').append(fab);

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h2>HUD</h2>
    <label class="sw">Map speedometer
      <select id="optHudStyle"><option value="classic">Classic</option><option value="compact">Compact</option><option value="big">Big</option></select></label>
    <label class="sw">Full-screen HUD color
      <select id="optHudColor"><option value="green">Green</option><option value="white">White</option><option value="amber">Amber</option><option value="cyan">Cyan</option></select></label>
    <label class="sw"><input type="checkbox" id="optHudMirror"> Mirror (for reflecting off the windshield)</label>
    <button id="hudOpenBtn" class="primary">Open full-screen HUD</button>
    <p class="mute small1">For the windshield: turn Mirror on, set the phone flat on the dash under the glass, and use it at night or dusk — reflections are faint in daylight.</p>`;
  $('slot-traffic').before(card);
  $('optHudStyle').value = opts.hudStyle;
  $('optHudStyle').onchange = e => { opts.hudStyle = e.target.value; saveOpts(); applyHudStyle(); };
  $('optHudColor').onchange = e => { opts.hudColor = e.target.value; saveOpts(); paintHudTheme(); };
  $('optHudMirror').onchange = e => { opts.hudMirror = e.target.checked; saveOpts(); paintHudTheme(); };
  $('hudOpenBtn').onclick = hudOpen;
  syncHudCard();
  applyHudStyle();
})();

function syncHudCard() {
  if ($('optHudColor')) $('optHudColor').value = opts.hudColor;
  if ($('optHudMirror')) $('optHudMirror').checked = !!opts.hudMirror;
}
