'use strict';

/* =========================================================
 *  Poker: gemeinsame Anzeige für Fernseher und Handy – Euro-Beträge
 *  (intern Cent), flache Spielkarten und Sitzmarken. Nur Darstellung.
 * ========================================================= */

/** 1250 → „12,50 €“ (wie server/games/poker/money.js) */
function pkEuro(cents) {
  const n = Math.round(Number(cents) || 0);
  const abs = Math.abs(n);
  const euros = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${n < 0 ? '−' : ''}${euros},${String(abs % 100).padStart(2, '0')} €`;
}

/** „12,50“, „12.5“, „12“ → Cent; sonst null. */
function pkParseEuro(text) {
  const m = String(text ?? '').trim().replace(/\s*€$/, '').match(/^(\d{1,9})(?:[.,](\d{1,2}))?$/);
  return m ? Number(m[1]) * 100 + (m[2] ? Number(m[2].padEnd(2, '0')) : 0) : null;
}

/** Betrag für Eingabefelder: 1250 → „12,50“ */
const pkEuroPlain = (cents) => pkEuro(cents).replace(' €', '').replace(/\./g, '');

const PK_SUITS = { s: '♠', h: '♥', d: '♦', c: '♣' };
const PK_SUIT_NAMES = { s: 'Pik', h: 'Herz', d: 'Karo', c: 'Kreuz' };
const PK_RANKS = { T: '10', J: 'B', Q: 'D', K: 'K', A: 'A' };
const PK_RANK_NAMES = { T: 'Zehn', J: 'Bube', Q: 'Dame', K: 'König', A: 'Ass', 2: 'Zwei', 3: 'Drei', 4: 'Vier', 5: 'Fünf', 6: 'Sechs', 7: 'Sieben', 8: 'Acht', 9: 'Neun' };

/** Offene Karte ('Ah') oder Rückseite (null). Vier Farben: Pik schwarz, Herz rot, Karo blau, Kreuz grün. */
function pkCardHtml(card, cls = '') {
  if (!card) return `<span class="pk-card back ${cls}" aria-label="verdeckte Karte"></span>`;
  const r = PK_RANKS[card[0]] || card[0];
  const s = card[1];
  return `<span class="pk-card s-${s} ${cls}" data-card="${card}" aria-label="${PK_SUIT_NAMES[s]} ${PK_RANK_NAMES[card[0]]}">`
    + `<span class="pk-r">${r}</span><span class="pk-s">${PK_SUITS[s]}</span><span class="pk-big">${PK_SUITS[s]}</span></span>`;
}

/** Leerer Kartenplatz (z. B. für Turn und River vor dem Aufdecken). */
const pkSlotHtml = (cls = '') => `<span class="pk-card slot ${cls}"></span>`;

/** „Anna“, „Anna und Ben“, „Anna, Ben und Cem“ (Namen schon maskiert) */
function pkNames(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`;
}

/** Sitzmarke: Nummer auf der Spielerfarbe – die Farbe ist nie der einzige Unterschied. */
function pkSeatHtml(p, cls = '') {
  return `<span class="pk-seat ${cls}" style="--c:${p.color};--ink:${lbInkOn(p.color)}" aria-label="Platz ${p.seat}">${p.seat}</span>`;
}
