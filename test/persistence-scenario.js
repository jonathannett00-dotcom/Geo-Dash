'use strict';

/*
 * Gemeinsames Szenario für die Persistenz-Tests: Partie spielen, speichern,
 * „Server neu starten“ (neuer RoomManager), laden, weiterspielen, erneut laden.
 * Läuft gegen jeden Speicher mit init/save/load/loadAll/remove.
 */

const assert = require('node:assert/strict');
const { RoomManager, COLORS, FIGURES } = require('../server/rooms');

const newManager = (store) => new RoomManager({ testMode: true, seed: 'persist', timeScale: 0.01, store });

async function saveAndRestart(manager, room, store) {
  room.broadcast();          // jede Änderung wird so zum Speichern vorgemerkt
  await manager.flush();
  manager.shutdown();        // Server weg – die Datenbank behält den Stand
  const next = newManager(store);
  await next.loadFromStore();
  return { manager: next, room: next.get(room.code) };
}

async function persistenceScenario(store) {
  await store.init();

  /* ---------- Partie beginnen ---------- */
  let manager = newManager(store);
  let room = manager.create();
  const code = room.code;
  const anna = room.join({ name: 'Anna', color: COLORS[0], figure: FIGURES[0] });
  const ben = room.join({ name: 'Ben', color: COLORS[1], figure: FIGURES[1] });
  room.pendingDice.push([1, 2], [1, 2]);
  room.start();
  room.game.engine.roll(anna.id);           // → Turmstraße
  room.act(anna.id, { type: 'buy' });
  assert.equal(room.game.engine.phase, 'end');

  /* ---------- speichern und laden ---------- */
  ({ manager, room } = await saveAndRestart(manager, room, store));
  assert.ok(room, 'Raum wurde aus dem Speicher geladen');
  assert.equal(room.code, code);
  assert.equal(room.started, true);
  assert.deepEqual(room.players.map((p) => p.name), ['Anna', 'Ben']);
  assert.ok(room.players.every((p) => !p.connected), 'nach dem Neustart sind alle getrennt');
  const g = room.game.engine;
  assert.equal(g.player(anna.id).money, 1440);
  assert.equal(g.props[3].owner, anna.id);
  assert.equal(g.phase, 'end');
  assert.equal(g.currentPlayer().id, anna.id);
  assert.ok(g.log.some((e) => /kauft Turmstraße/.test(e.text)), 'Ereignis-Ticker bleibt erhalten');
  assert.deepEqual(g.forcedDice, [[1, 2]], 'auch noch ausstehende Testwürfel bleiben erhalten');

  /* ---------- Partie fortsetzen ---------- */
  assert.equal(room.resume(anna.token).id, anna.id, 'Token aus dem Handy funktioniert weiter');
  room.act(anna.id, { type: 'endTurn' });
  assert.equal(room.game.engine.currentPlayer().id, ben.id);
  room.game.engine.roll(ben.id);            // → Turmstraße, Miete an Anna
  assert.equal(room.game.engine.player(ben.id).money, 1496);

  ({ manager, room } = await saveAndRestart(manager, room, store));
  assert.equal(room.game.engine.player(anna.id).money, 1444);
  assert.equal(room.game.engine.player(ben.id).money, 1496);
  assert.equal(room.game.engine.currentPlayer().id, ben.id);
  assert.equal(room.game.engine.phase, 'end');
  room.act(ben.id, { type: 'endTurn' });
  assert.equal(room.game.engine.currentPlayer().id, anna.id, 'Spiel läuft nach dem zweiten Neustart weiter');

  /* ---------- abgelaufene Räume verschwinden auch aus dem Speicher ---------- */
  room.lastActivity = 0;
  manager.sweep();
  await new Promise((r) => setTimeout(r, 50));
  manager.shutdown();
  assert.equal(await store.load(code), null);
}

module.exports = { persistenceScenario };
