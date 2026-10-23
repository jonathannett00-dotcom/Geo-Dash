'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Blackjack, handValue, isBlackjack, dealerShouldHit, settleHand, newShoe, needsShuffle } = require('../server/games/blackjack');
const { createRng } = require('../server/rng');

const C = (...ranks) => ranks.map((r) => ({ r: String(r), s: '♠' }));

function makeTable(ranks, bets = { a: 20, b: 10 }) {
  const balances = { a: 100, b: 100 };
  const wallet = {
    debit: (id, amt) => { if (amt > balances[id]) { const e = new Error('Nicht genug Geld'); e.name = 'RuleError'; throw e; } balances[id] -= amt; },
    credit: (id, amt) => { balances[id] += amt; },
  };
  // präparierter Schuh: bekannte Karten, danach viele Zehner
  const shoe = { cards: [...C(...ranks), ...C(...Array(40).fill('10'))], pos: 0 };
  const bj = new Blackjack({ id: 1, players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], wallet, rng: createRng('bj'), shoe, timeScale: 0 });
  Object.entries(bets).forEach(([id, amt]) => bj.placeBet(id, amt));
  bj.closeBetting();
  bj.stop();          // Timer im Test von Hand steuern
  return { bj, balances };
}

test('Blackjack: Handwerte inklusive Soft-Asse', () => {
  assert.deepEqual(handValue(C('A', 6)), { total: 17, soft: true });
  assert.deepEqual(handValue(C('A', 6, 10)), { total: 17, soft: false });
  assert.deepEqual(handValue(C('A', 'A')), { total: 12, soft: true });
  assert.deepEqual(handValue(C('A', 'A', 9)), { total: 21, soft: true });
  assert.deepEqual(handValue(C('A', 'A', 'A', 'K')), { total: 13, soft: false });
  assert.equal(handValue(C('K', 'Q', 2)).total, 22);
  assert.equal(handValue(C('J', 'Q')).total, 20);
  assert.equal(isBlackjack(C('A', 'K')), true);
  assert.equal(isBlackjack(C('A', 5, 5)), false);
});

test('Blackjack: Dealer steht auf Soft 17 und zieht bis 16', () => {
  assert.equal(dealerShouldHit(C('A', 6)), false, 'Soft 17 → steht');
  assert.equal(dealerShouldHit(C(10, 7)), false);
  assert.equal(dealerShouldHit(C(10, 6)), true);
  assert.equal(dealerShouldHit(C('A', 5)), true, 'Soft 16 → zieht');
  assert.equal(dealerShouldHit(C('A', 'A', 4)), true, 'Soft 16');
});

test('Blackjack: Auszahlung 3:2, Gewinn 1:1, Push, Verlust', () => {
  const hand = (cards, bet = 10, extra = {}) => ({ cards: C(...cards), bet, ...extra });
  assert.deepEqual(settleHand(hand(['A', 'K']), C(10, 7)), { result: 'blackjack', payout: 25 });
  assert.deepEqual(settleHand(hand(['A', 'Q'], 20), C(10, 9)), { result: 'blackjack', payout: 50 });
  assert.equal(settleHand(hand(['A', 'Q'], 15), C(10, 9)).payout, 37, '3:2 auf 15 M = 22 M (abgerundet) + Einsatz');
  assert.deepEqual(settleHand(hand(['A', 'K']), C('A', 'Q')), { result: 'push', payout: 10 });
  assert.deepEqual(settleHand(hand([10, 9]), C('A', 'Q')), { result: 'lose', payout: 0 });
  assert.deepEqual(settleHand(hand([10, 9]), C(10, 8)), { result: 'win', payout: 20 });
  assert.deepEqual(settleHand(hand([10, 8]), C(10, 8)), { result: 'push', payout: 10 });
  assert.deepEqual(settleHand(hand([10, 8]), C(10, 6, 8)), { result: 'win', payout: 20 }, 'Dealer überkauft');
  assert.deepEqual(settleHand(hand([10, 6, 9]), C(10, 6, 8)), { result: 'bust', payout: 0 }, 'Spieler überkauft verliert immer');
  assert.deepEqual(settleHand(hand(['A', 'K'], 10, { fromSplit: true }), C(10, 7)), { result: 'win', payout: 20 }, '21 nach Split ist kein Blackjack');
});

test('Blackjack: Split, Double nur auf den ersten 2 Karten, einmal teilen', () => {
  // Austeilen: a, b, Dealer, a, b, Dealer(verdeckt) – dann Split-Karten 3 und 8, Double-Karte 10, Hit-Karte 2
  const { bj, balances } = makeTable([8, 5, 10, 8, 6, 7, 3, 8, 10, 2]);
  assert.equal(balances.a, 80);
  assert.equal(bj.view().dealer[1].hidden, true, 'Lochkarte verdeckt');
  bj.advance();
  assert.throws(() => bj.act('b', 'hit'), /nicht dran/);
  bj.act('a', 'split');
  assert.equal(balances.a, 60, 'Split kostet einen zweiten Einsatz');
  assert.deepEqual(bj.seats[0].hands.map((h) => h.cards.map((c) => c.r)), [['8', '3'], ['8', '8']]);
  assert.throws(() => bj.act('a', 'split'), /Paar|einmal/);
  bj.act('a', 'double'); // 8 + 3 + 10 = 21
  assert.equal(balances.a, 40);
  assert.equal(bj.seats[0].hands[0].bet, 40);
  assert.equal(bj.seats[0].hands[0].done, true, 'nach Double genau eine Karte');
  assert.throws(() => bj.act('a', 'split'), /nur einmal geteilt/);
  bj.act('a', 'stand');
  bj.act('b', 'hit'); // 5 + 6 + 2 = 13
  assert.throws(() => bj.act('b', 'double'), /ersten 2 Karten/);
  bj.act('b', 'stand');
  assert.equal(bj.phase, 'dealer');
  assert.equal(bj.dealer.length, 2, 'Dealer steht auf 17');
  bj.settle();
  bj.stop();
  assert.deepEqual(bj.seats[0].hands.map((h) => h.result), ['win', 'lose']);
  assert.equal(balances.a, 40 + 80);
  assert.equal(balances.b, 90);
});

test('Blackjack: geteilte Asse bekommen je eine Karte, Blackjack zahlt 3:2, Soft 17', () => {
  // a: A,A  b: A,K (Blackjack)  Dealer: 6, A (Soft 17)  Split-Karten: 9, K
  const { bj, balances } = makeTable(['A', 'A', 6, 'A', 'K', 'A', 9, 'K'], { a: 10, b: 10 });
  bj.advance();
  assert.equal(bj.view().turn.playerId, 'a', 'b hat Blackjack und ist schon fertig');
  bj.act('a', 'split');
  assert.deepEqual(bj.seats[0].hands.map((h) => [h.cards.length, h.done]), [[2, true], [2, true]]);
  assert.equal(bj.phase, 'dealer', 'nach geteilten Assen spielt sofort der Dealer');
  assert.equal(handValue(bj.dealer).total, 17);
  assert.equal(bj.dealer.length, 2, 'Dealer zieht nicht auf Soft 17');
  bj.settle();
  bj.stop();
  assert.deepEqual(bj.seats[0].hands.map((h) => h.result), ['win', 'win']);
  assert.equal(balances.a, 100 - 20 + 40);
  assert.equal(bj.seats[1].hands[0].result, 'blackjack');
  assert.equal(balances.b, 100 - 10 + 25);
});

test('Blackjack: Einsatzregeln und Neumischen bei 75 % Verbrauch', () => {
  const rng = createRng('shoe');
  const shoe = newShoe(rng);
  assert.equal(shoe.cards.length, 312, '6 Decks');
  assert.equal(needsShuffle(shoe), false);
  shoe.pos = 234;
  assert.equal(needsShuffle(shoe), true, '75 % von 312 = 234');

  const wallet = { debit: () => {}, credit: () => {} };
  const bj = new Blackjack({ id: 2, players: [{ id: 'a', name: 'A' }], wallet, rng, shoe, timeScale: 0 });
  assert.throws(() => bj.placeBet('a', 5), /Mindesteinsatz/);
  bj.placeBet('a', 10);
  bj.setReady('a');
  bj.stop();
  assert.equal(bj.shuffled, true);
  assert.equal(shoe.cards.length, 312);
  assert.equal(shoe.pos, 4, 'nach dem Mischen: 2 Karten Spieler + 2 Dealer');
});
