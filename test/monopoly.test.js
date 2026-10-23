'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MonopolyGame, minigameForSum, BANK_HOUSES, AUCTION_MS, AUCTION_EXTEND_MS } = require('../server/monopoly/rules');
const { SQUARES } = require('../server/monopoly/board');
const { CHANCE_CARDS, COMMUNITY_CARDS } = require('../server/monopoly/cards');
const { createRng } = require('../server/rng');

const sq = (name) => SQUARES.findIndex((s) => s.name === name);

function makeGame(n = 3, { startMoney = 1500 } = {}) {
  let time = 1_000_000;
  const players = Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Spieler ${i + 1}`, color: '#000', figure: '🎩' }));
  const g = new MonopolyGame({ players, startMoney, rng: createRng('test'), now: () => time });
  g.advanceClock = (ms) => { time += ms; };
  return g;
}

const P = (g, id) => g.player(id);
function own(g, pid, ...names) { names.forEach((n) => { g.props[sq(n)].owner = pid; }); }

/** Macht `pid` zum aktuellen Spieler, der gleich würfelt. */
function turnOf(g, pid, position) {
  g.currentIndex = g.players.findIndex((p) => p.id === pid);
  g.startTurn();
  if (position !== undefined) P(g, pid).position = position;
}

/** Zug ist abgewickelt: Spieler beendet ihn selbst, danach ist `next` dran. */
function finishTurn(g, pid, next) {
  assert.equal(g.phase, 'end', 'Zug wartet auf „Zug beenden“');
  assert.equal(g.currentPlayer().id, pid);
  g.endTurn(pid);
  assert.equal(g.currentPlayer().id, next);
}

function rollWith(g, pid, d1, d2) {
  g.forcedDice.push([d1, d2]);
  g.roll(pid);
}

/* ---------------- Grundlagen ---------------- */

test('Brett: 40 Felder, 22 Straßen, 4 Bahnhöfe, 2 Werke, 16+16 Karten', () => {
  assert.equal(SQUARES.length, 40);
  assert.equal(SQUARES.filter((s) => s.type === 'street').length, 22);
  assert.equal(SQUARES.filter((s) => s.type === 'railroad').length, 4);
  assert.equal(SQUARES.filter((s) => s.type === 'utility').length, 2);
  assert.equal(CHANCE_CARDS.length, 16);
  assert.equal(COMMUNITY_CARDS.length, 16);
  assert.equal(SQUARES[39].name, 'Schlossallee');
  assert.equal(SQUARES[4].amount, 200);
  assert.equal(SQUARES[38].amount, 100);
});

test('Würfelsumme → Minispiel', () => {
  const expected = { 2: 'blackjack', 3: null, 4: null, 5: null, 6: 'blackjack', 7: 'horserace', 8: 'roulette', 9: null, 10: null, 11: null, 12: 'roulette' };
  for (const [sum, game] of Object.entries(expected)) assert.equal(minigameForSum(Number(sum)), game, `Summe ${sum}`);
});

test('Los: 200 M beim Überqueren und beim Betreten', () => {
  const g = makeGame();
  turnOf(g, 'p1', 36);
  rollWith(g, 'p1', 1, 3); // 36 → 0 (Los)
  assert.equal(P(g, 'p1').position, 0);
  assert.equal(P(g, 'p1').money, 1700);
  turnOf(g, 'p2', 37);
  rollWith(g, 'p2', 1, 2); // 37 → 40 = Los
  assert.equal(P(g, 'p2').money, 1700);
  turnOf(g, 'p3', 38);
  rollWith(g, 'p3', 1, 4); // 38 → 3 (Turmstraße, über Los)
  assert.equal(P(g, 'p3').position, 3);
  assert.equal(P(g, 'p3').money, 1700);
});

/* ---------------- Kaufen & Miete ---------------- */

test('Kaufen: freies Grundstück kaufen, Miete wird automatisch abgebucht', () => {
  const g = makeGame();
  rollWith(g, 'p1', 1, 2); // → Turmstraße
  assert.equal(g.phase, 'buy');
  assert.equal(g.turn.buyOffer, sq('Turmstraße'));
  g.buy('p1');
  assert.equal(g.props[sq('Turmstraße')].owner, 'p1');
  assert.equal(P(g, 'p1').money, 1440);
  finishTurn(g, 'p1', 'p2');
  rollWith(g, 'p2', 2, 1);
  assert.equal(P(g, 'p2').money, 1496, 'Grundmiete 4 M');
  assert.equal(P(g, 'p1').money, 1444);
  finishTurn(g, 'p2', 'p3');
});

test('Miete: doppelte Grundmiete bei kompletter Farbgruppe, dann Häuser/Hotel', () => {
  const g = makeGame();
  own(g, 'p1', 'Badstraße', 'Turmstraße');
  const t = sq('Turmstraße');
  assert.equal(g.rentFor(t, 7), 8, 'Farbgruppe komplett, keine Häuser → doppelt');
  g.props[t].houses = 1;
  assert.equal(g.rentFor(t, 7), 20);
  g.props[t].houses = 4;
  assert.equal(g.rentFor(t, 7), 320);
  g.props[t].houses = 5;
  assert.equal(g.rentFor(t, 7), 450, 'Hotel');
  g.props[t].houses = 0;
  g.props[sq('Badstraße')].owner = 'p2';
  assert.equal(g.rentFor(t, 7), 4, 'unvollständige Gruppe → einfache Miete');
});

test('Miete: Bahnhöfe 25/50/100/200 M', () => {
  const g = makeGame();
  const rails = ['Südbahnhof', 'Westbahnhof', 'Nordbahnhof', 'Hauptbahnhof'];
  [25, 50, 100, 200].forEach((rent, k) => {
    own(g, 'p1', rails[k]);
    assert.equal(g.rentFor(sq('Südbahnhof'), 7), rent, `${k + 1} Bahnhöfe`);
  });
  assert.equal(g.rentFor(sq('Südbahnhof'), 7, { railroadMultiplier: 2 }), 400, 'Ereigniskarte: doppelte Miete');
});

test('Miete: Werke 4× bzw. 10× Augenzahl', () => {
  const g = makeGame();
  own(g, 'p1', 'Elektrizitätswerk');
  assert.equal(g.rentFor(sq('Elektrizitätswerk'), 9), 36);
  own(g, 'p1', 'Wasserwerk');
  assert.equal(g.rentFor(sq('Elektrizitätswerk'), 9), 90);
  // Im Spielablauf: p2 landet mit 3+4=7 auf dem Wasserwerk (21 + 7 = 28)
  turnOf(g, 'p2', 21);
  rollWith(g, 'p2', 3, 4);
  assert.equal(P(g, 'p2').money, 1500 - 70);
  assert.equal(P(g, 'p1').money, 1500 + 70);
});

test('Miete: keine Miete bei Hypothek', () => {
  const g = makeGame();
  own(g, 'p1', 'Turmstraße');
  g.props[sq('Turmstraße')].mortgaged = true;
  turnOf(g, 'p2', 0);
  rollWith(g, 'p2', 1, 2);
  assert.equal(P(g, 'p2').money, 1500);
  assert.equal(P(g, 'p1').money, 1500);
});

test('Steuern: Einkommensteuer 200 M, Zusatzsteuer 100 M, Frei Parken ohne Geld', () => {
  const g = makeGame();
  rollWith(g, 'p1', 1, 3); // → 4
  assert.equal(P(g, 'p1').money, 1300);
  turnOf(g, 'p2', 35);
  rollWith(g, 'p2', 1, 2); // → 38
  assert.equal(P(g, 'p2').money, 1400);
  turnOf(g, 'p3', 16);
  rollWith(g, 'p3', 1, 3); // → 20
  assert.equal(P(g, 'p3').money, 1500);
});

/* ---------------- Bauen ---------------- */

test('Bauen: nur mit kompletter Farbgruppe ohne Hypothek und gleichmäßig', () => {
  const g = makeGame();
  own(g, 'p1', 'Badstraße');
  assert.throws(() => g.buildHouse('p1', sq('Badstraße')), /kompletten Farbgruppe/);
  own(g, 'p1', 'Turmstraße');
  g.props[sq('Turmstraße')].mortgaged = true;
  assert.throws(() => g.buildHouse('p1', sq('Badstraße')), /Hypothek/);
  g.props[sq('Turmstraße')].mortgaged = false;

  g.buildHouse('p1', sq('Badstraße'));
  assert.throws(() => g.buildHouse('p1', sq('Badstraße')), /Gleichmäßig/);
  g.buildHouse('p1', sq('Turmstraße'));
  g.buildHouse('p1', sq('Badstraße'));
  assert.equal(P(g, 'p1').money, 1500 - 3 * 50);
  assert.equal(g.bank.houses, BANK_HOUSES - 3);

  // bis zum Hotel
  for (let k = 0; k < 5; k++) {
    if (g.props[sq('Turmstraße')].houses < 4) g.buildHouse('p1', sq('Turmstraße'));
    if (g.props[sq('Badstraße')].houses < 4) g.buildHouse('p1', sq('Badstraße'));
  }
  assert.equal(g.props[sq('Badstraße')].houses, 4);
  g.buildHouse('p1', sq('Badstraße'));
  assert.equal(g.props[sq('Badstraße')].houses, 5, 'Hotel');
  assert.equal(g.bank.hotels, 11);
  assert.equal(g.bank.houses, BANK_HOUSES - 4, '4 Häuser gehen beim Hotel an die Bank zurück');
  assert.throws(() => g.buildHouse('p1', sq('Badstraße')), /schon ein Hotel/);
  assert.throws(() => g.buildHouse('p2', sq('Turmstraße')), /gehört dir nicht/);
});

test('Bauen: Häuserlimit der Bank (32 Häuser, 12 Hotels)', () => {
  const g = makeGame();
  own(g, 'p1', 'Badstraße', 'Turmstraße');
  g.bank.houses = 1;
  g.buildHouse('p1', sq('Badstraße'));
  assert.throws(() => g.buildHouse('p1', sq('Turmstraße')), /keine Häuser mehr/);
  g.bank.houses = 32;
  g.props[sq('Badstraße')].houses = 4;
  g.props[sq('Turmstraße')].houses = 4;
  g.bank.hotels = 0;
  assert.throws(() => g.buildHouse('p1', sq('Badstraße')), /keine Hotels mehr/);
});

test('Bauen: Verkauf zum halben Preis, gleichmäßig', () => {
  const g = makeGame();
  own(g, 'p1', 'Parkstraße', 'Schlossallee');
  g.props[sq('Parkstraße')].houses = 2;
  g.props[sq('Schlossallee')].houses = 1;
  g.bank.houses -= 3;
  assert.throws(() => g.sellHouse('p1', sq('Schlossallee')), /Gleichmäßig/);
  g.sellHouse('p1', sq('Parkstraße'));
  assert.equal(P(g, 'p1').money, 1600, 'Haus für 200 M → 100 M zurück');
  assert.equal(g.bank.houses, BANK_HOUSES - 2);
  // Hotel verkaufen → 4 Häuser
  g.props[sq('Parkstraße')].houses = 5;
  g.props[sq('Schlossallee')].houses = 4;
  g.sellHouse('p1', sq('Parkstraße'));
  assert.equal(g.props[sq('Parkstraße')].houses, 4);
});

/* ---------------- Hypothek ---------------- */

test('Hypothek: 50 % des Kaufpreises, Ablösung 110 %, nicht mit Häusern', () => {
  const g = makeGame();
  own(g, 'p1', 'Badstraße', 'Turmstraße', 'Parkstraße');
  g.mortgage('p1', sq('Badstraße'));
  assert.equal(P(g, 'p1').money, 1530);
  assert.throws(() => g.mortgage('p1', sq('Badstraße')), /schon eine Hypothek/);
  g.unmortgage('p1', sq('Badstraße'));
  assert.equal(P(g, 'p1').money, 1530 - 33);
  g.mortgage('p1', sq('Parkstraße'));
  assert.equal(P(g, 'p1').money, 1497 + 175);
  g.unmortgage('p1', sq('Parkstraße'));
  assert.equal(P(g, 'p1').money, 1672 - 193, '175 + 10 % aufgerundet = 193');

  g.props[sq('Turmstraße')].houses = 1;
  assert.throws(() => g.mortgage('p1', sq('Badstraße')), /Häuser/);
  P(g, 'p1').money = 10;
  g.props[sq('Turmstraße')].houses = 0;
  g.mortgage('p1', sq('Turmstraße'));
  P(g, 'p1').money = 10;
  assert.throws(() => g.unmortgage('p1', sq('Turmstraße')), /Nicht genug Geld/);
});

/* ---------------- Gefängnis ---------------- */

test('Gefängnis: „Gehe ins Gefängnis“-Feld, kein Los-Geld, kein Nachwurf nach Pasch', () => {
  const g = makeGame();
  turnOf(g, 'p1', 26);
  rollWith(g, 'p1', 2, 2); // → 30, Pasch
  const p = P(g, 'p1');
  assert.equal(p.position, 10);
  assert.equal(p.inJail, true);
  assert.equal(p.money, 1500);
  finishTurn(g, 'p1', 'p2'); // trotz Pasch kein Nachwurf
});

test('Gefängnis: dritter Pasch in Folge', () => {
  const g = makeGame();
  SQUARES.forEach((_, i) => { if (g.props[i]) g.props[i].owner = 'p1'; });
  turnOf(g, 'p1', 1);
  rollWith(g, 'p1', 2, 2); // → 5 eigener Bahnhof, Pasch
  assert.equal(g.phase, 'roll', 'Pasch → nochmal würfeln');
  rollWith(g, 'p1', 5, 5); // → 15 eigener Bahnhof, Pasch
  assert.equal(g.phase, 'roll');
  rollWith(g, 'p1', 2, 2); // dritter Pasch → Gefängnis, ohne zu ziehen
  const p = P(g, 'p1');
  assert.equal(p.inJail, true);
  assert.equal(p.position, 10);
  finishTurn(g, 'p1', 'p2');
});

test('Gefängnis: 50 M zahlen oder Freikarte, dann normal würfeln', () => {
  const g = makeGame();
  const p = P(g, 'p1');
  g.sendToJail(p);
  turnOf(g, 'p1');
  assert.equal(g.phase, 'jail');
  assert.throws(() => g.roll('p1'), /Gefängnis/);
  assert.throws(() => g.useJailCard('p1'), /keine Gefängnis-Freikarte/);
  g.payJail('p1');
  assert.equal(p.money, 1450);
  assert.equal(p.inJail, false);
  assert.equal(g.phase, 'roll');

  g.sendToJail(p);
  turnOf(g, 'p1');
  p.jailCards.push('chance');
  const deckBefore = g.decks.chance.length;
  g.useJailCard('p1');
  assert.equal(p.jailCards.length, 0);
  assert.equal(g.decks.chance.length, deckBefore + 1, 'Freikarte geht zurück ins Deck');
  assert.equal(g.phase, 'roll');
});

test('Gefängnis: Pasch innerhalb von 3 Versuchen, sonst 50 M zahlen und ziehen', () => {
  const g = makeGame();
  const p = P(g, 'p1');
  g.sendToJail(p);
  turnOf(g, 'p1');
  g.forcedDice.push([1, 2]);
  g.rollInJail('p1');
  assert.equal(p.inJail, true);
  assert.equal(p.jailRolls, 1);
  finishTurn(g, 'p1', 'p2');

  turnOf(g, 'p1');
  g.forcedDice.push([3, 3]);
  g.rollInJail('p1'); // Pasch → raus, 10 + 6 = 16 (Münchner Straße)
  assert.equal(p.inJail, false);
  assert.equal(p.position, 16);
  assert.equal(g.phase, 'buy');
  g.declineBuy('p1');
  g.endAuction();
  if (g.phase === 'minigame') g.finishMinigame();
  finishTurn(g, 'p1', 'p2'); // Pasch aus dem Gefängnis gibt keinen Nachwurf

  g.sendToJail(p);
  turnOf(g, 'p1');
  for (let k = 0; k < 2; k++) {
    turnOf(g, 'p1');
    g.forcedDice.push([1, 3]);
    g.rollInJail('p1');
    assert.equal(p.inJail, true);
  }
  turnOf(g, 'p1');
  const before = p.money;
  g.forcedDice.push([2, 3]);
  g.rollInJail('p1'); // 3. Fehlversuch → 50 M und 5 ziehen
  assert.equal(p.inJail, false);
  assert.equal(p.money, before - 50);
  assert.equal(p.position, 15);
});

/* ---------------- Karten ---------------- */

test('Karten: „Gehe 3 Felder zurück“ und „Jeder Spieler schenkt dir 10 M“', () => {
  const g = makeGame();
  g.decks.chance = [CHANCE_CARDS.findIndex((c) => c.action.type === 'back'), ...g.decks.chance];
  turnOf(g, 'p1', 2);
  rollWith(g, 'p1', 2, 3); // → 7 Ereignisfeld → zurück auf 4 (Einkommensteuer)
  assert.equal(P(g, 'p1').position, 4);
  assert.equal(P(g, 'p1').money, 1300);
  assert.match(g.lastCard.text, /3 Felder zurück/);

  g.decks.community = [COMMUNITY_CARDS.findIndex((c) => c.action.type === 'collectEach'), ...g.decks.community];
  turnOf(g, 'p2', 13);
  rollWith(g, 'p2', 1, 3); // → 17 Gemeinschaftsfeld
  assert.equal(P(g, 'p2').money, 1520);
  assert.equal(P(g, 'p3').money, 1490);
});

/* ---------------- Schulden & Pleite ---------------- */

test('Schulden: erst verkaufen/Hypothek, dann automatisch bezahlen', () => {
  const g = makeGame();
  own(g, 'p1', 'Schlossallee', 'Parkstraße');
  g.props[sq('Schlossallee')].houses = 1; // Miete 200
  own(g, 'p2', 'Badstraße', 'Turmstraße');
  turnOf(g, 'p2', 33);
  P(g, 'p2').money = 150;
  rollWith(g, 'p2', 2, 4); // → 39, Summe 6 = Blackjack
  assert.equal(g.phase, 'debt');
  assert.deepEqual(g.publicState().debts[0], { debtorId: 'p2', creditorId: 'p1', amount: 200, reason: 'Miete für Schlossallee' });
  assert.throws(() => g.roll('p2'), /Jetzt wird nicht gewürfelt/);
  g.mortgage('p2', sq('Badstraße')); // +30 → 180
  assert.equal(g.phase, 'debt');
  g.mortgage('p2', sq('Turmstraße')); // +30 → 210 → zahlt automatisch
  assert.equal(P(g, 'p2').money, 10);
  assert.equal(P(g, 'p1').money, 1700);
  assert.equal(g.phase, 'minigame', 'danach geht der Zug normal weiter');
});

test('Pleite an Spieler: Geld, Grundstücke und Freikarten gehen an den Gläubiger', () => {
  const g = makeGame();
  own(g, 'p1', 'Schlossallee', 'Parkstraße');
  g.props[sq('Schlossallee')].houses = 5;
  own(g, 'p2', 'Badstraße', 'Turmstraße');
  g.props[sq('Badstraße')].houses = 1;
  g.bank.houses -= 1;
  P(g, 'p2').jailCards.push('community');
  P(g, 'p2').money = 100;
  turnOf(g, 'p2', 35);
  rollWith(g, 'p2', 1, 3); // → 39, Miete 2000
  const p2 = P(g, 'p2');
  assert.equal(p2.bankrupt, true);
  assert.equal(g.props[sq('Badstraße')].owner, 'p1');
  assert.equal(g.props[sq('Turmstraße')].owner, 'p1');
  assert.equal(g.props[sq('Badstraße')].houses, 0, 'Häuser gehen an die Bank zurück');
  assert.equal(g.bank.houses, BANK_HOUSES);
  assert.equal(P(g, 'p1').money, 1500 + 100 + 25, 'Bargeld + halber Hauspreis');
  assert.equal(P(g, 'p1').jailCards.length, 1);
  assert.equal(g.currentPlayer().id, 'p3');
});

test('Pleite an die Bank: Besitz wird versteigert; letzter Spieler gewinnt', () => {
  const g = makeGame(2);
  own(g, 'p2', 'Badstraße');
  P(g, 'p2').money = 50;
  turnOf(g, 'p2', 0);
  rollWith(g, 'p2', 1, 3); // → Einkommensteuer 200, Vermögen 50 + 30 < 200
  assert.equal(P(g, 'p2').bankrupt, true);
  assert.equal(g.phase, 'gameover');
  assert.equal(g.winner, 'p1');

  const g3 = makeGame(3);
  own(g3, 'p2', 'Badstraße', 'Südbahnhof');
  P(g3, 'p2').money = 50;
  turnOf(g3, 'p2', 0);
  rollWith(g3, 'p2', 1, 3);
  assert.equal(P(g3, 'p2').bankrupt, true);
  assert.equal(g3.phase, 'auction');
  assert.equal(g3.auction.square, sq('Badstraße'));
  assert.equal(g3.props[sq('Badstraße')].owner, null);
  g3.bid('p1', 40);
  g3.passAuction('p3');
  assert.equal(g3.props[sq('Badstraße')].owner, 'p1');
  assert.equal(g3.phase, 'auction', 'danach der Südbahnhof');
  assert.equal(g3.auction.square, sq('Südbahnhof'));
  g3.advanceClock(AUCTION_MS + 1);
  g3.auctionTimeout();
  assert.equal(g3.props[sq('Südbahnhof')].owner, null, 'ohne Gebot bleibt er bei der Bank');
  assert.equal(g3.currentPlayer().id, 'p3');
});

/* ---------------- Versteigerung ---------------- */

test('Versteigerung: Ablehnen startet Auktion, Mindestschritt 10 M, Geld wird geprüft', () => {
  const g = makeGame();
  rollWith(g, 'p1', 2, 3); // → Südbahnhof
  g.declineBuy('p1');
  assert.equal(g.phase, 'auction');
  assert.throws(() => g.bid('p2', 5), /mindestens 10 M/);
  g.bid('p2', 10);
  assert.throws(() => g.bid('p3', 15), /mindestens 20 M/);
  assert.throws(() => g.bid('p2', 30), /bereits das höchste Gebot/);
  assert.throws(() => g.bid('p3', 5000), /Nicht genug Geld/);
  g.bid('p3', 20);
  g.bid('p1', 100);
  assert.throws(() => g.passAuction('p1'), /höchste Gebot/);
  g.passAuction('p2');
  assert.throws(() => g.bid('p2', 200), /ausgestiegen/);
  assert.equal(g.phase, 'auction');
  g.passAuction('p3');
  assert.equal(g.props[sq('Südbahnhof')].owner, 'p1');
  assert.equal(P(g, 'p1').money, 1400);
  finishTurn(g, 'p1', 'p2');
});

test('Versteigerung: Timer beendet die Auktion, Gebote verlängern', () => {
  const g = makeGame();
  rollWith(g, 'p1', 2, 3);
  g.declineBuy('p1');
  g.advanceClock(AUCTION_MS - 1000);
  g.bid('p3', 50);
  g.advanceClock(1500);
  g.auctionTimeout();
  assert.equal(g.phase, 'auction', 'Gebot hat die Zeit verlängert');
  g.advanceClock(AUCTION_EXTEND_MS);
  g.auctionTimeout();
  assert.equal(g.props[sq('Südbahnhof')].owner, 'p3');
  assert.equal(P(g, 'p3').money, 1450);
});

/* ---------------- Ablauf, Minispiele, Rechte ---------------- */

test('Ablauf: Feld abwickeln → Minispiel → Pasch-Nachwurf → nächster Spieler', () => {
  const g = makeGame();
  rollWith(g, 'p1', 4, 4); // → 8 Elisenstraße, Summe 8 = Roulette, Pasch
  assert.equal(g.phase, 'buy');
  g.buy('p1');
  assert.equal(g.phase, 'minigame');
  assert.equal(g.minigame.type, 'roulette');
  assert.throws(() => g.buildHouse('p1', 8), /Minispiel/);
  assert.throws(() => g.proposeTrade('p1', { toId: 'p2', give: { money: 10 } }), /Minispiel/);
  g.finishMinigame();
  assert.equal(g.phase, 'roll');
  assert.equal(g.currentPlayer().id, 'p1');
  rollWith(g, 'p1', 1, 2); // → 11 Seestraße
  g.declineBuy('p1');
  g.endAuction();
  finishTurn(g, 'p1', 'p2');
});

test('Zug beenden: erst wenn alles erledigt ist, nur durch den Spieler am Zug', () => {
  const g = makeGame();
  own(g, 'p1', 'Badstraße', 'Turmstraße');
  assert.throws(() => g.endTurn('p1'), /erst beenden, wenn alles erledigt/);
  rollWith(g, 'p1', 2, 3); // → Südbahnhof
  assert.throws(() => g.endTurn('p1'), /erst beenden/, 'Kaufentscheidung steht noch aus');
  g.buy('p1');
  assert.equal(g.phase, 'end');
  assert.throws(() => g.endTurn('p2'), /nicht am Zug/);
  g.buildHouse('p1', sq('Badstraße')); // vor dem Beenden noch bauen
  assert.equal(g.props[sq('Badstraße')].houses, 1);
  assert.equal(g.phase, 'end');
  g.endTurn('p1');
  assert.equal(g.currentPlayer().id, 'p2');
  assert.equal(g.phase, 'roll');
});

test('Rechte: wer nicht dran ist oder zu wenig Geld hat, wird abgelehnt', () => {
  const g = makeGame();
  assert.throws(() => g.roll('p2'), /nicht am Zug/);
  rollWith(g, 'p1', 6, 5); // → 11 Seestraße (140)
  assert.throws(() => g.buy('p2'), /nicht am Zug – gerade ist Spieler 1 dran/);
  P(g, 'p1').money = 100;
  assert.throws(() => g.buy('p1'), /Nicht genug Geld: Seestraße kostet 140 M, du hast nur 100 M/);
  assert.equal(g.phase, 'buy');
});

test('Handel: Straßen, Geld und Freikarten tauschen', () => {
  const g = makeGame();
  own(g, 'p1', 'Badstraße');
  own(g, 'p2', 'Turmstraße', 'Parkstraße');
  P(g, 'p2').jailCards.push('chance');
  assert.throws(() => g.proposeTrade('p1', { toId: 'p2', give: { props: [sq('Turmstraße')] } }), /gehört nicht dir/);
  assert.throws(() => g.proposeTrade('p1', { toId: 'p2', give: { money: 99999 } }), /nicht genug Geld/);
  const t = g.proposeTrade('p1', { toId: 'p2', give: { props: [sq('Badstraße')], money: 100 }, want: { props: [sq('Turmstraße')], jailCards: 1 } });
  assert.throws(() => g.respondTrade('p3', t.id, true), /nicht an dich/);
  g.respondTrade('p2', t.id, true);
  assert.equal(g.props[sq('Badstraße')].owner, 'p2');
  assert.equal(g.props[sq('Turmstraße')].owner, 'p1');
  assert.equal(P(g, 'p1').money, 1400);
  assert.equal(P(g, 'p2').money, 1600);
  assert.equal(P(g, 'p1').jailCards.length, 1);

  // Grundstücke mit Häusern in der Farbgruppe sind nicht handelbar
  own(g, 'p2', 'Schlossallee');
  g.props[sq('Schlossallee')].houses = 1;
  assert.throws(() => g.proposeTrade('p2', { toId: 'p1', give: { props: [sq('Parkstraße')] } }), /Häuser/);
  const t2 = g.proposeTrade('p1', { toId: 'p3', give: { money: 10 } });
  g.respondTrade('p3', t2.id, false);
  assert.equal(g.trades.length, 0);
});
