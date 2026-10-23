'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager, COLORS, FIGURES, MAX_PLAYERS, RECONNECT_GRACE_MS, ROOM_IDLE_MS } = require('../server/rooms');

function setup() {
  const manager = new RoomManager({ testMode: true, seed: 'rooms', timeScale: 0.01 });
  const room = manager.create();
  return { manager, room };
}

const join = (room, i, extra = {}) => room.join({ name: `Spieler${i}`, color: COLORS[i], figure: FIGURES[i], ...extra });

/** Minimaler Socket-Ersatz für attach/detach. */
const fakeSocket = (id) => ({ id, data: {}, join() {} });

test('Raumcode hat 4 Buchstaben und ist eindeutig', () => {
  const manager = new RoomManager({});
  const codes = new Set();
  for (let i = 0; i < 200; i++) {
    const room = manager.create();
    assert.match(room.code, /^[A-Z]{4}$/);
    codes.add(room.code);
  }
  assert.equal(codes.size, 200);
  assert.ok(manager.get(manager.create().code.toLowerCase()), 'Code ist case-insensitiv');
  manager.shutdown();
});

test('Beitritt: Name, Farbe und Figur sind Pflicht und eindeutig', () => {
  const { manager, room } = setup();
  join(room, 0, { name: 'Anna' });
  assert.throws(() => join(room, 1, { name: 'anna' }), /schon vergeben/);
  assert.throws(() => join(room, 1, { color: COLORS[0] }), /Farbe ist schon vergeben/);
  assert.throws(() => join(room, 1, { figure: FIGURES[0] }), /Spielfigur ist schon vergeben/);
  assert.throws(() => join(room, 1, { name: '   ' }), /Namen/);
  assert.throws(() => join(room, 1, { color: '#000000' }), /Farbe/);
  manager.shutdown();
});

test('maximal 10 Spieler, Start erst ab 2 Spielern', () => {
  const { manager, room } = setup();
  join(room, 0);
  assert.throws(() => room.start(), /mindestens 2/);
  for (let i = 1; i < MAX_PLAYERS; i++) join(room, i);
  assert.equal(room.players.length, 10);
  assert.throws(() => room.join({ name: 'Elf', color: COLORS[0], figure: FIGURES[0] }), /voll/);
  room.start();
  assert.ok(room.started);
  manager.shutdown();
});

test('kein Beitritt mehr nach Spielstart, Startbetrag einstellbar', () => {
  const { manager, room } = setup();
  join(room, 0);
  join(room, 1);
  room.setStartMoney(2000);
  assert.equal(room.settings.startMoney, 2000);
  assert.throws(() => room.setStartMoney(5), /zwischen/);
  room.start();
  assert.throws(() => join(room, 2), /läuft bereits/);
  assert.throws(() => room.setStartMoney(1500), /läuft bereits/);
  manager.shutdown();
});

test('Wiederverbindung über Token, getrennte Spieler bleiben 5 Minuten', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager, room } = setup();
  const a = join(room, 0);
  join(room, 1);
  const s1 = fakeSocket('s1');
  room.attach(s1, a);
  assert.equal(a.connected, true);
  assert.equal(room.resume(a.token), a);
  assert.throws(() => room.resume('falsch'), /abgelaufen/);

  room.detach(s1);
  assert.equal(a.connected, false);
  t.mock.timers.tick(RECONNECT_GRACE_MS - 1000);
  assert.ok(room.playerById(a.id), 'nach knapp 5 Minuten noch da');

  const s2 = fakeSocket('s2');
  room.attach(s2, room.resume(a.token));
  assert.equal(a.connected, true);
  t.mock.timers.tick(10 * 1000);
  assert.ok(room.playerById(a.id), 'wieder verbunden – Timer gestoppt');

  room.detach(s2);
  t.mock.timers.tick(RECONNECT_GRACE_MS + 1);
  assert.equal(room.playerById(a.id), undefined, 'in der Lobby nach 5 Minuten entfernt');
  manager.shutdown();
});

test('Räume werden nach 6 h Inaktivität gelöscht', () => {
  const { manager, room } = setup();
  const other = manager.create();
  other.lastActivity = Date.now();
  room.lastActivity = Date.now() - ROOM_IDLE_MS - 1;
  manager.sweep();
  assert.equal(manager.get(room.code), undefined);
  assert.ok(manager.get(other.code));
  manager.shutdown();
});
