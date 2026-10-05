'use strict';
// App version + update check (Android app): asks GitHub for the latest release
// of real-CAK3D/WhatTheFlock at most twice a day and offers the download when
// it's newer. Fails silently offline. Version comes from version.js (APK build).

const UPDATE_API = 'https://api.github.com/repos/real-CAK3D/WhatTheFlock/releases/latest';
const UPDATE_KEY = 'fy.update';

const verParts = v => String(v || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
function isNewer(a, b) {   // a > b ?
  const x = verParts(a), y = verParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
}

async function checkForUpdate(force = false) {
  const cur = window.FY_VERSION;
  if (!cur || !navigator.onLine) return null;
  let st = {};
  try { st = JSON.parse(localStorage.getItem(UPDATE_KEY)) || {}; } catch {}
  if (!force && st.at && Date.now() - st.at < 12 * 3600e3) { paintUpdate(st.latest); return st.latest; }
  try {
    const r = await fetch(UPDATE_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rel = await r.json();
    const apk = (rel.assets || []).find(a => /\.apk$/i.test(a.name));
    const latest = { tag: rel.tag_name, url: apk ? apk.browser_download_url : rel.html_url, page: rel.html_url, notes: (rel.body || '').slice(0, 400) };
    try { localStorage.setItem(UPDATE_KEY, JSON.stringify({ at: Date.now(), latest })); } catch {}
    paintUpdate(latest);
    if (isNewer(latest.tag, cur) && !force) toast(`Update available: What the Flock! ${latest.tag} — Settings → Setup`);
    return latest;
  } catch { return null; }
}

function paintUpdate(latest) {
  const el = $('updRow');
  if (!el) return;
  const cur = window.FY_VERSION;
  if (latest && cur && isNewer(latest.tag, cur)) {
    el.innerHTML = `<div class="setup-row"><span class="dot"></span><div class="setup-body"><b>Update available: ${esc(latest.tag)}</b>
      <div class="mute small1">You have v${esc(cur)}. ${esc(latest.notes)}</div></div><button id="updGo" class="primary">Download</button></div>`;
    $('updGo').onclick = () => window.open(latest.url, '_blank');
  } else {
    el.innerHTML = `<p class="mute small1">${cur ? `What the Flock! v${esc(cur)}${latest ? ' — up to date' : ''}` : 'What the Flock! (web version — updates arrive automatically)'}
      ${cur ? ' · <a href="#" id="updCheck">Check for updates</a>' : ''}</p>`;
    if ($('updCheck')) $('updCheck').onclick = async e => { e.preventDefault(); const l = await checkForUpdate(true); toast(l ? (isNewer(l.tag, cur) ? `${l.tag} is available` : 'You have the latest version') : 'Could not reach GitHub'); };
  }
}

(function buildUpdateUi() {
  const card = [...document.querySelectorAll('#tab-set .card h2')].find(h => h.textContent.startsWith('Setup'))?.parentElement;
  if (card) card.insertAdjacentHTML('afterbegin', '<div id="updRow"></div>');
  paintUpdate(null);
  if (window.FY_VERSION) setTimeout(() => checkForUpdate(false), 8000);
})();
