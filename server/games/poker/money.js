'use strict';

/* =========================================================
 *  Poker: Geld in Euro, intern immer als ganze Cent.
 *  Anzeige „12,50 €“, Eingabe mit Komma oder Punkt (höchstens zwei
 *  Nachkommastellen), ohne Tausenderpunkte.
 * ========================================================= */

/** 1250 → „12,50 €“, 123456 → „1.234,56 €“ */
function formatEuro(cents) {
  const n = Math.round(Number(cents) || 0);
  const sign = n < 0 ? '−' : '';
  const abs = Math.abs(n);
  const euros = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${euros},${String(abs % 100).padStart(2, '0')} €`;
}

/**
 * „12,50“, „12.5“, „12“, „12,50 €“ oder eine Zahl in Euro → Cent.
 * Liefert null, wenn die Eingabe kein gültiger Betrag ist.
 */
function parseEuro(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    value = String(value);
  }
  if (typeof value !== 'string') return null;
  const m = value.trim().replace(/\s*€$/, '').match(/^(\d{1,9})(?:[.,](\d{1,2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 100 + (m[2] ? Number(m[2].padEnd(2, '0')) : 0);
}

module.exports = { formatEuro, parseEuro };
