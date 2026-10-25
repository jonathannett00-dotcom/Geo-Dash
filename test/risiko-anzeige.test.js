'use strict';

/*
 * Reine Anzeigedaten der Risiko-Partie: Vorauswahl (Handy → Fernseher),
 * Phasentexte, Zugwechsel-Ereignisse und die Statistik fürs Abschlussbild –
 * auch beim Laden eines älteren Spielstands ohne Statistik.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createRng } = require('../server/rng');
const risiko = require('../server/games/risiko');
const { NEIGHBORS } = require('../server/games/risiko/map');
const { FORMAT_VERSION } = require('../server/games/risiko/rules');
const { RoomManager, Room, COLORS, FIGURES } = require('../server/rooms');

const PLAYERS = ['a', 'b', 'c'].map((id) => ({ id, name: id.toUpperCase() }));
const FIXTURE = path.join(__dirname, 'fixtures', 'risiko-raum-ohne-statistik.json');

function session(settings = {}, seed = 'anzeige') {
  return risiko.createGame({ players: PLAYERS, settings: { ...risiko.defaultSettings(), ...settings }, rng: createRng(seed), timeScale: 1 });
}

function finishSetup(g) {
  for (const p of g.players) g.handleAction(p.id, { type: 'place', territory: g.territoriesOf(p.id)[0], count: p.remaining });
}

/** Verstärkung setzen und ein Gebiet mit Nachbarfeind und mindestens 2 Armeen liefern. */
function toAttack(g) {
  const pid = g.currentPlayer().id;
  const from = g.territoriesOf(pid).find((id) => NEIGHBORS[id].some((n) => g.territories[n].owner !== pid));
  g.handleAction(pid, { type: 'place', territory: from, count: g.turn.reinforcements });
  const to = NEIGHBORS[from].find((n) => g.territories[n].owner !== pid);
  return { pid, from, to };
}

/* ---------------- Vorauswahl ---------------- */

test('Vorauswahl: gültige Auswahl erscheint mit Zielen in der Host-Ansicht', () => {
  const g = session();
  finishSetup(g);
  const { pid, from, to } = toAttack(g);
  assert.deepEqual(g.handleAction(pid, { type: 'preview', mode: 'attack', from }), { preview: true });
  let pv = g.view('board').preview;
  assert.equal(pv.playerId, pid);
  assert.equal(pv.from, from);
  assert.equal(pv.to, null);
  assert.deepEqual(pv.targets, NEIGHBORS[from].filter((n) => g.territories[n].owner !== pid));

  g.handleAction(pid, { type: 'preview', mode: 'attack', from, to });
  pv = g.view('board').preview;
  assert.equal(pv.to, to);
  // Die Vorauswahl ist kein Spielzustand: nichts geändert, nichts gespeichert
  assert.equal(g.phase, 'attack');
  assert.ok(!('_preview' in g.toJSON()));
});

test('Vorauswahl: ungültige Auswahl wird verworfen, ohne das Spiel zu ändern', () => {
  const g = session();
  finishSetup(g);
  const { pid, from, to } = toAttack(g);
  const other = g.players.find((p) => p.id !== pid).id;
  const before = JSON.stringify(g.toJSON());
  const bad = [
    [other, { mode: 'attack', from: g.territoriesOf(other)[0] }],                     // nicht am Zug
    [pid, { mode: 'attack', from: to }],                                             // fremdes Gebiet
    [pid, { mode: 'attack', from, to: g.territoriesOf(pid).find((id) => id !== from) }], // eigenes Ziel
    [pid, { mode: 'attack', from, to: 'gibtsnicht' }],
    [pid, { mode: 'place', from }],                                                  // falsche Phase
    [pid, { mode: 'zaubern', from }],
  ];
  for (const [who, action] of bad) {
    g.handleAction(pid, { type: 'preview', mode: 'attack', from }); // erst eine gültige
    assert.deepEqual(g.handleAction(who, { type: 'preview', ...action }), { preview: false }, JSON.stringify(action));
    assert.equal(g.view('board').preview, null, JSON.stringify(action));
  }
  assert.equal(JSON.stringify(g.toJSON()), before);
});

test('Vorauswahl verfällt am Zugende, bei Abwahl und beim Trennen', () => {
  const g = session();
  finishSetup(g);
  const { pid, from } = toAttack(g);
  g.handleAction(pid, { type: 'preview', mode: 'attack', from });
  g.handleAction(pid, { type: 'preview', mode: 'attack' });
  assert.equal(g.view('board').preview, null, 'abgewählt');

  g.handleAction(pid, { type: 'preview', mode: 'attack', from });
  g.onDisconnect(pid);
  assert.equal(g.view('board').preview, null, 'getrennt');

  g.handleAction(pid, { type: 'preview', mode: 'fortify', from });
  assert.ok(g.view('board').preview);
  g.handleAction(pid, { type: 'endTurn' });
  assert.notEqual(g.currentPlayer().id, pid);
  assert.equal(g.view('board').preview, null, 'Zugende');
});

test('Vorauswahl erreicht nur die Host-Ansicht, kein Handy', () => {
  const manager = new RoomManager({ testMode: true, seed: 'vorauswahl', timeScale: 0.01 });
  const room = manager.create();
  room.setGameType('risiko');
  const ids = [0, 1, 2].map((i) => room.join({ name: `Spieler${i}`, color: COLORS[i], figure: FIGURES[i] }).id);
  ids.forEach((id, i) => room.attach({ id: `s${i}`, data: {}, join() {} }, room.playerById(id)));
  room.start();
  finishSetup(room.game);
  const { pid, from, to } = toAttack(room.game);
  room.act(pid, { type: 'preview', mode: 'attack', from, to });

  const sent = [];
  manager.io = { to: (target) => ({ emit: (event, data) => sent.push({ target, event, data }) }) };
  room.broadcast();
  const board = sent.find((s) => s.target === `${room.code}:board`);
  assert.equal(board.data.preview.from, from);
  const phones = sent.filter((s) => s !== board);
  assert.equal(phones.length, 3);
  for (const s of phones) assert.ok(!JSON.stringify(s.data).includes('"preview"'), 'Handy sieht keine Vorauswahl');
  manager.io = null;
  manager.shutdown();
});

/* ---------------- Phasentexte und Zugwechsel ---------------- */

test('Phasenanzeige: Texte für Aufbau, Verstärken, Angriff, Verteidigung und Verschieben', () => {
  const g = session({}, 'phasen');
  let st = g.view('board').status;
  assert.equal(st.phase, 'setup');
  assert.match(st.detail, /^Startarmeen setzen: noch A \(\d+\), B \(\d+\), C \(\d+\)$/);

  finishSetup(g);
  const cur = g.currentPlayer();
  st = g.view('player', cur.id).status;
  assert.equal(st.text, `${cur.name} verstärkt`);
  assert.equal(st.playerId, cur.id);
  assert.equal(st.round, 1);
  assert.equal(st.detail, `Noch ${g.turn.reinforcements} Armeen zu setzen`);

  const { from, to } = toAttack(g);
  assert.equal(g.view('board').status.text, `${cur.name} greift an`);
  g.territories[from].armies = 5;
  g.handleAction(cur.id, { type: 'attack', from, to });
  st = g.view('board').status;
  const def = g.territories[to].owner;
  assert.equal(st.phase, 'defend');
  assert.equal(st.defenderId, def);
  assert.equal(st.detail, `${g.nameOf(def)} verteidigt`);
});

test('Zugwechsel: Ereignis mit Spieler, Runde und Rundenwechsel', () => {
  const g = session({}, 'zugwechsel');
  finishSetup(g);
  const first = g.view('board').anim.events.filter((e) => e.type === 'turn');
  assert.equal(first.length, 1);
  assert.equal(first[0].round, 1);
  assert.equal(first[0].newRound, true);
  // Der Zugwechsel verlängert die Wartezeit der Handys nicht
  assert.ok(g.view('board').animUntil <= first[0].at);

  for (let i = 0; i < g.players.length; i++) {
    const { pid } = toAttack(g);
    g.handleAction(pid, { type: 'endTurn' });
  }
  const turns = g.view('board').anim.events.filter((e) => e.type === 'turn');
  const last = turns[turns.length - 1];
  assert.equal(last.playerId, g.currentPlayer().id);
  assert.equal(last.round, 2);
  assert.equal(last.newRound, true);
  assert.equal(turns[turns.length - 2].newRound, false);
});

/* ---------------- Statistik ---------------- */

test('Statistik: Kampf und Eroberung werden für beide Seiten gezählt', () => {
  const g = session({}, 'statistik');
  finishSetup(g);
  for (const p of g.players) assert.equal(p.stats.maxTerritories, g.territoriesOf(p.id).length);
  const { pid, from, to } = toAttack(g);
  const def = g.territories[to].owner;
  g.territories[from].armies = 10;
  g.territories[to].armies = 3;
  // Angriff 6-5-1 gegen 6-4: ein Vergleich je Seite gewonnen (Gleichstand gewinnt der Verteidiger)
  g.forcedDice.push(6, 5, 1, 6, 4);
  g.handleAction(pid, { type: 'attack', from, to, dice: 3 });
  g.handleAction(def, { type: 'defend', dice: 2 });
  const a = () => g.player(pid).stats;
  const d = () => g.player(def).stats;
  assert.deepEqual([a().armiesDefeated, a().armiesLost, a().comparisonsWon, a().conquests], [1, 1, 1, 0]);
  assert.deepEqual([d().armiesDefeated, d().armiesLost, d().comparisonsWon], [1, 1, 1]);

  // Zweiter Angriff erobert das Gebiet (2 Armeen übrig, beide Vergleiche gewonnen)
  const own = g.territoriesOf(pid).length;
  g.forcedDice.push(6, 6, 1, 2, 2);
  g.handleAction(pid, { type: 'attack', from, to, dice: 3 });
  g.handleAction(def, { type: 'defend', dice: 2 });
  assert.equal(g.territories[to].owner, pid);
  assert.deepEqual([a().armiesDefeated, a().comparisonsWon, a().conquests, a().maxTerritories], [3, 3, 1, own + 1]);
  assert.equal(d().armiesLost, 3);

  // Statistik steckt im Spielstand und in der Anzeige
  const restored = risiko.restoreGame(JSON.parse(JSON.stringify(g.toJSON())), { rng: createRng('x') });
  assert.deepEqual(restored.player(pid).stats, a());
  const shown = restored.view('board').game.players.find((p) => p.id === pid);
  assert.deepEqual(shown.stats, a());
  assert.equal(restored.view('board').game.statsSinceRound, 0);
  assert.equal(g.toJSON().format, FORMAT_VERSION);
});

test('Alter Spielstand ohne Statistik lädt, zählt ab jetzt und wird im neuen Format gespeichert', () => {
  const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.equal(data.gameType, 'risiko');
  assert.equal(data.game.format, undefined, 'Testdatei stammt aus der Zeit vor der Statistik');
  assert.ok(data.game.players.every((p) => p.stats === undefined));

  const manager = new RoomManager({ testMode: true, seed: 'alt' });
  const room = Room.restore(data, manager);
  const g = room.game;
  const view = g.view('board').game;
  assert.equal(view.phase, data.game.phase);
  assert.equal(view.statsSinceRound, data.game.round);
  for (const p of view.players) {
    assert.deepEqual(p.stats, { conquests: 0, armiesDefeated: 0, armiesLost: 0, comparisonsWon: 0, maxTerritories: p.territories });
  }
  // Die Partie läuft normal weiter, die Zähler laufen mit
  const pid = g.currentPlayer().id;
  const from = g.territoriesOf(pid).find((id) => NEIGHBORS[id].some((n) => g.territories[n].owner !== pid));
  const to = NEIGHBORS[from].find((n) => g.territories[n].owner !== pid);
  if (g.phase !== 'attack') assert.fail(`Testdatei steht nicht im Angriff, sondern in ${g.phase}`);
  g.territories[from].armies = Math.max(g.territories[from].armies, 4);
  g.forcedDice.push(6, 6, 6, 1, 1);
  room.act(pid, { type: 'attack', from, to });
  if (g.phase === 'defend') room.act(g.waitingFor(), { type: 'defend' });
  assert.ok(g.player(pid).stats.comparisonsWon >= 1);

  const saved = room.serialize();
  assert.equal(saved.game.format, FORMAT_VERSION);
  const again = Room.restore(JSON.parse(JSON.stringify(saved)), manager);
  assert.deepEqual(again.game.player(pid).stats, g.player(pid).stats);
  assert.equal(again.game.statsSinceRound, data.game.round);
  room.dispose();
  again.dispose();
  manager.shutdown();
});
