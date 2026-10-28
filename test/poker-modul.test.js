'use strict';

/*
 * Poker als Spielmodul: Snapshots pro Rolle (versteckte Karten), Speichern und
 * Neustart, Animations-Ereignisse und animUntil, Zugzeit, Nachkaufen, Spielende
 * und eine lange Zufallspartie mit festem Seed (Geld bleibt erhalten).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const poker = require('../server/games/poker');
const { PokerGame } = require('../server/games/poker/rules');
const { createRng } = require('../server/rng');
const { RoomManager } = require('../server/rooms');
const { seats, cardsIn } = require('./poker-helfer');

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

/** Partie mit eigener Uhr (now) für zeitgesteuerte Tests. */
function session(n, settings = {}, seed = 'modul') {
  const clock = { t: 1_000_000 };
  const game = poker.createGame({
    players: seats(n), settings: { ...poker.defaultSettings(), ...settings }, rng: createRng(seed), timeScale: 1, now: () => clock.t,
  });
  return { game, clock };
}

/* ---------------- Versteckte Karten ---------------- */

/** Prüft für Host und jeden Spieler, dass nur erlaubte Karten im Snapshot stehen. */
function assertOnlyAllowedCards(room, where) {
  const g = room.game;
  const publicCards = new Set([...g.board, ...g.players.flatMap((p) => p.shown || [])]);
  const deckCards = new Set(g.deck);
  const board = room.snapshot('board');
  for (const c of cardsIn(board)) assert.ok(publicCards.has(c), `${where}: Fernseher sieht ${c}`);
  for (const p of g.players) {
    const snap = room.snapshot('player', p.id);
    const own = new Set(p.cards);
    for (const c of cardsIn(snap)) assert.ok(publicCards.has(c) || own.has(c), `${where}: ${p.name} sieht fremde Karte ${c}`);
    if (p.cards.length) assert.deepEqual(snap.game.me.cards, p.cards, `${where}: ${p.name} sieht die eigenen Karten`);
    for (const c of cardsIn(snap)) assert.ok(!deckCards.has(c), `${where}: Stapelkarte ${c} im Snapshot`);
  }
  assert.ok(!JSON.stringify(board).includes('"deck"'), `${where}: Stapel im Snapshot`);
}

test('Poker: Jede Rolle sieht nur erlaubte Karten – auch nach dem Neustart aus der Datenbank', async () => {
  const store = memoryStore();
  let manager = new RoomManager({ testMode: true, seed: 'verstecken', timeScale: 0.01, store });
  let room = manager.create('poker');
  for (let i = 0; i < 4; i++) room.join({ name: ['Anna', 'Ben', 'Cem', 'Dana'][i], color: poker.colors[i] });
  room.start();
  const code = room.code;
  assertOnlyAllowedCards(room, 'Pre-Flop');

  // Zum Flop: alle gehen mit
  const step = () => {
    const g = room.game;
    const p = g.actor();
    room.act(p.id, { type: g.toCall(p) ? 'call' : 'check' });
  };
  while (room.game.street === 'preflop') step();
  assertOnlyAllowedCards(room, 'Flop');
  // Einer steigt aus: seine Karten verlassen den Server nie
  const folder = room.game.actor();
  room.act(folder.id, { type: 'fold' });
  assert.ok(folder.cards.length === 2);
  assertOnlyAllowedCards(room, 'nach Fold');

  // Speichern und „Server neu starten“
  room.broadcast();
  await manager.flush();
  manager.shutdown();
  manager = new RoomManager({ testMode: true, seed: 'anders', timeScale: 0.01, store });
  await manager.loadFromStore();
  room = manager.get(code);
  assert.ok(room && room.game, 'Raum mit Partie geladen');
  assert.equal(room.gameType, 'poker');
  assertOnlyAllowedCards(room, 'nach Neustart');
  const saved = JSON.parse(store.rows.get(code));
  assert.equal(saved.game.type, 'poker');
  assert.equal(saved.game.format, 1);
  assert.equal(saved.game.deck.length, room.game.deck.length, 'Stapel wird mit gespeichert');
  assert.deepEqual(saved.game.deck, room.game.deck, 'Reihenfolge bleibt');

  // Bis zum Showdown durchspielen; nach dem River setzt der Erste, damit ggf. jemand verdeckt wegwerfen darf
  let guard = 0;
  while (room.game.phase === 'betting' && guard++ < 50) step();
  while (room.game.phase === 'showdown') {
    assertOnlyAllowedCards(room, 'Showdown');
    room.act(room.game.showdown.decider, { type: 'muck' });
  }
  assert.equal(room.game.phase, 'between');
  assertOnlyAllowedCards(room, 'nach dem Showdown');
  for (const p of room.game.players) if (p.mucked || p.folded) assert.equal(room.snapshot('board').game.players.find((q) => q.id === p.id).shown, null);

  // Nächste Runde: Karten der alten Runde sind weg
  room.game.tick(Date.now() + 60_000, { isConnected: () => true });
  assert.equal(room.game.handNo, 2);
  assert.ok(room.game.players.every((p) => !p.shown));
  assertOnlyAllowedCards(room, 'zweite Runde');
  manager.shutdown();
});

test('Poker: Raum – 12 Spieler mit eigener Farbpalette, der 13. ist zu viel', () => {
  const manager = new RoomManager({ testMode: true, seed: 'zwoelf', timeScale: 0.01 });
  const room = manager.create('poker');
  assert.equal(room.maxPlayers, 12);
  assert.deepEqual(room.snapshot().colors, poker.colors);
  for (let i = 0; i < 12; i++) room.join({ name: `Spieler ${i + 1}`, color: poker.colors[i] });
  assert.throws(() => room.join({ name: 'Dreizehn', color: poker.colors[0] }), /voll \(maximal 12 Spieler\)/);
  assert.ok(room.players.every((p) => p.avatar === 'monogramm'), 'ohne Wahl: Monogramm für alle 12');
  assert.throws(() => room.setGameType('monopoly'), /höchstens 10 Spieler/);
  room.start();
  assert.equal(room.game.players.length, 12);
  assert.deepEqual(room.game.players.map((p) => p.seat), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  manager.shutdown();
});

test('Poker: Spielwechsel in der Lobby übernimmt die Farben in die neue Palette', () => {
  const manager = new RoomManager({ testMode: true, seed: 'wechsel', timeScale: 0.01 });
  const room = manager.create('risiko');
  const colors = room.colors;
  room.join({ name: 'Anna', color: colors[2] });
  room.join({ name: 'Ben', color: colors[0] });
  room.setGameType('poker');
  assert.deepEqual(room.players.map((p) => p.color), [poker.colors[2], poker.colors[0]]);
  room.setGameType('monopoly');
  assert.deepEqual(room.players.map((p) => p.color), [colors[2], colors[0]]);
  assert.ok(room.players.every((p) => p.avatar), 'Avatar bleibt beim Spielwechsel erhalten');
  manager.shutdown();
});

/* ---------------- Ereignisse und Zeiten ---------------- */

test('Poker: Ereignisse laufen nacheinander, animUntil hält die Handys auf', () => {
  const { game, clock } = session(3);
  const types = game.anim.events.map((e) => e.type);
  assert.deepEqual(types, ['hand', 'bet', 'bet', 'deal']);
  for (let i = 1; i < game.anim.events.length; i++) {
    const a = game.anim.events[i - 1];
    assert.equal(game.anim.events[i].at, a.at + a.dur, 'strikt nacheinander');
  }
  assert.ok(game.anim.until > clock.t);
  const p = game.actor();
  game.handleAction(p.id, { type: 'raise', to: 60 });
  const last = game.anim.events[game.anim.events.length - 1];
  assert.equal(last.type, 'bet');
  assert.equal(last.action, 'raise');
  assert.equal(last.amount, 60);
  assert.equal(game.view('board').animUntil, last.at + last.dur);
  // Kein Ereignis enthält Handkarten
  for (const e of game.anim.events) assert.equal(cardsIn(e).size, 0, e.type);
  // Animationen aus: Ereignisse ohne Dauer
  const off = session(3, { animation: 'aus' }).game;
  assert.ok(off.anim.events.every((e) => e.dur === 0));
});

test('Poker: Flop, Turn und River einzeln; Gewinner nach dem Showdown', () => {
  const { game } = session(2);
  const play = () => { const p = game.actor(); game.handleAction(p.id, { type: game.toCall(p) ? 'call' : 'check' }); };
  while (game.phase === 'betting') play();
  while (game.phase === 'showdown') game.handleAction(game.showdown.decider, { type: 'show' });
  const types = game.anim.events.map((e) => e.type);
  const streets = game.anim.events.filter((e) => e.type === 'street').map((e) => [e.street, e.cards.length]);
  assert.deepEqual(streets, [['flop', 3], ['turn', 1], ['river', 1]]);
  assert.ok(types.includes('reveal') && types.includes('win'));
  assert.ok(types.indexOf('reveal') < types.indexOf('win'));
});

test('Poker: Zugzeit – Check wenn möglich, sonst Fold; getrennt ruht sie', () => {
  const { game, clock } = session(3, { turnTime: 30 });
  const first = game.actor();
  // Getrennt: keine Frist, kein automatischer Zug (Pause)
  assert.equal(game.tick(clock.t + 999_999, { isConnected: () => false }), null);
  assert.equal(game.actor(), first);
  // Verbunden: Frist beginnt nach den Animationen
  const wait = game.tick(clock.t, { isConnected: () => true });
  assert.equal(wait, game.anim.until + 30_000 - clock.t);
  assert.equal(game.view('board').deadlineFor, first.id);
  clock.t = game.deadline;
  game.tick(clock.t, { isConnected: () => true });
  assert.equal(first.folded, true, 'zum Mitgehen fehlte etwas: Fold');
  assert.match(game.log.at(-1).text, /steigt aus \(Zeit abgelaufen\)/);
  // Nächster (Small Blind) geht mit, der Big Blind lässt die Zeit ablaufen: Check
  game.handleAction(game.actor().id, { type: 'call' });
  const bb = game.actor();
  game.tick(clock.t, { isConnected: () => true });
  clock.t = game.deadline;
  game.tick(clock.t, { isConnected: () => true });
  assert.equal(bb.lastAction === 'Check' || game.street === 'flop', true);
  assert.equal(game.street, 'flop');
});

test('Poker: Nächste Runde startet erst nach den Animationen', () => {
  const { game, clock } = session(3);
  while (game.phase === 'betting') game.handleAction(game.actor().id, { type: 'fold' });
  assert.equal(game.phase, 'between');
  const wait = game.tick(clock.t, { isConnected: () => true });
  assert.ok(wait > 0 && clock.t + wait >= game.anim.until, 'wartet auf den Fernseher');
  assert.equal(game.handNo, 1);
  clock.t += wait;
  game.tick(clock.t, { isConnected: () => true });
  assert.equal(game.handNo, 2);
  assert.equal(game.phase, 'betting');
});

test('Poker: Nachkaufen oder Aussetzen zwischen zwei Runden, Zähler pro Spieler', () => {
  const { game, clock } = session(3);
  // Anna verliert alles: All-in gegen eine sichere Niederlage simulieren wir über ihr Guthaben
  while (game.phase === 'betting') game.handleAction(game.actor().id, { type: 'fold' });
  const anna = game.players[0];
  game.players[1].stack += anna.stack;
  anna.stack = 0;
  game.endHand();
  assert.equal(anna.pendingRebuy, true);
  assert.equal(game.waitingFor(), anna.id);
  assert.equal(game.tick(clock.t + 60_000, { isConnected: () => true }), null, 'ohne Zugzeit wird gewartet');
  assert.equal(game.view('player', anna.id).game.me.mustDecide, true);
  assert.throws(() => game.handleAction(game.players[1].id, { type: 'rebuy' }), /erst, wenn dein Guthaben aufgebraucht ist/);
  game.handleAction(anna.id, { type: 'rebuy' });
  assert.equal(anna.stack, 2000);
  assert.equal(anna.rebuys, 1);
  assert.equal(game.view('board').game.players[0].rebuys, 1);
  assert.equal(game.totalMoney(), game.totalBuyIns());
  // Wieder pleite, diesmal aussetzen; später nachkaufen geht trotzdem
  game.players[1].stack += anna.stack;
  anna.stack = 0;
  game.endHand();
  game.handleAction(anna.id, { type: 'sitout' });
  assert.equal(anna.status, 'sitout');
  clock.t += 60_000;
  game.tick(clock.t, { isConnected: () => true });
  assert.equal(game.phase, 'betting');
  assert.equal(anna.inHand, false, 'wer aussetzt, spielt nicht mit');
  assert.throws(() => game.handleAction(anna.id, { type: 'sitout' }), /nur, wenn du pleite bist/);
  game.handleAction(anna.id, { type: 'rebuy' });
  assert.equal(anna.rebuys, 2);
  assert.equal(anna.inHand, false, 'erst in der nächsten Runde dabei');
});

test('Poker: Nachkauf-Entscheidung mit Zugzeit – Ablauf heißt Aussetzen', () => {
  const { game, clock } = session(3, { turnTime: 30 });
  while (game.phase === 'betting') game.handleAction(game.actor().id, { type: 'fold' });
  const anna = game.players[0];
  game.players[1].stack += anna.stack;
  anna.stack = 0;
  game.endHand();
  game.tick(clock.t, { isConnected: () => true });
  clock.t = game.deadline;
  game.tick(clock.t, { isConnected: () => true });
  assert.equal(anna.status, 'sitout');
});

test('Poker: Ohne Nachkaufen endet das Spiel, wenn nur noch einer Guthaben hat', () => {
  const { game } = session(2, { rebuy: false });
  while (game.phase === 'betting') {
    const p = game.actor();
    game.handleAction(p.id, { type: game.toCall(p) ? 'call' : 'check' });
    if (game.phase === 'betting' && game.street === 'preflop') game.handleAction(game.actor().id, { type: 'allin' });
  }
  while (game.phase === 'showdown') game.handleAction(game.showdown.decider, { type: 'show' });
  if (game.players.every((p) => p.stack > 0)) return; // Split: kein Spielende in dieser Runde
  assert.equal(game.isOver(), true);
  assert.ok(game.winner);
  assert.equal(game.statusInfo().title, 'Spielende');
  assert.throws(() => game.handleAction(game.players[0].id, { type: 'fold' }), /vorbei/);
});

test('Poker: Wer zu lange getrennt ist, verlässt den Tisch; sein Zug wird gefoldet', () => {
  const { game } = session(3);
  const p = game.actor();
  game.removePlayer(p.id);
  assert.equal(p.status, 'left');
  assert.equal(p.folded, true);
  assert.notEqual(game.actor(), p);
  assert.equal(game.totalMoney(), game.totalBuyIns());
});

test('Poker: Speichern und Laden ergibt denselben Zustand', () => {
  const { game } = session(4);
  game.handleAction(game.actor().id, { type: 'call' });
  const data = JSON.parse(JSON.stringify(game.toJSON()));
  assert.equal(data.type, 'poker');
  assert.equal(data.format, 1);
  assert.ok(Array.isArray(data.deck) && data.deck.length === 52 - 8);
  const copy = poker.restoreGame(data, { rng: createRng('anders'), timeScale: 1 });
  assert.deepEqual(copy.view('board'), game.view('board'));
  for (const p of game.players) assert.deepEqual(copy.view('player', p.id), game.view('player', p.id));
  assert.throws(() => poker.restoreGame({ type: 'risiko' }, { rng: createRng('x') }), /Kein Poker-Spielstand/);
});

/* ---------------- Zufallspartie ---------------- */

test('Poker: Zufallspartie mit festem Seed – Guthaben plus Pot bleibt konstant (außer Nachkäufen)', () => {
  for (const n of [6, 12, 3]) {
    const rng = createRng(`partie-${n}`);
    const pick = createRng(`entscheidungen-${n}`);
    const g = new PokerGame({ players: seats(n), settings: { startMoney: 500, smallBlind: 5, bigBlind: 10, rebuy: true }, rng });
    let total = g.totalMoney();
    let hands = 0;
    let steps = 0;
    const check = (rebought = false) => {
      const now = g.totalMoney();
      assert.equal(now - total, rebought ? 500 : 0, `Runde ${g.handNo}: Geld darf nicht entstehen oder verschwinden`);
      total = now;
      assert.equal(now, g.totalBuyIns());
      for (const p of g.players) assert.ok(p.stack >= 0 && Number.isInteger(p.stack), 'Guthaben in ganzen Cent');
    };
    while (hands < 150 && steps < 20000) {
      steps++;
      if (g.phase === 'gameover') break;
      if (g.phase === 'between') {
        for (const p of g.pendingRebuys()) {
          if (pick.next() < 0.8) { g.handleAction(p.id, { type: 'rebuy' }); check(true); } else { g.handleAction(p.id, { type: 'sitout' }); check(); }
        }
        for (const p of g.players.filter((q) => q.status === 'sitout')) if (pick.next() < 0.3) { g.handleAction(p.id, { type: 'rebuy' }); check(true); }
        if (!g.canStartHand()) { const s = g.players.find((q) => q.status === 'sitout'); if (s) { g.handleAction(s.id, { type: 'rebuy' }); check(true); continue; } break; }
        g.startHand();
        hands++;
        check();
        continue;
      }
      if (g.phase === 'showdown') {
        g.handleAction(g.showdown.decider, { type: pick.next() < 0.3 ? 'show' : 'muck' });
        check();
        continue;
      }
      const p = g.actor();
      const o = g.options(p);
      const r = pick.next();
      let action;
      if (r < 0.12) action = { type: 'fold' };
      else if (r < 0.2 && o.canRaise) action = { type: 'allin' };
      else if (r < 0.4 && o.canRaise) action = { type: 'raise', to: o.minTo + pick.int(Math.max(1, Math.floor((o.maxTo - o.minTo) / 3))) };
      else action = { type: o.canCheck ? 'check' : 'call' };
      g.handleAction(p.id, action);
      check();
      // Gemeinschaftskarten und Handkarten sind immer verschieden
      const seen = [...g.board, ...g.players.flatMap((q) => q.cards)];
      assert.equal(new Set(seen).size, seen.length);
    }
    assert.ok(hands >= 100, `${n} Spieler: ${hands} Runden gespielt`);
  }
});
