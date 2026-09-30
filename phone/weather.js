'use strict';
// Weather along the route (Open-Meteo, free, no key): the forecast at each
// point of the route for the time you'll actually be there. Flags snow,
// freezing rain / ice, heavy rain, thunderstorms, fog and strong wind; shows
// them in the route options, warns ahead while navigating, and shows
// current conditions. Loaded after announce.js.

const WX_URL = 'https://api.open-meteo.com/v1/forecast';
const WX_STEP_M = 30000;      // sample the route every 30 km
const WX_MAX_POINTS = 60;
const WX_WARN_M = 25000;      // warn this far ahead while navigating

opts.weather = opts.weather ?? true;

// WMO weather codes → text + icon.
const WMO = {
  0: ['Clear', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Freezing fog', '🌫️'], 51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
  56: ['Freezing drizzle', '🧊'], 57: ['Freezing drizzle', '🧊'], 61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🧊'], 67: ['Freezing rain', '🧊'], 71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'],
  77: ['Snow grains', '🌨️'], 80: ['Showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Violent showers', '⛈️'], 85: ['Snow showers', '🌨️'],
  86: ['Heavy snow showers', '❄️'], 95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm with hail', '⛈️'], 99: ['Thunderstorm with hail', '⛈️'],
};

// What's worth a warning, most serious first.
function wxHazard(h) {
  const c = h.code;
  if ([66, 67, 56, 57, 48].includes(c) || (h.temp <= 0.5 && h.precip > 0.2)) return { level: 3, text: c === 48 ? 'Freezing fog' : 'Freezing rain or ice', icon: '🧊' };
  if ([75, 86].includes(c) || h.snow >= 1) return { level: 3, text: 'Heavy snow', icon: '❄️' };
  if ([71, 73, 77, 85].includes(c) || h.snow > 0) return { level: 2, text: 'Snow', icon: '🌨️' };
  if ([95, 96, 99].includes(c)) return { level: 3, text: 'Thunderstorms', icon: '⛈️' };
  if ([65, 82].includes(c) || h.precip >= 6) return { level: 2, text: 'Heavy rain', icon: '🌧️' };
  if (c === 45 || (h.vis != null && h.vis < 500)) return { level: 2, text: 'Fog, low visibility', icon: '🌫️' };
  if (h.gust >= 65) return { level: 2, text: `Wind gusts ${opts.units === 'metric' ? Math.round(h.gust) + ' km/h' : Math.round(h.gust / 1.609) + ' mph'}`, icon: '💨' };
  return null;
}
const tempTxt = c => opts.units === 'metric' ? `${Math.round(c)}°C` : `${Math.round(c * 9 / 5 + 32)}°F`;

async function wxFetch(points) {
  const lat = points.map(p => p.lat.toFixed(3)).join(','), lon = points.map(p => p.lon.toFixed(3)).join(',');
  const u = `${WX_URL}?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation,weather_code,snowfall,visibility,wind_gusts_10m&forecast_hours=48&timeformat=unixtime&timezone=GMT`;
  const d = await getJSON(u, 20000);
  return Array.isArray(d) ? d : [d];
}
// The forecast hour closest to a time (ms).
function wxAt(loc, ts) {
  const t = loc.hourly.time;
  let i = 0, best = Infinity;
  for (let k = 0; k < t.length; k++) { const dd = Math.abs(t[k] * 1000 - ts); if (dd < best) { best = dd; i = k; } }
  const H = loc.hourly;
  return { code: H.weather_code[i], temp: H.temperature_2m[i], precip: H.precipitation[i], snow: H.snowfall[i], vis: H.visibility[i], gust: H.wind_gusts_10m[i] };
}

// Forecast along a route for the time you'll pass each point.
async function routeWeather(rt, startAt = Date.now()) {
  const pts = [];
  const step = Math.max(WX_STEP_M, rt.total / WX_MAX_POINTS);
  for (let s = 0; s <= rt.total; s += step) pts.push({ s, ...pointAlong(rt, Math.min(s, rt.total - 1)) });
  if (pts.length < 2) pts.push({ s: rt.total, ...pointAlong(rt, rt.total - 1) });
  const locs = await wxFetch(pts);
  const out = pts.map((p, i) => {
    const eta = startAt + rt.duration * (p.s / rt.total) * 1000;
    const h = wxAt(locs[i], eta);
    return { s: p.s, lat: p.lat, lon: p.lon, eta, h, hazard: wxHazard(h) };
  });
  rt.weather = out;
  return out;
}

function wxSummary(rt) {
  const w = rt.weather;
  if (!w) return '';
  const temps = w.map(x => x.h.temp);
  const worst = w.filter(x => x.hazard).sort((a, b) => b.hazard.level - a.hazard.level || a.s - b.s)[0];
  const range = `${tempTxt(Math.min(...temps))}–${tempTxt(Math.max(...temps))}`;
  if (!worst) return `<span class="ok">${(WMO[w[0].h.code] || ['', '🌤️'])[1]} No bad weather on the way · ${range}</span>`;
  return `<span class="warn">${worst.hazard.icon} ${worst.hazard.text} in ${fmtDist(worst.s)} (around ${fmtClock(worst.eta)})</span> · ${range}`;
}

// ---------------------------------------------------------------- live: warn ahead, current conditions

const wxWarned = new Set();
let wxRouteAt = 0;
function weatherOnFix(f) {
  if (!opts.weather || typeof nav === 'undefined' || !nav || !navigator.onLine) return;
  const rt = nav.rt;
  // Refresh the route forecast every 30 min (and first time).
  if (!rt.weather || Date.now() - wxRouteAt > 30 * 60e3) {
    wxRouteAt = Date.now();
    const along = nav.along;
    routeWeather(rt, Date.now() - rt.duration * (along / rt.total) * 1000).catch(() => {});
    return;
  }
  for (const w of rt.weather) {
    if (!w.hazard || w.s < nav.along) continue;
    const ahead = w.s - nav.along;
    if (ahead > WX_WARN_M) break;
    const key = w.hazard.text + '@' + Math.round(w.s / WX_STEP_M);
    if (wxWarned.has(key)) continue;
    wxWarned.add(key);
    announce('weather', `${w.hazard.text} ahead in about ${fmtDist(ahead)}. ${(WMO[w.h.code] || ['Weather'])[0]}, ${tempTxt(w.h.temp)}.`,
      { title: `${w.hazard.icon} ${w.hazard.text} ahead`, body: `${fmtDist(ahead)} · ${tempTxt(w.h.temp)}` });
    break;
  }
}

let wxNow = null, wxNowAt = 0;
async function refreshWeatherNow() {
  const c = fix || (typeof biasLL === 'function' ? biasLL() : null);
  if (!c || !navigator.onLine) return;
  try {
    const [loc] = await wxFetch([c]);
    wxNow = wxAt(loc, Date.now()); wxNowAt = Date.now();
    paintWeatherNow();
  } catch {}
}
function paintWeatherNow() {
  const el = $('wxBadge');
  if (!el) return;
  el.hidden = !opts.weather || !wxNow;
  if (!wxNow) return;
  const hz = wxHazard(wxNow);
  el.textContent = `${hz ? hz.icon : (WMO[wxNow.code] || ['', '🌡️'])[1]} ${tempTxt(wxNow.temp)}`;
  el.title = `${(WMO[wxNow.code] || ['Weather'])[0]}${hz ? ' · ' + hz.text : ''}`;
  el.classList.toggle('bad', !!hz);
  const st = $('wxStatus');
  if (st) st.textContent = `Now: ${(WMO[wxNow.code] || ['—'])[0]}, ${tempTxt(wxNow.temp)}${hz ? ' — ' + hz.text : ''} · updated ${ago(wxNowAt)}`;
}

(function buildWeatherUi() {
  // Small badge in the header.
  $('netStat').insertAdjacentHTML('beforebegin', '<span class="stat wx" id="wxBadge" hidden></span>');
  $('wxBadge').onclick = () => toast($('wxBadge').title);
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h2>Weather</h2>
    <label class="sw"><input type="checkbox" id="optWeather"> Weather on routes and warnings ahead</label>
    <p class="small1" id="wxStatus"></p>
    <p class="mute small1">Forecast for the time you'll reach each part of the route: snow, ice, freezing rain, heavy rain, storms, fog, strong wind. Weather data © Open-Meteo.com (CC BY 4.0).</p>`;
  $('slot-traffic').after(card);
  bindOpt('optWeather', 'weather', () => { paintWeatherNow(); if (opts.weather) refreshWeatherNow(); });
  setTimeout(refreshWeatherNow, 3000);
  setInterval(() => { if (opts.weather && Date.now() - wxNowAt > 20 * 60e3) refreshWeatherNow(); }, 60000);
})();
