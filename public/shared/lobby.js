'use strict';

/* Gemeinsame Teile für Host-Lobby und Beitritt am Handy (Gestaltung wie die Startseite). */

/** Name und Dauer der Spiele für die Auswahlkarten (Spielerzahl kommt vom Server). */
const LB_GAMES = {
  monopoly: { name: 'Monopoly', time: '2–3 Stunden' },
  risiko: { name: 'Risiko', time: '1–3 Stunden' },
  poker: { name: 'Poker', time: 'offen, ab 30 Minuten' },
};

/** Namen der Lobby-Farben (Standardpalette und Poker-Palette). */
const LB_FARBNAMEN = {
  '#e63946': 'Rot', '#1d72d8': 'Blau', '#2a9d8f': 'Petrol', '#f4a261': 'Apricot', '#8e44ad': 'Violett',
  '#e9c46a': 'Gelb', '#ff6fb5': 'Pink', '#264653': 'Nachtblau', '#8ac926': 'Grün', '#795548': 'Braun',
  '#d1495b': 'Rot', '#2e86de': 'Blau', '#f0a202': 'Gelb', '#7e57c2': 'Violett', '#26a69a': 'Petrol',
  '#ef6c9a': 'Pink', '#8d6e63': 'Braun', '#9ccc65': 'Grün', '#00acc1': 'Türkis', '#f57c00': 'Orange',
  '#5c6bc0': 'Indigo', '#e0e0e0': 'Weiß',
};
const lbFarbname = (hex) => LB_FARBNAMEN[String(hex).toLowerCase()] || '';

/** Lesbare Schriftfarbe auf einer Spielerfarbe. */
function lbInkOn(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.32 ? '#17202a' : '#ffffff';
}

/**
 * Gesamthintergrund: je Spiel eine Stimmungsfläche (Monopoly warmes Grün, Risiko tiefes
 * Blau, Poker Tischgrün), dazu langsam treibende Lichter wie auf der Startseite.
 * Der Wechsel ist eine Überblendung (nur opacity), die Lichter bewegen sich nur per transform.
 */
function lbBackground(el, game) {
  if (!el) return;
  if (!el.firstChild) {
    el.innerHTML = ['neutral', 'monopoly', 'risiko', 'poker'].map((g) => `<span class="lb-mood" data-mood="${g}"></span>`).join('')
      + '<span class="lb-light lb-light-a"></span><span class="lb-light lb-light-b"></span><span class="lb-light lb-light-c"></span>';
  }
  const mood = ['monopoly', 'risiko', 'poker'].includes(game) ? game : 'neutral';
  if (el.dataset.game === mood) return;
  el.dataset.game = mood;
  el.querySelectorAll('.lb-mood').forEach((m) => m.classList.toggle('on', m.dataset.mood === mood));
}

/** Wortmarke in Buchstaben teilen (für das gestaffelte Einblenden); der Text bleibt lesbar. */
function lbSplitMark(mark) {
  if (!mark || mark.dataset.split) return;
  const text = mark.textContent;
  mark.dataset.split = '1';
  mark.setAttribute('aria-label', text);
  mark.textContent = '';
  [...text].forEach((ch, i) => {
    const span = document.createElement('span');
    span.className = 'lb-ch';
    span.style.setProperty('--c', i);
    span.setAttribute('aria-hidden', 'true');
    span.textContent = ch;
    mark.appendChild(span);
  });
}

/** Eingangsanimation einmal starten, sobald der Bereich sichtbar ist. */
function lbEnter(section) {
  if (!section || section.classList.contains('lb-go')) return;
  requestAnimationFrame(() => section.classList.add('lb-go'));
}
