'use strict';

/* =========================================================
 *  Poker: Pot und Side-Pots. Beträge sind ganze Cent.
 *
 *  Aus den Einsätzen einer Runde (je Spieler die Summe, ob gefoldet)
 *  entstehen Schichten an den All-in-Grenzen der noch beteiligten
 *  Spieler. Jede Schicht ist ein Pot, um den genau die Spieler spielen,
 *  die mindestens bis zu dieser Grenze gesetzt haben. Was ein Spieler
 *  mehr gesetzt hat, als irgendein anderer gehen konnte, bekommt er
 *  zurück (nicht gecallter Einsatz).
 * ========================================================= */

/**
 * Nicht gecallter Einsatz: Der höchste Einsatz über dem zweithöchsten
 * (auch gefoldete Einsätze zählen) geht zurück. Liefert { id, amount } oder null.
 */
function uncalled(entries) {
  const sorted = entries.filter((e) => e.amount > 0).sort((a, b) => b.amount - a.amount);
  if (!sorted.length) return null;
  const second = sorted[1] ? sorted[1].amount : 0;
  const diff = sorted[0].amount - second;
  return diff > 0 ? { id: sorted[0].id, amount: diff } : null;
}

/**
 * Pots aus den Einsätzen. entries: [{ id, amount, folded }] in Sitzreihenfolge.
 * Ergebnis: [{ amount, eligible: [ids] }] – zuerst der Hauptpot, dann die Side-Pots.
 * Nicht gecallte Einsätze müssen vorher mit uncalled() abgezogen sein.
 */
function buildPots(entries) {
  const live = entries.filter((e) => !e.folded && e.amount > 0);
  const levels = [...new Set(live.map((e) => e.amount))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const e of entries) amount += Math.max(0, Math.min(e.amount, level) - prev);
    const eligible = live.filter((e) => e.amount >= level).map((e) => e.id);
    if (amount > 0) {
      const last = pots[pots.length - 1];
      // Gleiche Berechtigte (z. B. nach Folds) bilden einen gemeinsamen Pot
      if (last && last.eligible.join() === eligible.join()) last.amount += amount;
      else pots.push({ amount, eligible });
    }
    prev = level;
  }
  // Gefoldete Einsätze über der höchsten Grenze (kommt praktisch nicht vor) gehören zum letzten Pot
  const extra = entries.reduce((s, e) => s + Math.max(0, e.amount - prev), 0);
  if (extra && pots.length) pots[pots.length - 1].amount += extra;
  return pots;
}

/**
 * Teilt einen Pot gleichmäßig. winners in Sitzreihenfolge ab dem Spieler links vom Dealer:
 * Übrige Cent gehen einzeln reihum, beginnend beim ersten (dem nächsten links vom Dealer).
 */
function splitPot(amount, winners) {
  const k = winners.length;
  const base = Math.floor(amount / k);
  let rest = amount - base * k;
  return winners.map((id) => {
    const extra = rest > 0 ? 1 : 0;
    rest -= extra;
    return { id, amount: base + extra };
  });
}

module.exports = { uncalled, buildPots, splitPot };
