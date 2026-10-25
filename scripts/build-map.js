'use strict';

/* =========================================================
 *  Baut die realistische Risiko-Weltkarte für die Host-Ansicht.
 *
 *  Quelle: Natural Earth 1:50m aus dem Paket sane-topojson (Länder,
 *  Staaten/Provinzen für Kanada, USA und Australien, Seen) – alles in
 *  einer Topologie, gemeinsame Grenzen teilen sich dieselben Arcs.
 *
 *  Ablauf:
 *   1. Arcs projizieren (Miller, Naht im Pazifik bei 169,5° W), leicht
 *      vereinfachen und glätten. Weil Nachbarn dieselben Arcs teilen,
 *      bleiben gemeinsame Grenzen deckungsgleich.
 *   2. Länder den 42 Gebieten aus map.js zuordnen. Kanada, USA und
 *      Australien werden entlang ihrer Provinz- bzw. Staatsgrenzen geteilt,
 *      Russland (ohne admin-1-Daten in 1:50m) entlang natürlicher Linien:
 *      Uralkamm, Jenissei mit Westsajan und Altai, Lena, Aldan, Stanowoi.
 *   3. Kontakte prüfen: Jede Landgrenze muss eine Nachbarschaft aus
 *      map.js sein; Nachbarn ohne Landgrenze bekommen einen Seeweg.
 *   4. Marker und Namen platzieren (ohne Überlappung, für TV und Tablet).
 *   5. Ergebnis als statische Daten nach server/games/risiko/map-paths.js.
 *
 *  Nur zum Bauen (devDependencies): npm run build:map
 * ========================================================= */

const fs = require('fs');
const path = require('path');
const topojson = require('topojson-client');
const pc = require('polygon-clipping');
const world = require('sane-topojson/dist/world_50m.json');
const { TERRITORY_IDS, TERRITORY, CONTINENTS, CONTINENT_TERRITORIES, BORDERS } = require('../server/games/risiko/map');

const OUT = path.join(__dirname, '..', 'server', 'games', 'risiko', 'map-paths.js');

/* ---------------- Projektion ---------------- */

const WIDTH = 1000;
const SEAM = -169.5;                 // Naht zwischen Tschukotka und Alaska
const LON0 = SEAM + 180;             // Kartenmitte
const LAT_TOP = 83.7;
const LAT_BOTTOM = -56.2;
const SIMPLIFY = 0.5;               // Douglas-Peucker-Toleranz (Karteneinheiten), danach Glättung
const MIN_AREA = 0.6;                // kleinere Inseln entfallen (Karteneinheiten²)
const MIN_LAKE = 3;                  // kleinere Seen bleiben Land

const rad = Math.PI / 180;
const millerY = (lat) => 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * lat * rad));
const SCALE = WIDTH / (2 * Math.PI);
const Y_TOP = millerY(LAT_TOP);
const HEIGHT = Math.round((Y_TOP - millerY(LAT_BOTTOM)) * SCALE * 10) / 10;

const unwrap = (lon) => (lon < SEAM ? lon + 360 : lon);
const px = (lon) => (unwrap(lon) - LON0) * rad * SCALE + WIDTH / 2;
const py = (lat) => (Y_TOP - millerY(Math.max(-89, Math.min(89, lat)))) * SCALE;
const project = ([lon, lat]) => [px(lon), py(lat)];

/** Darstellung (gemeinsam mit der Host-Ansicht): Marker und Namen in Karteneinheiten bzw. Pixeln. */
const STYLE = {
  markerR: 7.2, markerMinPx: 11, markerMaxScale: 1.8,
  labelUnits: 5.4, labelMinPx: 8.5, labelMaxPx: 13, charWidth: 0.56, labelGap: 0.3,
};
/** Maßstäbe (Pixel je Karteneinheit), für die Namen überlappungsfrei sein müssen: Tablet … großer TV. */
const CHECK_SCALES = [0.98, 1.2, 1.45, 1.7, 1.86, 2.2];

/* ---------------- Geometrie-Hilfen ---------------- */

function simplifyLine(points, tol) {
  if (points.length <= 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const closed = points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1];
  const stack = [];
  if (closed) {
    // Geschlossener Arc: weitesten Punkt vom Start erzwingen, damit der Ring nicht kollabiert
    let far = 1; let best = -1;
    for (let i = 1; i < points.length - 1; i++) {
      const d = (points[i][0] - points[0][0]) ** 2 + (points[i][1] - points[0][1]) ** 2;
      if (d > best) { best = d; far = i; }
    }
    keep[far] = 1;
    stack.push([0, far], [far, points.length - 1]);
  } else {
    stack.push([0, points.length - 1]);
  }
  while (stack.length) {
    const [a, b] = stack.pop();
    let idx = -1; let max = tol * tol;
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(points[i][0], points[i][1], [...points[a], ...points[b]]);
      if (d > max) { max = d; idx = i; }
    }
    if (idx >= 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

/** Chaikin-Glättung; Anfang und Ende bleiben fest (Knoten der Topologie). */
function chaikin(points, rounds = 1) {
  let pts = points;
  for (let r = 0; r < rounds; r++) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i]; const [bx, by] = pts[i + 1];
      if (i > 0) out.push([0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by]);
      if (i < pts.length - 2) out.push([0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

/** Linie in Grad → dicht gesetzte, geglättete Linie in Karteneinheiten. */
function naturalLine(lonlat) {
  const pts = [];
  for (let i = 0; i < lonlat.length - 1; i++) {
    const [a, b] = [lonlat[i], lonlat[i + 1]];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.5));
    for (let k = 0; k < n; k++) pts.push(project([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]));
  }
  pts.push(project(lonlat[lonlat.length - 1]));
  return chaikin(pts, 3);
}

function segDist2(x, y, [ax, ay, bx, by]) {
  const dx = bx - ax; const dy = by - ay; const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
  return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2;
}

function ringArea(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return s / 2;
}
const polyArea = (poly) => Math.abs(ringArea(poly[0])) - poly.slice(1).reduce((s, r) => s + Math.abs(ringArea(r)), 0);
const mpArea = (mp) => mp.reduce((s, p) => s + polyArea(p), 0);

function ringCentroid(ring) {
  let a = 0; let cx = 0; let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
  }
  return a === 0 ? ring[0] : [cx / (3 * a), cy / (3 * a)];
}

function bbox(poly) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [x, y] of poly[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}

function pointInPoly([x, y], poly) {
  let inside = false;
  for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
const pointInMP = (p, mp) => mp.some((poly) => pointInPoly(p, poly));

function mpDistance([x, y], mp) {
  let min = Infinity;
  for (const poly of mp) for (const ring of poly) for (let i = 1; i < ring.length; i++) min = Math.min(min, segDist2(x, y, [...ring[i - 1], ...ring[i]]));
  return Math.sqrt(min);
}

/** Rückrechnung Karteneinheiten → Grad (für Zuordnung nach Lage). */
function lonLat([x, y]) {
  const lon = (x - WIDTH / 2) / SCALE / rad + LON0;
  const lat = (Math.atan(Math.exp((Y_TOP - y / SCALE) / 1.25)) - Math.PI / 4) / 0.4 / rad;
  return [lon > 180 ? lon - 360 : lon, lat];
}

/* ---------------- 1. Topologie projizieren, vereinfachen, glätten ---------------- */

const topo = JSON.parse(JSON.stringify(world));
{
  const { scale: [sx, sy], translate: [tx, ty] } = topo.transform;
  topo.arcs = topo.arcs.map((arc) => {
    let x = 0; let y = 0;
    const pts = arc.map(([dx, dy]) => { x += dx; y += dy; return project([x * sx + tx, y * sy + ty]); });
    return chaikin(simplifyLine(pts, SIMPLIFY), 1);
  });
  delete topo.transform;
}
const polygonsOf = (g) => (g.type === 'Polygon' ? [g.arcs] : g.type === 'MultiPolygon' ? g.arcs : []);
const coordsOf = (arcs) => topojson.feature(topo, { type: 'Polygon', arcs }).geometry.coordinates;
const mergeGeoms = (geoms) => (geoms.length ? topojson.merge(topo, geoms).coordinates : []);

/* ---------------- 2. Zuordnung ---------------- */

const COUNTRIES = {
  groenland: ['GRL'],
  mittelamerika: ['MEX', 'GTM', 'BLZ', 'HND', 'SLV', 'NIC', 'CRI', 'PAN', 'CUB', 'JAM', 'HTI', 'DOM', 'BHS', 'PRI', 'CYM', 'TCA', 'VGB', 'VIR',
    'AIA', 'ATG', 'KNA', 'MSR', 'DMA', 'LCA', 'VCT', 'BRB', 'GRD', 'MAF', 'SXM', 'BLM'],
  quebec: ['SPM'],
  venezuela: ['VEN', 'COL', 'GUY', 'SUR', 'TTO', 'ABW', 'CUW'],
  peru: ['PER', 'BOL'],
  brasilien: ['BRA'],
  argentinien: ['ARG', 'PRY', 'URY', 'FLK'],
  island: ['ISL'],
  grossbritannien: ['GBR', 'IRL', 'IMN', 'GGY', 'JEY'],
  skandinavien: ['SWE', 'FIN', 'DNK', 'ALA', 'FRO'],
  nordeuropa: ['DEU', 'POL', 'BEL', 'LUX', 'CZE'],
  westeuropa: ['AND', 'MCO', 'CHE', 'LIE'],
  suedeuropa: ['ITA', 'SMR', 'VAT', 'MLT', 'AUT', 'SVN', 'HRV', 'BIH', 'SRB', 'MNE', 'ALB', 'MKD', 'GRC', 'BGR', 'ROU', 'HUN', 'SVK'],
  osteuropa: ['UKR', 'BLR', 'MDA', 'LTU', 'LVA', 'EST'],
  nordafrika: ['MAR', 'ESH', 'DZA', 'TUN', 'LBY', 'MRT', 'MLI', 'NER', 'TCD', 'SEN', 'GMB', 'GNB', 'GIN', 'SLE', 'LBR', 'CIV', 'BFA', 'GHA',
    'TGO', 'BEN', 'NGA', 'CPV', 'CAF'],
  aegypten: ['EGY', 'SDN'],
  ostafrika: ['ETH', 'ERI', 'DJI', 'SOM', 'KEN', 'UGA', 'TZA', 'RWA', 'BDI', 'SSD', 'MWI'],
  zentralafrika: ['CMR', 'GAB', 'GNQ', 'COG', 'COD', 'AGO', 'STP'],
  suedafrika: ['ZAF', 'NAM', 'BWA', 'ZWE', 'MOZ', 'LSO', 'SWZ', 'ZMB'],
  madagaskar: ['MDG', 'COM', 'MUS'],
  'naher-osten': ['TUR', 'SYR', 'IRQ', 'IRN', 'SAU', 'YEM', 'OMN', 'ARE', 'QAT', 'BHR', 'KWT', 'JOR', 'ISR', 'PSE', 'LBN', 'CYP', 'GEO', 'ARM', 'AZE'],
  afghanistan: ['AFG', 'KAZ', 'UZB', 'TKM', 'KGZ', 'TJK'],
  indien: ['IND', 'PAK', 'NPL', 'BTN', 'BGD', 'LKA'],
  china: ['CHN', 'TWN', 'PRK', 'KOR', 'HKG', 'MAC'],
  mongolei: ['MNG'],
  japan: ['JPN'],
  suedostasien: ['MMR', 'THA', 'LAO', 'KHM', 'VNM', 'SGP'],
  indonesien: ['TLS', 'PHL', 'BRN'],
  neuguinea: ['PNG'],
};
const OWNER = {};
for (const [t, list] of Object.entries(COUNTRIES)) for (const id of list) OWNER[id] = t;

/** Gebiete ohne ISO-Code in den Daten, nach Lage (Grad). */
const UNNAMED = [
  [[48.9, 11.3], 'ostafrika'],      // Somaliland
  [[20.4, 42.8], 'suedeuropa'],     // Kosovo
  [[34.0, 35.1], 'naher-osten'],    // Nordzypern
  [[77.1, 35.1], 'indien'],         // Siachen-Gletscher
];

/** Länder, deren Teile einzeln (nach Lage) zugeordnet werden; null = unbespieltes Land. */
const BY_PART = {
  FRA: (lon, lat) => (lon < -40 ? (lat < 10 ? 'venezuela' : 'mittelamerika') : lon > 40 ? (lon < 60 ? 'madagaskar' : null) : 'westeuropa'),
  NLD: (lon, lat) => (lon < -50 ? (lat < 13 ? 'venezuela' : 'mittelamerika') : 'nordeuropa'),
  NOR: (lon, lat) => (lat < -30 ? null : 'skandinavien'),
  CHL: (lon) => (lon < -80 ? null : 'argentinien'),
  ECU: (lon) => (lon < -85 ? null : 'peru'),
  MYS: (lon) => (lon < 105 ? 'suedostasien' : 'indonesien'),
  IDN: (lon) => (lon < 134 ? 'indonesien' : 'neuguinea'),
  PRT: () => 'westeuropa',
  ESP: () => 'westeuropa',
};

/** Kanada, USA, Australien: Provinzen bzw. Staaten → Gebiet ('none' = unbespielt). */
const SUBUNITS = {
  CAN: { YT: 'nordwest-territorium', NT: 'nordwest-territorium', NU: 'nordwest-territorium', BC: 'alberta', AB: 'alberta',
    SK: 'ontario', MB: 'ontario', ON: 'ontario', QC: 'quebec', NB: 'quebec', NS: 'quebec', PE: 'quebec', NL: 'quebec' },
  USA: Object.fromEntries([
    ['AK', 'alaska'], ['HI', 'none'],
    ...['WA', 'OR', 'CA', 'NV', 'ID', 'MT', 'WY', 'UT', 'CO', 'AZ', 'NM', 'ND', 'SD', 'NE', 'KS'].map((s) => [s, 'weststaaten']),
  ]),
  AUS: { WA: 'westaustralien', NT: 'westaustralien' },
};
const SUBUNIT_DEFAULT = { CAN: null, USA: 'oststaaten', AUS: 'ostaustralien' };

/*
 * Russland: natürliche Linien (Grad, Nord → Süd bzw. West → Ost), dicht gesetzt und geglättet.
 * Gewählt so, dass nur Nachbarn aus map.js aneinandergrenzen:
 *  – Ural zwischen Uralkamm und Jenissei, unten über Westsajan und Altai bis an die Grenze zu China
 *    (Ural und Sibirien berühren China, die Mongolei nur Sibirien).
 *  – Lena trennt Jakutien (Nordwest) von Irkutsk (Süd) und Kamtschatka (Ost), der Aldan Irkutsk von Kamtschatka.
 *  – Stanowoi und Jablonowygebirge trennen den Süden am Amur (Gebiet Mongolei) vom Norden.
 */
const RU = {
  ural: [[62.0, 73.5], [65.2, 69.2], [66.0, 68.4], [65.0, 67.5], [63.8, 66.7], [62.3, 65.9], [60.1, 65.0], [59.3, 63.9], [59.2, 62.5],
    [59.3, 61.0], [59.5, 59.5], [59.3, 58.3], [59.8, 57.0], [59.5, 55.9], [59.0, 54.6], [59.1, 53.4], [58.8, 52.2], [58.6, 51.2], [58.5, 48.0]],
  jenissei: [[80.0, 77.5], [82.0, 72.5], [83.5, 70.6], [86.2, 69.4], [87.9, 65.8], [89.5, 63.5], [90.1, 61.6], [92.2, 58.45], [92.9, 56.0],
    [91.5, 54.9], [91.4, 53.1], [90.5, 52.5], [89.3, 51.4], [88.6, 50.6], [87.9, 49.9], [87.55, 49.15], [87.5, 46.5]],
  sibirienNord: [[114.0, 76.5], [113.5, 73.3], [112.0, 71.0], [110.0, 69.0], [108.5, 66.5], [108.0, 64.0], [108.3, 61.0], [108.1, 57.8]],
  sibirienSued: [[108.1, 57.8], [107.6, 54.0], [105.0, 54.3], [102.0, 53.4], [100.0, 52.4], [98.8, 51.8], [98.6, 48.0]],
  lenaMitte: [[108.1, 57.8], [110.5, 58.6], [112.6, 59.4], [116.0, 60.2], [120.4, 60.4], [124.0, 60.6], [127.0, 61.0], [129.1, 61.5],
    [129.7, 62.0], [129.6, 63.4]],
  lenaUnten: [[129.6, 63.4], [128.0, 64.5], [125.5, 65.8], [123.4, 66.8], [124.5, 68.5], [127.4, 70.7], [127.0, 72.5], [127.0, 77.0]],
  aldan: [[129.6, 63.4], [131.5, 63.0], [134.0, 62.8], [135.6, 62.65], [135.2, 61.5], [134.4, 60.4], [132.0, 59.4], [129.0, 59.0],
    [126.3, 58.95], [125.2, 57.5], [124.5, 56.3]],
  stanowoiWest: [[124.5, 56.3], [120.0, 56.0], [116.0, 55.6], [113.0, 55.0], [111.0, 53.5], [110.5, 52.0], [109.8, 50.5], [109.6, 47.5]],
  stanowoiOst: [[124.5, 56.3], [127.5, 55.6], [131.0, 55.3], [134.0, 55.0], [135.8, 54.75], [137.5, 54.6]],
};
const L = Object.fromEntries(Object.entries(RU).map(([k, v]) => [k, naturalLine(v)]));
const rev = (line) => line.slice().reverse();
const P = (lon, lat) => project([lon, lat]);
const ring = (...parts) => { const r = parts.flat(); r.push(r[0]); return [[r]]; };

/** Regionen für das russische Festland, in dieser Reihenfolge abgezogen; der Rest ist Kamtschatka. */
const RUSSIA_REGIONS = [
  ['osteuropa', ring(L.ural, [P(58.5, 40), P(15, 40), P(15, 86), P(62, 86)])],
  ['ural', ring(L.ural, [P(58.5, 40), P(87.5, 40)], rev(L.jenissei), [P(80, 86), P(62, 86)])],
  ['sibirien', ring(L.jenissei, [P(87.5, 40), P(98.6, 40)], rev(L.sibirienSued), rev(L.sibirienNord), [P(114, 86), P(80, 86)])],
  ['jakutien', ring(L.sibirienNord, L.lenaMitte, L.lenaUnten, [P(127, 86), P(114, 86)])],
  ['irkutsk', ring(L.lenaMitte, L.aldan, L.stanowoiWest, [P(109.6, 40), P(98.6, 40)], rev(L.sibirienSued))],
  ['mongolei', ring(rev(L.stanowoiWest), L.stanowoiOst, [P(142, 54.6), P(142, 40), P(109.6, 40)])],
];

/** Russische Inseln: Sachalin und Kurilen (östlich 141° O) sowie Tschukotka jenseits von 180° gehören zu Kamtschatka. */
function russiaIsland(lon, centroid) {
  if (lon < 0 || lon >= 141) return 'kamtschatka';
  const hit = RUSSIA_REGIONS.find(([, region]) => pointInMP(centroid, region));
  return hit ? hit[0] : 'kamtschatka';
}

const pieces = Object.fromEntries(TERRITORY_IDS.map((id) => [id, { topo: [], geo: [] }]));
const other = { topo: [], geo: [] };
const seamDropped = new Set();
const seams = { n: 0, area: 0 };
const ALASKA_X1 = px(-129);

/** Festland in Regionen schneiden: Reihenfolge wie angegeben, Reste gehen an die nächstgelegene Region. */
function splitByRegions(coords, { regions, nearest, rest: restTarget }) {
  let rest = [coords];
  for (const [t, region] of regions) {
    if (!rest.length) break;
    const part = pc.intersection(rest, region);
    if (part.length) pieces[t].geo.push(...part);
    rest = pc.difference(rest, region);
  }
  if (restTarget) { pieces[restTarget].geo.push(...rest); return; }
  for (const poly of rest) {
    if (polyArea(poly) < 0.01) continue;
    pieces[nearest(ringCentroid(poly[0]))].geo.push(poly);
    seams.n++; seams.area += polyArea(poly);
    if (process.env.MAP_DEBUG && polyArea(poly) > 2) console.log('Saum', nearest(ringCentroid(poly[0])), polyArea(poly).toFixed(1), lonLat(ringCentroid(poly[0])).map((v) => v.toFixed(1)).join(','));
  }
}

/** Regionen aus Provinzflächen; Säume an der Küste (Landes- und Provinzküste weichen minimal ab) gehen an die nächste Region. */
function subunitRegions(gu) {
  const groups = {};
  for (const g of world.objects.subunits.geometries) {
    if (g.properties.gu !== gu) continue;
    const t = SUBUNITS[gu][g.id] || SUBUNIT_DEFAULT[gu];
    if (!t) throw new Error(`Provinz ohne Gebiet: ${gu}/${g.id}`);
    (groups[t] = groups[t] || []).push(g);
  }
  const regions = Object.entries(groups).map(([t, gs]) => [t, mergeGeoms(gs)]);
  const nearest = (p) => regions.reduce((best, [t, mp]) => {
    const d = pointInMP(p, mp) ? 0 : mpDistance(p, mp);
    return d < best[1] ? [t, d] : best;
  }, [null, Infinity])[0];
  return { regions, nearest };
}
const SPLIT = {
  CAN: subunitRegions('CAN'),
  USA: subunitRegions('USA'),
  AUS: subunitRegions('AUS'),
  RUS: {
    regions: RUSSIA_REGIONS,
    rest: 'kamtschatka',
    nearest: (p) => RUSSIA_REGIONS.reduce((best, [t, mp]) => { const d = mpDistance(p, mp); return d < best[1] ? [t, d] : best; }, ['kamtschatka', Infinity])[0],
  },
};

for (const g of world.objects.countries.geometries) {
  if (g.id === 'ATA') continue;
  const feats = polygonsOf(g).map((arcs) => ({ arcs, coords: coordsOf(arcs) }));
  for (const f of feats) {
    if (!f.coords.length || f.coords[0].length < 4) continue;
    // Teile, die über die Naht reichen (Inseln in der Beringsee), entfallen
    const [bx0, , bx1] = bbox(f.coords);
    if (bx1 - bx0 > WIDTH / 2) { seamDropped.add(g.id || '?'); continue; }
    const centroid = ringCentroid(f.coords[0]);
    const [lon, lat] = lonLat(centroid);
    const split = SPLIT[g.id];
    let target;
    if (split) {
      if (polyArea(f.coords) > 40) { splitByRegions(f.coords, split); continue; }
      target = g.id === 'RUS' ? russiaIsland(lon, centroid) : split.nearest(centroid);
      if (target === 'none') continue;
      if (target === 'alaska' && bx1 > ALASKA_X1) continue;          // Aleuten jenseits der Naht
    } else if (BY_PART[g.id]) {
      target = BY_PART[g.id](lon, lat);
    } else if (!g.id) {
      const hit = UNNAMED.find(([c]) => Math.hypot(c[0] - lon, c[1] - lat) < 4);
      target = hit ? hit[1] : null;
    } else {
      target = OWNER[g.id] || null;
    }
    (target ? pieces[target] : other).topo.push({ type: 'Polygon', arcs: f.arcs });
  }
}

/* ---------------- Gebiete zusammensetzen ---------------- */

const EXTENT = [[[0, 0], [WIDTH, 0], [WIDTH, HEIGHT], [0, HEIGHT], [0, 0]]];
const lakeGeoms = world.objects.lakes.geometries.filter((g) => polygonsOf(g).length);
const lakes = pc.intersection(pc.union(...lakeGeoms.map((g) => topojson.feature(topo, g).geometry.coordinates)
  .map((c) => (Array.isArray(c[0][0][0]) ? c : [c]))), EXTENT).filter((p) => polyArea(p) >= MIN_LAKE);

function tidy(mp) {
  const big = mp.reduce((m, p) => (polyArea(p) > polyArea(m) ? p : m), mp[0]);
  return mp
    .filter((p) => p === big || Math.abs(ringArea(p[0])) >= MIN_AREA)
    .map((p) => [p[0], ...p.slice(1).filter((r) => Math.abs(ringArea(r)) >= MIN_AREA)]);
}
function assemble({ topo: parts, geo }) {
  let mp = pc.union(mergeGeoms(parts), ...geo);
  mp = pc.intersection(mp, EXTENT);
  if (lakes.length) mp = pc.difference(mp, lakes);
  return mp.length ? tidy(mp) : mp;
}

const shapes = {};
for (const id of TERRITORY_IDS) {
  shapes[id] = assemble(pieces[id]);
  if (!shapes[id].length) throw new Error(`Gebiet ohne Fläche: ${id}`);
}
const otherShape = assemble(other);

/* ---------------- 3. Kontakte und Seewege ---------------- */

const r1 = (n) => Math.round(n * 10) / 10;
const pairKey = (a, b) => [a, b].sort().join('|');
const risikoNeighbors = new Set(BORDERS.map(([a, b]) => pairKey(a, b)));

const CELL = 4;
function edgeIndex(mp) {
  const edges = [];
  for (const poly of mp) for (const rg of poly) for (let i = 1; i < rg.length; i++) edges.push([...rg[i - 1], ...rg[i]]);
  const grid = new Map();
  edges.forEach((e, n) => {
    for (let gx = Math.floor(Math.min(e[0], e[2]) / CELL); gx <= Math.floor(Math.max(e[0], e[2]) / CELL); gx++) {
      for (let gy = Math.floor(Math.min(e[1], e[3]) / CELL); gy <= Math.floor(Math.max(e[1], e[3]) / CELL); gy++) {
        const k = `${gx},${gy}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(n);
      }
    }
  });
  return { edges, grid };
}
function nearDist(idx, x, y, reach = 1) {
  let min = Infinity;
  const gx = Math.floor(x / CELL); const gy = Math.floor(y / CELL);
  for (let i = gx - reach; i <= gx + reach; i++) for (let j = gy - reach; j <= gy + reach; j++) {
    for (const n of idx.grid.get(`${i},${j}`) || []) min = Math.min(min, segDist2(x, y, idx.edges[n]));
  }
  return Math.sqrt(min);
}
const index = Object.fromEntries(TERRITORY_IDS.map((id) => [id, edgeIndex(shapes[id])]));
const landIndex = edgeIndex([...Object.values(shapes).flat(), ...otherShape]);

/** Länge des gemeinsamen Rands: Stichproben alle 0,5 Einheiten entlang der Kanten von a, die auf dem Rand von b liegen. */
function sharedLength(a, b) {
  let len = 0;
  for (const e of index[a].edges) {
    const l = Math.hypot(e[2] - e[0], e[3] - e[1]);
    const n = Math.max(1, Math.ceil(l / 0.5));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      if (nearDist(index[b], e[0] + t * (e[2] - e[0]), e[1] + t * (e[3] - e[1])) < 0.08) len += l / n;
    }
  }
  return len;
}

const landBorders = [];
for (let i = 0; i < TERRITORY_IDS.length; i++) {
  for (let j = i + 1; j < TERRITORY_IDS.length; j++) {
    const a = TERRITORY_IDS[i]; const b = TERRITORY_IDS[j];
    if (sharedLength(a, b) > 0.3) landBorders.push([a, b]);
  }
}
const landSet = new Set(landBorders.map(([a, b]) => pairKey(a, b)));
const wrongContacts = landBorders.filter(([a, b]) => !risikoNeighbors.has(pairKey(a, b)));

/** Nächste Punkte zweier Gebiete (Ecke von a zu Kante von b und umgekehrt). */
function closest(a, b) {
  let best = [Infinity];
  const scan = (from, to, flip) => {
    for (const e of index[from].edges) {
      const [x, y] = [e[0], e[1]];
      for (const f of index[to].edges) {
        const dx = f[2] - f[0]; const dy = f[3] - f[1]; const l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, ((x - f[0]) * dx + (y - f[1]) * dy) / l2)) : 0;
        const q = [f[0] + t * dx, f[1] + t * dy];
        const d = (x - q[0]) ** 2 + (y - q[1]) ** 2;
        if (d < best[0]) best = [d, ...(flip ? [q, [x, y]] : [[x, y], q])];
      }
    }
  };
  scan(a, b, false);
  scan(b, a, true);
  return [best[1], best[2]];
}

const f1 = (n) => String(r1(n));
/** Sanft geschwungene Kurve zwischen zwei Küstenpunkten; die Biegung zeigt zur Seite mit mehr Wasser. */
function curve(p, q, bendFactor = 0.22) {
  const [mx, my] = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  const [nx, ny] = len ? [-(q[1] - p[1]) / len, (q[0] - p[0]) / len] : [0, 0];
  const bend = Math.min(18, Math.max(1.2, len * bendFactor));
  const sides = [1, -1].map((s) => {
    const c = [mx + nx * bend * s, my + ny * bend * s];
    let clearance = 0;
    for (let t = 0.2; t <= 0.8; t += 0.1) {
      const x = (1 - t) ** 2 * p[0] + 2 * (1 - t) * t * c[0] + t * t * q[0];
      const y = (1 - t) ** 2 * p[1] + 2 * (1 - t) * t * c[1] + t * t * q[1];
      clearance += Math.min(6, nearDist(landIndex, x, y, 2));
    }
    return [c, clearance];
  });
  const [c] = sides[0][1] >= sides[1][1] ? sides[0] : sides[1];
  return `M${f1(p[0])} ${f1(p[1])}Q${f1(c[0])} ${f1(c[1])} ${f1(q[0])} ${f1(q[1])}`;
}
/** Weiche Kurve durch mehrere Punkte (Catmull-Rom → kubische Bézier). */
function smoothPath(pts) {
  let d = `M${f1(pts[0][0])} ${f1(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]; const p1 = pts[i]; const p2 = pts[i + 1]; const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f1(c1[0])} ${f1(c1[1])} ${f1(c2[0])} ${f1(c2[1])} ${f1(p2[0])} ${f1(p2[1])}`;
  }
  return d;
}

/** Handverlegte Seewege (Grad), wo die kürzeste Verbindung über fremdes Land führen würde. */
const LANE_ROUTES = {
  [pairKey('ontario', 'groenland')]: [[-84.6, 55.6], [-80.6, 61.0], [-71.5, 62.25], [-62.6, 61.3], [-48.2, 60.9]],
};

const seaLanes = [];
for (const [a, b] of BORDERS) {
  if (landSet.has(pairKey(a, b))) continue;
  const route = LANE_ROUTES[pairKey(a, b)];
  if (route) { seaLanes.push({ a, b, wrap: false, d: smoothPath(route.map(project)) }); continue; }
  const all = (id) => shapes[id].flat(2);
  const meanX = (id) => all(id).reduce((s, p) => s + p[0], 0) / all(id).length;
  if (Math.abs(meanX(a) - meanX(b)) > WIDTH / 2) {
    // Über den Kartenrand (Alaska – Kamtschatka): je ein kurzer Bogen bis zum Rand
    const [west, east] = meanX(a) < meanX(b) ? [a, b] : [b, a];
    const w = all(west).reduce((m, p) => (p[0] < m[0] ? p : m));
    const e = all(east).reduce((m, p) => (p[0] > m[0] ? p : m));
    seaLanes.push({ a, b, wrap: true, d: `${curve(w, [0, w[1] - 1.5], 0.3)}${curve(e, [WIDTH, e[1] + 1.5], 0.3)}` });
  } else {
    const [p, q] = closest(a, b);
    seaLanes.push({ a, b, wrap: false, d: curve(p, q) });
  }
}

/* ---------------- 4. Marker und Namen ---------------- */

function edgeDist(p, poly) { return mpDistance(p, [poly]); }
function poleOfInaccessibility(poly) {
  let [x0, y0, x1, y1] = bbox(poly);
  let best = [ringCentroid(poly[0]), -1];
  for (let round = 0; round < 5; round++) {
    const n = 24;
    const sx = (x1 - x0) / n; const sy = (y1 - y0) / n;
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
      const p = [x0 + i * sx, y0 + j * sy];
      if (!pointInPoly(p, poly)) continue;
      const d = edgeDist(p, poly);
      if (d > best[1]) best = [p, d];
    }
    const [cx, cy] = best[0];
    x0 = cx - sx * 2; x1 = cx + sx * 2; y0 = cy - sy * 2; y1 = cy + sy * 2;
  }
  return best[0];
}

/** Handverlegte Marker (Grad), wo der rechnerische Punkt ungünstig liegt. */
const MARKER_OVERRIDES = {
  grossbritannien: [-1.8, 52.9],
  westeuropa: [1.6, 46.6],
  nordeuropa: [13.6, 52.3],
};

const markers = {};
for (const id of TERRITORY_IDS) {
  if (MARKER_OVERRIDES[id]) { markers[id] = project(MARKER_OVERRIDES[id]).map(r1); continue; }
  const main = shapes[id].reduce((m, p) => (polyArea(p) > polyArea(m) ? p : m));
  markers[id] = poleOfInaccessibility(main).map(r1);
}

/** Größen bei einem Maßstab k (Pixel je Karteneinheit) – dieselben Formeln nutzt die Host-Ansicht. */
function sizesAt(k) {
  const markerScale = Math.max(1, Math.min(STYLE.markerMaxScale, STYLE.markerMinPx / (STYLE.markerR * k)));
  const font = Math.max(STYLE.labelMinPx, Math.min(STYLE.labelMaxPx, STYLE.labelUnits * k)) / k;
  return { r: STYLE.markerR * markerScale, font };
}
/** Kasten eines Namens bei Maßstab k: [x0, y0, x1, y1]. */
function labelBox(id, label, k) {
  const { r, font } = sizesAt(k);
  const w = TERRITORY[id].name.length * STYLE.charWidth * font;
  const h = font;
  if (label.x !== undefined) return [label.x - w / 2, label.y - h / 2, label.x + w / 2, label.y + h / 2];
  const [mx, my] = markers[id];
  const gap = STYLE.labelGap * font;
  const d = (r + gap) * label.m;
  const [dx, dy] = { s: [0, 1], n: [0, -1], e: [1, 0], w: [-1, 0], se: [0.72, 0.72], sw: [-0.72, 0.72], ne: [0.72, -0.72], nw: [-0.72, -0.72] }[label.dir];
  const ax = mx + dx * d; const ay = my + dy * d;
  const x0 = dx > 0.1 ? ax : dx < -0.1 ? ax - w : ax - w / 2;
  const y0 = dy > 0.1 ? ay : dy < -0.1 ? ay - h : ay - h / 2;
  return [x0, y0, x0 + w, y0 + h];
}
const boxesOverlap = (a, b, pad = 0) => a[0] < b[2] + pad && b[0] < a[2] + pad && a[1] < b[3] + pad && b[1] < a[3] + pad;
const circleBox = ([cx, cy], r, b, pad = 0) => {
  const x = Math.max(b[0], Math.min(cx, b[2])); const y = Math.max(b[1], Math.min(cy, b[3]));
  return (x - cx) ** 2 + (y - cy) ** 2 < (r + pad) ** 2;
};

/** Anteil eines Kastens, der auf dem eigenen Gebiet liegt (Stichproben). */
function insideShare(id, b) {
  let hit = 0; let n = 0;
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 2; j++) {
    n++;
    if (pointInMP([b[0] + ((b[2] - b[0]) * i) / 4, b[1] + ((b[3] - b[1]) * j) / 2], shapes[id])) hit++;
  }
  return hit / n;
}

const CANDIDATES = [];
for (const m of [1, 1.5, 2.2]) for (const dir of ['s', 'n', 'e', 'w', 'se', 'sw', 'ne', 'nw']) CANDIDATES.push({ dir, m });

const labels = {};
const crowd = (id) => TERRITORY_IDS.filter((o) => Math.hypot(markers[o][0] - markers[id][0], markers[o][1] - markers[id][1]) < 70).length;
const order = TERRITORY_IDS.slice().sort((a, b) => crowd(b) - crowd(a));
const failedLabels = [];
for (const id of order) {
  let best = null;
  for (const cand of CANDIDATES) {
    let ok = true;
    let score = 0;
    for (const k of CHECK_SCALES) {
      const box = labelBox(id, cand, k);
      const { r } = sizesAt(k);
      const pad = 1.2 / k;      // mindestens gut 1 Pixel Luft
      if (box[0] < 2 || box[1] < 2 || box[2] > WIDTH - 2 || box[3] > HEIGHT - 2) { ok = false; break; }
      if (TERRITORY_IDS.some((o) => circleBox(markers[o], r, box, pad))) { ok = false; break; }
      if (Object.entries(labels).some(([o, l]) => boxesOverlap(labelBox(o, l, k), box, pad))) { ok = false; break; }
      score += (1 - insideShare(id, box)) * 3;
    }
    if (!ok) continue;
    score += (cand.m - 1) * 0.8 + (['s', 'n'].includes(cand.dir) ? 0 : 0.3) + (cand.dir === 's' ? 0 : 0.1);
    if (!best || score < best.score) best = { ...cand, score };
  }
  if (!best) { failedLabels.push(id); best = { dir: 's', m: 1, score: 99 }; }
  labels[id] = { dir: best.dir, m: best.m };
}

/* ---------------- 5. Ausgabe ---------------- */

/** SVG-Pfad mit relativen Schritten (gerundet auf 0,1). */
function pathData(mp) {
  let out = '';
  for (const poly of mp) {
    for (const rg of poly) {
      const pts = rg.slice(0, -1).map(([x, y]) => [Math.round(x * 10), Math.round(y * 10)]);
      let prev = null;
      let s = '';
      for (const p of pts) {
        if (prev && p[0] === prev[0] && p[1] === prev[1]) continue;
        s += prev ? `l${(p[0] - prev[0]) / 10} ${(p[1] - prev[1]) / 10}` : `M${p[0] / 10} ${p[1] / 10}`;
        prev = p;
      }
      out += `${s}z`;
    }
  }
  return out.replace(/ -/g, '-').replace(/l(-?)0\./g, 'l$1.').replace(/ (-?)0\./g, ' $1.');
}

const continentShapes = Object.fromEntries(CONTINENTS.map((c) => [c.id, pc.union(...CONTINENT_TERRITORIES[c.id].map((id) => shapes[id]))]));

const data = {
  source: 'Natural Earth 1:50m (sane-topojson), gemeinfrei',
  projection: `Miller, Mitte ${LON0}°, ${LAT_BOTTOM}° bis ${LAT_TOP}°`,
  width: WIDTH,
  height: HEIGHT,
  style: STYLE,
  territories: Object.fromEntries(TERRITORY_IDS.map((id) => [id, { d: pathData(shapes[id]), marker: markers[id], label: labels[id] }])),
  continents: Object.fromEntries(CONTINENTS.map((c) => [c.id, pathData(continentShapes[c.id])])),
  otherLand: pathData(otherShape),
  lakes: pathData(lakes),
  seaLanes,
  landBorders,
};

const body = `'use strict';

/* Automatisch erzeugt von scripts/build-map.js – nicht von Hand ändern.
 * Quelle: Natural Earth 1:50m (Paket sane-topojson, gemeinfrei).
 * Läuft im Browser (window.RISIKO_MAP_PATHS) und in Node (module.exports). */

(function (root, data) {
  if (typeof module === 'object' && module.exports) module.exports = data;
  else root.RISIKO_MAP_PATHS = data;
}(typeof self !== 'undefined' ? self : this, ${JSON.stringify(data)}));
`;
fs.writeFileSync(OUT, body);

/* ---------------- Bericht ---------------- */

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`Karte ${WIDTH} × ${HEIGHT}, ${kb(body.length)} → ${path.relative(process.cwd(), OUT)}`);
console.log(`Landgrenzen: ${landBorders.length}, Seewege: ${seaLanes.length} (Nachbarschaften gesamt: ${BORDERS.length}), Seen: ${lakes.length}`);
if (seamDropped.size) console.log(`An der Naht weggelassen (Teile von): ${[...seamDropped].join(', ')}`);
console.log(`Küstensäume nach Lage zugeordnet: ${seams.n} (zusammen ${seams.area.toFixed(1)} Einheiten²)`);
if (failedLabels.length) {
  console.log(`WARNUNG – kein freier Platz für Namen: ${failedLabels.join(', ')}`);
  process.exitCode = 1;
}
if (wrongContacts.length) {
  console.log('WARNUNG – Landgrenze ohne Nachbarschaft in map.js:');
  for (const [a, b] of wrongContacts) console.log(`  ${TERRITORY[a].name} – ${TERRITORY[b].name}`);
  process.exitCode = 1;
}
const seaOverLand = seaLanes.filter((s) => !s.wrap && !LANE_ROUTES[pairKey(s.a, s.b)]).map((s) => `${s.a}–${s.b}`);
console.log(`Seewege: ${seaOverLand.join(', ')}`);
console.log(`Flächen (Einheiten²): ${TERRITORY_IDS.map((id) => `${id} ${mpArea(shapes[id]).toFixed(0)}`).join(', ')}`);
