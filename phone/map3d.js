'use strict';
// 3D view: MapLibre GL + OpenFreeMap vector tiles (extruded OSM buildings),
// optional terrain from the AWS Terrarium elevation tiles. It mirrors the same
// data the 2D Leaflet map shows (board detections, mapped cameras, route, me);
// the 2D map is untouched and remains the default. MapLibre (~1 MB) is only
// loaded the first time 3D is switched on. Loaded after layers.js.

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const VIEW3D_SPAN = 0.08;   // max degrees from center to query mapped cameras in 3D (horizon is huge when tilted)

opts.view3d = opts.view3d ?? false;
opts.terrain = opts.terrain ?? false;

let map3d = null, map3dReady = false, mlLoading = null;
let itemIndex = new Map();

function map3dActive() { return !!(opts.view3d && map3dReady); }

function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve();
  if (mlLoading) return mlLoading;
  mlLoading = new Promise((res, rej) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'vendor/maplibre-gl.css';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = 'vendor/maplibre-gl.js';
    s.onload = res; s.onerror = () => { mlLoading = null; rej(new Error('could not load 3D engine')); };
    document.head.appendChild(s);
  });
  return mlLoading;
}

// Leaflet uses 256px tiles, MapLibre 512px: same view is one zoom level lower.
function view3dBox() {
  const c = map3d.getCenter(), b = map3d.getBounds();
  return {
    s: Math.max(b.getSouth(), c.lat - VIEW3D_SPAN), n: Math.min(b.getNorth(), c.lat + VIEW3D_SPAN),
    w: Math.max(b.getWest(), c.lng - VIEW3D_SPAN), e: Math.min(b.getEast(), c.lng + VIEW3D_SPAN),
    zoom: map3d.getZoom() + 1,
  };
}

async function init3D() {
  await loadMapLibre();
  const el = document.createElement('div');
  el.id = 'map3d';
  $('map').after(el);
  // Must have a real size when MapLibre measures its container.
  el.style.display = 'block';
  const c = map.getCenter();
  map3d = new maplibregl.Map({
    container: el, style: STYLE_URL, center: [c.lng, c.lat], zoom: Math.max(map.getZoom() - 1, 1),
    pitch: 60, maxPitch: 80, attributionControl: { compact: true },
  });
  map3d.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map3d.on('dragstart', () => setFollow(false));
  map3d.on('moveend', () => {
    if (!opts.view3d) return;
    clearTimeout(init3D.t); init3D.t = setTimeout(onView, 700);
  });
  map3d.on('click', e => {
    const f = map3d.queryRenderedFeatures(e.point, { layers: ['fy-dets', 'fy-mapped', 'fy-mapped-cctv'] })[0];
    if (!f) return;
    const html = f.layer.id === 'fy-dets'
      ? popupHtml(data.devices[f.properties.mac])
      : popupFor(itemIndex.get(f.properties.id));
    new maplibregl.Popup({ maxWidth: '280px' }).setLngLat(f.geometry.coordinates).setHTML(html).addTo(map3d);
  });
  for (const l of ['fy-dets', 'fy-mapped', 'fy-mapped-cctv']) {
    map3d.on('mouseenter', l, () => { map3d.getCanvas().style.cursor = 'pointer'; });
    map3d.on('mouseleave', l, () => { map3d.getCanvas().style.cursor = ''; });
  }
  if (!map3d.loaded()) {
    await new Promise(res => {
      const done = () => { if (map3d.isStyleLoaded()) { map3d.off('idle', done); res(); } };
      map3d.on('load', done);
      map3d.on('idle', done);
    });
  }
  addLayers3D();
  map3dReady = true;
  applyTerrain();
  if (typeof applyBasemap3D === 'function') applyBasemap3D();
  if (typeof navOn3DReady === 'function') navOn3DReady();
  if (typeof incOn3DReady === 'function') incOn3DReady();
  if (typeof placesOn3DReady === 'function') placesOn3DReady();
  map3d.on('contextmenu', e => { if (typeof dropPin === 'function') dropPin(e.lngLat.lat, e.lngLat.lng); });
}

const EMPTY = { type: 'FeatureCollection', features: [] };

function addLayers3D() {
  for (const id of ['fy-track', 'fy-cones', 'fy-pillars', 'fy-mapped', 'fy-dets', 'fy-me'])
    map3d.addSource(id, { type: 'geojson', data: EMPTY });
  map3d.addSource('fy-dem', { type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 15 });

  map3d.addLayer({ id: 'fy-track', type: 'line', source: 'fy-track',
    paint: { 'line-color': '#58a6ff', 'line-width': 4, 'line-opacity': 0.7 } });
  map3d.addLayer({ id: 'fy-cones', type: 'fill', source: 'fy-cones', minzoom: 14,
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.25 } });
  // Short coloured columns so cameras stand out among the extruded buildings.
  map3d.addLayer({ id: 'fy-pillars', type: 'fill-extrusion', source: 'fy-pillars', minzoom: 14,
    paint: { 'fill-extrusion-color': ['get', 'color'], 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-opacity': 0.9 } });
  map3d.addLayer({ id: 'fy-mapped-cctv', type: 'circle', source: 'fy-mapped', minzoom: 13, filter: ['==', ['get', 'kind'], 'cctv'],
    paint: { 'circle-radius': 4, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#111', 'circle-stroke-width': 1 } });
  map3d.addLayer({ id: 'fy-mapped', type: 'circle', source: 'fy-mapped', filter: ['!=', ['get', 'kind'], 'cctv'],
    paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#111', 'circle-stroke-width': 1.5 } });
  map3d.addLayer({ id: 'fy-dets', type: 'circle', source: 'fy-dets',
    paint: { 'circle-radius': 9, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#000', 'circle-stroke-width': 2 } });
  map3d.addLayer({ id: 'fy-me', type: 'circle', source: 'fy-me',
    paint: { 'circle-radius': 8, 'circle-color': '#58a6ff', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
}

function applyTerrain() {
  if (!map3dReady) return;
  map3d.setTerrain(opts.terrain ? { source: 'fy-dem', exaggeration: 1.3 } : null);
}

function square(lat, lon, m) {
  const dLat = m / 111320, dLon = m / (111320 * Math.cos(lat * Math.PI / 180));
  return [[[lon - dLon, lat - dLat], [lon + dLon, lat - dLat], [lon + dLon, lat + dLat], [lon - dLon, lat + dLat], [lon - dLon, lat - dLat]]];
}
const pt = (lon, lat, props) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: props });
const poly = (coords, props) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: coords }, properties: props });

let syncTimer = null;
function sync3D(now = false) {
  if (!map3dActive()) return;
  if (!now) { if (!syncTimer) syncTimer = setTimeout(() => { syncTimer = null; sync3D(true); }, 400); return; }

  const dets = [], pillars = [], mapped = [], cones = [];
  if (opts.layers.det !== false) {
    for (const d of visibleDevices()) {
      if (!d.bestLoc) continue;
      const color = tierColor(d.tier);
      dets.push(pt(d.bestLoc.lon, d.bestLoc.lat, { mac: d.mac, color }));
      pillars.push(poly(square(d.bestLoc.lat, d.bestLoc.lon, 3), { color, h: 30 }));
    }
  }
  itemIndex = new Map();
  for (const p of allItems()) {
    if (!opts.layers[p.kind]) continue;
    itemIndex.set(p.id, p);
    const k = KINDS[p.kind];
    mapped.push(pt(p.lon, p.lat, { id: p.id, kind: p.kind, color: k.color, r: k.r }));
    if (p.kind === 'alpr' || p.kind === 'enf') pillars.push(poly(square(p.lat, p.lon, 2), { color: k.color, h: 15 }));
    for (const dir of p.dirs) {
      cones.push(poly([cone(p, dir, p.kind === 'cctv' ? 25 : 60).map(([la, lo]) => [lo, la])], { color: k.color }));
    }
  }
  map3d.getSource('fy-dets').setData({ type: 'FeatureCollection', features: dets });
  map3d.getSource('fy-pillars').setData({ type: 'FeatureCollection', features: pillars });
  map3d.getSource('fy-mapped').setData({ type: 'FeatureCollection', features: mapped });
  map3d.getSource('fy-cones').setData({ type: 'FeatureCollection', features: cones });
  map3d.getSource('fy-track').setData(data.track.length > 1
    ? { type: 'Feature', geometry: { type: 'LineString', coordinates: data.track.map(p => [p.lon, p.lat]) }, properties: {} }
    : EMPTY);
  map3d.getSource('fy-me').setData(fix ? pt(fix.lon, fix.lat, {}) : EMPTY);
}

// Follow mode in 3D: keep me centred and, when moving, turn the map to face
// the direction of travel like a car satnav.
function follow3D() {
  if (!map3dActive() || !opts.follow || !fix) return;
  const moving = fix.spd != null && fix.spd > 2 && fix.hdg != null && !Number.isNaN(fix.hdg);
  map3d.easeTo({ center: [fix.lon, fix.lat], bearing: moving ? fix.hdg : map3d.getBearing(), duration: 800 });
}

let init3DPromise = null;
async function set3D(on) {
  const btn = $('b3d');
  if (on && !map3dReady) {
    btn.textContent = '…';
    try { await (init3DPromise ||= init3D()); }
    catch (e) {
      init3DPromise = null;
      if (map3d) { try { map3d.remove(); } catch {} map3d = null; }
      $('map3d')?.remove();
      toast('3D: ' + e.message + (navigator.onLine ? '' : ' (offline — open 3D once while online)'));
      btn.textContent = '3D'; return;
    }
  }
  opts.view3d = on; saveOpts();
  btn.textContent = on ? '2D' : '3D';
  if (on) {
    const c = map.getCenter();
    $('map3d').style.display = 'block';
    map3d.resize();
    map3d.jumpTo({ center: [c.lng, c.lat], zoom: Math.max(map.getZoom() - 1, 1), pitch: map3d.getPitch() || 60 });
    sync3D(true);
    onView();
  } else if (map3d) {
    const c = map3d.getCenter();
    $('map3d').style.display = 'none';
    map.setView([c.lat, c.lng], Math.round(map3d.getZoom() + 1), { animate: false });
    map.invalidateSize();
  }
}

// ---------------------------------------------------------------- UI

(function build3DUi() {
  const btn = document.createElement('button');
  btn.id = 'b3d'; btn.className = 'fab b3d'; btn.textContent = '3D';
  btn.title = 'Switch between 2D map and 3D buildings view';
  btn.onclick = () => set3D(!opts.view3d);
  $('tab-map').append(btn);

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h2>3D view</h2>
    <p class="mute">Tap <b>3D</b> on the map. Two-finger drag up/down to tilt, twist to rotate. While following, the map turns to face your direction of travel.</p>
    <label class="sw"><input type="checkbox" id="optTerrain"> Show terrain (hills &amp; elevation)</label>
    <p class="mute small0">3D map © OpenFreeMap, OpenMapTiles, OpenStreetMap contributors. Terrain: AWS Terrain Tiles (Mapzen).</p>`;
  $('slot-3d').append(card);
  bindOpt('optTerrain', 'terrain', applyTerrain);

  if (opts.view3d) { opts.view3d = false; set3D(true); }
})();
