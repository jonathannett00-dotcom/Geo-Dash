'use strict';

/* =========================================================
 *  Avatare: 24 flache, rein geometrische Motive (SVG) in der
 *  Spielerfarbe mit einer zweiten Tönung, dazu „Monogramm“
 *  (erster Buchstabe des Namens) und optional ein eigenes Foto.
 *
 *  Anzeige überall mit avatarHtml(spieler, 'S' | 'M' | 'L'):
 *  runde Maske, feiner Rand in der Spielerfarbe. Fehlt das Foto
 *  oder lädt es nicht, bleibt das Motiv bzw. Monogramm stehen.
 * ========================================================= */

/** Zweite Tönung: auf dunklen Farben heller, auf hellen dunkler. */
function avTint(hex) {
  const n = parseInt(String(hex || '#777777').slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  const out = lum > 0.55 ? rgb.map((v) => Math.round(v * 0.55)) : rgb.map((v) => Math.round(v + (255 - v) * 0.5));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Zahl kurz für SVG-Koordinaten. */
const avN = (v) => String(Math.round(v * 100) / 100);

/** Stern mit k Zacken um (cx, cy). */
function avStar(cx, cy, r1, r2, k = 5, rot = -90) {
  const pts = [];
  for (let i = 0; i < k * 2; i++) {
    const r = i % 2 ? r2 : r1;
    const a = (rot + i * 180 / k) * Math.PI / 180;
    pts.push(`${avN(cx + r * Math.cos(a))},${avN(cy + r * Math.sin(a))}`);
  }
  return pts.join(' ');
}

/** Die Motive: jeweils (Farbe, Tönung) → Inhalt eines 64×64-SVG (Hintergrund in der Farbe kommt dazu). */
const AV_MOTIVE = [
  { id: 'ringe', name: 'Ringe', draw: (c, t) => `<circle cx="32" cy="32" r="24" fill="none" stroke="${t}" stroke-width="5"/><circle cx="32" cy="32" r="13" fill="none" stroke="${t}" stroke-width="5"/><circle cx="32" cy="32" r="4" fill="${t}"/>` },
  { id: 'streifen', name: 'Streifen', draw: (c, t) => `<path d="${[-48, -32, -16, 0, 16, 32, 48].map((x) => `M${x} 64L${x + 64} 0`).join('')}" stroke="${t}" stroke-width="6"/>` },
  { id: 'stern', name: 'Stern', draw: (c, t) => `<polygon points="${avStar(32, 34, 24, 10)}" fill="${t}"/>` },
  { id: 'wellen', name: 'Wellen', draw: (c, t) => `<path d="${[14, 28, 42, 56].map((y) => `M-4 ${y}q9 -8 18 0t18 0t18 0t18 0`).join('')}" fill="none" stroke="${t}" stroke-width="4.5"/>` },
  { id: 'rauten', name: 'Rauten', draw: (c, t) => [[16, 16], [48, 16], [32, 32], [16, 48], [48, 48]].map(([x, y]) => `<polygon points="${x},${y - 10} ${x + 10},${y} ${x},${y + 10} ${x - 10},${y}" fill="${t}"/>`).join('') },
  { id: 'punkte', name: 'Punkte', draw: (c, t) => [12, 26, 40, 54].flatMap((y, r) => [12, 26, 40, 54].map((x) => `<circle cx="${x + (r % 2 ? 7 : 0)}" cy="${y}" r="4" fill="${t}"/>`)).join('') },
  { id: 'schach', name: 'Schachbrett', draw: (c, t) => [0, 16, 32, 48].flatMap((y, r) => [0, 16, 32, 48].filter((x, k) => (k + r) % 2 === 0).map((x) => `<rect x="${x}" y="${y}" width="16" height="16" fill="${t}"/>`)).join('') },
  { id: 'halbkreis', name: 'Halbkreis', draw: (c, t) => `<path d="M8 40a24 24 0 0 1 48 0z" fill="${t}"/><rect x="8" y="46" width="48" height="6" fill="${t}"/>` },
  { id: 'dreiecke', name: 'Dreiecke', draw: (c, t) => [0, 1, 2, 3].map((i) => `<polygon points="${i * 16},44 ${i * 16 + 16},44 ${i * 16 + 8},28" fill="${t}"/>`).join('') + [0, 1, 2].map((i) => `<polygon points="${i * 16 + 8},20 ${i * 16 + 24},20 ${i * 16 + 16},36" fill="${t}"/>`).join('') },
  { id: 'zickzack', name: 'Zickzack', draw: (c, t) => `<path d="${[16, 32, 48].map((y) => `M-2 ${y}l8 -8l8 8l8 -8l8 8l8 -8l8 8l8 -8l8 8`).join('')}" fill="none" stroke="${t}" stroke-width="4.5" stroke-linejoin="round"/>` },
  { id: 'kreuz', name: 'Kreuz', draw: (c, t) => `<path d="M26 10h12v16h16v12h-16v16h-12v-16h-16v-12h16z" fill="${t}"/>` },
  { id: 'boegen', name: 'Bögen', draw: (c, t) => [44, 32, 20].map((r) => `<path d="M0 ${64 - r}a${r} ${r} 0 0 1 ${r} ${r}" fill="none" stroke="${t}" stroke-width="5"/>`).join('') + [44, 32, 20].map((r) => `<path d="M64 ${r}a${r} ${r} 0 0 1 ${-r} ${-r}" fill="none" stroke="${t}" stroke-width="5"/>`).join('') },
  { id: 'sonne', name: 'Sonne', draw: (c, t) => `<circle cx="32" cy="32" r="11" fill="${t}"/><path d="${Array.from({ length: 12 }, (_, i) => { const a = i * Math.PI / 6; return `M${avN(32 + 16 * Math.cos(a))} ${avN(32 + 16 * Math.sin(a))}L${avN(32 + 25 * Math.cos(a))} ${avN(32 + 25 * Math.sin(a))}`; }).join('')}" stroke="${t}" stroke-width="4" stroke-linecap="round"/>` },
  { id: 'faecher', name: 'Fächer', draw: (c, t) => Array.from({ length: 4 }, (_, i) => { const a1 = (180 + i * 45) * Math.PI / 180; const a2 = (180 + i * 45 + 22.5) * Math.PI / 180; return `<path d="M32 48L${avN(32 + 30 * Math.cos(a1))} ${avN(48 + 30 * Math.sin(a1))}A30 30 0 0 1 ${avN(32 + 30 * Math.cos(a2))} ${avN(48 + 30 * Math.sin(a2))}z" fill="${t}"/>`; }).join('') },
  { id: 'gitter', name: 'Gitter', draw: (c, t) => `<path d="M16 0V64M32 0V64M48 0V64M0 16H64M0 32H64M0 48H64" stroke="${t}" stroke-width="3.5"/>` },
  { id: 'gipfel', name: 'Gipfel', draw: (c, t) => `<polygon points="2,52 22,20 42,52" fill="${t}"/><polygon points="26,52 44,26 62,52" fill="${t}"/><rect x="0" y="52" width="64" height="12" fill="${t}"/>` },
  { id: 'kreise', name: 'Kreise', draw: (c, t) => `<circle cx="24" cy="26" r="14" fill="none" stroke="${t}" stroke-width="4.5"/><circle cx="40" cy="26" r="14" fill="none" stroke="${t}" stroke-width="4.5"/><circle cx="32" cy="40" r="14" fill="none" stroke="${t}" stroke-width="4.5"/>` },
  { id: 'sternfeld', name: 'Sternfeld', draw: (c, t) => [[18, 18, 9], [46, 22, 7], [24, 46, 7], [48, 48, 10], [34, 30, 4]].map(([x, y, r]) => `<polygon points="${avStar(x, y, r, r * 0.42)}" fill="${t}"/>`).join('') },
  { id: 'quadrate', name: 'Quadrate', draw: (c, t) => `<rect x="10" y="10" width="44" height="44" fill="none" stroke="${t}" stroke-width="4.5" transform="rotate(45 32 32)"/><rect x="21" y="21" width="22" height="22" fill="${t}"/>` },
  { id: 'balken', name: 'Balken', draw: (c, t) => [[8, 30], [20, 18], [32, 38], [44, 12], [56, 26]].map(([x, h]) => `<rect x="${x - 4}" y="${54 - h - 10}" width="8" height="${h + 10}" fill="${t}"/>`).join('') },
  { id: 'schuppen', name: 'Schuppen', draw: (c, t) => [8, 24, 40, 56].flatMap((y, r) => [-8, 8, 24, 40, 56].map((x) => `<path d="M${x + (r % 2 ? 8 : 0) - 8} ${y}a8 8 0 0 0 16 0" fill="none" stroke="${t}" stroke-width="3.5"/>`)).join('') },
  { id: 'sechseck', name: 'Sechseck', draw: (c, t) => `<polygon points="${Array.from({ length: 6 }, (_, i) => { const a = (i * 60 - 90) * Math.PI / 180; return `${avN(32 + 24 * Math.cos(a))},${avN(32 + 24 * Math.sin(a))}`; }).join(' ')}" fill="none" stroke="${t}" stroke-width="5"/><polygon points="${Array.from({ length: 6 }, (_, i) => { const a = (i * 60 - 90) * Math.PI / 180; return `${avN(32 + 11 * Math.cos(a))},${avN(32 + 11 * Math.sin(a))}`; }).join(' ')}" fill="${t}"/>` },
  { id: 'winkel', name: 'Winkel', draw: (c, t) => `<path d="M12 22l20 -12l20 12M12 38l20 -12l20 12M12 54l20 -12l20 12" fill="none" stroke="${t}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>` },
  { id: 'viertel', name: 'Viertel', draw: (c, t) => `<path d="M0 0h32a32 32 0 0 1 -32 32z" fill="${t}"/><path d="M64 64h-32a32 32 0 0 1 32 -32z" fill="${t}"/><circle cx="48" cy="16" r="8" fill="${t}"/><circle cx="16" cy="48" r="8" fill="${t}"/>` },
];

/** Gültige Avatar-Kennungen (Motive und Monogramm). */
const AV_IDS = [...AV_MOTIVE.map((m) => m.id), 'monogramm'];

/** SVG eines Motivs in der Spielerfarbe (Hintergrund = Farbe, Motiv = Tönung). */
function avatarSvg(id, color) {
  const m = AV_MOTIVE.find((x) => x.id === id);
  if (!m) return '';
  const c = /^#[0-9a-f]{6}$/i.test(String(color)) ? color : '#777777';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><rect width="64" height="64" fill="${c}"/>${m.draw(c, avTint(c))}</svg>`;
}

/** Erster Buchstabe des Namens (für das Monogramm). */
function avInitial(name) {
  const ch = [...String(name || '').trim()][0] || '?';
  return ch.toLocaleUpperCase('de-DE');
}

const avEsc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/**
 * Einheitliche Anzeige. `p` braucht name und color, dazu avatar und optional photo (Adresse).
 * Liegt `lobby` vor, werden Avatar und Foto von dort ergänzt (Spieldaten kennen nur id, Name, Farbe).
 */
function avatarHtml(p, size = 'M', lobby = null) {
  if (!p) return '';
  const l = lobby && p.id ? lobby.find((x) => x.id === p.id) : null;
  const avatar = (l && l.avatar) || p.avatar;
  const photo = (l ? l.photo : p.photo) || null;
  const color = p.color || (l && l.color) || '#777777';
  const svg = avatar && avatar !== 'monogramm' ? avatarSvg(avatar, color) : '';
  const base = svg || `<span class="av-mono">${avEsc(avInitial(p.name || (l && l.name)))}</span>`;
  const img = photo ? `<img class="av-foto" src="${avEsc(photo)}" alt="" loading="lazy" decoding="async" />` : '';
  return `<span class="av av-${size}" style="--c:${color};--ink-av:${avTint(color)}">${base}${img}</span>`;
}

// Foto lädt nicht: ausblenden, das Motiv bzw. Monogramm darunter bleibt (nie ein kaputtes Bild)
if (typeof document !== 'undefined') {
  document.addEventListener('error', (e) => {
    const el = e.target;
    if (el && el.classList && el.classList.contains('av-foto')) el.remove();
  }, true);
}

if (typeof module !== 'undefined') module.exports = { AV_MOTIVE, AV_IDS, avatarSvg, avatarHtml, avTint, avInitial };
