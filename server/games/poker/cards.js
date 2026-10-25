'use strict';

/* =========================================================
 *  Poker: Karten und Mischen. Eine Karte ist ein kurzer Text aus Rang
 *  und Farbe, z. B. 'As' (Pik-Ass), 'Td' (Karo-Zehn), '7h', '2c'.
 *  Gemischt wird nur mit dem Zufallsgenerator des Servers (server/rng.js).
 * ========================================================= */

const RANKS = '23456789TJQKA';
/** s = Pik, h = Herz, d = Karo, c = Kreuz */
const SUITS = 'shdc';
const SUIT_NAMES = { s: 'Pik', h: 'Herz', d: 'Karo', c: 'Kreuz' };

const rankValue = (card) => RANKS.indexOf(card[0]) + 2;
const suitOf = (card) => card[1];
const isCard = (card) => typeof card === 'string' && card.length === 2 && RANKS.includes(card[0]) && SUITS.includes(card[1]);

/** Alle 52 Karten in fester Reihenfolge. */
function freshDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

/** Neu gemischter Stapel (Fisher-Yates über server/rng.js). */
function shuffledDeck(rng) {
  return rng.shuffle(freshDeck());
}

module.exports = { RANKS, SUITS, SUIT_NAMES, rankValue, suitOf, isCard, freshDeck, shuffledDeck };
