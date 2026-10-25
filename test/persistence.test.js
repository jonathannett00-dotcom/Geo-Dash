'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MonopolyGame } = require('../server/monopoly/rules');
const { createRng } = require('../server/rng');
const { RoomManager, COLORS, FIGURES } = require('../server/rooms');
const { persistenceScenario } = require('./persistence-scenario');

/** Speicher im Arbeitsspeicher mit derselben Schnittstelle wie Postgres (inkl. JSON-Umwandlung). */
function memoryStore() {
  const rows = new Map();
  return {
    rows,
    async init() {},
    async save(code, state) { rows.set(code, JSON.stringify(state)); },
    async load(code) { return rows.has(code) ? JSON.parse(rows.get(code)) : null; },
    async loadAll() { return [...rows.values()].map((s) => JSON.parse(s)); },
    async remove(code) { rows.delete(code); },
    async close() {},
  };
}

test('Persistenz: Spielzustand übersteht toJSON/fromJSON vollständig', () => {
  const g = new MonopolyGame({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], rng: createRng('json') });
  g.forcedDice.push([3, 4]);
  g.roll('a');
  const copy = MonopolyGame.fromJSON(g.toJSON(), { rng: createRng('weiter') });
  assert.deepEqual(copy.publicState(), g.publicState());
  assert.equal(typeof copy.roll, 'function', 'Methoden sind wieder da');
  assert.ok(!('rng' in g.toJSON()), 'Zufallsgenerator wird nicht gespeichert');
});

test('Persistenz: Raum speichern, laden und Partie fortsetzen (Speicher im Arbeitsspeicher)', async () => {
  await persistenceScenario(memoryStore());
});

test('Persistenz: während eines Minispiels wird nicht gespeichert', async () => {
  const store = memoryStore();
  const manager = new RoomManager({ testMode: true, timeScale: 0.01, store });
  const room = manager.create();
  room.join({ name: 'Anna', color: COLORS[0], figure: FIGURES[0] });
  room.join({ name: 'Ben', color: COLORS[1], figure: FIGURES[1] });
  room.start();
  room.game.mini = { stop() {} };
  room.broadcast();
  await manager.flush();
  assert.equal(store.rows.size, 0);
  room.game.mini = null;
  room.broadcast();
  await manager.flush();
  assert.equal(store.rows.size, 1);
  manager.shutdown();
});

test('Persistenz: ohne Speicher bleibt alles im Arbeitsspeicher', async () => {
  const manager = new RoomManager({ testMode: true });
  const room = manager.create();
  room.broadcast();
  await manager.flush();
  assert.equal(await manager.loadFromStore(), 0);
  manager.shutdown();
});

test('Persistenz: Monopoly-Raum im alten Format (Version 1) übersteht den Neustart und wird als Version 2 weitergespeichert', async () => {
  // Spielstand, erzeugt mit dem Code vor der Spiel-Schnittstelle (main, 6e5fe60):
  // Anna hat die Turmstraße gekauft, Ben ist als Nächster dran, ein Testwurf [1, 2] steht noch aus.
  const v1 = JSON.parse(JSON.stringify(require('./fixtures/monopoly-raum-v1.json')));
  assert.equal(v1.version, 1);
  v1.lastActivity = Date.now();
  const store = memoryStore();
  await store.save(v1.code, v1);

  let manager = new RoomManager({ testMode: true, timeScale: 0.01, store });
  assert.equal(await manager.loadFromStore(), 1);
  let room = manager.get(v1.code);
  const [anna, ben] = room.players;
  const g = room.game.engine;
  assert.equal(room.gameType, 'monopoly');
  assert.equal(g.phase, 'end');
  assert.equal(g.player(anna.id).money, 1440);
  assert.equal(g.props[3].owner, anna.id);
  assert.deepEqual(g.forcedDice, [[1, 2]]);
  assert.deepEqual(room.game.shoe, { cards: [3, 7, 11] }, 'Blackjack-Schuh aus Version 1 bleibt erhalten');
  assert.equal(room.resume(anna.token).id, anna.id, 'alter Token funktioniert weiter');

  room.act(anna.id, { type: 'endTurn' });
  room.game.engine.roll(ben.id);              // → Turmstraße, Miete an Anna
  assert.equal(room.game.engine.player(ben.id).money, 1496);
  room.broadcast();
  await manager.flush();
  manager.shutdown();
  assert.equal(JSON.parse(store.rows.get(v1.code)).version, 2, 'nach der nächsten Änderung als Version 2 gespeichert');

  manager = new RoomManager({ testMode: true, timeScale: 0.01, store });
  await manager.loadFromStore();
  room = manager.get(v1.code);
  assert.equal(room.game.engine.player(anna.id).money, 1444);
  assert.equal(room.game.engine.currentPlayer().id, ben.id);
  assert.deepEqual(room.game.shoe, { cards: [3, 7, 11] });
  room.act(ben.id, { type: 'endTurn' });
  assert.equal(room.game.engine.currentPlayer().id, anna.id);
  manager.shutdown();
});
