'use strict';

/*
 * Spiel beenden (Host, alle Spiele): Nur die Host-Ansicht darf beenden, das Spiel
 * geht in die Endphase mit Endstand, der Stand übersteht einen Neustart, danach
 * „Zurück zur Lobby“ und „Raum schließen“ (auch aus der Datenbank). Im Poker geht
 * der Endstand auf den Cent auf.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager, COLORS, FIGURES } = require('../server/rooms');
const { createRng } = require('../server/rng');

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

/** Ersatz für Socket.IO: Sockets mit Ereignissen und Antworten, gesendete Nachrichten werden gesammelt. */
function fakeIo() {
  const sent = [];
  const io = { sent, to: (target) => ({ emit: (event, data) => sent.push({ target, event, data }) }) };
  let n = 0;
  const socket = (manager) => {
    const handlers = {};
    const s = {
      id: `s${++n}`, data: {}, rooms: new Set(), handshake: { headers: {}, address: '127.0.0.1' }, nsp: { server: io },
      on: (ev, fn) => { handlers[ev] = fn; },
      join: (r) => s.rooms.add(r),
      call: (ev, payload = {}) => new Promise((resolve) => handlers[ev](payload, resolve)),
    };
    manager.bindSocket(s);
    return s;
  };
  return { io, sent, socket };
}

const newManager = (store) => new RoomManager({ testMode: true, seed: 'ende', timeScale: 0.01, store });

/** Raum mit Host-Ansicht und zwei Handys im gewählten Spiel, gestartet. */
async function setup(gameType, store = null) {
  const manager = newManager(store);
  const net = fakeIo();
  manager.io = net.io;
  const host = net.socket(manager);
  const { code } = await host.call('board:create');
  const room = manager.get(code);
  await host.call('board:game', { gameType });
  const colors = room.colors;
  const phones = [];
  for (const [i, name] of ['Anna', 'Ben'].entries()) {
    const phone = net.socket(manager);
    const res = await phone.call('player:join', { code, name, color: colors[i], figure: gameType === 'monopoly' ? FIGURES[i] : undefined });
    assert.ok(res.ok, res.error);
    phones.push(phone);
  }
  const started = await host.call('board:start');
  assert.ok(started.ok, started.error);
  return { manager, net, host, phones, room, code };
}

for (const gameType of ['monopoly', 'risiko', 'poker']) {
  test(`Spiel beenden (${gameType}): nur der Host, danach Endphase mit Endstand`, async () => {
    const { manager, host, phones, room } = await setup(gameType);
    // Handys dürfen nicht beenden – weder direkt noch als Spielaktion
    const denied = await phones[0].call('board:end');
    assert.equal(denied.ok, false);
    assert.match(denied.error, /Nur die Host-Ansicht kann das Spiel beenden/);
    const asAction = await phones[0].call('act', { type: 'end' });
    assert.equal(asAction.ok, false);
    assert.equal(room.game.isOver(), false);
    assert.equal((await phones[1].call('board:lobby')).ok, false);
    assert.equal((await phones[1].call('board:close')).ok, false);
    assert.ok(manager.get(room.code), 'Raum besteht noch');

    // Zurück zur Lobby geht erst nach dem Ende
    assert.match((await host.call('board:lobby')).error, /erst, wenn das Spiel beendet ist/);

    const res = await host.call('board:end');
    assert.ok(res.ok, res.error);
    assert.equal(room.game.isOver(), true);
    const snap = room.snapshot('player', room.players[0].id);
    assert.equal(snap.final.reason, 'host');
    assert.equal(snap.final.title, 'Spiel vom Host beendet');
    assert.equal(snap.final.rows.length, 2);
    assert.ok(snap.final.rows.every((r) => r.cells.length === snap.final.columns.length));
    assert.equal(room.snapshot('board').status?.text ?? 'Spiel vom Host beendet', 'Spiel vom Host beendet');
    // Zweites Beenden: verständliche Meldung
    assert.match((await host.call('board:end')).error, /schon vorbei/);
    // Spielaktionen gehen nicht mehr
    assert.equal((await phones[0].call('act', { type: gameType === 'poker' ? 'fold' : 'endTurn' })).ok, false);
    manager.shutdown();
  });
}

test('Spiel beenden: Spielstand übersteht einen Neustart, dann zurück zur Lobby', async () => {
  const store = memoryStore();
  const first = await setup('risiko', store);
  await first.host.call('board:end');
  first.room.broadcast();
  await first.manager.flush();
  const before = first.room.snapshot('board').final;
  first.manager.shutdown();

  const manager = newManager(store);
  await manager.loadFromStore();
  const room = manager.get(first.code);
  assert.ok(room && room.game && room.game.isOver(), 'beendetes Spiel wieder geladen');
  assert.deepEqual(room.snapshot('board').final, before);

  const net = fakeIo();
  manager.io = net.io;
  const host = net.socket(manager);
  await host.call('board:watch', { code: room.code });
  const res = await host.call('board:lobby');
  assert.ok(res.ok, res.error);
  assert.equal(room.started, false);
  assert.equal(room.game, null);
  assert.deepEqual(room.players.map((p) => p.name), ['Anna', 'Ben'], 'gleiche Spieler');
  assert.equal(room.snapshot('board').final, null);
  // Neues Spiel wählbar und startbar
  assert.ok((await host.call('board:game', { gameType: 'poker' })).ok);
  assert.ok((await host.call('board:start')).ok);
  assert.equal(room.game.isOver(), false);
  manager.shutdown();
});

test('Raum schließen: alle Geräte bekommen Bescheid, der Raum ist auch aus der Datenbank weg', async () => {
  const store = memoryStore();
  const { manager, net, host, room, code } = await setup('poker', store);
  room.broadcast();
  await manager.flush();
  assert.ok(store.rows.has(code));
  await host.call('board:end');
  const res = await host.call('board:close');
  assert.ok(res.ok, res.error);
  assert.equal(manager.get(code), undefined);
  await new Promise((r) => setImmediate(r));
  assert.equal(store.rows.has(code), false, 'aus der Datenbank gelöscht');
  const closed = net.sent.filter((m) => m.event === 'room:closed').map((m) => m.target).sort();
  assert.deepEqual(closed, [`${code}:board`, `${code}:players`]);
  manager.shutdown();
});

test('Poker-Endstand: Endguthaben minus Einzahlungen ergibt zusammen genau null', async () => {
  const { manager, host, room } = await setup('poker');
  const g = room.game;
  // Ein paar Runden mit festem Zufall spielen, mit Nachkäufen; dann mitten in einer Runde beenden
  const pick = createRng('endstand');
  for (let step = 0; step < 4000 && g.handNo < 25; step++) {
    if (g.phase === 'between') {
      for (const p of g.pendingRebuys()) g.handleAction(p.id, { type: 'rebuy' });
      if (g.canStartHand()) g.startHand();
      continue;
    }
    if (g.phase === 'showdown') { g.handleAction(g.showdown.decider, { type: 'muck' }); continue; }
    const p = g.actor();
    const o = g.options(p);
    const r = pick.next();
    g.handleAction(p.id, r < 0.15 ? { type: 'fold' } : r < 0.3 && o.canRaise ? { type: 'allin' } : { type: o.canCheck ? 'check' : 'call' });
  }
  if (g.phase !== 'betting') g.startHand();
  g.handleAction(g.actor().id, { type: 'call' });
  assert.ok(g.pot() > 0, 'es liegt Geld im Pot');
  await host.call('board:end');
  const final = room.snapshot('board').final;
  const nets = final.rows.map((r) => r.values.net);
  assert.equal(nets.reduce((a, b) => a + b, 0), 0, 'Summe aller Gewinne und Verluste ist null');
  const paid = final.rows.reduce((s, r) => s + r.values.start + r.values.rebuyAmount, 0);
  const finals = final.rows.reduce((s, r) => s + r.values.final, 0);
  assert.equal(finals - paid, 0);
  assert.ok(final.rows.every((r) => Number.isInteger(r.values.net)));
  assert.ok(final.rows.some((r) => r.values.rebuys > 0), 'Nachkäufe sind im Endstand');
  for (let i = 1; i < nets.length; i++) assert.ok(nets[i - 1] >= nets[i], 'sortiert vom größten Gewinn');
  assert.deepEqual(final.columns, ['Start', 'Nachkäufe', 'Endguthaben', 'Gewinn/Verlust']);
  manager.shutdown();
});

test('Monopoly-Endstand: Vermögen aus Bargeld, Grundstücken und Häusern; Minispiel-Einsätze gehen zurück', async () => {
  const { manager, host, room } = await setup('monopoly');
  const e = room.game.engine;
  const [a, b] = e.players;
  // Anna besitzt die Schlossallee (400) mit 2 Häusern (je 200) und die Parkstraße mit Hypothek (350 − 175)
  const schloss = 39;
  const park = 37;
  e.props[schloss] = { ...e.props[schloss], owner: a.id, houses: 2, mortgaged: false };
  e.props[park] = { ...e.props[park], owner: a.id, houses: 0, mortgaged: true };
  a.money = 1000;
  b.money = 1600;
  // Laufendes Minispiel mit Einsatz: beim Beenden zurück
  room.game.miniStake = { [b.id]: 100 };
  room.game.mini = { stop() {}, view() { return null; } };
  await host.call('board:end');
  const final = room.snapshot('board').final;
  assert.deepEqual(final.columns, ['Bargeld', 'Grundstücke & Häuser', 'Vermögen']);
  const anna = final.rows.find((r) => r.id === a.id);
  assert.deepEqual(anna.values, { money: 1000, property: 400 + 400 + 175, total: 1975 });
  const ben = final.rows.find((r) => r.id === b.id);
  assert.equal(ben.values.total, 1700, 'Einsatz aus dem Minispiel ist zurück');
  assert.equal(final.rows[0].id, a.id, 'Rangliste nach Vermögen');
  assert.equal(room.game.mini, null);
  manager.shutdown();
});

test('Risiko-Endstand: Gebiete und Armeen je Spieler, ohne Sieger', async () => {
  const { manager, host, room } = await setup('risiko');
  await host.call('board:end');
  const final = room.snapshot('board').final;
  const g = room.game;
  assert.equal(g.winner, null);
  assert.equal(room.snapshot('board').game.endedBy, 'host');
  for (const r of final.rows) {
    assert.equal(r.values.territories, g.territoriesOf(r.id).length);
    assert.equal(r.values.armies, g.armiesOf(r.id));
  }
  assert.equal(final.rows.reduce((s, r) => s + r.values.territories, 0) + g.territoriesOf('neutral').length, 42);
  manager.shutdown();
});

test('Spiel beenden: ohne laufendes Spiel gibt es eine Meldung', async () => {
  const manager = newManager();
  const net = fakeIo();
  manager.io = net.io;
  const host = net.socket(manager);
  await host.call('board:create');
  assert.match((await host.call('board:end')).error, /Es läuft gerade kein Spiel/);
  manager.shutdown();
  assert.ok(COLORS.length >= 10);
});
