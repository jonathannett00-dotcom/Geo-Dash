'use strict';

/* Gemeinsame Teile für Startseite, Host-Lobby und Beitritt am Handy. */

/** Kurzbeschreibung der Spiele für die Auswahlkarten (Spielerzahl kommt vom Server). */
const LB_GAMES = {
  monopoly: { name: 'Monopoly', desc: 'Straßen kaufen, Häuser bauen, Miete kassieren. Dazu Pferderennen, Roulette und Blackjack.', time: '2–3 Stunden' },
  risiko: { name: 'Risiko', desc: 'Die Welt in 42 Gebieten: verstärken, angreifen, verteidigen. Die Würfel fallen auf dem Fernseher.', time: '1–3 Stunden' },
  poker: { name: 'Poker', desc: 'Texas Hold’em mit Blinds und Side-Pots. Die eigenen Karten liegen verdeckt auf dem Handy.', time: 'offen, ab 30 Minuten' },
};

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

const LB_SVG = 'http://www.w3.org/2000/svg';

/**
 * Ruhiger Hintergrund: bei Risiko die Weltkarte als dunkle Fläche (langsam treibend),
 * bei Monopoly ein flaches Feldraster wie am Spielbrettrand, bei Poker ein flaches
 * Rautenmuster in Tischgrün.
 */
function lbBackground(el, game) {
  if (!el || el.dataset.game === game) return;
  el.dataset.game = game;
  el.innerHTML = '';
  const svg = document.createElementNS(LB_SVG, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const geo = window.RISIKO_MAP_PATHS;
  if (game === 'risiko' && geo) {
    svg.setAttribute('viewBox', `0 0 ${geo.width} ${geo.height}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    svg.classList.add('drift');
    const d = [geo.otherLand, ...Object.values(geo.territories).map((t) => t.d)].join(' ');
    const land = document.createElementNS(LB_SVG, 'path');
    land.setAttribute('class', 'lb-land');
    land.setAttribute('d', d);
    svg.appendChild(land);
  } else if (game === 'monopoly') {
    // Raster aus Feldern: große Quadrate mit schmalen Zwischenfeldern, wie Straßen am Brettrand
    svg.setAttribute('viewBox', '0 0 1600 900');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    const path = document.createElementNS(LB_SVG, 'path');
    let d = '';
    for (let x = 0; x <= 1600; x += 120) d += `M${x} 0V900`;
    for (let y = 0; y <= 900; y += 180) d += `M0 ${y}H1600`;
    path.setAttribute('d', d);
    path.setAttribute('class', 'lb-grid-line');
    svg.appendChild(path);
  } else if (game === 'poker') {
    // Feines Rautengitter wie auf einem Kartenrücken, ohne Motive
    svg.setAttribute('viewBox', '0 0 1600 900');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    const path = document.createElementNS(LB_SVG, 'path');
    let d = '';
    for (let x = -900; x <= 1600; x += 80) d += `M${x} 0L${x + 900} 900M${x + 900} 0L${x} 900`;
    path.setAttribute('d', d);
    path.setAttribute('class', 'lb-grid-line thin');
    svg.appendChild(path);
  }
  el.appendChild(svg);
}
