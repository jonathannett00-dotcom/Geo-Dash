'use strict';

/* =========================================================
 *  Tablet/TV: Risiko-Weltkarte. Flächen, Marker, Namen und Seewege kommen
 *  aus map-paths.js (erzeugt von scripts/build-map.js aus Natural Earth),
 *  Gebiete und Nachbarschaften aus map.js. Nur Anzeige – Besitz, Armeen
 *  und Würfel kommen vom Server.
 * ========================================================= */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Feste, ruhige Kartenfarbe je Spielerfarbe aus der Lobby. */
const RK_TONES = {
  '#e63946': '#c4605a',
  '#1d72d8': '#5582b8',
  '#2a9d8f': '#4f9a8d',
  '#f4a261': '#d39a66',
  '#8e44ad': '#8a6aa6',
  '#e9c46a': '#cdb567',
  '#ff6fb5': '#c9809f',
  '#264653': '#58747c',
  '#8ac926': '#8aad5b',
  '#795548': '#977661',
};
const RK_NEUTRAL = '#b5b0a4';
const LABEL_DIRS = { s: [0, 1], n: [0, -1], e: [1, 0], w: [-1, 0], se: [0.72, 0.72], sw: [-0.72, 0.72], ne: [0.72, -0.72], nw: [-0.72, -0.72] };

let rkBuilt = false;
let rkBattleSeq = 0;
let rkBattleTimer = null;
let rkK = 1;                 // Pixel je Karteneinheit
const rkShown = {};          // angezeigte Armeezahl je Gebiet (für weiche Übergänge)

function svgEl(tag, attrs = {}, parent = null) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  if (parent) parent.appendChild(el);
  return el;
}

/** Karte einmal aufbauen: Ozean, Land, Seen, Gebiete, Kontinentränder, Seewege, Namen, Marker. */
function buildRisikoMap() {
  const geo = window.RISIKO_MAP_PATHS;
  const svg = $('#rk-map');
  svg.innerHTML = '';
  svgEl('rect', { class: 'rk-ocean', id: 'rk-ocean', x: -5000, y: -5000, width: 10000, height: 10000 }, svg);
  svgEl('path', { class: 'rk-other-land', d: geo.otherLand }, svg);

  const areas = svgEl('g', { class: 'rk-areas' }, svg);
  for (const t of S.map.territories) {
    svgEl('path', { class: 'rk-area', id: `rk-a-${t.id}`, 'data-territory': t.id, d: geo.territories[t.id].d }, areas);
  }
  svgEl('path', { class: 'rk-lakes', d: geo.lakes }, svg);
  const continents = svgEl('g', { class: 'rk-continents' }, svg);
  for (const d of Object.values(geo.continents)) svgEl('path', { d }, continents);

  const lanes = svgEl('g', { class: 'rk-lanes' }, svg);
  for (const lane of geo.seaLanes) svgEl('path', { d: lane.d, 'data-lane': `${lane.a}|${lane.b}` }, lanes);

  svgEl('g', { class: 'rk-fx', id: 'rk-fx' }, svg);

  const labels = svgEl('g', { class: 'rk-labels' }, svg);
  for (const t of S.map.territories) {
    svgEl('text', { class: 'rk-label', id: `rk-l-${t.id}` }, labels).textContent = t.name;
  }

  const markers = svgEl('g', { class: 'rk-markers' }, svg);
  for (const t of S.map.territories) {
    const g = svgEl('g', { class: 'rk-territory', id: `rk-t-${t.id}`, 'data-territory': t.id }, markers);
    const inner = svgEl('g', { class: 'rk-marker' }, g);
    svgEl('circle', { class: 'rk-disc', r: geo.style.markerR }, inner);
    svgEl('text', { class: 'rk-armies', 'text-anchor': 'middle', dy: '0.35em' }, inner).textContent = '0';
    svgEl('title', {}, g).textContent = t.name;
  }
  rkBuilt = true;
  rkLayout();
}

/* ---------------- Layout: Karte füllt das Fenster, Flächen im Ozean ---------------- */

/** Größen bei Maßstab k – dieselben Formeln wie scripts/build-map.js. */
function rkSizes(k) {
  const st = window.RISIKO_MAP_PATHS.style;
  const markerScale = Math.max(1, Math.min(st.markerMaxScale, st.markerMinPx / (st.markerR * k)));
  const font = Math.max(st.labelMinPx, Math.min(st.labelMaxPx, st.labelUnits * k)) / k;
  return { markerScale, r: st.markerR * markerScale, font };
}

function rkLayout() {
  const geo = window.RISIKO_MAP_PATHS;
  const root = $('#risiko');
  const svg = $('#rk-map');
  if (!geo || !root.clientWidth) return;
  const W = root.clientWidth;
  const H = root.clientHeight;
  const gap = Math.round(Math.max(8, Math.min(16, Math.min(W, H) * 0.012)));
  root.style.setProperty('--gap', `${gap}px`);
  rkFitPanels(W, H, gap);
  const top = $('.rk-top').offsetHeight;
  const bottom = $('.rk-bottom').offsetHeight;
  // Karte zwischen den Flächen einpassen; überzählige Höhe gleichmäßig als Ozean verteilen
  const availW = W - 2 * gap;
  const availH = H - top - bottom - 4 * gap;
  const k = Math.min(availW / geo.width, availH / geo.height);
  const mapW = geo.width * k;
  const mapH = geo.height * k;
  const x = (W - mapW) / 2;
  const y = gap + top + gap + (availH - mapH) / 2;
  svg.setAttribute('viewBox', `${(-x / k).toFixed(2)} ${(-y / k).toFixed(2)} ${(W / k).toFixed(2)} ${(H / k).toFixed(2)}`);
  if (Math.abs(k - rkK) > 1e-4 || !rkLayout.done) {
    rkK = k;
    rkLayout.done = true;
    rkPlaceMarkersAndLabels();
  }
}
window.addEventListener('resize', () => { if (rkBuilt) rkLayout(); });

/**
 * Ist die Karte durch die Breite begrenzt (z. B. 4:3), bleibt oben und unten Ozean übrig.
 * Dann wachsen Banner und Leisten, solange die Karte ihre volle Breite behält.
 */
function rkFitPanels(W, H, gap) {
  const key = `${W}x${H}:${S.game.players.length + (S.game.neutral ? 1 : 0)}`;
  if (rkFitPanels.key === key) return;
  rkFitPanels.key = key;
  const root = $('#risiko');
  const geo = window.RISIKO_MAP_PATHS;
  const mapH = ((W - 2 * gap) / geo.width) * geo.height;
  const fits = (scale) => {
    root.style.setProperty('--panel-scale', String(scale));
    return H - $('.rk-top').offsetHeight - $('.rk-bottom').offsetHeight - 4 * gap >= mapH;
  };
  let lo = 1; let hi = 1.7;
  if (!fits(lo)) { root.style.setProperty('--panel-scale', '1'); return; }
  for (let i = 0; i < 6; i++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
  root.style.setProperty('--panel-scale', lo.toFixed(3));
  rkPlayerColumns();
}

/** Zweite Kopfzeile nur zeigen, wenn die Spielerliste wirklich zwei Spalten hat. */
function rkPlayerColumns() {
  const list = $('#rk-players');
  const cols = getComputedStyle(list).gridTemplateColumns.split(' ').length;
  list.classList.toggle('one-col', cols < 2);
}

function rkPlaceMarkersAndLabels() {
  const geo = window.RISIKO_MAP_PATHS;
  const { markerScale, r, font } = rkSizes(rkK);
  const gap = geo.style.labelGap * font;
  for (const [id, t] of Object.entries(geo.territories)) {
    const [mx, my] = t.marker;
    const node = document.getElementById(`rk-t-${id}`);
    node.setAttribute('transform', `translate(${mx} ${my})`);
    node.firstChild.setAttribute('transform', `scale(${markerScale.toFixed(3)})`);
    const label = document.getElementById(`rk-l-${id}`);
    const l = t.label;
    let lx; let ly; let anchor = 'middle';
    if (l.x !== undefined) { lx = l.x; ly = l.y; } else {
      const [dx, dy] = LABEL_DIRS[l.dir];
      const d = (r + gap) * l.m;
      lx = mx + dx * d;
      ly = my + dy * d;
      if (dx > 0.1) anchor = 'start'; else if (dx < -0.1) anchor = 'end';
      if (dy > 0.1) ly += font / 2; else if (dy < -0.1) ly -= font / 2;
    }
    label.setAttribute('x', lx.toFixed(2));
    label.setAttribute('y', ly.toFixed(2));
    label.setAttribute('text-anchor', anchor);
    label.style.fontSize = `${font.toFixed(2)}px`;
  }
}

/* ---------------- Anzeige ---------------- */

const rkPlayer = (id) => S.game.players.find((p) => p.id === id);
const rkIsNeutral = (id) => Boolean(S.game.neutral) && id === S.game.neutral.id;
const rkName = (id) => (rkIsNeutral(id) ? 'Neutral' : escapeHtml(rkPlayer(id)?.name || '?'));
const rkTone = (id) => (rkIsNeutral(id) ? RK_NEUTRAL : (RK_TONES[rkPlayer(id)?.color] || RK_NEUTRAL));
const rkTerritoryName = (id) => escapeHtml(S.map.territories.find((t) => t.id === id)?.name || id);
/** Ticker-Texte der Engine ohne Emojis – auf der Karte nur Text. */
const rkPlain = (text) => String(text).replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim();
const rkEase = (t) => 1 - (1 - t) ** 3;

/** Zahl im Marker weich auf den neuen Wert zählen. */
function rkSetArmies(id, value, ms = 350) {
  const text = document.querySelector(`#rk-t-${id} .rk-armies`);
  const from = rkShown[id];
  rkShown[id] = value;
  cancelAnimationFrame(text._raf);
  if (from === undefined || from === value || ms <= 0) { text.textContent = String(value); return; }
  const start = performance.now();
  (function step(now) {
    const t = Math.min(1, (now - start) / ms);
    text.textContent = String(Math.round(from + (value - from) * rkEase(t)));
    if (t < 1) text._raf = requestAnimationFrame(step);
  })(start);
}

function rkBannerHtml(g) {
  const cur = g.currentId ? rkPlayer(g.currentId) : null;
  const who = cur ? `<b style="--c:${rkTone(cur.id)}" class="rk-who">${escapeHtml(cur.name)}</b>` : '';
  let text;
  switch (g.phase) {
    case 'setup': {
      const open = g.players.filter((p) => !p.eliminated && p.remaining > 0);
      text = `Aufbau: Alle setzen ihre Startarmeen${open.length ? ` – noch offen: ${open.map((p) => `${escapeHtml(p.name)} (${p.remaining})`).join(', ')}` : ''}`;
      break;
    }
    case 'reinforce':
      text = `${who} verstärkt – noch ${g.turn.reinforcements} ${g.turn.reinforcements === 1 ? 'Armee' : 'Armeen'}${cur.cards >= 5 ? ', muss Karten tauschen' : ''}`;
      break;
    case 'attack': text = `${who} greift an`; break;
    case 'defend': {
      const pa = g.turn.pendingAttack;
      text = `${who} greift ${rkTerritoryName(pa.to)} von ${rkTerritoryName(pa.from)} aus an – ${rkName(pa.defenderId)} wählt die Würfel`;
      break;
    }
    case 'occupy': text = `${who} rückt nach ${rkTerritoryName(g.turn.occupy.to)} nach`; break;
    case 'fortify': text = `${who} kann einmal verschieben`; break;
    case 'gameover': text = g.winner ? `${rkName(g.winner)} erobert die Welt` : 'Das Spiel ist vorbei.'; break;
    default: text = '';
  }
  return `${text}${S.paused ? ' <span class="rk-paused">Pausiert – Spieler getrennt</span>' : ''}`;
}

function rkShowBattle(b) {
  const box = $('#rk-battle');
  const dice = (list, cls) => list.map((d) => `<span class="rk-die ${cls}">${d}</span>`).join('');
  box.innerHTML = `<div class="rk-battle-row"><span>${rkTerritoryName(b.from)}</span>${dice(b.attack, 'att')}</div>
    <div class="rk-battle-row"><span>${rkTerritoryName(b.to)}</span>${dice(b.defend, 'def')}</div>
    <div class="rk-battle-foot">Verluste ${b.attackerLosses} : ${b.defenderLosses}${b.conquered ? ' – erobert' : ''}</div>`;
  box.classList.remove('hidden');
  clearTimeout(rkBattleTimer);
  rkBattleTimer = setTimeout(() => box.classList.add('hidden'), 8000);
}

function rkPlayersHtml(g) {
  const row = (cls, tone, name, cells) => `<div class="rk-player ${cls}" style="--c:${tone}">
    <span class="rk-swatch"></span><span class="rk-pname">${name}</span>${cells.map((c) => `<span class="rk-num">${c}</span>`).join('')}</div>`;
  const head = '<div class="rk-player rk-head"><span></span><span></span><span class="rk-num">Armeen</span><span class="rk-num">Karten</span><span class="rk-num">Gebiete</span></div>';
  const list = g.players.map((p) => row(
    `${p.id === g.currentId ? 'current' : ''} ${p.eliminated ? 'out' : ''}`,
    rkTone(p.id),
    escapeHtml(p.name),
    p.eliminated ? ['–', '–', '–'] : [p.armies, p.cards, p.territories],
  ));
  if (g.neutral) {
    const own = Object.values(g.territories).filter((t) => t.owner === g.neutral.id);
    list.push(row('neutral', RK_NEUTRAL, 'Neutral', [own.reduce((s, t) => s + t.armies, 0), '–', own.length]));
  }
  // Bei zwei Spalten bekommt jede ihre Kopfzeile (die zweite blendet sich bei einer Spalte aus)
  return head + (list.length > 1 ? head.replace('rk-head', 'rk-head rk-head-2') : '') + list.join('');
}

function renderRisiko() {
  $('#lobby').classList.add('hidden');
  $('#game').classList.add('hidden');
  $('#risiko').classList.remove('hidden');
  $('#rk-code').textContent = S.code;
  const g = S.game;
  patch($('#rk-banner'), rkBannerHtml(g));
  patch($('#rk-players'), rkPlayersHtml(g));
  patch($('#rk-log'), g.log.slice(-3).reverse().map((e) => `<li>${escapeHtml(rkPlain(e.text))}</li>`).join(''));
  if (!rkBuilt) buildRisikoMap();
  else rkLayout();
  const geo = window.RISIKO_MAP_PATHS;

  for (const [id, t] of Object.entries(g.territories)) {
    const area = document.getElementById(`rk-a-${id}`);
    const node = document.getElementById(`rk-t-${id}`);
    if (!area || !node) continue;
    area.style.fill = rkTone(t.owner);
    node.dataset.owner = t.owner || '';
    rkSetArmies(id, t.armies);
    node.classList.toggle('active', Boolean(g.currentId) && t.owner === g.currentId);
    node.classList.toggle('wide', t.armies >= 100);
  }

  // Laufender Angriff oder Nachrücken: Bogen zwischen den Markern
  const pa = g.turn && (g.turn.pendingAttack || g.turn.occupy);
  $$('.rk-territory.attacking, .rk-territory.defending').forEach((n) => n.classList.remove('attacking', 'defending'));
  const fx = $('#rk-fx');
  let arrow = document.getElementById('rk-attack-arrow');
  if (pa) {
    if (!arrow) arrow = svgEl('path', { id: 'rk-attack-arrow', class: 'rk-arrow' }, fx);
    arrow.setAttribute('d', rkArc(geo.territories[pa.from].marker, geo.territories[pa.to].marker));
    document.getElementById(`rk-t-${pa.from}`).classList.add('attacking');
    document.getElementById(`rk-t-${pa.to}`).classList.add('defending');
  } else if (arrow) {
    arrow.remove();
  }

  if (g.lastBattle && g.lastBattle.seq !== rkBattleSeq) {
    rkBattleSeq = g.lastBattle.seq;
    rkShowBattle(g.lastBattle);
  }
}

/** Sanfter Bogen zwischen zwei Punkten (Karteneinheiten). */
function rkArc([x1, y1], [x2, y2], bend = 0.22) {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const cx = (x1 + x2) / 2 - ((y2 - y1) / len) * len * bend;
  const cy = (y1 + y2) / 2 + ((x2 - x1) / len) * len * bend;
  return `M${x1} ${y1}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x2} ${y2}`;
}
