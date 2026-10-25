'use strict';

/*
 * Prüft die erzeugte Weltkarte (server/games/risiko/map-paths.js, gebaut von
 * scripts/build-map.js) gegen die Spieldaten aus map.js: Flächen, Marker,
 * Namen (ohne Überlappung bei TV- und Tablet-Größe), Grenzen und Seewege.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const geo = require('../server/games/risiko/map-paths');
const { TERRITORY_IDS, TERRITORY, BORDERS, CONTINENTS } = require('../server/games/risiko/map');
const pkg = require('../package.json');

const pairKey = ([a, b]) => [a, b].sort().join('|');
const ST = geo.style;
/** Pixel je Karteneinheit: Tablet 1024×768 (≈ 1,0) bis großer TV (≈ 2,2). */
const SCALES = [0.98, 1.2, 1.45, 1.7, 1.86, 2.2];
const DIRS = { s: [0, 1], n: [0, -1], e: [1, 0], w: [-1, 0], se: [0.72, 0.72], sw: [-0.72, 0.72], ne: [0.72, -0.72], nw: [-0.72, -0.72] };

/** SVG-Pfad (M, l, z) in Ringe mit absoluten Punkten zerlegen. */
function rings(d) {
  const out = [];
  let ring = null; let x = 0; let y = 0;
  for (const m of d.matchAll(/([Mlz])(?:(-?[\d.]+)[ ]?(-?[\d.]+))?/g)) {
    if (m[1] === 'M') { x = Number(m[2]); y = Number(m[3]); ring = [[x, y]]; out.push(ring); }
    else if (m[1] === 'l') { x += Number(m[2]); y += Number(m[3]); ring.push([x, y]); }
  }
  return out;
}

/** Gerade-ungerade-Regel wie beim Zeichnen (fill-rule: evenodd). */
function inside([px, py], rs) {
  let hit = false;
  for (const r of rs) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i]; const [xj, yj] = r[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

/** Größen wie in der Host-Ansicht (public/board/risiko.js). */
function sizes(k) {
  const markerScale = Math.max(1, Math.min(ST.markerMaxScale, ST.markerMinPx / (ST.markerR * k)));
  return { r: ST.markerR * markerScale, font: Math.max(ST.labelMinPx, Math.min(ST.labelMaxPx, ST.labelUnits * k)) / k };
}
function labelBox(id, k) {
  const { r, font } = sizes(k);
  const { marker: [mx, my], label } = geo.territories[id];
  const w = TERRITORY[id].name.length * ST.charWidth * font;
  if (label.x !== undefined) return [label.x - w / 2, label.y - font / 2, label.x + w / 2, label.y + font / 2];
  const [dx, dy] = DIRS[label.dir];
  const d = (r + ST.labelGap * font) * label.m;
  const ax = mx + dx * d; const ay = my + dy * d;
  const x0 = dx > 0.1 ? ax : dx < -0.1 ? ax - w : ax - w / 2;
  const y0 = dy > 0.1 ? ay : dy < -0.1 ? ay - font : ay - font / 2;
  return [x0, y0, x0 + w, y0 + font];
}
const overlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const circleHitsBox = ([cx, cy], r, b) => {
  const x = Math.max(b[0], Math.min(cx, b[2])); const y = Math.max(b[1], Math.min(cy, b[3]));
  return (x - cx) ** 2 + (y - cy) ** 2 < r * r;
};

test('Weltkarte: alle 42 Gebiete haben eine Fläche und einen Marker im eigenen Gebiet', () => {
  assert.deepEqual(Object.keys(geo.territories).sort(), [...TERRITORY_IDS].sort());
  assert.ok(geo.width === 1000 && geo.height > 400 && geo.height < 600);
  for (const id of TERRITORY_IDS) {
    const { d, marker } = geo.territories[id];
    const rs = rings(d);
    assert.ok(rs.length >= 1 && rs.every((r) => r.length >= 3), `${id}: Fläche`);
    for (const [x, y] of rs.flat()) assert.ok(x >= -0.1 && x <= geo.width + 0.1 && y >= -0.1 && y <= geo.height + 0.1, `${id}: Punkt im Bild`);
    assert.ok(inside(marker, rs), `${id}: Marker liegt im Gebiet`);
  }
  assert.deepEqual(Object.keys(geo.continents).sort(), CONTINENTS.map((c) => c.id).sort());
  assert.ok(rings(geo.lakes).length > 10, 'große Seen sind Wasser');
});

test('Weltkarte: Marker überlappen sich nicht, auch vergrößert auf dem Tablet', () => {
  for (const k of SCALES) {
    const { r } = sizes(k);
    for (let i = 0; i < TERRITORY_IDS.length; i++) {
      for (let j = i + 1; j < TERRITORY_IDS.length; j++) {
        const [a, b] = [geo.territories[TERRITORY_IDS[i]].marker, geo.territories[TERRITORY_IDS[j]].marker];
        assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) >= 2 * r, `${TERRITORY_IDS[i]} – ${TERRITORY_IDS[j]} bei ${k} px/Einheit`);
      }
    }
  }
});

test('Weltkarte: Namen auf jedem Gebiet, ohne Überlappung mit Markern oder anderen Namen', () => {
  for (const k of SCALES) {
    const { r, font } = sizes(k);
    assert.ok(font * k >= ST.labelMinPx - 1e-9, 'Namen bleiben lesbar');
    const boxes = Object.fromEntries(TERRITORY_IDS.map((id) => [id, labelBox(id, k)]));
    for (const id of TERRITORY_IDS) {
      const b = boxes[id];
      assert.ok(b[0] >= 0 && b[1] >= 0 && b[2] <= geo.width && b[3] <= geo.height, `${id}: Name im Bild (${k})`);
      for (const o of TERRITORY_IDS) {
        assert.ok(!circleHitsBox(geo.territories[o].marker, r, b), `Name ${id} überdeckt Marker ${o} (${k})`);
        if (o !== id) assert.ok(!overlap(b, boxes[o]), `Namen ${id} und ${o} überlappen (${k})`);
      }
    }
  }
});

test('Weltkarte: Landgrenzen und Seewege ergeben genau die 83 Nachbarschaften aus map.js', () => {
  const risiko = new Set(BORDERS.map(pairKey));
  const land = geo.landBorders.map(pairKey);
  const sea = geo.seaLanes.map((s) => pairKey([s.a, s.b]));
  for (const k of land) assert.ok(risiko.has(k), `Landgrenze ohne Nachbarschaft: ${k}`);
  for (const k of sea) assert.ok(risiko.has(k), `Seeweg ohne Nachbarschaft: ${k}`);
  assert.equal(new Set([...land, ...sea]).size, land.length + sea.length, 'kein Paar doppelt');
  assert.deepEqual([...land, ...sea].sort(), [...risiko].sort());
  for (const pair of [['alaska', 'kamtschatka'], ['groenland', 'island'], ['suedostasien', 'indonesien'], ['brasilien', 'nordafrika']]) {
    assert.ok(sea.includes(pairKey(pair)), `Seeweg ${pair.join(' – ')}`);
  }
  assert.ok(geo.seaLanes.find((s) => pairKey([s.a, s.b]) === pairKey(['alaska', 'kamtschatka'])).wrap, 'über den Kartenrand');
  for (const s of geo.seaLanes) assert.match(s.d, /^M[\d. -]+[QC]/, `${s.a}–${s.b}: geschwungene Kurve`);
});

test('Weltkarte: zur Laufzeit keine neuen Abhängigkeiten', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'games', 'risiko', 'map-paths.js'), 'utf8');
  assert.ok(!/require\(/.test(src), 'erzeugte Datei lädt nichts nach');
  for (const dep of ['sane-topojson', 'topojson-client', 'polygon-clipping']) {
    assert.ok(pkg.devDependencies[dep], `${dep} nur als devDependency`);
    assert.ok(!pkg.dependencies[dep], `${dep} nicht zur Laufzeit`);
  }
  assert.ok(src.length < 400 * 1024, 'Kartendaten bleiben klein');
});
