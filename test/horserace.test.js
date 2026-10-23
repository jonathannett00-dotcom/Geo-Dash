'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HorseRace, simulateRace, generateHorses, settleBet } = require('../server/games/horserace');
const { createRng } = require('../server/rng');

function makeRace() {
  const balances = { a: 500, b: 500 };
  const wallet = {
    balance: (id) => balances[id],
    debit: (id, amt) => { if (amt > balances[id]) { const e = new Error(`Nicht genug Geld: Du hast nur ${balances[id]} M.`); e.name = 'RuleError'; throw e; } balances[id] -= amt; },
    credit: (id, amt) => { balances[id] += amt; },
  };
  const race = new HorseRace({ id: 1, players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], wallet, rng: createRng('race'), timeScale: 0 });
  return { race, balances };
}

test('Rennen: Simulation läuft durch, alle 6 Pferde kommen ins Ziel', () => {
  const rng = createRng('sim');
  const horses = generateHorses(rng);
  assert.equal(horses.length, 6);
  horses.forEach((h) => { assert.ok(h.winOdds >= 1.1); assert.ok(h.placeOdds >= 1.05); });
  const { order, frames, finishTime } = simulateRace(horses, rng, true);
  assert.deepEqual([...order].sort(), [0, 1, 2, 3, 4, 5]);
  assert.ok(frames.length > 60 * 15 && frames.length < 60 * 25, 'ca. 18 Sekunden');
  assert.ok(finishTime.every(Number.isFinite));
});

test('Rennen: Sieg- und Platzwetten werden mit der Quote ausgezahlt', () => {
  const horses = [{ winOdds: 4.2, placeOdds: 1.6 }, { winOdds: 2, placeOdds: 1.2 }, {}, {}];
  const order = [0, 1, 2, 3];
  assert.equal(settleBet({ horse: 0, type: 'win', amount: 50 }, horses, order).payout, 210);
  assert.equal(settleBet({ horse: 1, type: 'win', amount: 50 }, horses, order).payout, 0);
  assert.equal(settleBet({ horse: 1, type: 'place', amount: 50 }, horses, order).payout, 60);
  assert.equal(settleBet({ horse: 0, type: 'place', amount: 10 }, horses, order).payout, 16);
});

test('Rennen: Einsatzregeln, Fertig-Status und Abrechnung', () => {
  const { race, balances } = makeRace();
  assert.throws(() => race.placeBet('a', { horse: 0, kind: 'win', amount: 5 }), /Mindesteinsatz/);
  assert.throws(() => race.placeBet('a', { horse: 9, kind: 'win', amount: 10 }), /Pferd/);
  assert.throws(() => race.placeBet('a', { horse: 0, kind: 'x', amount: 10 }), /Sieg oder Platz/);
  assert.throws(() => race.placeBet('a', { horse: 0, kind: 'win', amount: 900 }), /Nicht genug Geld/);
  assert.throws(() => race.placeBet('z', { horse: 0, kind: 'win', amount: 10 }), /nicht mit/);
  race.placeBet('a', { horse: 0, kind: 'win', amount: 100 });
  race.placeBet('a', { horse: 1, kind: 'place', amount: 50 });
  assert.equal(balances.a, 350, 'Einsatz wird sofort vom Konto abgebucht');
  race.clearBets('a');
  assert.equal(balances.a, 500);
  race.placeBet('a', { horse: 2, kind: 'place', amount: 100 });
  race.setReady('a');
  assert.throws(() => race.placeBet('a', { horse: 0, kind: 'win', amount: 10 }), /Fertig/);
  assert.equal(race.phase, 'betting');
  race.setReady('b'); // b setzt 0 → setzt aus
  assert.equal(race.phase, 'running', 'alle fertig → Rennen startet');
  assert.ok(race.frames.length > 100);
  assert.throws(() => race.placeBet('b', { horse: 0, kind: 'win', amount: 10 }), /Wettzeit ist vorbei/);
  race.settle();
  race.stop();
  const won = race.order.slice(0, 3).includes(2);
  assert.equal(balances.a, won ? 400 + Math.round(100 * race.horses[2].placeOdds) : 400);
  assert.equal(balances.b, 500);
});
