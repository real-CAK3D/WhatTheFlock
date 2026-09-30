'use strict';
// Android app bridge. Android's WebView lacks WebUSB, speech synthesis and
// background GPS, so inside the Capacitor app this maps the browser APIs the
// web app already uses onto native plugins:
//   navigator.usb          -> UsbSerial (our CDC-ACM plugin, UsbSerialPlugin.java)
//   speechSynthesis        -> TextToSpeech
//   notifications          -> LocalNotifications
//   geolocation.watchPosition -> BackgroundGeolocation (foreground service, keeps
//                              running with the screen off)
// Loaded before the app's own scripts; does nothing in a normal browser.
(function () {
  const C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return;
  window.FY_NATIVE = true;
  // Catch errors from the very first script on, for diagnostics (diag.js).
  window.__fyErrors = [];
  window.addEventListener('error', e => window.__fyErrors.push(`${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`));
  window.addEventListener('unhandledrejection', e => window.__fyErrors.push('promise: ' + (e.reason?.message || e.reason)));
  // Shared reports live on the PC; the app's pages are served from the APK.
  window.FY_REPORTS_URL = 'https://nukebox.tailac984b.ts.net/reports/';
  const plugin = name => (C.registerPlugin ? C.registerPlugin(name) : C.Plugins[name]);

  const b64enc = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const b64dec = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  // ---------------------------------------------------------------- USB
  const Usb = plugin('UsbSerial');
  const listeners = { connect: [], disconnect: [] };
  let rxQueue = [], rxWaiters = [];
  const failPending = why => { const w = rxWaiters; rxWaiters = []; w.forEach(x => x.reject(new Error(why))); };
  Usb.addListener('data', e => {
    const u8 = b64dec(e.data);
    const result = { status: 'ok', data: new DataView(u8.buffer) };
    if (rxWaiters.length) rxWaiters.shift().resolve(result); else rxQueue.push(result);
  });

  // Just enough of a WebUSB USBDevice for app.js's CDC code path.
  class NativeUsbDevice {
    constructor(info) {
      Object.assign(this, info);
      this.opened = false;
      this.configuration = { interfaces: [
        { interfaceNumber: 0, alternates: [{ interfaceClass: 0x02, endpoints: [] }] },
        { interfaceNumber: 1, alternates: [{ interfaceClass: 0x0a, endpoints: [
          { type: 'bulk', direction: 'in', endpointNumber: 1 }, { type: 'bulk', direction: 'out', endpointNumber: 1 }] }] },
      ] };
    }
    async open() { await Usb.open({ vendorId: this.vendorId }); this.opened = true; rxQueue = []; }
    async selectConfiguration() {}
    async claimInterface() {}
    async controlTransferOut() { return { status: 'ok' }; }   // native side sets 115200 8N1 + DTR
    transferIn() {
      if (!this.opened) return Promise.reject(new Error('device closed'));
      if (rxQueue.length) return Promise.resolve(rxQueue.shift());
      return new Promise((resolve, reject) => rxWaiters.push({ resolve, reject }));
    }
    async transferOut(ep, data) {
      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data.buffer ? data.buffer : data);
      await Usb.write({ data: b64enc(u8) });
      return { status: 'ok', bytesWritten: u8.length };
    }
    async close() { this.opened = false; failPending('closed'); await Usb.close(); }
  }
  const devices = new Map();
  const devFor = info => { let d = devices.get(info.deviceName); if (!d) { d = new NativeUsbDevice(info); devices.set(info.deviceName, d); } else Object.assign(d, info); return d; };

  const usb = {
    async requestDevice({ filters } = {}) {
      const { devices: list } = await Usb.list();
      const vid = filters?.[0]?.vendorId;
      const info = list.find(d => !vid || d.vendorId === vid);
      if (!info) { const e = new Error('No board found — plug the XIAO into the phone'); e.name = 'NotFoundError'; throw e; }
      return devFor(info);
    },
    async getDevices() {
      const { devices: list } = await Usb.list();
      return list.filter(d => d.hasPermission).map(devFor);
    },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter(f => f !== fn); },
  };
  Usb.addListener('attached', info => listeners.connect.forEach(fn => fn({ device: devFor(info) })));
  Usb.addListener('detached', info => {
    const d = devices.get(info.deviceName);
    if (d) d.opened = false;
    failPending('unplugged');
    listeners.disconnect.forEach(fn => fn({ device: d || devFor(info) }));
  });
  Object.defineProperty(navigator, 'usb', { value: usb, configurable: true });

  // ---------------------------------------------------------------- speech
  const TTS = plugin('TextToSpeech');
  function Utterance(text) { this.text = text; this.rate = 1; this.voice = null; this.onend = null; this.onerror = null; }
  let queue = [], busy = false;
  const synth = {
    speaking: false, pending: false, onvoiceschanged: null,
    getVoices() { return []; },
    speak(u) { queue.push(u); synth.pending = queue.length > 1; next(); },
    cancel() { queue = []; synth.pending = false; TTS.stop().catch(() => {}); },
  };
  function next() {
    if (busy || !queue.length) return;
    const u = queue.shift();
    busy = synth.speaking = true; synth.pending = queue.length > 0;
    TTS.speak({ text: u.text, lang: 'en-US', rate: u.rate || 1, pitch: 1, volume: 1 })
      .then(() => { busy = synth.speaking = false; u.onend && u.onend(); next(); })
      .catch(err => { busy = synth.speaking = false; u.onerror && u.onerror(err); next(); });
  }
  window.SpeechSynthesisUtterance = Utterance;
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });

  // ---------------------------------------------------------------- notifications
  const LN = plugin('LocalNotifications');
  const NotificationShim = {
    permission: 'default',
    async requestPermission() {
      const r = await LN.requestPermissions();
      NotificationShim.permission = r.display === 'granted' ? 'granted' : 'denied';
      return NotificationShim.permission;
    },
  };
  LN.checkPermissions().then(r => { NotificationShim.permission = r.display === 'granted' ? 'granted' : r.display === 'denied' ? 'denied' : 'default'; }).catch(() => {});
  Object.defineProperty(window, 'Notification', { value: NotificationShim, configurable: true });
  let nid = 1;
  window.fyNativeNotify = (title, body) => LN.schedule({ notifications: [{ id: nid++ % 2000000000, title, body }] }).catch(() => {});

  // ---------------------------------------------------------------- GPS (keeps running in the background)
  const BG = plugin('BackgroundGeolocation');
  navigator.geolocation.watchPosition = function (success, error) {
    // Android 13+: the persistent "running" notification needs this permission.
    LN.requestPermissions().catch(() => {});
    BG.addWatcher({
      backgroundTitle: 'Flock You is running',
      backgroundMessage: 'Watching for cameras and guiding you. Tap to open.',
      requestPermissions: true, stale: false, distanceFilter: 0,
    }, (loc, err) => {
      if (err) { error && error({ code: err.code === 'NOT_AUTHORIZED' ? 1 : 2, message: err.message }); return; }
      success({ timestamp: loc.time, coords: { latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy,
        speed: loc.speed, heading: loc.bearing, altitude: loc.altitude } });
    });
    return 1;
  };
})();
