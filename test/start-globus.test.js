'use strict';

/*
 * Punktdatei der Weltkugel auf der Startseite (scripts/build-globe.js):
 * klein, gültig, deterministisch und identisch mit dem neuen Bau.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'start', 'globe-points.json');
const hasSource = (() => { try { require.resolve('sane-topojson/dist/world_50m.json'); require.resolve('topojson-client'); return true; } catch (_) { return false; } })();

test('Weltkugel: Punktdatei ist kleiner als 150 KB und gültig', () => {
  const text = fs.readFileSync(FILE, 'utf8');
  assert.ok(Buffer.byteLength(text) < 150 * 1024, `${Buffer.byteLength(text)} Bytes`);
  const data = JSON.parse(text);
  assert.equal(data.version, 1);
  assert.equal(data.points.length, data.count * 2);
  assert.ok(data.count > 3000, 'genug Landpunkte');
  for (let i = 0; i < data.points.length; i += 2) {
    assert.ok(Number.isInteger(data.points[i]) && Math.abs(data.points[i]) <= 900);
    assert.ok(Number.isInteger(data.points[i + 1]) && Math.abs(data.points[i + 1]) <= 1800);
  }
  // Stichproben: Land und Meer
  const near = (lat, lon) => { for (let i = 0; i < data.points.length; i += 2) if (Math.abs(data.points[i] / 10 - lat) < 1.3 && Math.abs(data.points[i + 1] / 10 - lon) < 1.6) return true; return false; };
  assert.ok(near(51, 10), 'Deutschland ist Land');
  assert.ok(near(-25, 134), 'Australien ist Land');
  assert.ok(!near(0, -30), 'Mitte des Atlantiks ist Meer');
  assert.ok(!near(-40, -140), 'Südpazifik ist Meer');
});

test('Weltkugel: Bau ist deterministisch und entspricht der Datei im Repo', { skip: hasSource ? false : 'devDependencies fehlen' }, () => {
  const { buildGlobe, toJson } = require('../scripts/build-globe');
  const a = toJson(buildGlobe());
  const b = toJson(buildGlobe());
  assert.equal(a, b);
  assert.equal(a, fs.readFileSync(FILE, 'utf8'), 'npm run build:globe ausführen und die Datei committen');
});
