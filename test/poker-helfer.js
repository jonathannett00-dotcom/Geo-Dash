'use strict';

/*
 * Helfer für die Poker-Tests: gezinkter Zufall (fester Button, vorgegebene Karten)
 * und Tische mit beliebigen Guthaben.
 */

const { PokerGame } = require('../server/games/poker/rules');
const { freshDeck } = require('../server/games/poker/cards');

const names = ['Anna', 'Ben', 'Cem', 'Dana', 'Eli', 'Finn', 'Gina', 'Hugo', 'Ida', 'Jan', 'Kai', 'Lea', 'Mia'];
const seats = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: names[i], color: '#888888' }));

/**
 * Stapel für eine Runde: holes[i] sind die Karten des i-ten Spielers in Austeilreihenfolge
 * (ab links vom Dealer), board die fünf Gemeinschaftskarten. Brennkarten und Rest werden aufgefüllt.
 */
function deckFor(holes, board = []) {
  const used = new Set([...holes.flat(), ...board]);
  const rest = freshDeck().filter((c) => !used.has(c));
  const deck = [...holes.map((h) => h[0]), ...holes.map((h) => h[1])];
  const b = board.slice();
  if (b.length) deck.push(rest.shift(), ...b.splice(0, 3));
  if (b.length) deck.push(rest.shift(), b.shift());
  if (b.length) deck.push(rest.shift(), b.shift());
  return [...deck, ...rest];
}

/** Zufall mit festem Button (Index `button`) und vorgegebenen Stapeln je Runde. */
function riggedRng({ button = 0, decks = [] } = {}) {
  const queue = decks.slice();
  return {
    next: () => 0.5,
    int: () => button,
    range: (lo) => lo,
    pick: (arr) => arr[0],
    shuffle: (arr) => (queue.length ? queue.shift() : arr.slice()),
  };
}

/** Tisch ohne laufende Runde; stacks in Cent (optional je Spieler). */
function table(n, { stacks, settings = {}, button = 0, decks = [] } = {}) {
  const g = new PokerGame({ players: seats(n), settings, rng: riggedRng({ button, decks }) });
  if (stacks) stacks.forEach((s, i) => { g.players[i].stack = s; });
  return g;
}

const P = (g, i) => g.players[i];
const act = (g, i, type, extra = {}) => g.handleAction(`p${i}`, { type, ...extra });

/** Alle Kartenkürzel (z. B. 'As') in einem beliebigen Objekt. */
function cardsIn(obj, out = new Set()) {
  if (typeof obj === 'string') { if (/^[2-9TJQKA][shdc]$/.test(obj)) out.add(obj); return out; }
  if (Array.isArray(obj)) { obj.forEach((x) => cardsIn(x, out)); return out; }
  if (obj && typeof obj === 'object') Object.values(obj).forEach((x) => cardsIn(x, out));
  return out;
}

module.exports = { seats, deckFor, riggedRng, table, P, act, cardsIn };
