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

/**
 * Offene Karte ('Ah') oder Rückseite (null). Echte Proportionen (5:7), Ecken mit Rang und Farbe
 * oben links und unten rechts (gedreht), großes Farbsymbol in der Mitte; Bildkarten (B, D, K) rein
 * typografisch mit feinem Rahmen. Vier Farben: Pik schwarz, Herz rot, Karo blau, Kreuz grün.
 * cls 'mini' (kleine Karten am Platz): nur die obere Ecke und das Mittelsymbol.
 */
function pkCardHtml(card, cls = '') {
  if (!card) return `<span class="pk-card back ${cls}" aria-label="verdeckte Karte"><span class="pk-back"></span></span>`;
  const r = PK_RANKS[card[0]] || card[0];
  const s = card[1];
  const suit = PK_SUITS[s];
  const face = 'JQK'.includes(card[0]);
  const index = (pos) => `<span class="pk-ix ${pos}"><b>${r}</b><i>${suit}</i></span>`;
  const mid = face
    ? `<span class="pk-face"><b>${r}</b><i>${suit}</i></span>`
    : `<span class="pk-pip ${card[0] === 'A' ? 'ace' : ''}">${suit}</span>`;
  return `<span class="pk-card s-${s} ${face ? 'is-face' : ''} ${cls}" data-card="${card}" aria-label="${PK_SUIT_NAMES[s]} ${PK_RANK_NAMES[card[0]]}">`
    + `${index('tl')}${mid}${index('br')}</span>`;
}

/* ---------------- Chips ---------------- */

/** Chipwerte in Cent mit festen, gedeckten Farben (Fläche, Kante, Schrift). */
const PK_CHIPS = [
  { v: 50000, label: '500', fill: '#c2a24b', edge: '#8a6f2c', ink: '#2b2209' },
  { v: 10000, label: '100', fill: '#6b4f8c', edge: '#47335f', ink: '#f4eff8' },
  { v: 2500, label: '25', fill: '#2e3134', edge: '#141618', ink: '#f2f2f0' },
  { v: 500, label: '5', fill: '#3f8a5c', edge: '#2a5f3e', ink: '#f2f7f3' },
  { v: 100, label: '1', fill: '#3d6ea6', edge: '#284b73', ink: '#f1f5fa' },
  { v: 50, label: '0,50', fill: '#b5473e', edge: '#7e2f29', ink: '#fbf1ef' },
  { v: 10, label: '0,10', fill: '#ece7dc', edge: '#b9b1a1', ink: '#3a352c' },
  { v: 5, label: '0,05', fill: '#d79a6b', edge: '#a26c45', ink: '#33220f' },
  { v: 1, label: '0,01', fill: '#a9b0b5', edge: '#767d82', ink: '#1f2326' },
];

/** Betrag in Chips zerlegen (gierig, größte Werte zuerst): [{ chip, count }]. */
function pkChipBreakdown(cents) {
  let rest = Math.max(0, Math.round(cents));
  const out = [];
  for (const chip of PK_CHIPS) {
    const count = Math.floor(rest / chip.v);
    if (count) { out.push({ chip, count }); rest -= count * chip.v; }
  }
  return out;
}

/**
 * Chipstapel als flache Seitenansicht (SVG): je Wert ein Stapel, höchstens maxStacks Stapel
 * (die größten Werte) und maxChips Chips je Stapel. Jeder Chip hat Randkerben als feine Linien,
 * der oberste trägt seinen Wert.
 */
function pkChipStacksSvg(cents, { maxStacks = 4, maxChips = 6, unit = 1.5, cls = '' } = {}) {
  const stacks = pkChipBreakdown(cents).slice(0, maxStacks);
  if (!stacks.length) return '';
  const w = 20; const h = 4.2; const gap = 3; const top = 7;
  const tallest = Math.min(maxChips, Math.max(...stacks.map((x) => x.count)));
  const width = stacks.length * w + (stacks.length - 1) * gap + 2;
  const height = tallest * h + top + 2;
  let body = '';
  stacks.forEach(({ chip, count }, k) => {
    const x = 1 + k * (w + gap);
    const n = Math.min(count, maxChips);
    for (let i = 0; i < n; i++) {
      const y = height - 1 - (i + 1) * h - top / 2;
      body += `<rect x="${x}" y="${y.toFixed(1)}" width="${w}" height="${h}" rx="1.6" fill="${chip.fill}" stroke="${chip.edge}" stroke-width=".6"/>`;
      // Randkerben: kurze helle Striche auf der Kante
      for (const nx of [3.5, 9, 14.5]) body += `<rect x="${x + nx}" y="${(y + 0.7).toFixed(1)}" width="2" height="${(h - 1.4).toFixed(1)}" fill="#fbfaf6" opacity=".78"/>`;
    }
    // Oberseite des obersten Chips mit Wert
    const ty = height - 1 - n * h - top / 2;
    body += `<ellipse cx="${x + w / 2}" cy="${ty.toFixed(1)}" rx="${w / 2}" ry="${top / 2}" fill="${chip.fill}" stroke="${chip.edge}" stroke-width=".6"/>`
      + `<ellipse cx="${x + w / 2}" cy="${ty.toFixed(1)}" rx="${w / 2 - 3}" ry="${top / 2 - 1}" fill="none" stroke="#fbfaf6" stroke-width=".5" stroke-dasharray="2 1.6" opacity=".8"/>`
      + `<text x="${x + w / 2}" y="${(ty + 1.5).toFixed(1)}" text-anchor="middle" font-size="${chip.label.length > 3 ? 3.6 : 4.4}" font-weight="700" fill="${chip.ink}">${chip.label}</text>`;
  });
  // Feste Chipbreite (unit in em je Chip), die Höhe folgt aus dem höchsten Stapel
  const em = (x) => ((x / w) * unit).toFixed(3);
  return `<svg class="pk-chips ${cls}" viewBox="0 0 ${width} ${height}" style="width:${em(width)}em;height:${em(height)}em" aria-hidden="true">${body}</svg>`;
}

/** Ein einzelner Chip von oben (für fliegende Chips). */
function pkChipTopSvg(chip) {
  return `<svg class="pk-chip-top" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9.4" fill="${chip.fill}" stroke="${chip.edge}" stroke-width=".8"/>`
    + `<circle cx="10" cy="10" r="9.4" fill="none" stroke="#fbfaf6" stroke-width="2.2" stroke-dasharray="3 4.4" opacity=".8"/>`
    + `<circle cx="10" cy="10" r="5.6" fill="none" stroke="${chip.edge}" stroke-width=".6"/></svg>`;
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
