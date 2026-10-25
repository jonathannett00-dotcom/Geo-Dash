'use strict';

/*
 * Schutz vor Missbrauch der öffentlichen Seite: Raumlimit, Rate-Limit pro IP,
 * Aufräumen leerer Räume und die Begrenzung beim Laden aus der Datenbank.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const {
  RoomManager, COLORS, FIGURES, ROOM_IDLE_MS, MAX_ACTIVE_ROOMS, ROOMS_PER_MINUTE_PER_IP, EMPTY_ROOM_MS,
} = require('../server/rooms');
const { createServer } = require('../server');

const MIN = 60 * 1000;

/** Host-Ansicht im Raum simulieren (Socket.IO-Adapter mit verbundenen Board-Sockets). */
function fakeIo(boards = new Set()) {
  return {
    sockets: { adapter: { rooms: { get: (name) => (boards.has(name.split(':')[0]) && name.endsWith(':board') ? new Set(['s']) : undefined) } } },
    to: () => ({ emit() {} }),
  };
}

test('Grenzen: höchstens 5 neue Räume pro Minute und IP', () => {
  const manager = new RoomManager({});
  const t0 = Date.now();
  for (let i = 0; i < ROOMS_PER_MINUTE_PER_IP; i++) manager.open({ ip: '1.2.3.4', now: t0 + i });
  assert.throws(() => manager.open({ ip: '1.2.3.4', now: t0 + 10 }), (err) => err.status === 429 && /warte eine Minute/.test(err.message));
  // Andere IP ist nicht betroffen, nach einer Minute geht es wieder
  assert.ok(manager.open({ ip: '5.6.7.8', now: t0 + 10 }));
  assert.ok(manager.open({ ip: '1.2.3.4', now: t0 + MIN + 5 }));
  manager.shutdown();
});

test('Grenzen: höchstens 20 Räume gleichzeitig, verlassene leere Räume machen Platz', () => {
  const manager = new RoomManager({});
  const boards = new Set();
  manager.io = fakeIo(boards);
  const t0 = Date.now();
  for (let i = 0; i < MAX_ACTIVE_ROOMS; i++) {
    const room = manager.open({ ip: `10.0.0.${i}`, now: t0 });
    boards.add(room.code);           // jeder Raum hat eine Host-Ansicht
  }
  assert.equal(manager.size, 20);
  assert.throws(() => manager.open({ ip: '10.0.1.1', now: t0 + 1000 }), (err) => err.status === 503 && /schon 20 Spiele/.test(err.message));

  // Ein Raum wird verlassen (kein Host, keine Spieler): nach 2 Minuten darf er Platz machen
  const left = [...manager.rooms.values()][3];
  boards.delete(left.code);
  left.lastActivity = t0;
  assert.throws(() => manager.open({ ip: '10.0.1.1', now: t0 + 30 * 1000 }), /schon 20 Spiele/, 'nicht sofort');
  const fresh = manager.open({ ip: '10.0.1.1', now: t0 + 3 * MIN });
  assert.ok(fresh);
  assert.equal(manager.size, 20);
  assert.equal(manager.get(left.code), undefined, 'der verlassene Raum ist weg');
  manager.io = null;
  manager.shutdown();
});

test('Aufräumen: leere Räume nach 30 Minuten, Räume mit Host oder Spielern bleiben', () => {
  const manager = new RoomManager({});
  const boards = new Set();
  manager.io = fakeIo(boards);
  const now = Date.now();
  const empty = manager.create();
  const hosted = manager.create();
  const withPlayer = manager.create();
  const young = manager.create();
  boards.add(hosted.code);
  withPlayer.join({ name: 'Anna', color: COLORS[0], figure: FIGURES[0] });
  for (const r of [empty, hosted, withPlayer]) r.lastActivity = now - EMPTY_ROOM_MS - 1;
  young.lastActivity = now - EMPTY_ROOM_MS + 60 * 1000;
  manager.sweep(now);
  assert.equal(manager.get(empty.code), undefined, 'leerer Raum nach 30 Minuten gelöscht');
  assert.ok(manager.get(hosted.code), 'Host-Ansicht verbunden');
  assert.ok(manager.get(withPlayer.code), 'Spieler im Raum');
  assert.ok(manager.get(young.code), 'noch keine 30 Minuten leer');
  // Laufende Spiele bleiben bis zu 6 h ohne Aktivität
  withPlayer.lastActivity = now - ROOM_IDLE_MS - 1;
  manager.sweep(now);
  assert.equal(manager.get(withPlayer.code), undefined);
  manager.io = null;
  manager.shutdown();
});

test('Datenbank: Gelöschte Räume verschwinden auch dort, beim Laden höchstens 20', async () => {
  const removed = [];
  const saved = Array.from({ length: 25 }, (_, i) => ({ version: 2, code: `AA${String.fromCharCode(65 + Math.floor(i / 10))}${String.fromCharCode(65 + (i % 10))}`, gameType: 'monopoly', settings: {}, started: false, lastActivity: Date.now(), players: [], game: null }));
  const store = {
    async loadAll() { return saved; },
    async remove(code) { removed.push(code); },
    async save() {},
  };
  const manager = new RoomManager({ store });
  assert.equal(await manager.loadFromStore(), 20);
  assert.deepEqual(removed.sort(), saved.slice(0, 5).map((d) => d.code).sort(), 'die 5 ältesten werden gelöscht');
  const room = manager.get(saved[24].code);
  room.lastActivity = Date.now() - EMPTY_ROOM_MS - 1;
  manager.sweep();
  assert.ok(removed.includes(room.code), 'leerer Raum auch aus der Datenbank entfernt');
  manager.shutdown();
});

/* ---------------- HTTP: Startseite ---------------- */

function request(port, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('Startseite: „/“ ist eine Seite, Räume anlegen und prüfen mit Grenzen', async () => {
  const srv = createServer({ testMode: true, seed: 'start' });
  const port = await srv.listen(0);
  try {
    const home = await request(port, 'GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.type, /html/);
    assert.match(home.body, /Neues Spiel starten/);
    assert.match(home.body, /Spiel beitreten/);

    const made = await request(port, 'POST', '/api/rooms', { 'X-Forwarded-For': '9.9.9.9' });
    assert.equal(made.status, 201);
    const { code } = JSON.parse(made.body);
    assert.match(code, /^[A-Z]{4}$/);
    const info = await request(port, 'GET', `/api/rooms/${code.toLowerCase()}`);
    assert.equal(info.status, 200);
    assert.equal(JSON.parse(info.body).code, code);
    assert.equal(JSON.parse(info.body).exists, true);
    const missing = await request(port, 'GET', '/api/rooms/ZZZZ');
    assert.equal(JSON.parse(missing.body).exists, false);
    assert.match(JSON.parse(missing.body).error, /gibt es nicht/);

    for (let i = 1; i < ROOMS_PER_MINUTE_PER_IP; i++) assert.equal((await request(port, 'POST', '/api/rooms', { 'X-Forwarded-For': '9.9.9.9' })).status, 201);
    const limited = await request(port, 'POST', '/api/rooms', { 'X-Forwarded-For': '9.9.9.9' });
    assert.equal(limited.status, 429);
    assert.match(JSON.parse(limited.body).error, /Bitte warte eine Minute/);
  } finally {
    await srv.close();
  }
});
