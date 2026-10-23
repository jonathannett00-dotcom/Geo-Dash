'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Roulette, payoutFor, WHEEL_ORDER } = require('../server/games/roulette');
const { createRng } = require('../server/rng');

const bet = (kind, value, amount = 10) => ({ kind, value, amount });

test('Roulette: europäisches Rad mit 37 Fächern', () => {
  assert.equal(WHEEL_ORDER.length, 37);
  assert.deepEqual([...WHEEL_ORDER].sort((a, b) => a - b), [...Array(37).keys()]);
});

test('Roulette: Plein zahlt 35:1', () => {
  assert.equal(payoutFor(bet('straight', 17), 17), 360);
  assert.equal(payoutFor(bet('straight', 0), 0), 360);
  assert.equal(payoutFor(bet('straight', 17), 18), 0);
});

test('Roulette: Rot/Schwarz, Gerade/Ungerade, 1–18/19–36 zahlen 1:1', () => {
  assert.equal(payoutFor(bet('red'), 1), 20);
  assert.equal(payoutFor(bet('red'), 2), 0);
  assert.equal(payoutFor(bet('black'), 2), 20);
  assert.equal(payoutFor(bet('black'), 3), 0);
  assert.equal(payoutFor(bet('even'), 36), 20);
  assert.equal(payoutFor(bet('odd'), 35), 20);
  assert.equal(payoutFor(bet('even'), 35), 0);
  assert.equal(payoutFor(bet('low'), 18), 20);
  assert.equal(payoutFor(bet('low'), 19), 0);
  assert.equal(payoutFor(bet('high'), 19), 20);
});

test('Roulette: Dutzende und Kolonnen zahlen 2:1', () => {
  assert.equal(payoutFor(bet('dozen', 1), 12), 30);
  assert.equal(payoutFor(bet('dozen', 2), 13), 30);
  assert.equal(payoutFor(bet('dozen', 3), 36), 30);
  assert.equal(payoutFor(bet('dozen', 1), 13), 0);
  assert.equal(payoutFor(bet('column', 1), 34), 30);
  assert.equal(payoutFor(bet('column', 2), 35), 30);
  assert.equal(payoutFor(bet('column', 3), 36), 30);
  assert.equal(payoutFor(bet('column', 1), 36), 0);
});

test('Roulette: Bei 0 verlieren alle Außenwetten', () => {
  for (const kind of ['red', 'black', 'even', 'odd', 'low', 'high']) assert.equal(payoutFor(bet(kind), 0), 0, kind);
  assert.equal(payoutFor(bet('dozen', 1), 0), 0);
  assert.equal(payoutFor(bet('column', 3), 0), 0);
});

test('Roulette: Chips, Mindesteinsatz, Fertig und Auszahlung', () => {
  const balances = { a: 100, b: 100 };
  const wallet = {
    debit: (id, amt) => { if (amt > balances[id]) { const e = new Error('Nicht genug Geld'); e.name = 'RuleError'; throw e; } balances[id] -= amt; },
    credit: (id, amt) => { balances[id] += amt; },
  };
  const r = new Roulette({ id: 1, players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], wallet, rng: createRng('roulette'), timeScale: 0 });
  assert.throws(() => r.placeChip('a', { kind: 'straight', value: 37, amount: 10 }), /0 bis 36/);
  assert.throws(() => r.placeChip('a', { kind: 'red', amount: 7 }), /Chip/);
  r.placeChip('a', { kind: 'red', amount: 100 });
  assert.throws(() => r.placeChip('a', { kind: 'red', amount: 5 }), /Nicht genug Geld/);
  r.clearBets('a');
  assert.equal(balances.a, 100);
  r.placeChip('a', { kind: 'straight', value: 7, amount: 5 });
  assert.throws(() => r.setReady('a'), /Mindesteinsatz/);
  r.placeChip('a', { kind: 'straight', value: 7, amount: 5 });
  assert.equal(r.bets.length, 1, 'gleiches Feld wird zusammengefasst');
  assert.equal(r.bets[0].amount, 10);
  r.placeChip('a', { kind: 'red', amount: 25 });
  r.placeChip('b', { kind: 'dozen', value: 2, amount: 5 }); // unter Minimum → zurück
  r.setReady('a');
  r.closeBetting();
  assert.equal(balances.b, 100, 'Einsatz unter 10 M wird erstattet');
  assert.ok(r.result >= 0 && r.result <= 36);
  r.settle();
  r.stop();
  const expected = 100 - 35 + (r.result === 7 ? 360 : 0) + ([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36].includes(r.result) ? 50 : 0);
  assert.equal(balances.a, expected);
});
