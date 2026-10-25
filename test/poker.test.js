'use strict';

/*
 * Poker (Texas Hold'em): Handbewertung, Pots und Side-Pots, Setzregeln,
 * Heads-up, Blinds, Einstellungen, Spielerzahl, Showdown.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { bestHand, compareScores } = require('../server/games/poker/hands');
const { buildPots, uncalled, splitPot } = require('../server/games/poker/pots');
const { formatEuro, parseEuro } = require('../server/games/poker/money');
const { PokerGame, applySettings, DEFAULT_SETTINGS } = require('../server/games/poker/rules');
const poker = require('../server/games/poker');
const { createRng } = require('../server/rng');
const { seats, deckFor, table, P, act } = require('./poker-helfer');

const hand = (s) => bestHand(s.split(' '));
const cmp = (a, b) => Math.sign(compareScores(hand(a).score, hand(b).score));

/* ---------------- Handbewertung ---------------- */

test('Poker: Handbewertung erkennt alle Kategorien mit deutschem Namen', () => {
  const cases = [
    ['Ah Kh Qh Jh Th 2c 3d', 9, 'Royal Flush'],
    ['9s 8s 7s 6s 5s Ad Ac', 8, 'Straight Flush bis zur Neun'],
    ['5d 4d 3d 2d Ad Kc Kh', 8, 'Straight Flush bis zur Fünf'],
    ['9c 9d 9h 9s Kd 2c 3h', 7, 'Vierling, Neunen'],
    ['Qc Qd Qh 8s 8d 2c 3h', 6, 'Full House, Damen über Achten'],
    ['Ah 9h 7h 4h 2h Kc Kd', 5, 'Flush, Ass hoch'],
    ['Td 9c 8h 7s 6d 2c 2h', 4, 'Straße bis zur Zehn'],
    ['Ah Kd Qc Js Th 3c 3h', 4, 'Straße bis zum Ass'],
    ['5c 4d 3h 2s Ad Kc 9h', 4, 'Straße bis zur Fünf'],
    ['7c 7d 7h Ks 2d 4c 9h', 3, 'Drilling, Siebenen'],
    ['Kc Kd Th Ts 2d 4c 9h', 2, 'Zwei Paare, Könige und Zehnen'],
    ['Jc Jd 8h 6s 2d 4c 9h', 1, 'Ein Paar, Buben'],
    ['Ac Qd 8h 6s 2d 4c 9h', 0, 'Höchste Karte, Ass'],
  ];
  for (const [cards, cat, label] of cases) {
    const h = hand(cards);
    assert.equal(h.category, cat, cards);
    assert.equal(h.label, label, cards);
    assert.equal(h.cards.length, 5);
  }
});

test('Poker: Kicker und Gleichstände', () => {
  assert.equal(cmp('Ac Ad Kh 7s 4d', 'As Ah Qh 7c 4c'), 1, 'Paar Asse: König schlägt Dame als Kicker');
  assert.equal(cmp('Ac Ad Kh 7s 4d', 'As Ah Kd 7c 3c'), 1, 'dritter Kicker entscheidet');
  assert.equal(cmp('Ac Ad Kh 7s 4d', 'As Ah Kd 7c 4c'), 0, 'gleiche Ränge: Gleichstand');
  assert.equal(cmp('Kc Kd 5h 5s Ad', 'Kh Ks 5c 5d Qd'), 1, 'Zwei Paare: Kicker');
  assert.equal(cmp('Kc Kd 5h 5s 2d', 'Qh Qs Jc Jd Ad'), 1, 'höheres oberes Paar');
  assert.equal(cmp('Ah Jh 9h 6h 3h', 'Ac Jc 9c 6c 2c'), 1, 'Flush: letzte Karte');
  assert.equal(cmp('6c 5d 4h 3s 2d', '5c 4d 3c 2h Ah'), 1, 'Sechs-hohe Straße schlägt das Wheel');
  assert.equal(cmp('Qc Qd Qh 2s 2d', 'Jc Jd Jh As Ad'), 1, 'Full House nach dem Drilling');
  assert.equal(cmp('9c 9d 9h 9s 2d', '9c 9d 9h 9s Ad'), -1, 'Vierling: Kicker');
  assert.equal(cmp('Ah Kh Qh Jh Th', '9s 8s 7s 6s 5s'), 1);
  // Board spielt: beide haben dieselbe Straße
  assert.equal(compareScores(hand('As Kd Qh Jc Ts 2c 3c').score, hand('As Kd Qh Jc Ts 4d 4h').score), 0);
  // Siebte Karte zählt nicht
  assert.equal(compareScores(hand('Ac Ad Kh Qs Jd 3c 2h').score, hand('Ac Ad Kh Qs Jd 4c 2h').score), 0);
});

/* ---------------- Geld ---------------- */

test('Poker: Beträge als Cent, Anzeige und Eingabe in Euro', () => {
  assert.equal(formatEuro(1250), '12,50 €');
  assert.equal(formatEuro(5), '0,05 €');
  assert.equal(formatEuro(123456789), '1.234.567,89 €');
  assert.equal(parseEuro('12,50'), 1250);
  assert.equal(parseEuro('12.5'), 1250);
  assert.equal(parseEuro('12'), 1200);
  assert.equal(parseEuro('0,1'), 10);
  assert.equal(parseEuro(' 20,00 € '), 2000);
  assert.equal(parseEuro(0.2), 20);
  for (const bad of ['', 'abc', '-1', '1,234', '1.000,00', '12,5,0', null, undefined, NaN]) assert.equal(parseEuro(bad), null, String(bad));
});

/* ---------------- Pots ---------------- */

test('Poker: Side-Pots mit drei und mehr Spielern und mehreren All-ins', () => {
  // A 300 All-in, B 600 All-in, C 1000 All-in, D 1000; dazu E gefoldet mit 200
  const pots = buildPots([
    { id: 'A', amount: 300, folded: false }, { id: 'B', amount: 600, folded: false },
    { id: 'C', amount: 1000, folded: false }, { id: 'D', amount: 1000, folded: false }, { id: 'E', amount: 200, folded: true },
  ]);
  assert.deepEqual(pots, [
    { amount: 300 * 4 + 200, eligible: ['A', 'B', 'C', 'D'] },
    { amount: 300 * 3, eligible: ['B', 'C', 'D'] },
    { amount: 400 * 2, eligible: ['C', 'D'] },
  ]);
  assert.equal(pots.reduce((s, p) => s + p.amount, 0), 3100);
  // Drei Spieler, zwei All-ins mit gleichem Betrag: ein Hauptpot, ein Side-Pot
  assert.deepEqual(buildPots([{ id: 'A', amount: 500, folded: false }, { id: 'B', amount: 500, folded: false }, { id: 'C', amount: 900, folded: false }, { id: 'D', amount: 900, folded: true }]), [
    { amount: 2000, eligible: ['A', 'B', 'C'] },
    { amount: 800, eligible: ['C'] },
  ]);
  assert.deepEqual(uncalled([{ id: 'A', amount: 300 }, { id: 'B', amount: 1000 }, { id: 'C', amount: 0 }]), { id: 'B', amount: 700 });
  assert.equal(uncalled([{ id: 'A', amount: 300 }, { id: 'B', amount: 300 }]), null);
});

test('Poker: Split-Pot mit ungeradem Cent geht an den Spieler links vom Dealer', () => {
  assert.deepEqual(splitPot(7, ['links', 'weiter']), [{ id: 'links', amount: 4 }, { id: 'weiter', amount: 3 }]);
  assert.deepEqual(splitPot(11, ['a', 'b', 'c']), [{ id: 'a', amount: 4 }, { id: 'b', amount: 4 }, { id: 'c', amount: 3 }]);
  assert.deepEqual(splitPot(9, ['a', 'b', 'c']), [{ id: 'a', amount: 3 }, { id: 'b', amount: 3 }, { id: 'c', amount: 3 }]);

  // Ganze Runde: Blinds 0,01 / 0,03 €, Pot 7 Cent, Anna (Dealer) und Cem teilen mit der Straße am Board
  const g = table(3, {
    settings: applySettings(DEFAULT_SETTINGS, { smallBlind: '0,01', bigBlind: '0,03' }),
    decks: [deckFor([['2c', '3d'], ['4c', '5d'], ['6c', '7d']], ['As', 'Kd', 'Qh', 'Jc', 'Ts'])],
  });
  g.startHand();
  act(g, 0, 'call');   // Anna (Dealer) geht mit
  act(g, 1, 'fold');   // Ben (Small Blind) steigt aus
  act(g, 2, 'check');  // Cem (Big Blind)
  for (let s = 0; s < 3; s++) { act(g, 2, 'check'); act(g, 0, 'check'); }
  assert.equal(g.phase, 'between');
  assert.equal(g.result.pots[0].amount, 7);
  assert.deepEqual(g.result.pots[0].winners, [{ id: 'p2', amount: 4 }, { id: 'p0', amount: 3 }]);
  assert.deepEqual(g.players.map((p) => p.stack), [2000, 1999, 2001]);
});

test('Poker: Runde mit vier Spielern, drei All-ins und Side-Pots', () => {
  // Dealer Anna (1000), Ben SB (300), Cem BB (600), Dana (2000). Ben hat Asse, Cem Könige, Dana Damen.
  const g = table(4, {
    stacks: [1000, 300, 600, 2000],
    decks: [deckFor([['As', 'Ah'], ['Kd', 'Kh'], ['Qd', 'Qh'], ['3d', '5h']], ['2c', '7d', '9h', 'Jc', '4s'])],
  });
  g.startHand();
  assert.equal(g.actor().name, 'Dana');
  act(g, 3, 'allin');
  act(g, 0, 'call');
  act(g, 1, 'call');
  act(g, 2, 'call');
  assert.equal(g.phase, 'between');
  assert.deepEqual(g.result.pots.map((p) => [p.amount, p.winners.map((w) => w.id), p.side]), [
    [1200, ['p1'], false], [900, ['p2'], true], [800, ['p3'], true],
  ]);
  assert.deepEqual(g.players.map((p) => p.stack), [0, 1200, 900, 1800]);
  assert.equal(g.totalMoney(), 3900);
  // Alle waren All-in: alle Hände wurden gezeigt
  assert.ok(g.players.every((p) => p.shown));
  assert.match(g.log.map((l) => l.text).join('\n'), /Dana bekommt 10,00 € zurück/);
});

test('Poker: Side-Pot mit Gleichstand im Hauptpot', () => {
  // Anna und Ben All-in mit gleicher Hand, Cem deckt beide; Board gibt Anna/Ben eine Straße
  const g = table(3, {
    stacks: [500, 501, 2000],
    decks: [deckFor([['8c', '2d'], ['3h', '3s'], ['8d', '2h']], ['9s', 'Th', 'Jd', 'Qc', '4h'])],
  });
  // Dealer Anna (p0), Ben SB (p1), Cem BB (p2): Austeilen Ben, Cem, Anna
  g.startHand();
  act(g, 0, 'allin');   // Anna 500
  act(g, 1, 'allin');   // Ben 501
  act(g, 2, 'call');    // Cem
  assert.equal(g.phase, 'between');
  // Hauptpot 1500: Ben (8♣ 2♦) und Anna (8♦ 2♥) haben dieselbe Straße und teilen
  const [main, side] = g.result.pots;
  assert.equal(main.amount, 1500);
  assert.deepEqual(main.winners.map((w) => w.id).sort(), ['p0', 'p1']);
  assert.equal(side.amount, 2, 'Side-Pot: Bens Cent mehr gegen Cem');
  assert.equal(g.totalMoney(), 3001);
});

/* ---------------- Setzregeln ---------------- */

test('Poker: Mindest-Raise und zu kleines All-in', () => {
  const g = table(3, { stacks: [2000, 2000, 120] });
  g.startHand();   // Anna Dealer (zuerst), Ben SB 10, Cem BB 20 (Rest 100)
  assert.throws(() => act(g, 0, 'raise', { to: 30 }), /mindestens auf 0,40 €/);
  act(g, 0, 'raise', { to: 60 });            // +40
  assert.equal(g.minRaiseTo(), 100);
  assert.throws(() => act(g, 1, 'raise', { to: 90 }), /mindestens auf 1,00 €/);
  act(g, 1, 'raise', { to: 100 });           // +40, vollständig
  act(g, 2, 'allin');                         // auf 120: nur +20, unvollständig
  assert.equal(g.currentBet, 120);
  assert.equal(g.minRaiseTo(), 160, 'Mindest-Raise bleibt 40 über dem höchsten Einsatz');
  // Anna hat seit Bens voller Erhöhung nicht gehandelt: darf erhöhen
  assert.equal(g.options(P(g, 0)).canRaise, true);
  act(g, 0, 'call');
  // Ben hat nach seiner Erhöhung nur ein zu kleines All-in gesehen: nur mitgehen oder aussteigen
  assert.equal(g.options(P(g, 1)).canRaise, false);
  assert.throws(() => act(g, 1, 'raise', { to: 300 }), /zu kleinen All-in/);
  assert.throws(() => act(g, 1, 'raise', { to: 99999 }), /So viel hast du nicht/);
  act(g, 1, 'call');
  assert.equal(g.street, 'flop');
  // Neue Straße: Mindesteinsatz ist der Big Blind
  assert.equal(g.minRaiseTo(), 20);
});

test('Poker: Check, Call und Bet nur, wenn sie erlaubt sind', () => {
  const g = table(3);
  g.startHand();
  assert.throws(() => act(g, 0, 'check'), /zum Mitgehen fehlen 0,20 €/);
  act(g, 0, 'call');
  act(g, 1, 'call');
  assert.throws(() => act(g, 2, 'call'), /nichts mitzugehen/);
  act(g, 2, 'check');   // Option des Big Blind
  assert.equal(g.street, 'flop');
  assert.equal(g.actor().name, 'Ben', 'nach dem Flop handelt zuerst der Spieler links vom Dealer');
  assert.throws(() => act(g, 1, 'raise', { to: 10 }), /mindestens auf 0,20 €/);
  act(g, 1, 'raise', { to: 20 });
  assert.equal(P(g, 1).lastAction, 'Bet');
  assert.throws(() => act(g, 2, 'raise', { to: 'viel' }), /gültigen Betrag/);
});

test('Poker: Aktionen außerhalb des Zuges werden abgelehnt', () => {
  const g = table(3);
  g.startHand();
  assert.throws(() => act(g, 1, 'call'), /nicht am Zug – gerade ist Anna dran/);
  assert.throws(() => act(g, 2, 'fold'), /nicht am Zug/);
  act(g, 0, 'fold');
  assert.throws(() => act(g, 0, 'call'), /spielst in dieser Runde nicht mehr mit/);
  assert.throws(() => act(g, 1, 'show'), /nichts aufdecken/);
  assert.throws(() => act(g, 1, 'zaubern'), /Unbekannte Aktion/);
  assert.throws(() => g.handleAction('fremd', { type: 'call' }), /Unbekannter Spieler/);
});

test('Poker: Heads-up – Dealer ist Small Blind und handelt vor dem Flop zuerst', () => {
  const g = table(2);
  g.startHand();
  assert.equal(g.players[g.buttonIndex].id, 'p0');
  assert.equal(g.players[g.sbIndex].id, 'p0');
  assert.equal(g.players[g.bbIndex].id, 'p1');
  assert.deepEqual([P(g, 0).bet, P(g, 1).bet], [10, 20]);
  assert.equal(g.actor().id, 'p0', 'vor dem Flop zuerst der Dealer');
  act(g, 0, 'call');
  act(g, 1, 'check');
  assert.equal(g.street, 'flop');
  assert.equal(g.actor().id, 'p1', 'nach dem Flop zuerst der Big Blind');
  act(g, 1, 'check');
  act(g, 0, 'raise', { to: 40 });
  act(g, 1, 'fold');
  assert.equal(g.phase, 'between');
  assert.deepEqual(g.players.map((p) => p.stack), [2020, 1980]);
  // Nächste Runde: Button wechselt, Ben ist jetzt Dealer und Small Blind
  g.startHand();
  assert.equal(g.players[g.buttonIndex].id, 'p1');
  assert.equal(g.players[g.sbIndex].id, 'p1');
  assert.equal(g.actor().id, 'p1');
});

test('Poker: Button und Blinds rotieren und überspringen Spieler ohne Guthaben', () => {
  const g = table(4, { settings: { ...DEFAULT_SETTINGS, rebuy: false } });
  const seen = [];
  for (let h = 0; h < 5; h++) {
    g.startHand();
    seen.push([g.buttonIndex, g.sbIndex, g.bbIndex].map((i) => g.players[i].name).join('/'));
    // Alle steigen aus bis auf den Big Blind
    while (g.phase === 'betting') g.handleAction(g.actor().id, { type: 'fold' });
  }
  assert.deepEqual(seen, ['Anna/Ben/Cem', 'Ben/Cem/Dana', 'Cem/Dana/Anna', 'Dana/Anna/Ben', 'Anna/Ben/Cem']);
  // Cem ist pleite und scheidet aus: Er wird übersprungen
  P(g, 2).stack = 0;
  P(g, 2).status = 'out';
  g.players[3].stack += 0;
  const order = [];
  for (let h = 0; h < 3; h++) {
    g.startHand();
    order.push([g.buttonIndex, g.sbIndex, g.bbIndex].map((i) => g.players[i].name).join('/'));
    assert.equal(P(g, 2).inHand, false);
    while (g.phase === 'betting') g.handleAction(g.actor().id, { type: 'fold' });
  }
  assert.deepEqual(order, ['Ben/Dana/Anna', 'Dana/Anna/Ben', 'Anna/Ben/Dana']);
});

/* ---------------- Showdown ---------------- */

test('Poker: Showdown – wer nicht gewinnen kann, darf verdeckt wegwerfen', () => {
  // Dealer Anna, Austeilen Ben, Cem, Anna. Cem hat das Paar Asse, Anna nichts.
  const g = table(3, { decks: [deckFor([['2c', '7d'], ['Ac', 'Ad'], ['3h', '8s']], ['Ks', 'Qd', '9h', '5c', '4d'])] });
  g.startHand();
  act(g, 0, 'call'); act(g, 1, 'fold'); act(g, 2, 'check');
  for (let s = 0; s < 2; s++) { act(g, 2, 'check'); act(g, 0, 'check'); }
  act(g, 2, 'raise', { to: 40 });   // River-Bet: Cem zeigt zuerst
  act(g, 0, 'call');
  assert.equal(g.phase, 'showdown');
  assert.deepEqual(P(g, 2).shown, ['Ac', 'Ad']);
  assert.equal(g.showdown.decider, 'p0', 'Anna kann nicht gewinnen und entscheidet');
  assert.throws(() => act(g, 2, 'muck'), /nichts aufdecken/);
  const before = g.publicState(null);
  assert.equal(before.players[0].shown, null);
  act(g, 0, 'muck');
  assert.equal(g.phase, 'between');
  assert.equal(P(g, 0).shown, null, 'Annas Karten bleiben verdeckt');
  assert.equal(P(g, 0).mucked, true);
  assert.deepEqual(g.result.pots[0].winners, [{ id: 'p2', amount: 130 }]);
  assert.equal(g.result.pots[0].label, 'Ein Paar, Asse');
});

test('Poker: Showdown – wer gewinnen kann, muss zeigen; Gleichstand teilt', () => {
  const g = table(3, { decks: [deckFor([['2c', '7d'], ['Ac', 'Kd'], ['Ah', 'Ks']], ['Qs', 'Jd', '9h', '5c', '4d'])] });
  g.startHand();
  act(g, 0, 'call'); act(g, 1, 'fold'); act(g, 2, 'check');
  for (let s = 0; s < 3; s++) { act(g, 2, 'check'); act(g, 0, 'check'); }
  // Kein River-Bet: zuerst zeigt Cem (erster links vom Dealer), Anna hat dieselbe Hand und muss zeigen
  assert.equal(g.phase, 'between');
  assert.ok(P(g, 2).shown && P(g, 0).shown);
  assert.deepEqual(g.result.pots[0].winners.map((w) => w.id), ['p2', 'p0']);
  assert.equal(g.result.pots[0].cards, null, 'geteilter Pot: keine einzelne beste Hand');
});

/* ---------------- Einstellungen und Spielerzahl ---------------- */

test('Poker: Einstellungen werden geprüft', () => {
  let s = poker.defaultSettings();
  assert.deepEqual([s.startMoney, s.smallBlind, s.bigBlind, s.rebuy, s.turnTime, s.animation], [2000, 10, 20, true, 0, 'normal']);
  s = poker.applySettings(s, { startMoney: '50,00', smallBlind: '0.25', bigBlind: '0,5' });
  assert.deepEqual([s.startMoney, s.smallBlind, s.bigBlind], [5000, 25, 50]);
  s = poker.applySettings(s, { rebuy: 'aus', turnTime: '30', animation: 'kurz' });
  assert.deepEqual([s.rebuy, s.turnTime, s.animation], [false, 30, 'kurz']);
  const bad = [
    [{ bigBlind: '0,10' }, /Big Blind muss mindestens so groß sein wie der Small Blind/],
    [{ bigBlind: '60' }, /höchstens so groß sein wie das Startguthaben/],
    [{ startMoney: '0,40' }, /zwischen 1,00 € und 100\.000,00 €/],
    [{ startMoney: '1,234' }, /höchstens zwei Nachkommastellen/],
    [{ smallBlind: 'abc' }, /Small Blind: Bitte einen Betrag/],
    [{ smallBlind: '0' }, /mindestens 0,01 €/],
    [{ turnTime: 45 }, /Zugzeit/],
    [{ rebuy: 'vielleicht' }, /Nachkaufen/],
    [{ animation: 'schnell' }, /Animationen/],
  ];
  for (const [patch, re] of bad) assert.throws(() => poker.applySettings(s, patch), re, JSON.stringify(patch));
  // Big Blind gleich Small Blind und gleich Startguthaben sind erlaubt
  assert.equal(poker.applySettings(s, { smallBlind: '50', bigBlind: '50' }).bigBlind, 5000);
});

test('Poker: 2 bis 12 Spieler – der 13. wird abgelehnt', () => {
  assert.throws(() => new PokerGame({ players: seats(1), rng: createRng('x') }), /mindestens 2 Spieler/);
  assert.throws(() => new PokerGame({ players: seats(13), rng: createRng('x') }), /höchstens 12 Spieler/);
  assert.equal(poker.minPlayers, 2);
  assert.equal(poker.maxPlayers, 12);
  assert.equal(new Set(poker.colors).size, 12, '12 eigene Farben');
});

test('Poker: 12 Spieler – Austeilen bis zum River ohne Kartenmangel', () => {
  const g = new PokerGame({ players: seats(12), rng: createRng('zwoelf') });
  g.startHand();
  const holes = g.players.flatMap((p) => p.cards);
  assert.equal(holes.length, 24);
  while (g.phase === 'betting') {
    const p = g.actor();
    g.handleAction(p.id, { type: g.toCall(p) ? 'call' : 'check' });
  }
  assert.equal(g.board.length, 5);
  const all = [...holes, ...g.board];
  assert.equal(new Set(all).size, 29, 'keine Karte doppelt');
  assert.equal(g.deck.length, 52 - 24 - 5 - 3, 'drei Brennkarten');
  assert.equal(g.totalMoney(), 12 * 2000);
});
