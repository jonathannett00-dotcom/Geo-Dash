'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRng } = require('../server/rng');
const {
  TERRITORIES, TERRITORY_IDS, CONTINENTS, CONTINENT_TERRITORIES, BORDERS, NEIGHBORS, isNeighbor,
} = require('../server/games/risiko/map');
const { RisikoGame, CARDS, NEUTRAL, isValidSet, risingTradeValue, fixedTradeValue } = require('../server/games/risiko/rules');
const risiko = require('../server/games/risiko');
const { RoomManager, COLORS, FIGURES } = require('../server/rooms');

const IDS = ['a', 'b', 'c', 'd', 'e', 'f'];

function newGame(n = 3, settings = {}, seed = 'risiko') {
  const players = IDS.slice(0, n).map((id) => ({ id, name: id.toUpperCase() }));
  return new RisikoGame({ players, settings, rng: createRng(seed) });
}

/**
 * Spielstand vorgeben: Alle Gebiete gehören `rest` (1 Armee), `own` legt einzelne
 * Gebiete fest ({ gebiet: [besitzer, armeen] }). Danach beginnt der Zug von `current`.
 */
function arrange(g, { rest = 'b', own = {}, current = 'a', cards = {} } = {}) {
  for (const id of TERRITORY_IDS) g.territories[id] = { owner: rest, armies: 1 };
  for (const [id, [owner, armies]] of Object.entries(own)) g.territories[id] = { owner, armies };
  g.players.forEach((p) => { p.remaining = 0; p.cards = (cards[p.id] || []).slice(); });
  g.currentIndex = g.players.findIndex((p) => p.id === current);
  g.startTurn();
  return g;
}

/** Alle Verstärkungen auf ein Gebiet setzen → Angriffsphase. */
function placeAll(g, territory) {
  g.place(g.currentPlayer().id, territory, g.turn.reinforcements);
  assert.equal(g.phase, 'attack');
}

/**
 * Angriff ansagen und den Verteidiger antworten lassen (ohne Angabe mit der
 * vorausgewählten Höchstzahl). Die neutrale Armee verteidigt von selbst.
 */
function fight(g, from, to, dice, defendDice) {
  g.attack(g.currentPlayer().id, from, to, dice);
  if (g.phase === 'defend') g.defend(g.turn.pendingAttack.defenderId, defendDice);
}

/** Alle Gebiete eines Kontinents für einen Spieler. */
const continent = (id, owner, armies = 1) => Object.fromEntries(CONTINENT_TERRITORIES[id].map((t) => [t, [owner, armies]]));

/* =================== Karte =================== */

test('Karte: 42 Gebiete, 6 Kontinente mit den klassischen Boni', () => {
  assert.equal(TERRITORIES.length, 42);
  assert.equal(new Set(TERRITORY_IDS).size, 42);
  assert.deepEqual(CONTINENTS.map((c) => [c.name, c.bonus]), [
    ['Nordamerika', 5], ['Südamerika', 2], ['Europa', 5], ['Afrika', 3], ['Asien', 7], ['Australien', 2],
  ]);
  assert.deepEqual(CONTINENTS.map((c) => CONTINENT_TERRITORIES[c.id].length), [9, 4, 7, 6, 12, 4]);
  assert.equal(Object.values(CONTINENT_TERRITORIES).flat().length, 42, 'jedes Gebiet liegt in genau einem Kontinent');
  for (const t of TERRITORIES) {
    assert.ok(t.name && Number.isFinite(t.x) && Number.isFinite(t.y), `${t.id}: Name und Position`);
  }
});

test('Karte: Grenzen sind symmetrisch, eindeutig und verbinden die ganze Welt', () => {
  assert.equal(BORDERS.length, 83);
  assert.equal(new Set(BORDERS.map((b) => b.slice().sort().join('|'))).size, 83);
  for (const id of TERRITORY_IDS) {
    assert.ok(NEIGHBORS[id].length >= 2, `${id} hat Nachbarn`);
    assert.ok(!NEIGHBORS[id].includes(id));
    for (const n of NEIGHBORS[id]) assert.ok(NEIGHBORS[n].includes(id), `${id} ↔ ${n}`);
  }
  // Klassische Übergänge zwischen den Kontinenten
  for (const [a, b] of [['alaska', 'kamtschatka'], ['groenland', 'island'], ['mittelamerika', 'venezuela'],
    ['brasilien', 'nordafrika'], ['aegypten', 'naher-osten'], ['suedostasien', 'indonesien'], ['osteuropa', 'ural']]) {
    assert.ok(isNeighbor(a, b), `${a} – ${b}`);
  }
  assert.ok(!isNeighbor('alaska', 'groenland'));
  const seen = new Set(['alaska']);
  const queue = ['alaska'];
  while (queue.length) for (const n of NEIGHBORS[queue.shift()]) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  assert.equal(seen.size, 42);
});

/* =================== Aufbau =================== */

test('Aufbau: Gebiete werden verteilt, Startarmeen nach Spielerzahl', () => {
  const expected = { 3: 35, 4: 30, 5: 25, 6: 20 };
  for (const [n, start] of Object.entries(expected)) {
    const g = newGame(Number(n));
    assert.equal(g.phase, 'setup');
    const counts = g.players.map((p) => g.territoriesOf(p.id).length);
    assert.equal(counts.reduce((a, b) => a + b, 0), 42);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, 'gleichmäßig verteilt');
    for (const p of g.players) assert.equal(g.armiesOf(p.id) + p.remaining, start, `${n} Spieler: ${start} Armeen`);
  }
});

test('Aufbau: Bei 2 Spielern gibt es eine neutrale Armee mit 40 Armeen', () => {
  const g = newGame(2);
  assert.equal(g.neutral.id, NEUTRAL);
  assert.equal(g.territoriesOf(NEUTRAL).length, 14);
  assert.equal(g.armiesOf(NEUTRAL), 40);
  for (const p of g.players) assert.equal(g.armiesOf(p.id) + p.remaining, 40);
});

test('Aufbau: Startarmeen setzen, danach beginnt der erste Zug', () => {
  const g = newGame(3);
  const [a] = g.players;
  const own = g.territoriesOf(a.id)[0];
  const foreign = TERRITORY_IDS.find((id) => g.territories[id].owner !== a.id);
  assert.throws(() => g.place(a.id, foreign, 1), /gehört dir nicht/);
  assert.throws(() => g.place(a.id, own, a.remaining + 1), /Höchstens/);
  assert.throws(() => g.attack(a.id, own, foreign), /Startarmeen/);
  for (const p of g.players) {
    const first = g.territoriesOf(p.id)[0];
    g.place(p.id, first, p.remaining);
    assert.equal(p.remaining, 0);
  }
  assert.equal(g.phase, 'reinforce');
  const other = g.players.find((p) => p.id !== g.turn.playerId);
  assert.throws(() => g.place(other.id, g.territoriesOf(other.id)[0], 1), /nicht am Zug/);
  assert.ok(g.turn.playerId);
  assert.equal(g.waitingFor(), g.turn.playerId);
});

/* =================== Verstärkung =================== */

test('Verstärkung: Gebiete / 3, abgerundet, mindestens 3', () => {
  const g = newGame(3);
  // Jedes zweite Gebiet: so wird kein Kontinent komplett
  const spread = TERRITORY_IDS.filter((_, i) => i % 2 === 0);
  const give = (count) => {
    const mine = spread.slice(0, count);
    TERRITORY_IDS.forEach((id) => { g.territories[id] = { owner: mine.includes(id) ? 'a' : 'b', armies: 1 }; });
    assert.equal(g.continentsOf('a').length, 0);
  };
  for (const [count, expected] of [[1, 3], [8, 3], [11, 3], [12, 4], [14, 4], [15, 5], [21, 7]]) {
    give(count);
    assert.equal(g.reinforcementsFor('a'), expected, `${count} Gebiete`);
  }
});

test('Kontinentboni: komplette Kontinente bringen Zusatzarmeen', () => {
  const g = newGame(3);
  arrange(g, { own: continent('australien', 'a') });
  assert.equal(g.turn.reinforcements, 3 + 2, '4 Gebiete → 3, Australien +2');

  arrange(g, { own: continent('suedamerika', 'a') });
  assert.equal(g.reinforcementsFor('a'), 3 + 2);

  arrange(g, { own: { ...continent('asien', 'a'), ...continent('australien', 'a') } });
  assert.equal(g.reinforcementsFor('a'), 5 + 7 + 2, '16 Gebiete → 5, Asien +7, Australien +2');

  arrange(g, { own: { ...continent('nordamerika', 'a'), ...continent('europa', 'a'), ...continent('afrika', 'a') } });
  assert.equal(g.reinforcementsFor('a'), 7 + 5 + 5 + 3, '22 Gebiete → 7, Nordamerika +5, Europa +5, Afrika +3');

  // Ein fremdes Gebiet im Kontinent → kein Bonus
  arrange(g, { own: { ...continent('australien', 'a'), neuguinea: ['b', 1] } });
  assert.equal(g.reinforcementsFor('a'), 3);

  // Ganze Welt bis auf ein Gebiet
  arrange(g, { rest: 'a', own: { japan: ['b', 1] } });
  assert.equal(g.reinforcementsFor('a'), 13 + 5 + 2 + 5 + 3 + 2);
});

test('Verstärkung: erst alle Armeen setzen, nur auf eigene Gebiete', () => {
  const g = arrange(newGame(3), { own: { alaska: ['a', 3], 'nordwest-territorium': ['a', 1] } });
  assert.equal(g.phase, 'reinforce');
  assert.equal(g.turn.reinforcements, 3);
  assert.throws(() => g.attack('a', 'alaska', 'kamtschatka'), /Verstärkungen/);
  assert.throws(() => g.place('a', 'kamtschatka', 1), /gehört dir nicht/);
  assert.throws(() => g.place('b', 'kamtschatka', 1), /nicht am Zug/);
  assert.throws(() => g.place('a', 'alaska', 4), /Höchstens 3 Armeen/);
  assert.throws(() => g.place('a', 'alaska', 0), /Mindestens 1 Armee/);
  assert.throws(() => g.place('a', 'alaska', 1.5), /ganze Zahl/);
  g.place('a', 'alaska', 2);
  assert.equal(g.territories.alaska.armies, 5);
  assert.equal(g.phase, 'reinforce');
  g.place('a', 'nordwest-territorium', 1);
  assert.equal(g.phase, 'attack');
  assert.throws(() => g.place('a', 'alaska', 1), /Angriffsphase/);
});

/* =================== Kampf =================== */

test('Kampf: höchste Würfel werden verglichen, Gleichstand gewinnt der Verteidiger', () => {
  const g = arrange(newGame(3), { own: { alaska: ['a', 10], kamtschatka: ['b', 5] } });
  placeAll(g, 'alaska');
  const before = g.territories.alaska.armies;
  g.forcedDice.push(4, 6, 5, 5, 5); // Angreifer 6-5-4, Verteidiger 5-5
  fight(g, 'alaska', 'kamtschatka', 3);
  assert.deepEqual(g.lastBattle.attack, [6, 5, 4]);
  assert.deepEqual(g.lastBattle.defend, [5, 5]);
  assert.equal(g.lastBattle.defenderLosses, 1, '6 schlägt 5');
  assert.equal(g.lastBattle.attackerLosses, 1, '5 gegen 5: Verteidiger gewinnt');
  assert.equal(g.territories.alaska.armies, before - 1);
  assert.equal(g.territories.kamtschatka.armies, 4);

  g.forcedDice.push(3, 3, 3, 3, 3);
  fight(g, 'alaska', 'kamtschatka', 3);
  assert.equal(g.lastBattle.attackerLosses, 2, 'nur Gleichstände → Angreifer verliert 2');
  assert.equal(g.lastBattle.defenderLosses, 0);

  g.forcedDice.push(6, 6, 1, 1);
  fight(g, 'alaska', 'kamtschatka', 2);
  assert.equal(g.lastBattle.defenderLosses, 2);
  assert.equal(g.territories.kamtschatka.armies, 2);
});

test('Kampf: Würfelzahl hängt von den Armeen ab', () => {
  const g = arrange(newGame(3), { own: { alaska: ['a', 3], alberta: ['a', 1], kamtschatka: ['b', 1], 'nordwest-territorium': ['b', 4] } });
  placeAll(g, 'alberta'); // Alberta: 4 Armeen
  assert.throws(() => g.attack('a', 'alaska', 'kamtschatka', 3), /höchstens mit 2 Würfeln/);
  assert.throws(() => g.attack('a', 'alaska', 'kamtschatka', 0), /1 bis 3/);
  assert.throws(() => g.attack('a', 'alaska', 'japan'), /grenzt nicht/);
  assert.throws(() => g.attack('a', 'alaska', 'alberta'), /eigenes Gebiet/);
  assert.throws(() => g.attack('a', 'kamtschatka', 'alaska'), /gehört dir nicht/);
  assert.throws(() => g.attack('b', 'kamtschatka', 'alaska'), /nicht am Zug/);

  // Verteidiger mit 1 Armee hat nur 1 Würfel; ohne Angabe würfelt der Angreifer mit dem Maximum
  g.forcedDice.push(1, 1, 6);
  fight(g, 'alaska', 'kamtschatka');
  assert.equal(g.lastBattle.attack.length, 2);
  assert.equal(g.lastBattle.defend.length, 1);
  assert.equal(g.lastBattle.attackerLosses, 1);
  assert.equal(g.territories.alaska.armies, 2);

  g.forcedDice.push(2, 6);
  fight(g, 'alaska', 'kamtschatka');
  assert.equal(g.lastBattle.attack.length, 1, 'mit 2 Armeen nur 1 Würfel');
  assert.equal(g.territories.alaska.armies, 1);
  assert.throws(() => g.attack('a', 'alaska', 'kamtschatka'), /mindestens 2 Armeen/);

  // Verteidiger mit 4 Armeen hat höchstens 2 Würfel (vorausgewählt)
  g.forcedDice.push(6, 6, 6, 1, 1);
  fight(g, 'alberta', 'nordwest-territorium', 3);
  assert.equal(g.lastBattle.defend.length, 2);
});

test('Verteidigung: Der Verteidiger wählt seine Würfel auf dem Handy, nichts wird automatisch gewürfelt', () => {
  const g = arrange(newGame(3), { own: { alaska: ['a', 10], kamtschatka: ['b', 5], japan: ['c', 1] } });
  placeAll(g, 'alaska');
  g.forcedDice.push(6, 5, 4, 3, 3);
  g.attack('a', 'alaska', 'kamtschatka', 3);
  assert.equal(g.phase, 'defend');
  assert.deepEqual(g.turn.pendingAttack, { from: 'alaska', to: 'kamtschatka', dice: 3, defenderId: 'b', maxDefend: 2 });
  assert.equal(g.lastBattle, null, 'noch nicht gewürfelt');
  assert.equal(g.forcedDice.length, 5, 'keine Würfel verbraucht');
  assert.equal(g.tick(), null, 'kein Timer würfelt für den Verteidiger');
  assert.equal(g.waitingFor(), 'b', 'das Spiel wartet auf den Verteidiger');
  assert.equal(g.publicState('b').turn.pendingAttack.maxDefend, 2, 'Handy kennt die Höchstzahl zur Vorauswahl');

  assert.throws(() => g.attack('a', 'alaska', 'kamtschatka', 3), /Verteidiger seine Würfel/);
  assert.throws(() => g.endTurn('a'), /Verteidiger seine Würfel/);
  assert.throws(() => g.defend('a', 2), /verteidigt B, nicht du/);
  assert.throws(() => g.defend('c', 2), /verteidigt B, nicht du/);
  assert.throws(() => g.defend('b', 3), /1 oder 2 Würfeln/);
  assert.throws(() => g.defend('b', 0), /1 oder 2 Würfeln/);

  g.defend('b', 1);
  assert.equal(g.phase, 'attack');
  assert.deepEqual(g.lastBattle.attack, [6, 5, 4]);
  assert.deepEqual(g.lastBattle.defend, [3], 'nur ein Würfel für den Verteidiger');
  assert.equal(g.lastBattle.defenderLosses, 1);
  assert.equal(g.lastBattle.attackerLosses, 0);
  assert.equal(g.forcedDice.length, 1);
  assert.throws(() => g.defend('b', 1), /nicht angegriffen/);
});

test('Verteidigung: mit 1 Armee höchstens 1 Würfel, ohne Angabe die Höchstzahl', () => {
  const g = arrange(newGame(3), { own: { alaska: ['a', 10], kamtschatka: ['b', 1], japan: ['b', 4] } });
  placeAll(g, 'alaska');
  g.attack('a', 'alaska', 'kamtschatka', 3);
  assert.equal(g.turn.pendingAttack.maxDefend, 1);
  assert.throws(() => g.defend('b', 2), /genau 1 Würfel/);
  g.forcedDice.push(1, 1, 1, 6);
  g.handleAction('b', { type: 'defend' });
  assert.deepEqual(g.lastBattle.defend, [6]);
});

test('Verteidigung: Die neutrale Armee verteidigt automatisch mit der Höchstzahl (offene Entscheidung)', () => {
  const g = arrange(newGame(2), { own: { alaska: ['a', 10], kamtschatka: [NEUTRAL, 5] } });
  placeAll(g, 'alaska');
  g.forcedDice.push(6, 6, 6, 1, 1);
  g.attack('a', 'alaska', 'kamtschatka', 3);
  assert.equal(g.phase, 'attack');
  assert.equal(g.lastBattle.defend.length, 2);
  assert.equal(g.territories.kamtschatka.armies, 3);
});

test('Verteidigung: Scheidet der Verteidiger aus, wird der Angriff gegen das neutrale Gebiet aufgelöst', () => {
  const g = arrange(newGame(3), { own: { alaska: ['a', 10], kamtschatka: ['b', 3] } });
  placeAll(g, 'alaska');
  g.forcedDice.push(6, 6, 6, 1, 1);
  g.attack('a', 'alaska', 'kamtschatka', 3);
  g.removePlayer('b');
  assert.equal(g.phase, 'attack');
  assert.equal(g.lastBattle.defenderId, NEUTRAL);
  assert.equal(g.territories.kamtschatka.owner, NEUTRAL);
  assert.equal(g.territories.kamtschatka.armies, 1);
});

test('Kampf: Eroberung mit Nachrücken (mindestens so viele Armeen wie Würfel)', () => {
  const g = arrange(newGame(3), { own: { alaska: ['a', 7], kamtschatka: ['b', 1] } });
  placeAll(g, 'alaska'); // Alaska: 10
  g.forcedDice.push(6, 5, 4, 1);
  fight(g, 'alaska', 'kamtschatka', 3);
  assert.equal(g.lastBattle.conquered, true);
  assert.equal(g.territories.kamtschatka.owner, 'a');
  assert.equal(g.phase, 'occupy');
  assert.deepEqual(g.turn.occupy, { from: 'alaska', to: 'kamtschatka', min: 3, max: 9 });
  assert.throws(() => g.attack('a', 'kamtschatka', 'japan'), /nachziehen|Nachrücken|eroberte/);
  assert.throws(() => g.endTurn('a'), /eroberte Gebiet/);
  assert.throws(() => g.occupy('a', 2), /Mindestens 3/);
  assert.throws(() => g.occupy('a', 10), /Höchstens 9/);
  g.occupy('a', 5);
  assert.equal(g.territories.alaska.armies, 5);
  assert.equal(g.territories.kamtschatka.armies, 5);
  assert.equal(g.phase, 'attack');
  assert.equal(g.turn.conquered, true);
});

test('Kampf: ohne Wahlmöglichkeit wird automatisch nachgerückt', () => {
  const g = arrange(newGame(3), { own: { alaska: ['a', 1], kamtschatka: ['b', 1] } });
  placeAll(g, 'alaska'); // 4 Armeen → 3 Würfel, nachrücken genau 3
  g.forcedDice.push(6, 6, 6, 1);
  fight(g, 'alaska', 'kamtschatka', 3);
  assert.equal(g.phase, 'attack');
  assert.equal(g.territories.kamtschatka.armies, 3);
  assert.equal(g.territories.alaska.armies, 1);
});

test('Kampf: Ausgeschalteter Gegner gibt seine Karten ab, ab 6 Karten wird sofort getauscht', () => {
  const g = arrange(newGame(3), {
    own: { alaska: ['a', 7], kamtschatka: ['c', 1] },
    cards: { a: ['alaska', 'groenland', 'ontario'], c: ['japan', 'china', 'indien'] },
  });
  // Symbole: Karten zyklisch infanterie/kavallerie/artillerie nach Kartenreihenfolge
  placeAll(g, 'alaska');
  g.forcedDice.push(6, 6, 6, 1);
  fight(g, 'alaska', 'kamtschatka', 3);
  const c = g.player('c');
  assert.equal(c.eliminated, true);
  assert.equal(c.cards.length, 0);
  assert.equal(g.player('a').cards.length, 6);
  g.occupy('a', 3);
  assert.equal(g.phase, 'reinforce', 'sofort tauschen');
  assert.equal(g.turn.returnTo, 'attack');
  assert.throws(() => g.place('a', 'alaska', 1), /musst zuerst tauschen/);
  assert.throws(() => g.attack('a', 'kamtschatka', 'japan'), /Verstärkungen/);
  const set = pickSet(g.player('a').cards);
  g.trade('a', set);
  assert.equal(g.player('a').cards.length, 3);
  g.place('a', 'alaska', g.turn.reinforcements);
  assert.equal(g.phase, 'attack', 'danach geht der Angriff weiter');
  // Ausgeschiedene sind nicht mehr am Zug
  g.endTurn('a');
  assert.equal(g.currentPlayer().id, 'b');
  g.place('b', 'japan', g.turn.reinforcements);
  g.endTurn('b');
  assert.equal(g.currentPlayer().id, 'a');
});

test('Kampf: Wer den letzten Gegner ausschaltet, gewinnt', () => {
  const g = arrange(newGame(2), { rest: 'a', own: { kamtschatka: ['b', 1], japan: [NEUTRAL, 3] } });
  placeAll(g, 'alaska');
  g.forcedDice.push(6, 6, 6, 1);
  fight(g, 'alaska', 'kamtschatka', 3);
  assert.equal(g.phase, 'gameover');
  assert.equal(g.winner, 'a');
  assert.ok(g.isOver());
  assert.equal(g.territories.kamtschatka.armies, 3);
  assert.equal(g.waitingFor(), null);
  assert.throws(() => g.endTurn('a'), /vorbei/);
});

test('Kampf: Würfel kommen ohne Vorgabe aus dem Zufallsgenerator des Servers', () => {
  const run = (seed) => {
    const g = arrange(newGame(3, {}, seed), { own: { alaska: ['a', 30], kamtschatka: ['b', 30] } });
    placeAll(g, 'alaska');
    const rolls = [];
    for (let i = 0; i < 5; i++) { fight(g, 'alaska', 'kamtschatka', 3); rolls.push(g.lastBattle.attack, g.lastBattle.defend); }
    return rolls;
  };
  const a = run('w1');
  assert.deepEqual(run('w1'), a, 'gleicher Seed → gleiche Würfel');
  assert.notDeepEqual(run('w2'), a);
  assert.ok(a.flat().every((d) => Number.isInteger(d) && d >= 1 && d <= 6));
});

/* =================== Karten =================== */

/** Findet irgendein gültiges Set in einer Hand. */
function pickSet(hand) {
  for (let i = 0; i < hand.length; i++) for (let j = i + 1; j < hand.length; j++) for (let k = j + 1; k < hand.length; k++) {
    const set = [hand[i], hand[j], hand[k]];
    if (isValidSet(set)) return set;
  }
  return null;
}

const bySymbol = (symbol) => CARDS.filter((c) => c.symbol === symbol).map((c) => c.id);
const INF = bySymbol('infanterie');
const KAV = bySymbol('kavallerie');
const ART = bySymbol('artillerie');
const JOKER = bySymbol('joker');

test('Karten: 42 Gebietskarten (je 14 pro Symbol) und 2 Joker', () => {
  assert.equal(CARDS.length, 44);
  assert.deepEqual([INF.length, KAV.length, ART.length, JOKER.length], [14, 14, 14, 2]);
});

test('Kartentausch: gültige und ungültige Sets', () => {
  assert.ok(isValidSet([INF[0], INF[1], INF[2]]), 'drei Infanterie');
  assert.ok(isValidSet([ART[0], ART[1], ART[2]]), 'drei Artillerie');
  assert.ok(isValidSet([INF[0], KAV[0], ART[0]]), 'je eins');
  assert.ok(isValidSet([INF[0], INF[1], JOKER[0]]), 'zwei gleiche + Joker');
  assert.ok(isValidSet([INF[0], KAV[1], JOKER[0]]), 'zwei verschiedene + Joker');
  assert.ok(isValidSet([KAV[0], JOKER[0], JOKER[1]]), 'zwei Joker');
  assert.ok(!isValidSet([INF[0], INF[1], KAV[0]]), 'zwei gleiche + ein anderes');
  assert.ok(!isValidSet([ART[0], ART[1], INF[0]]));
});

test('Kartentausch: steigende Werte 4, 6, 8, 10, 12, 15, dann +5', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(risingTradeValue), [4, 6, 8, 10, 12, 15, 20, 25, 30]);
  const g = arrange(newGame(3), { cards: { a: [INF[0], INF[1], INF[2], KAV[0], KAV[1], KAV[2]] } });
  assert.equal(g.turn.reinforcements, 3);
  assert.equal(g.nextTradeValue(), 4);
  g.trade('a', [INF[0], INF[1], INF[2]]);
  assert.equal(g.turn.reinforcements, 7);
  assert.equal(g.nextTradeValue(), 6);
  g.trade('a', [KAV[0], KAV[1], KAV[2]]);
  assert.equal(g.turn.reinforcements, 13);
  assert.equal(g.tradeCount, 2);
  assert.equal(g.player('a').cards.length, 0);
  assert.equal(g.discard.length, 6, 'getauschte Karten liegen auf dem Ablagestapel');
});

test('Kartentausch: feste Werte (Infanterie 4, Kavallerie 6, Artillerie 8, gemischt 10)', () => {
  assert.equal(fixedTradeValue([INF[0], INF[1], INF[2]]), 4);
  assert.equal(fixedTradeValue([KAV[0], KAV[1], KAV[2]]), 6);
  assert.equal(fixedTradeValue([ART[0], ART[1], JOKER[0]]), 8);
  assert.equal(fixedTradeValue([INF[0], KAV[0], ART[0]]), 10);
  assert.equal(fixedTradeValue([INF[0], ART[0], JOKER[0]]), 10, 'Joker zählt zum besten Wert');
  const g = arrange(newGame(3, { cardValues: 'fest' }), { cards: { a: [ART[0], ART[1], ART[2], ART[3], ART[4], ART[5]] } });
  assert.equal(g.nextTradeValue(), null);
  g.trade('a', [ART[0], ART[1], ART[2]]);
  g.trade('a', [ART[3], ART[4], ART[5]]);
  assert.equal(g.turn.reinforcements, 3 + 8 + 8, 'Wert steigt nicht');
});

test('Kartentausch: +2 Armeen auf ein eigenes abgebildetes Gebiet (einmal pro Tausch)', () => {
  // Karten zu Alaska und Grönland gehören a, Ontario nicht
  const hand = ['alaska', 'groenland', 'ontario'];
  assert.ok(isValidSet(hand));
  const g = arrange(newGame(3), { own: { alaska: ['a', 1], groenland: ['a', 1] }, cards: { a: hand } });
  g.trade('a', hand);
  assert.equal(g.territories.alaska.armies, 3, 'erste passende Karte bekommt +2');
  assert.equal(g.territories.groenland.armies, 1, 'nur einmal pro Tausch');
  assert.equal(g.lastTrade.bonusTerritory, 'alaska');
  assert.equal(g.turn.reinforcements, 3 + 4);

  const h = arrange(newGame(3), { cards: { a: hand } });
  h.trade('a', hand);
  assert.equal(h.lastTrade.bonusTerritory, null, 'kein eigenes Gebiet → kein Bonus');
});

test('Kartentausch: Prüfungen und Pflicht ab 5 Karten', () => {
  const g = arrange(newGame(3), { own: { alaska: ['a', 2] }, cards: { a: [INF[0], INF[1], KAV[0], KAV[1], ART[0]] } });
  assert.throws(() => g.place('a', 'alaska', 1), /5 Karten und musst zuerst tauschen/);
  assert.throws(() => g.trade('a', [INF[0], INF[1]]), /genau drei/);
  assert.throws(() => g.trade('a', [INF[0], INF[0], INF[1]]), /nur einmal/);
  assert.throws(() => g.trade('a', [INF[0], INF[1], INF[2]]), /hast du nicht/);
  assert.throws(() => g.trade('a', [INF[0], INF[1], KAV[0]]), /Kein gültiges Set/);
  assert.throws(() => g.trade('b', [INF[0], KAV[0], ART[0]]), /nicht am Zug/);
  g.trade('a', [INF[0], KAV[0], ART[0]]);
  g.place('a', 'alaska', g.turn.reinforcements);
  assert.equal(g.phase, 'attack');
  assert.throws(() => g.trade('a', [INF[1], KAV[1], JOKER[0]]), /Angriffsphase/);
});

test('Karten: nur wer im Zug erobert hat, zieht am Zugende eine Karte', () => {
  const g = arrange(newGame(3), { own: { alaska: ['a', 10], kamtschatka: ['b', 1], japan: ['c', 1] } });
  const deck = g.deck.length;
  placeAll(g, 'alaska');
  g.endTurn('a');
  assert.equal(g.player('a').cards.length, 0, 'ohne Eroberung keine Karte');
  assert.equal(g.currentPlayer().id, 'b');
  g.place('b', 'china', g.turn.reinforcements);
  g.endTurn('b');
  g.place('c', 'japan', g.turn.reinforcements);
  g.endTurn('c');

  placeAll(g, 'alaska');
  g.forcedDice.push(6, 6, 6, 1, 6, 6, 1);
  fight(g, 'alaska', 'kamtschatka', 3);
  g.occupy('a', 3);
  fight(g, 'kamtschatka', 'mongolei', 2);
  assert.equal(g.territories.mongolei.owner, 'a');
  g.endTurn('a');
  assert.equal(g.player('a').cards.length, 1, 'zwei Eroberungen → trotzdem nur eine Karte');
  assert.equal(g.deck.length, deck - 1);
});

test('Karten: leerer Stapel wird aus dem Ablagestapel neu gemischt', () => {
  const g = arrange(newGame(3), { own: { alaska: ['a', 10], kamtschatka: ['b', 1] } });
  g.discard = g.deck.slice(1);
  g.deck = [];
  placeAll(g, 'alaska');
  g.forcedDice.push(6, 6, 6, 1);
  fight(g, 'alaska', 'kamtschatka', 3);
  g.occupy('a', 3);
  g.endTurn('a');
  assert.equal(g.player('a').cards.length, 1);
  assert.equal(g.discard.length, 0);
  assert.equal(g.deck.length, 42);
});

test('Versteckte Information: Handkarten sieht nur ihr Besitzer, der Stapel bleibt auf dem Server', () => {
  const g = risiko.createGame({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], settings: risiko.defaultSettings(), rng: createRng('geheim') });
  arrange(g, { cards: { a: ['alaska', 'japan'], b: ['china'] } });
  const board = g.view('board', null);
  const forA = g.view('player', 'a');
  const forB = g.view('player', 'b');
  assert.equal(board.game.myCards, null);
  assert.deepEqual(forA.game.myCards.map((c) => c.id), ['alaska', 'japan']);
  assert.deepEqual(forB.game.myCards.map((c) => c.id), ['china']);
  assert.deepEqual(forA.game.players.map((p) => p.cards), [2, 1, 0], 'von den anderen nur die Anzahl');
  assert.equal(g.view('player', 'c').game.myCards.length, 0);
  const text = JSON.stringify(forB);
  assert.ok(!/"joker-/.test(text), 'Stapel und fremde Karten tauchen nicht auf');
  assert.ok(!('deck' in forB.game) && !('discard' in forB.game) && !('forcedDice' in forB.game));
  assert.equal(board.game.deckCount, g.deck.length);
  assert.equal(board.map.territories.length, 42);
});

/* =================== Verschieben =================== */

test('Verschieben: einmal pro Zug ins Nachbargebiet, danach endet der Zug', () => {
  const g = arrange(newGame(3), { own: { alaska: ['a', 6], alberta: ['a', 1], ontario: ['a', 1] } });
  placeAll(g, 'ontario');
  assert.throws(() => g.fortify('a', 'alaska', 'ontario', 2), /grenzt nicht.*Nachbargebiet/);
  assert.throws(() => g.fortify('a', 'alaska', 'kamtschatka', 2), /Zielgebiet gehört dir nicht/);
  assert.throws(() => g.fortify('a', 'kamtschatka', 'alaska', 2), /Ausgangsgebiet gehört dir nicht/);
  assert.throws(() => g.fortify('a', 'alaska', 'alaska', 2), /verschiedene/);
  assert.throws(() => g.fortify('a', 'alaska', 'alberta', 6), /Höchstens 5/);
  assert.throws(() => g.fortify('a', 'alberta', 'alaska', 1), /Eine Armee muss/);
  assert.throws(() => g.fortify('b', 'kamtschatka', 'japan', 1), /nicht am Zug/);
  g.fortify('a', 'alaska', 'alberta', 5);
  assert.equal(g.territories.alaska.armies, 1);
  assert.equal(g.territories.alberta.armies, 6);
  assert.equal(g.currentPlayer().id, 'b', 'Zug ist zu Ende');
  assert.throws(() => g.fortify('a', 'alberta', 'alaska', 1), /nicht am Zug/);
});

test('Verschieben: nach „Angriff beenden“ sind keine Angriffe mehr möglich', () => {
  const g = arrange(newGame(3), { own: { alaska: ['a', 6], alberta: ['a', 1] } });
  placeAll(g, 'alaska');
  g.endAttack('a');
  assert.equal(g.phase, 'fortify');
  assert.throws(() => g.attack('a', 'alaska', 'kamtschatka'), /Angriffe sind vorbei/);
  assert.throws(() => g.endAttack('a'), /Angriffe sind vorbei/);
  g.endTurn('a');
  assert.equal(g.currentPlayer().id, 'b');
  assert.equal(g.territories.alaska.armies, 9, 'Zug ohne Verschieben beendet');
});

test('Verschieben: Variante „verbunden“ erlaubt Wege über eigene Gebiete', () => {
  const own = { alaska: ['a', 6], alberta: ['a', 1], weststaaten: ['a', 1], groenland: ['a', 1] };
  const g = arrange(newGame(3, { fortify: 'verbunden' }), { own });
  placeAll(g, 'alberta');
  assert.throws(() => g.fortify('a', 'alaska', 'groenland', 1), /nicht über eigene Gebiete verbunden/);
  g.fortify('a', 'alaska', 'weststaaten', 4);
  assert.equal(g.territories.weststaaten.armies, 5);
  assert.equal(g.currentPlayer().id, 'b');
});

/* =================== Ausscheiden, Speichern, Modul =================== */

test('Ausscheiden: Gebiete werden neutral, der Zug geht weiter', () => {
  const g = arrange(newGame(3), { own: { alaska: ['a', 3], japan: ['c', 2] }, cards: { a: ['china'] } });
  g.quit('a');
  assert.equal(g.player('a').eliminated, true);
  assert.equal(g.territories.alaska.owner, NEUTRAL);
  assert.equal(g.territories.alaska.armies, 3);
  assert.ok(g.discard.includes('china'));
  assert.equal(g.currentPlayer().id, 'b');
  assert.equal(g.phase, 'reinforce');
  g.removePlayer('c');
  assert.equal(g.phase, 'gameover');
  assert.equal(g.winner, 'b');
});

test('Ausscheiden im Aufbau: wer fehlt, hält das Spiel nicht auf', () => {
  const g = newGame(3);
  const [a, b, c] = g.players;
  g.place(a.id, g.territoriesOf(a.id)[0], a.remaining);
  g.place(b.id, g.territoriesOf(b.id)[0], b.remaining);
  assert.equal(g.waitingFor(), c.id);
  g.removePlayer(c.id);
  assert.equal(g.phase, 'reinforce');
  assert.notEqual(g.currentPlayer().id, c.id);
});

test('Speichern: Zustand übersteht toJSON/fromJSON vollständig', () => {
  const g = arrange(risiko.createGame({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], settings: {}, rng: createRng('j') }),
    { own: { alaska: ['a', 5], kamtschatka: ['b', 1] }, cards: { a: ['japan'] } });
  placeAll(g, 'alaska');
  g.forcedDice.push(6, 6, 6, 1);
  fight(g, 'alaska', 'kamtschatka', 3);
  const copy = risiko.restoreGame(JSON.parse(JSON.stringify(g.toJSON())), { rng: createRng('weiter') });
  assert.deepEqual(copy.view('player', 'a'), g.view('player', 'a'));
  assert.ok(!('rng' in g.toJSON()));
  copy.occupy('a', 5);
  assert.equal(copy.territories.kamtschatka.armies, 5);
});

test('Modul: Einstellungen werden geprüft', () => {
  const s = risiko.defaultSettings();
  assert.deepEqual(s, { cardValues: 'steigend', fortify: 'benachbart' });
  assert.deepEqual(risiko.applySettings(s, { cardValues: 'fest' }), { cardValues: 'fest', fortify: 'benachbart' });
  assert.throws(() => risiko.applySettings(s, { cardValues: 'doppelt' }), /steigend/);
  assert.throws(() => risiko.applySettings(s, { fortify: 'überall' }), /benachbart/);
  assert.throws(() => newGame(1), /mindestens 2/);
  assert.throws(() => new RisikoGame({ players: IDS.concat('g').map((id) => ({ id, name: id })) }), /höchstens 6/);
});

test('Raum: Risiko läuft über die gemeinsame Schnittstelle', () => {
  const manager = new RoomManager({ testMode: true, seed: 'raum', timeScale: 0.01 });
  const room = manager.create('risiko');
  assert.equal(room.maxPlayers, 6);
  const players = [0, 1, 2].map((i) => room.join({ name: `S${i}`, color: COLORS[i], figure: FIGURES[i] }));
  room.start();
  const g = room.game;
  assert.equal(g.phase, 'setup');
  for (const p of players) room.act(p.id, { type: 'place', territory: g.territoriesOf(p.id)[0], count: g.player(p.id).remaining });
  assert.equal(g.phase, 'reinforce');
  assert.throws(() => room.act(players[0].id, { type: 'zaubern' }), /Unbekannte Aktion/);
  const snap = room.snapshot('player', players[0].id);
  assert.equal(snap.gameType, 'risiko');
  assert.ok(Array.isArray(snap.game.myCards));
  assert.equal(room.snapshot('board').game.myCards, null);
  assert.equal(room.serialize().gameType, 'risiko');
  manager.shutdown();
});
