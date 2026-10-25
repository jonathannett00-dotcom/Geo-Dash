'use strict';

/*
 * Prüft die erzeugte Weltkarte (server/games/risiko/map-paths.js, gebaut von
 * scripts/build-map.js) gegen die Spieldaten aus map.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const geo = require('../server/games/risiko/map-paths');
const { TERRITORY_IDS, BORDERS, CONTINENTS } = require('../server/games/risiko/map');
const pkg = require('../package.json');

const pairKey = ([a, b]) => [a, b].sort().join('|');

/** SVG-Pfad (M, l, z) in Ringe mit absoluten Punkten zerlegen. */
function rings(d) {
  const out = [];
  let ring = null;
  let x = 0;
  let y = 0;
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
});

test('Weltkarte: Marker überlappen sich nicht (auch vergrößert auf dem Tablet)', () => {
  const ids = Object.keys(geo.territories);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = [geo.territories[ids[i]].marker, geo.territories[ids[j]].marker];
      assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) >= 22, `${ids[i]} – ${ids[j]}`);
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
});

test('Weltkarte: zur Laufzeit keine neuen Abhängigkeiten', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'games', 'risiko', 'map-paths.js'), 'utf8');
  assert.ok(!/require\(/.test(src), 'erzeugte Datei lädt nichts nach');
  for (const dep of ['world-atlas', 'topojson-client', 'polygon-clipping']) {
    assert.ok(pkg.devDependencies[dep], `${dep} nur als devDependency`);
    assert.ok(!pkg.dependencies[dep], `${dep} nicht zur Laufzeit`);
  }
  assert.ok(src.length < 400 * 1024, 'Kartendaten bleiben klein');
});
