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
  room.mini = { stop() {} };
  room.broadcast();
  await manager.flush();
  assert.equal(store.rows.size, 0);
  room.mini = null;
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
