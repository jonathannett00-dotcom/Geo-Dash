'use strict';

/* =========================================================
 *  Baut die realistische Risiko-Weltkarte für die Host-Ansicht.
 *
 *  Quelle: Natural Earth 1:50m (Paket world-atlas, gemeinfrei).
 *  Ablauf:
 *   1. Arcs der Länder-Topologie projizieren (Miller-Zylinderprojektion,
 *      Naht im Pazifik bei 169,5° W) und vereinfachen. Weil benachbarte
 *      Länder dieselben Arcs teilen, bleiben gemeinsame Grenzen deckungsgleich.
 *   2. Länder den 42 Gebieten aus map.js zuordnen; Kanada, USA, Russland
 *      und Australien entlang fester Längen-/Breitengrade schneiden.
 *   3. Kontakte zwischen Gebieten prüfen: Jede Landgrenze muss eine
 *      Nachbarschaft aus map.js sein; Nachbarn ohne Landgrenze bekommen
 *      einen gestrichelten Seeweg.
 *   4. Ergebnis als statische Daten nach server/games/risiko/map-paths.js.
 *
 *  Nur zum Bauen (devDependencies): node scripts/build-map.js
 *  Zur Laufzeit wird nur die erzeugte Datei gebraucht.
 * ========================================================= */

const fs = require('fs');
const path = require('path');
const topojson = require('topojson-client');
const pc = require('polygon-clipping');
const world = require('world-atlas/countries-50m.json');
const { TERRITORY_IDS, CONTINENTS, CONTINENT_TERRITORIES, BORDERS, TERRITORY } = require('../server/games/risiko/map');

const OUT = path.join(__dirname, '..', 'server', 'games', 'risiko', 'map-paths.js');

/* ---------------- Projektion ---------------- */

const WIDTH = 1000;
const SEAM = -169.5;                 // Naht zwischen Tschukotka und Alaska
const LON0 = SEAM + 180;             // Kartenmitte
const LAT_TOP = 83.7;
const LAT_BOTTOM = -56.2;
const SIMPLIFY = 0.22;               // Douglas-Peucker-Toleranz in Karteneinheiten
const MIN_AREA = 0.6;                // kleinere Inseln entfallen (Karteneinheiten²)

const rad = Math.PI / 180;
const millerY = (lat) => 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * lat * rad));
const SCALE = WIDTH / (2 * Math.PI);
const Y_TOP = millerY(LAT_TOP);
const HEIGHT = Math.round((Y_TOP - millerY(LAT_BOTTOM)) * SCALE * 10) / 10;

const unwrap = (lon) => (lon < SEAM ? lon + 360 : lon);
const px = (lon) => (unwrap(lon) - LON0) * rad * SCALE + WIDTH / 2;
const py = (lat) => (Y_TOP - millerY(Math.max(-89, Math.min(89, lat)))) * SCALE;
const project = ([lon, lat]) => [px(lon), py(lat)];
/** x ohne Umklappen an der Naht (für Kastengrenzen jenseits von 180°). */
const pxRaw = (lon) => (lon - LON0) * rad * SCALE + WIDTH / 2;

/* ---------------- Geometrie-Hilfen ---------------- */

function simplifyLine(points, tol) {
  if (points.length <= 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const closed = points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1];
  if (closed) {
    // Geschlossener Arc: weitesten Punkt vom Start erzwingen, damit der Ring nicht kollabiert
    let far = 1;
    let best = -1;
    for (let i = 1; i < points.length - 1; i++) {
      const d = (points[i][0] - points[0][0]) ** 2 + (points[i][1] - points[0][1]) ** 2;
      if (d > best) { best = d; far = i; }
    }
    keep[far] = 1;
    stack.length = 0;
    stack.push([0, far], [far, points.length - 1]);
  }
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let idx = -1;
    let max = tol * tol;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = points[i];
      let d;
      if (len2 === 0) d = (x - ax) ** 2 + (y - ay) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
        d = (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2;
      }
      if (d > max) { max = d; idx = i; }
    }
    if (idx >= 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function ringArea(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return s / 2;
}
const polyArea = (poly) => Math.abs(ringArea(poly[0])) - poly.slice(1).reduce((s, r) => s + Math.abs(ringArea(r)), 0);

function ringCentroid(ring) {
  let a = 0; let cx = 0; let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    cx += (ring[j][0] + ring[i][0]) * f;
    cy += (ring[j][1] + ring[i][1]) * f;
  }
  if (a === 0) return ring[0];
  return [cx / (3 * a), cy / (3 * a)];
}

function bbox(poly) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [x, y] of poly[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}

/** Kasten in Grad → Rechteck-Polygon in Karteneinheiten (Miller: Meridiane und Breitenkreise sind Geraden). */
function box([lon0, lon1, lat0, lat1]) {
  const x0 = pxRaw(lon0); const x1 = pxRaw(lon1); const y0 = py(lat1); const y1 = py(lat0);
  return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
}
const inBox = ([x, y], b) => {
  const [[[x0, y0], , [x1, y1]]] = box(b);
  return x >= x0 && x < x1 && y >= y0 && y < y1;
};

/* ---------------- 1. Topologie projizieren und vereinfachen ---------------- */

const topo = JSON.parse(JSON.stringify(world));
{
  const { scale: [sx, sy], translate: [tx, ty] } = topo.transform;
  topo.arcs = topo.arcs.map((arc) => {
    let x = 0; let y = 0;
    const pts = arc.map(([dx, dy]) => { x += dx; y += dy; return project([x * sx + tx, y * sy + ty]); });
    return simplifyLine(pts, SIMPLIFY);
  });
  delete topo.transform;
}

/* ---------------- 2. Zuordnung der Länder ---------------- */

const COUNTRIES = {
  groenland: ['Greenland'],
  mittelamerika: ['Mexico', 'Guatemala', 'Belize', 'Honduras', 'El Salvador', 'Nicaragua', 'Costa Rica', 'Panama', 'Cuba', 'Jamaica', 'Haiti',
    'Dominican Rep.', 'Bahamas', 'Puerto Rico', 'Cayman Is.', 'Turks and Caicos Is.', 'British Virgin Is.', 'U.S. Virgin Is.', 'Anguilla',
    'Antigua and Barb.', 'St. Kitts and Nevis', 'Montserrat', 'Dominica', 'Saint Lucia', 'St. Vin. and Gren.', 'Barbados', 'Grenada',
    'St-Martin', 'Sint Maarten', 'St-Barthélemy'],
  quebec: ['St. Pierre and Miquelon'],
  venezuela: ['Venezuela', 'Colombia', 'Guyana', 'Suriname', 'Trinidad and Tobago', 'Aruba', 'Curaçao'],
  peru: ['Peru', 'Ecuador', 'Bolivia'],
  brasilien: ['Brazil'],
  argentinien: ['Argentina', 'Chile', 'Paraguay', 'Uruguay', 'Falkland Is.'],
  island: ['Iceland'],
  grossbritannien: ['United Kingdom', 'Ireland', 'Isle of Man', 'Guernsey', 'Jersey'],
  skandinavien: ['Norway', 'Sweden', 'Finland', 'Denmark', 'Åland', 'Faeroe Is.'],
  nordeuropa: ['Germany', 'Poland', 'Netherlands', 'Belgium', 'Luxembourg', 'Czechia'],
  westeuropa: ['France', 'Spain', 'Portugal', 'Andorra', 'Monaco', 'Switzerland', 'Liechtenstein'],
  suedeuropa: ['Italy', 'San Marino', 'Vatican', 'Malta', 'Austria', 'Slovenia', 'Croatia', 'Bosnia and Herz.', 'Serbia', 'Montenegro', 'Kosovo',
    'Albania', 'Macedonia', 'Greece', 'Bulgaria', 'Romania', 'Hungary', 'Slovakia'],
  osteuropa: ['Ukraine', 'Belarus', 'Moldova', 'Lithuania', 'Latvia', 'Estonia'],
  nordafrika: ['Morocco', 'W. Sahara', 'Algeria', 'Tunisia', 'Libya', 'Mauritania', 'Mali', 'Niger', 'Chad', 'Senegal', 'Gambia', 'Guinea-Bissau',
    'Guinea', 'Sierra Leone', 'Liberia', "Côte d'Ivoire", 'Burkina Faso', 'Ghana', 'Togo', 'Benin', 'Nigeria', 'Cabo Verde', 'Central African Rep.'],
  aegypten: ['Egypt', 'Sudan'],
  ostafrika: ['Ethiopia', 'Eritrea', 'Djibouti', 'Somalia', 'Somaliland', 'Kenya', 'Uganda', 'Tanzania', 'Rwanda', 'Burundi', 'S. Sudan', 'Malawi'],
  zentralafrika: ['Cameroon', 'Gabon', 'Eq. Guinea', 'Congo', 'Dem. Rep. Congo', 'Angola', 'São Tomé and Principe'],
  suedafrika: ['South Africa', 'Namibia', 'Botswana', 'Zimbabwe', 'Mozambique', 'Lesotho', 'eSwatini', 'Zambia'],
  madagaskar: ['Madagascar', 'Comoros', 'Mauritius'],
  'naher-osten': ['Turkey', 'Syria', 'Iraq', 'Iran', 'Saudi Arabia', 'Yemen', 'Oman', 'United Arab Emirates', 'Qatar', 'Bahrain', 'Kuwait', 'Jordan',
    'Israel', 'Palestine', 'Lebanon', 'Cyprus', 'N. Cyprus', 'Georgia', 'Armenia', 'Azerbaijan'],
  afghanistan: ['Afghanistan', 'Kazakhstan', 'Uzbekistan', 'Turkmenistan', 'Kyrgyzstan', 'Tajikistan'],
  indien: ['India', 'Pakistan', 'Nepal', 'Bhutan', 'Bangladesh', 'Sri Lanka', 'Siachen Glacier'],
  china: ['China', 'Taiwan', 'North Korea', 'South Korea', 'Hong Kong', 'Macao'],
  mongolei: ['Mongolia'],
  japan: ['Japan'],
  suedostasien: ['Myanmar', 'Thailand', 'Laos', 'Cambodia', 'Vietnam', 'Singapore'],
  indonesien: ['Timor-Leste', 'Philippines', 'Brunei'],
  neuguinea: ['Papua New Guinea'],
};

/** Länder, deren Teile einzeln (nach Lage) zugeordnet werden; null = unbespieltes Land. */
const BY_PART = {
  France: (lon, lat) => (lon < -40 ? (lat < 10 ? 'venezuela' : 'mittelamerika') : lon > 40 ? (lon < 60 ? 'madagaskar' : null) : 'westeuropa'),
  Netherlands: (lon, lat) => (lon < -50 ? (lat < 13 ? 'venezuela' : 'mittelamerika') : 'nordeuropa'),
  Norway: (lon, lat) => (lat < -30 ? null : 'skandinavien'),
  Chile: (lon) => (lon < -80 ? null : 'argentinien'),
  Ecuador: (lon) => (lon < -85 ? null : 'peru'),
  Malaysia: (lon) => (lon < 105 ? 'suedostasien' : 'indonesien'),
  Indonesia: (lon) => (lon < 134 ? 'indonesien' : 'neuguinea'),
  Portugal: () => 'westeuropa',
  Spain: () => 'westeuropa',
};

/** Geteilte Länder: Kästen [lonMin, lonMax, latMin, latMax], der erste passende gewinnt. */
const CUTS = {
  Canada: {
    boxes: [
      ['nordwest-territorium', [-145, -79.5, 60, 90]],
      ['alberta', [-145, -110, -90, 60]],
      ['ontario', [-110, -79.5, -90, 60]],
      ['quebec', [-79.5, -40, -90, 90]],
    ],
    // Inseln nördlich von 60° (Baffin, Arktis) gehören zum Nordwest-Territorium
    part: (lon, lat) => (lat >= 60 ? 'nordwest-territorium' : null),
  },
  'United States of America': {
    boxes: [
      ['weststaaten', [-130, -100, -90, 90]],
      ['oststaaten', [-100, -60, -90, 90]],
    ],
    part: (lon, lat) => (lat < 30 && lon < -150 ? 'none' : lon < -129 && lat > 50 ? 'alaska' : null),
  },
  Russia: {
    boxes: [
      ['osteuropa', [15, 56, -90, 90]],
      ['ural', [56, 76, -90, 90]],
      ['ural', [76, 87.5, -90, 55]],
      ['sibirien', [76, 102, -90, 90]],
      ['mongolei', [112, 141.5, -90, 54.5]],
      ['irkutsk', [102, 128, -90, 59]],
      ['jakutien', [102, 141.5, 59, 90]],
      ['kamtschatka', [128, 200, -90, 90]],
    ],
    part: (lon) => (lon < 0 || lon > 180 ? 'kamtschatka' : null),
  },
  Australia: {
    boxes: [
      ['westaustralien', [100, 135, -90, 90]],
      ['ostaustralien', [135, 170, -90, 90]],
    ],
  },
};

const OWNER = {};
for (const [t, list] of Object.entries(COUNTRIES)) for (const name of list) OWNER[name] = t;

/** Lage eines Teils in Grad (für die Zuordnung), aus dem projizierten Schwerpunkt zurückgerechnet. */
function lonLat([x, y]) {
  const lon = (x - WIDTH / 2) / SCALE / rad + LON0;
  const m = Y_TOP - y / SCALE;
  const lat = (Math.atan(Math.exp(m / 1.25)) - Math.PI / 4) / 0.4 / rad;
  return [lon > 180 ? lon - 360 : lon, lat];
}

const pieces = Object.fromEntries(TERRITORY_IDS.map((id) => [id, { topo: [], geo: [] }]));
const other = { topo: [], geo: [] };
const unassigned = new Set();
const seamDropped = new Set();
const ALASKA_X = [px(SEAM + 0.01), px(-129)];

for (const g of world.objects.countries.geometries) {
  const name = g.properties.name;
  if (name === 'Antarctica') continue;
  const polys = g.type === 'Polygon' ? [g.arcs] : g.type === 'MultiPolygon' ? g.arcs : [];
  const feats = polys.map((arcs) => ({ arcs, coords: topojson.feature(topo, { type: 'Polygon', arcs }).geometry.coordinates }));
  const cut = CUTS[name];
  const largest = cut ? feats.reduce((m, f) => (polyArea(f.coords) > polyArea(m.coords) ? f : m), feats[0]) : null;

  for (const f of feats) {
    // Teile, die über die Naht reichen (Inseln in der Beringsee), entfallen
    const [bx0, , bx1] = bbox(f.coords);
    if (bx1 - bx0 > WIDTH / 2) { seamDropped.add(name); continue; }
    const [lon, lat] = lonLat(ringCentroid(f.coords[0]));
    let target;
    if (cut) {
      if (f === largest) {
        // Festland entlang der Kästen schneiden
        let rest = [f.coords];
        for (const [t, b] of cut.boxes) {
          if (!rest.length) break;
          const part = pc.intersection(rest, box(b));
          if (part.length) pieces[t].geo.push(...part);
          rest = pc.difference(rest, box(b));
        }
        continue;
      }
      target = (cut.part && cut.part(lon, lat)) || cut.boxes.find(([, b]) => inBox(project([lon, lat]), b))?.[0] || null;
      if (target === 'alaska') {
        const [x0, , x1] = bbox(f.coords);
        if (x0 < ALASKA_X[0] || x1 > ALASKA_X[1]) target = 'none';   // Aleuten jenseits der Naht entfallen
      }
      if (target === 'none') continue;
    } else if (BY_PART[name]) {
      target = BY_PART[name](lon, lat);
    } else {
      target = OWNER[name] || null;
      if (!target) unassigned.add(name);
    }
    (target ? pieces[target] : other).topo.push({ type: 'Polygon', arcs: f.arcs });
  }
}

/* ---------------- Gebiete zusammensetzen ---------------- */

const EXTENT = [[[0, 0], [WIDTH, 0], [WIDTH, HEIGHT], [0, HEIGHT], [0, 0]]];

function assemble({ topo: parts, geo }) {
  const merged = parts.length ? topojson.merge(topo, parts).coordinates : [];
  let mp = pc.union(merged, ...geo);
  mp = pc.intersection(mp, EXTENT);
  // Winzige Inseln und Löcher weglassen, das größte Teil bleibt immer
  const big = mp.reduce((m, p) => (polyArea(p) > polyArea(m) ? p : m), mp[0]);
  return mp
    .filter((p) => p === big || Math.abs(ringArea(p[0])) >= MIN_AREA)
    .map((p) => [p[0], ...p.slice(1).filter((r) => Math.abs(ringArea(r)) >= MIN_AREA)]);
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

/** Kanten eines Gebiets mit Rasterindex für schnelle Abstandsabfragen. */
const CELL = 4;
function edgeIndex(mp) {
  const edges = [];
  for (const poly of mp) for (const ring of poly) for (let i = 1; i < ring.length; i++) edges.push([...ring[i - 1], ...ring[i]]);
  const grid = new Map();
  edges.forEach((e, n) => {
    const [x0, x1] = [Math.min(e[0], e[2]), Math.max(e[0], e[2])];
    const [y0, y1] = [Math.min(e[1], e[3]), Math.max(e[1], e[3])];
    for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) {
      for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
        const k = `${gx},${gy}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(n);
      }
    }
  });
  return { edges, grid };
}
function segDist2(x, y, [ax, ay, bx, by]) {
  const dx = bx - ax; const dy = by - ay; const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
  return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2;
}
/** Abstand eines Punkts zum Rand (nur Nachbarzellen; Infinity, wenn weiter weg). */
function nearDist(idx, x, y) {
  let min = Infinity;
  const gx = Math.floor(x / CELL); const gy = Math.floor(y / CELL);
  for (let i = gx - 1; i <= gx + 1; i++) for (let j = gy - 1; j <= gy + 1; j++) {
    for (const n of idx.grid.get(`${i},${j}`) || []) min = Math.min(min, segDist2(x, y, idx.edges[n]));
  }
  return Math.sqrt(min);
}
const index = Object.fromEntries(TERRITORY_IDS.map((id) => [id, edgeIndex(shapes[id])]));

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

/**
 * Handverlegte Seewege (Grad), wo die kürzeste Verbindung über fremdes Land
 * führen würde: Ontario – Grönland durch Hudson Bay und Hudson-Straße.
 */
const LANE_ROUTES = {
  [pairKey('ontario', 'groenland')]: [[-84.6, 55.6], [-80.6, 61.0], [-71.5, 62.25], [-62.6, 61.3], [-48.2, 60.9]],
};

const seaLanes = [];
for (const [a, b] of BORDERS) {
  if (landSet.has(pairKey(a, b))) continue;
  if (LANE_ROUTES[pairKey(a, b)]) {
    const pts = LANE_ROUTES[pairKey(a, b)].map(project);
    seaLanes.push({ a, b, wrap: false, lines: pts.slice(1).map((q, i) => [pts[i], q]) });
    continue;
  }
  const all = (id) => shapes[id].flat(2);
  const [ax] = [all(a).reduce((s, p) => s + p[0], 0) / all(a).length];
  const [bx] = [all(b).reduce((s, p) => s + p[0], 0) / all(b).length];
  if (Math.abs(ax - bx) > WIDTH / 2) {
    // Über den Kartenrand (Alaska – Kamtschatka): je ein Stück bis zum Rand
    const [west, east] = ax < bx ? [a, b] : [b, a];
    const w = all(west).reduce((m, p) => (p[0] < m[0] ? p : m));
    const e = all(east).reduce((m, p) => (p[0] > m[0] ? p : m));
    seaLanes.push({ a, b, wrap: true, lines: [[w, [0, w[1]]], [e, [WIDTH, e[1]]]] });
  } else {
    seaLanes.push({ a, b, wrap: false, lines: [closest(a, b)] });
  }
}

/* ---------------- Marker: Punkt mit größtem Abstand zum Rand ---------------- */

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
function edgeDist([x, y], poly) {
  let min = Infinity;
  for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[j]; const [bx, by] = ring[i];
      const dx = bx - ax; const dy = by - ay; const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      min = Math.min(min, (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2);
    }
  }
  return Math.sqrt(min);
}
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

/** Handverlegte Marker, wo der rechnerische Punkt ungünstig liegt (Grad). */
const MARKER_OVERRIDES = {};

const markers = {};
for (const id of TERRITORY_IDS) {
  if (MARKER_OVERRIDES[id]) { markers[id] = project(MARKER_OVERRIDES[id]).map(r1); continue; }
  const main = shapes[id].reduce((m, p) => (polyArea(p) > polyArea(m) ? p : m));
  markers[id] = poleOfInaccessibility(main).map(r1);
}

/* ---------------- 4. Ausgabe ---------------- */

/** SVG-Pfad mit relativen Schritten (gerundet auf 0,1). */
function pathData(mp) {
  let out = '';
  for (const poly of mp) {
    for (const ring of poly) {
      const pts = ring.slice(0, -1).map(([x, y]) => [Math.round(x * 10), Math.round(y * 10)]);
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
const seg = ([p, q]) => [r1(p[0]), r1(p[1]), r1(q[0]), r1(q[1])];

const data = {
  source: 'Natural Earth 1:50m (world-atlas), gemeinfrei',
  projection: `Miller, Mitte ${LON0}°, ${LAT_BOTTOM}° bis ${LAT_TOP}°`,
  width: WIDTH,
  height: HEIGHT,
  territories: Object.fromEntries(TERRITORY_IDS.map((id) => [id, { d: pathData(shapes[id]), marker: markers[id] }])),
  continents: Object.fromEntries(CONTINENTS.map((c) => [c.id, pathData(continentShapes[c.id])])),
  otherLand: pathData(otherShape),
  seaLanes: seaLanes.map((s) => ({ a: s.a, b: s.b, wrap: s.wrap, lines: s.lines.map(seg) })),
  landBorders,
};

const body = `'use strict';

/* Automatisch erzeugt von scripts/build-map.js – nicht von Hand ändern.
 * Quelle: Natural Earth 1:50m (Paket world-atlas, gemeinfrei).
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
console.log(`Landgrenzen: ${landBorders.length}, Seewege: ${seaLanes.length} (Nachbarschaften gesamt: ${BORDERS.length})`);
if (seamDropped.size) console.log(`An der Naht weggelassen (Teile von): ${[...seamDropped].join(', ')}`);
if (unassigned.size) console.log(`Unbespieltes Land (grau): ${[...unassigned].sort().join(', ')}`);
if (wrongContacts.length) {
  console.log('WARNUNG – Landgrenze ohne Nachbarschaft in map.js:');
  for (const [a, b] of wrongContacts) console.log(`  ${TERRITORY[a].name} – ${TERRITORY[b].name}`);
  process.exitCode = 1;
}
