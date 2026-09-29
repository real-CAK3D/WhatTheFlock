'use strict';
// Base map switcher for both the 2D (Leaflet) and 3D (MapLibre) views.
//   map  – OpenStreetMap (2D) / OpenFreeMap Liberty (3D)
//   sat  – Esri World Imagery, sharp to street level worldwide, with Esri
//          road + place-name overlays in 2D (3D keeps the Liberty labels)
//   usgs – USGS National Map imagery with roads/labels baked in; US only,
//          public domain, but native resolution stops at zoom 16
// Loaded after map3d.js and uses its globals.

const BASEMAPS = {
  map:  { label: 'Map' },
  sat:  { label: 'Satellite',
          tiles: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          max: 19, attr: 'Imagery © Esri, Maxar, Earthstar Geographics',
          labels: [
            'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
            'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
          ] },
  usgs: { label: 'USGS',
          tiles: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}',
          max: 16, attr: 'USGS The National Map' },
};

if (!BASEMAPS[opts.basemap]) opts.basemap = 'map';
let sat2D = [];

function applyBasemap2D() {
  sat2D.forEach(l => l.remove());
  sat2D = [];
  const b = BASEMAPS[opts.basemap];
  if (!b.tiles) { if (!map.hasLayer(baseLayer)) baseLayer.addTo(map); return; }
  baseLayer.remove();
  // maxNativeZoom lets Leaflet stretch the last real zoom level instead of showing blanks.
  sat2D.push(L.tileLayer(b.tiles, { maxZoom: 19, maxNativeZoom: b.max, zIndex: 1, attribution: b.attr }).addTo(map));
  for (const u of b.labels || []) sat2D.push(L.tileLayer(u, { maxZoom: 19, maxNativeZoom: b.max, zIndex: 2 }).addTo(map));
}

function applyBasemap3D() {
  if (!map3dReady) return;
  if (map3d.getLayer('fy-sat')) map3d.removeLayer('fy-sat');
  if (map3d.getSource('fy-sat')) map3d.removeSource('fy-sat');
  const b = BASEMAPS[opts.basemap];
  const sat = !!b.tiles;
  if (sat) {
    map3d.addSource('fy-sat', { type: 'raster', tiles: [b.tiles], tileSize: 256, maxzoom: b.max, attribution: b.attr });
    // Above land/roads, below the 3D buildings and the style's text labels.
    map3d.addLayer({ id: 'fy-sat', type: 'raster', source: 'fy-sat' }, 'building');
  }
  // Flat building footprints would paint over the imagery; see-through blocks let roofs show.
  if (map3d.getLayer('building')) map3d.setLayoutProperty('building', 'visibility', sat ? 'none' : 'visible');
  if (map3d.getLayer('building-3d')) map3d.setPaintProperty('building-3d', 'fill-extrusion-opacity', sat ? 0.45 : 0.8);
}

function setBasemap(name) {
  opts.basemap = name; saveOpts();
  document.querySelectorAll('#baseSeg button').forEach(b => b.classList.toggle('on', b.dataset.base === name));
  applyBasemap2D();
  applyBasemap3D();
}

(function buildBasemapUi() {
  const seg = document.createElement('div');
  seg.id = 'baseSeg';
  seg.className = 'seg';
  seg.innerHTML = Object.entries(BASEMAPS).map(([k, v]) =>
    `<button data-base="${k}" class="${k === opts.basemap ? 'on' : ''}">${v.label}</button>`).join('');
  seg.onclick = e => { const k = e.target.dataset.base; if (k) setBasemap(k); };
  $('lyrPanel').prepend(seg);
  applyBasemap2D();
})();
