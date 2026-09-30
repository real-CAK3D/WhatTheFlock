'use strict';
// Diagnostics: collects what's working (USB bridge, GPS, voice, notifications,
// storage) plus recent errors and log lines, and posts them to the PC
// (reports server /diag → reports/diag.log) so problems can be checked
// remotely. Sent once shortly after start in the Android app, and on demand.

// The Android bridge (native.js) starts collecting before any app script runs.
const diagErrors = window.__fyErrors || [];
if (!window.__fyErrors) {
  window.addEventListener('error', e => diagErrors.push(`${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`));
  window.addEventListener('unhandledrejection', e => diagErrors.push('promise: ' + (e.reason?.message || e.reason)));
}

async function collectDiag(reason) {
  const perm = async n => { try { return (await navigator.permissions.query({ name: n })).state; } catch { return 'n/a'; } };
  let usbDevices = 'n/a';
  try { usbDevices = (await navigator.usb.getDevices()).map(d => `${d.vendorId?.toString(16)}:${d.productId?.toString(16)}`).join(',') || 'none'; } catch (e) { usbDevices = 'error ' + e.message; }
  const est = navigator.storage?.estimate ? await navigator.storage.estimate().catch(() => null) : null;
  return {
    reason, at: new Date().toISOString(), ua: navigator.userAgent,
    native: !!window.FY_NATIVE, installed: matchMedia('(display-mode: standalone)').matches,
    usbApi: 'usb' in navigator, usbDevices, boardConnected: !!dev,
    gps: fix ? { acc: fix.acc, ageS: Math.round((Date.now() - fix.ts) / 1000), spd: fix.spd } : null,
    geoPerm: await perm('geolocation'), notif: window.Notification?.permission,
    speech: 'speechSynthesis' in window, sw: !!navigator.serviceWorker?.controller,
    storageMB: est ? Math.round(est.usage / 1e6) : null, online: navigator.onLine,
    view3d: !!opts.view3d, navigating: typeof nav !== 'undefined' && !!nav,
    errors: diagErrors.slice(-20), log: (typeof logLines !== 'undefined' ? logLines : []).slice(-40).map(l => l.line),
  };
}

async function sendDiag(reason = 'manual') {
  const url = (window.FY_REPORTS_URL || '/reports/') + 'diag';
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await collectDiag(reason)) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (reason === 'manual') toast('Diagnostics sent to the PC');
  } catch (e) { if (reason === 'manual') toast('Could not send (is Tailscale on?): ' + e.message); }
}

(function buildDiagUi() {
  const card = [...document.querySelectorAll('#tab-set .card h2')].find(h => h.textContent.startsWith('Setup'))?.parentElement;
  if (card) {
    card.insertAdjacentHTML('beforeend', '<button id="bDiag">Send diagnostics to PC</button>');
    $('bDiag').onclick = () => sendDiag('manual');
  }
  // In the Android app, report in automatically after start-up (and again after
  // a minute, once GPS/USB have had a chance to connect).
  if (window.FY_NATIVE) { setTimeout(() => sendDiag('startup'), 15000); setTimeout(() => sendDiag('after-1-min'), 70000); }
})();
