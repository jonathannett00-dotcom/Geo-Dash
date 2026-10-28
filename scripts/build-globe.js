'use strict';

/* =========================================================
 *  Baut die Punktdatei der Landmassen für die drehende Weltkugel
 *  auf der Startseite (public/start/globe-points.json).
 *
 *  Quelle: Natural Earth 1:50m (Objekt „land“) aus sane-topojson,
 *  wie scripts/build-map.js. Die Punkte liegen auf einem Raster mit
 *  ungefähr gleichem Abstand auf der Kugel: Breitenkreise im Abstand
 *  STEP, auf jedem Breitenkreis STEP / cos(Breite). Ein Punkt gehört
 *  zum Land, wenn er nach der Gerade-Ungerade-Regel in den Polygonen
 *  liegt (Scanline je Breitenkreis). Ohne Zufall, also deterministisch.
 *
 *  Format: { version, step, points: [breite·10, länge·10, …] } (ganze Zahlen).
 *
 *  Nur zum Bauen (devDependencies): npm run build:globe [-- --out <datei>]
 * ========================================================= */

const fs = require('fs');
const path = require('path');

const STEP = 1.25;
const OUT = path.join(__dirname, '..', 'public', 'start', 'globe-points.json');

/** Kanten aller Land-Ringe als [lon1, lat1, lon2, lat2]. */
function landEdges() {
  const topojson = require('topojson-client');
  const world = require('sane-topojson/dist/world_50m.json');
  const land = topojson.feature(world, world.objects.land);
  const edges = [];
  const addRing = (ring) => {
    for (let i = 0; i < ring.length - 1; i++) edges.push([ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]]);
  };
  for (const f of land.features || [land]) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const poly of polys) for (const ring of poly) addRing(ring);
  }
  return edges;
}

function buildGlobe() {
  const edges = landEdges();
  const points = [];
  for (let lat = -90 + STEP / 2; lat < 90; lat += STEP) {
    // Schnittpunkte des Breitenkreises mit allen Kanten (halboffen, damit Ecken nicht doppelt zählen)
    const xs = [];
    for (const [x1, y1, x2, y2] of edges) {
      if ((y1 <= lat) !== (y2 <= lat)) xs.push(x1 + ((lat - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    const dLon = Math.min(360, STEP / Math.max(Math.cos(lat * Math.PI / 180), 0.02));
    const n = Math.max(1, Math.round(360 / dLon));
    let k = 0;
    for (let j = 0; j < n; j++) {
      const lon = -180 + (j + 0.5) * (360 / n);
      while (k < xs.length && xs[k] < lon) k++;
      if (k % 2 === 1) points.push(Math.round(lat * 10), Math.round(lon * 10));
    }
  }
  return { version: 1, step: STEP, count: points.length / 2, points };
}

const toJson = (data) => `{"version":${data.version},"step":${data.step},"count":${data.count},"points":[${data.points.join(',')}]}\n`;

if (require.main === module) {
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? path.resolve(process.argv[i + 1]) : OUT;
  const text = toJson(buildGlobe());
  fs.writeFileSync(out, text);
  console.log(`${path.relative(process.cwd(), out)}: ${(text.length / 1024).toFixed(1)} KB`);
}

module.exports = { buildGlobe, toJson, OUT };
