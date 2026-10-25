'use strict';

/* =========================================================
 *  Poker: Handbewertung (eigene Umsetzung, keine Bibliothek).
 *  Aus bis zu sieben Karten wird die beste Fünf-Karten-Hand gesucht.
 *  Die Wertung ist eine Zahlenliste [Kategorie, Ränge …], die
 *  lexikografisch verglichen wird – damit sind Kicker und Gleichstände
 *  exakt abgebildet. Kategorien: 0 Höchste Karte … 9 Royal Flush.
 * ========================================================= */

const { rankValue, suitOf } = require('./cards');

const CATEGORY_NAMES = [
  'Höchste Karte', 'Ein Paar', 'Zwei Paare', 'Drilling', 'Straße',
  'Flush', 'Full House', 'Vierling', 'Straight Flush', 'Royal Flush',
];

const RANK_ONE = { 2: 'Zwei', 3: 'Drei', 4: 'Vier', 5: 'Fünf', 6: 'Sechs', 7: 'Sieben', 8: 'Acht', 9: 'Neun', 10: 'Zehn', 11: 'Bube', 12: 'Dame', 13: 'König', 14: 'Ass' };
const RANK_MANY = { 2: 'Zweien', 3: 'Dreien', 4: 'Vieren', 5: 'Fünfen', 6: 'Sechsen', 7: 'Siebenen', 8: 'Achten', 9: 'Neunen', 10: 'Zehnen', 11: 'Buben', 12: 'Damen', 13: 'Könige', 14: 'Asse' };
/** „bis zur Zehn“, aber „bis zum Buben / König / Ass“. */
const RANK_UPTO = (v) => (v === 11 ? 'zum Buben' : v === 13 ? 'zum König' : v === 14 ? 'zum Ass' : `zur ${RANK_ONE[v]}`);

/** Wertung einer Hand aus genau fünf Karten. */
function score5(cards) {
  const vals = cards.map(rankValue).sort((a, b) => b - a);
  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]));
  const distinct = [...new Set(vals)];
  let straightHigh = 0;
  if (distinct.length === 5) {
    if (vals[0] - vals[4] === 4) straightHigh = vals[0];
    else if (vals[0] === 14 && vals[1] === 5) straightHigh = 5;   // A-2-3-4-5 („Wheel“)
  }
  const counts = {};
  for (const v of vals) counts[v] = (counts[v] || 0) + 1;
  const groups = Object.entries(counts).map(([v, c]) => ({ v: Number(v), c }))
    .sort((a, b) => b.c - a.c || b.v - a.v);
  const g = groups.map((x) => x.v);

  if (straightHigh && flush) return straightHigh === 14 ? [9, 14] : [8, straightHigh];
  if (groups[0].c === 4) return [7, ...g];
  if (groups[0].c === 3 && groups[1].c === 2) return [6, ...g];
  if (flush) return [5, ...vals];
  if (straightHigh) return [4, straightHigh];
  if (groups[0].c === 3) return [3, ...g];
  if (groups[0].c === 2 && groups[1].c === 2) return [2, ...g];
  if (groups[0].c === 2) return [1, ...g];
  return [0, ...vals];
}

/** Vergleich zweier Wertungen: > 0, wenn a besser ist; 0 bei Gleichstand. */
function compareScores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Lesbarer Name, z. B. „Full House, Damen über Achten“. */
function describe(score) {
  const [cat, a, b] = score;
  switch (cat) {
    case 9: return 'Royal Flush';
    case 8: return `Straight Flush bis ${RANK_UPTO(a)}`;
    case 7: return `Vierling, ${RANK_MANY[a]}`;
    case 6: return `Full House, ${RANK_MANY[a]} über ${RANK_MANY[b]}`;
    case 5: return `Flush, ${RANK_ONE[a]} hoch`;
    case 4: return `Straße bis ${RANK_UPTO(a)}`;
    case 3: return `Drilling, ${RANK_MANY[a]}`;
    case 2: return `Zwei Paare, ${RANK_MANY[a]} und ${RANK_MANY[b]}`;
    case 1: return `Ein Paar, ${RANK_MANY[a]}`;
    default: return `Höchste Karte, ${RANK_ONE[a]}`;
  }
}

/** Alle Teilmengen mit k Elementen. */
function combinations(list, k) {
  const out = [];
  const pick = (start, acc) => {
    if (acc.length === k) { out.push(acc.slice()); return; }
    for (let i = start; i <= list.length - (k - acc.length); i++) { acc.push(list[i]); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  return out;
}

/**
 * Beste Hand aus fünf bis sieben Karten:
 * { score, category, name, label, cards } – cards sind die fünf gewerteten Karten.
 */
function bestHand(cards) {
  if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7) throw new Error('bestHand braucht 5 bis 7 Karten');
  let best = null;
  for (const five of combinations(cards, 5)) {
    const score = score5(five);
    if (!best || compareScores(score, best.score) > 0) best = { score, cards: five };
  }
  const category = best.score[0];
  return { score: best.score, category, name: CATEGORY_NAMES[category], label: describe(best.score), cards: best.cards };
}

module.exports = { CATEGORY_NAMES, RANK_ONE, RANK_MANY, score5, compareScores, describe, bestHand, combinations };
