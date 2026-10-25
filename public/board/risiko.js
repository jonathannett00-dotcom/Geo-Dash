'use strict';

/* =========================================================
 *  Tablet/TV: Risiko-Weltkarte. Die Flächen kommen aus map-paths.js
 *  (erzeugt aus Natural Earth von scripts/build-map.js), Gebiete und
 *  Nachbarschaften aus map.js. Nur Anzeige – Besitz, Armeen und Würfel
 *  kommen vom Server.
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
const RK_MARKER_R = 7.2;
const RK_MARKER_MIN_PX = 11;     // Marker-Radius auf dem Bildschirm mindestens so groß (z. B. Tablet)

let rkBuilt = false;
let rkBattleSeq = 0;
let rkBattleTimer = null;

function svgEl(tag, attrs = {}, parent = null) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  if (parent) parent.appendChild(el);
  return el;
}

/** Karte einmal aufbauen: Ozean, Land, Gebiete, Kontinentränder, Seewege, Marker. */
function buildRisikoMap() {
  const geo = window.RISIKO_MAP_PATHS;
  const svg = $('#rk-map');
  svg.setAttribute('viewBox', `0 0 ${geo.width} ${geo.height}`);
  svg.innerHTML = '';
  svgEl('rect', { class: 'rk-ocean', x: 0, y: 0, width: geo.width, height: geo.height }, svg);
  svgEl('path', { class: 'rk-other-land', d: geo.otherLand }, svg);

  const areas = svgEl('g', { class: 'rk-areas' }, svg);
  for (const t of S.map.territories) {
    svgEl('path', { class: 'rk-area', id: `rk-a-${t.id}`, 'data-territory': t.id, d: geo.territories[t.id].d }, areas);
  }
  const continents = svgEl('g', { class: 'rk-continents' }, svg);
  for (const d of Object.values(geo.continents)) svgEl('path', { d }, continents);

  const lanes = svgEl('g', { class: 'rk-lanes' }, svg);
  for (const lane of geo.seaLanes) {
    for (const [x1, y1, x2, y2] of lane.lines) svgEl('line', { x1, y1, x2, y2 }, lanes);
  }

  svgEl('line', { id: 'rk-attack-line', class: 'rk-attack-line hidden', x1: 0, y1: 0, x2: 0, y2: 0 }, svg);

  const markers = svgEl('g', { class: 'rk-markers' }, svg);
  for (const t of S.map.territories) {
    const [x, y] = geo.territories[t.id].marker;
    const g = svgEl('g', { class: 'rk-territory', id: `rk-t-${t.id}`, 'data-territory': t.id, transform: `translate(${x} ${y})` }, markers);
    svgEl('circle', { class: 'rk-disc', r: RK_MARKER_R }, g);
    const armies = svgEl('text', { class: 'rk-armies', 'text-anchor': 'middle', dy: '0.35em' }, g);
    armies.textContent = '0';
    svgEl('title', {}, g).textContent = t.name;
  }
  rkBuilt = true;
}

/** Marker auf kleinen Bildschirmen vergrößern, damit die Zahlen lesbar bleiben. */
function rkScaleMarkers() {
  const geo = window.RISIKO_MAP_PATHS;
  const svg = $('#rk-map');
  if (!geo || !svg.clientWidth) return;
  const k = Math.min(svg.clientWidth / geo.width, svg.clientHeight / geo.height);
  const scale = Math.max(1, Math.min(1.8, RK_MARKER_MIN_PX / (RK_MARKER_R * k)));
  if (scale === rkScaleMarkers.last) return;
  rkScaleMarkers.last = scale;
  for (const [id, t] of Object.entries(geo.territories)) {
    const node = document.getElementById(`rk-t-${id}`);
    if (node) node.setAttribute('transform', `translate(${t.marker[0]} ${t.marker[1]}) scale(${scale.toFixed(3)})`);
  }
}
window.addEventListener('resize', () => { if (rkBuilt) rkScaleMarkers(); });

const rkPlayer = (id) => S.game.players.find((p) => p.id === id);
const rkIsNeutral = (id) => Boolean(S.game.neutral) && id === S.game.neutral.id;
const rkName = (id) => (rkIsNeutral(id) ? 'Neutral' : escapeHtml(rkPlayer(id)?.name || '?'));
const rkTone = (id) => (rkIsNeutral(id) ? RK_NEUTRAL : (RK_TONES[rkPlayer(id)?.color] || RK_NEUTRAL));
const rkTerritoryName = (id) => escapeHtml(S.map.territories.find((t) => t.id === id)?.name || id);
/** Ticker-Texte der Engine ohne Emojis – auf der Karte nur Text. */
const rkPlain = (text) => String(text).replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim();

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
  rkBattleTimer = setTimeout(() => box.classList.add('hidden'), 6000);
}

function rkPlayersHtml(g) {
  const row = (cls, tone, name, stats) => `<div class="rk-player ${cls}" style="--c:${tone}"><span class="rk-swatch"></span><div><div class="rk-pname">${name}</div><div class="rk-pstats">${stats}</div></div></div>`;
  const list = g.players.map((p) => row(
    `${p.id === g.currentId ? 'current' : ''} ${p.eliminated ? 'out' : ''}`,
    rkTone(p.id),
    escapeHtml(p.name),
    p.eliminated ? 'ausgeschieden' : `${p.armies} Armeen · ${p.cards} Karten · ${p.territories} Gebiete`,
  ));
  if (g.neutral) {
    const own = Object.values(g.territories).filter((t) => t.owner === g.neutral.id);
    list.push(row('neutral', RK_NEUTRAL, 'Neutral', `${own.reduce((s, t) => s + t.armies, 0)} Armeen · ${own.length} Gebiete`));
  }
  return list.join('');
}

function renderRisiko() {
  $('#lobby').classList.add('hidden');
  $('#game').classList.add('hidden');
  $('#risiko').classList.remove('hidden');
  $('#rk-code').textContent = S.code;
  if (!rkBuilt) buildRisikoMap();
  rkScaleMarkers();
  const g = S.game;
  const geo = window.RISIKO_MAP_PATHS;

  for (const [id, t] of Object.entries(g.territories)) {
    const area = document.getElementById(`rk-a-${id}`);
    const node = document.getElementById(`rk-t-${id}`);
    if (!area || !node) continue;
    area.style.fill = rkTone(t.owner);
    node.dataset.owner = t.owner || '';
    const text = node.querySelector('.rk-armies');
    if (text.textContent !== String(t.armies)) text.textContent = String(t.armies);
    node.classList.toggle('active', Boolean(g.currentId) && t.owner === g.currentId);
    node.classList.toggle('wide', t.armies >= 100);
  }

  // Laufender Angriff oder Nachrücken: Linie zwischen den Markern
  const line = $('#rk-attack-line');
  const pa = g.turn && (g.turn.pendingAttack || g.turn.occupy);
  $$('.rk-territory.attacking, .rk-territory.defending').forEach((n) => n.classList.remove('attacking', 'defending'));
  if (pa) {
    const [x1, y1] = geo.territories[pa.from].marker;
    const [x2, y2] = geo.territories[pa.to].marker;
    Object.entries({ x1, y1, x2, y2 }).forEach(([k, v]) => line.setAttribute(k, v));
    line.classList.remove('hidden');
    document.getElementById(`rk-t-${pa.from}`).classList.add('attacking');
    document.getElementById(`rk-t-${pa.to}`).classList.add('defending');
  } else {
    line.classList.add('hidden');
  }

  if (g.lastBattle && g.lastBattle.seq !== rkBattleSeq) {
    rkBattleSeq = g.lastBattle.seq;
    rkShowBattle(g.lastBattle);
  }

  patch($('#rk-banner'), rkBannerHtml(g));
  patch($('#rk-players'), rkPlayersHtml(g));
  patch($('#rk-log'), g.log.slice(-3).reverse().map((e) => `<li>${escapeHtml(rkPlain(e.text))}</li>`).join(''));
}
