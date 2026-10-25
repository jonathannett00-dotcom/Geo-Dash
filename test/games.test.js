'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GAMES, DEFAULT_GAME } = require('../server/games');
const { RoomManager, Room, COLORS, FIGURES } = require('../server/rooms');
const { createRng } = require('../server/rng');

const GAME_METHODS = ['handleAction', 'view', 'tick', 'isOver', 'waitingFor', 'removePlayer', 'canSave', 'toJSON', 'dispose'];
const players = [{ id: 'a', name: 'Anna' }, { id: 'b', name: 'Ben' }];

test('Spielmodule: jedes Modul erfüllt die gemeinsame Schnittstelle', () => {
  assert.ok(GAMES[DEFAULT_GAME]);
  for (const [id, mod] of Object.entries(GAMES)) {
    assert.equal(mod.id, id);
    assert.ok(mod.name && mod.minPlayers >= 1 && mod.maxPlayers >= mod.minPlayers, `${id}: Kenndaten`);
    for (const fn of ['defaultSettings', 'applySettings', 'createGame', 'restoreGame']) assert.equal(typeof mod[fn], 'function', `${id}.${fn}`);
    const game = mod.createGame({ players, settings: mod.defaultSettings(), rng: createRng(id), timeScale: 0.01 });
    for (const fn of GAME_METHODS) assert.equal(typeof game[fn], 'function', `${id}: Partie.${fn}`);
    assert.equal(game.isOver(), false);
    assert.ok(game.view('board', null) && game.view('player', 'a'));
    const copy = mod.restoreGame(JSON.parse(JSON.stringify(game.toJSON())), { rng: createRng('weiter'), timeScale: 0.01 });
    assert.deepEqual(copy.view('board', null), game.view('board', null), `${id}: Speichern und Laden`);
    game.dispose();
  }
});

test('Spielmodule: unbekannte Aktion wird mit deutscher Meldung abgelehnt', () => {
  const game = GAMES.monopoly.createGame({ players, settings: GAMES.monopoly.defaultSettings(), rng: createRng('x') });
  assert.throws(() => game.handleAction('a', { type: 'zaubern' }), /Unbekannte Aktion/);
});

test('Spielmodule: tick würfelt automatisch erst nach der Wartezeit und nur für verbundene Spieler', () => {
  const game = GAMES.monopoly.createGame({ players, settings: GAMES.monopoly.defaultSettings(), rng: createRng('tick'), timeScale: 1 });
  const now = Date.now();
  assert.equal(game.tick(now, { isConnected: () => false }), null, 'getrennt: nichts zu tun');
  const wait = game.tick(now, { isConnected: () => true });
  assert.equal(wait, 3000);
  assert.equal(game.engine.phase, 'roll');
  game.tick(now + 3000, { isConnected: () => true });
  assert.ok(game.engine.lastRoll, 'nach 3 s wurde gewürfelt');
});

test('Raum: jedes Handy bekommt einen eigenen Snapshot', () => {
  const manager = new RoomManager({ testMode: true, seed: 'snap', timeScale: 0.01 });
  const sent = [];
  manager.io = { to: (target) => ({ emit: (event, data) => sent.push({ target, data }) }) };
  const room = manager.create();
  const a = room.join({ name: 'Anna', color: COLORS[0], figure: FIGURES[0] });
  const b = room.join({ name: 'Ben', color: COLORS[1], figure: FIGURES[1] });
  room.attach({ id: 'sa', data: {}, join() {} }, a);
  room.attach({ id: 'sb', data: {}, join() {} }, b);
  room.start();
  room.broadcast();
  assert.deepEqual(sent.map((s) => s.target), [`${room.code}:board`, ['sa'], ['sb']]);
  assert.deepEqual(sent.map((s) => s.data.role), ['board', 'player', 'player']);
  assert.equal(sent[0].data.gameType, 'monopoly');
  manager.shutdown();
});

test('Raum: Spielstände im alten Format (Version 1) lassen sich laden', () => {
  const manager = new RoomManager({ testMode: true, seed: 'v1', timeScale: 0.01 });
  const room = manager.create();
  room.join({ name: 'Anna', color: COLORS[0], figure: FIGURES[0] });
  room.join({ name: 'Ben', color: COLORS[1], figure: FIGURES[1] });
  room.start();
  const v2 = room.serialize();
  const v1 = { ...v2, version: 1, game: v2.game.engine, shoe: { cards: [1, 2, 3] } };
  delete v1.gameType;
  const restored = Room.restore(JSON.parse(JSON.stringify(v1)), manager);
  assert.equal(restored.gameType, 'monopoly');
  assert.deepEqual(restored.game.engine.publicState(), room.game.engine.publicState());
  assert.deepEqual(restored.game.shoe, { cards: [1, 2, 3] });
  restored.dispose();
  manager.shutdown();
});

test('Raum: unbekanntes Spiel wird abgelehnt', () => {
  const manager = new RoomManager({});
  assert.throws(() => manager.create('halma'), /gibt es nicht/);
  manager.shutdown();
});

test('Lobby: Spielauswahl wechselt Spiel und Einstellungen, nur vor dem Start', () => {
  const manager = new RoomManager({ testMode: true, seed: 'wahl', timeScale: 0.01 });
  const room = manager.create();
  assert.equal(room.gameType, 'monopoly');
  assert.deepEqual(room.snapshot().games.map((g) => g.id), ['monopoly', 'risiko', 'poker']);
  room.setGameType('risiko');
  assert.equal(room.gameType, 'risiko');
  assert.deepEqual(room.settings, { cardValues: 'steigend', fortify: 'benachbart', animation: 'normal' });
  assert.equal(room.snapshot().maxPlayers, 6);
  room.updateSettings({ cardValues: 'fest' });
  assert.equal(room.settings.cardValues, 'fest');
  assert.throws(() => room.updateSettings({ fortify: 'überall' }), /benachbart/);
  assert.throws(() => room.setGameType('halma'), /gibt es nicht/);
  room.setGameType('monopoly');
  assert.deepEqual(room.settings, { startMoney: 1500 });

  // Zu viele Spieler für Risiko
  for (let i = 0; i < 7; i++) room.join({ name: `S${i}`, color: COLORS[i], figure: FIGURES[i] });
  assert.throws(() => room.setGameType('risiko'), /höchstens 6 Spieler – im Raum sind schon 7/);
  manager.shutdown();

  const m2 = new RoomManager({ testMode: true, seed: 'wahl2', timeScale: 0.01 });
  const r2 = m2.create();
  r2.setGameType('risiko');
  for (let i = 0; i < 6; i++) r2.join({ name: `S${i}`, color: COLORS[i], figure: FIGURES[i] });
  assert.throws(() => r2.join({ name: 'S6', color: COLORS[6], figure: FIGURES[6] }), /voll \(maximal 6/);
  r2.start();
  assert.equal(r2.game.phase, 'setup');
  assert.throws(() => r2.setGameType('monopoly'), /läuft bereits/);
  m2.shutdown();
});
