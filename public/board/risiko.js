'use strict';

/* =========================================================
 *  Tablet: Risiko-Weltkarte als eigenes SVG (Daten aus server/games/risiko/map.js).
 *  Nur Anzeige – Besitz, Armeen und Würfel kommen vom Server.
 * ========================================================= */

const SVG_NS = 'http://www.w3.org/2000/svg';
const RK_GREY = '#9e9e9e';
let rkBuilt = false;
let rkBattleSeq = 0;
let rkBattleTimer = null;

function svgEl(tag, attrs = {}, parent = null) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  if (parent) parent.appendChild(el);
  return el;
}

/** Karte einmal aufbauen: Kontinentflächen, Grenzlinien, Gebiete. */
function buildRisikoMap() {
  const map = S.map;
  const svg = $('#rk-map');
  svg.setAttribute('viewBox', `0 0 ${map.width} ${map.height}`);
  svg.innerHTML = '';
  const pos = Object.fromEntries(map.territories.map((t) => [t.id, t]));
  const colorOf = Object.fromEntries(map.continents.map((c) => [c.id, c.color]));

  // Kontinente als weiche Flächen aus überlappenden Kreisen
  const lands = svgEl('g', { class: 'rk-lands' }, svg);
  for (const t of map.territories) svgEl('circle', { cx: t.x, cy: t.y, r: 54, fill: colorOf[t.continent] }, lands);
  const labels = svgEl('g', { class: 'rk-continent-labels' }, svg);
  for (const c of map.continents) {
    const label = svgEl('text', { x: c.label.x, y: c.label.y, 'text-anchor': 'middle' }, labels);
    label.textContent = `${c.name} +${c.bonus}`;
  }

  // Grenzen; Verbindungen über den Kartenrand (Alaska – Kamtschatka) laufen nach außen
  const borders = svgEl('g', { class: 'rk-borders' }, svg);
  const done = new Set();
  for (const t of map.territories) {
    for (const n of t.neighbors) {
      const key = [t.id, n].sort().join('|');
      if (done.has(key)) continue;
      done.add(key);
      const a = pos[t.id];
      const b = pos[n];
      if (Math.abs(a.x - b.x) > map.width / 2) {
        const [left, right] = a.x < b.x ? [a, b] : [b, a];
        svgEl('line', { x1: left.x, y1: left.y, x2: 0, y2: left.y, class: 'wrap' }, borders);
        svgEl('line', { x1: right.x, y1: right.y, x2: map.width, y2: right.y, class: 'wrap' }, borders);
      } else {
        svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y }, borders);
      }
    }
  }

  svgEl('line', { id: 'rk-attack-line', class: 'rk-attack-line hidden', x1: 0, y1: 0, x2: 0, y2: 0 }, svg);

  const nodes = svgEl('g', { class: 'rk-nodes' }, svg);
  for (const t of map.territories) {
    const g = svgEl('g', { class: 'rk-territory', id: `rk-t-${t.id}`, 'data-territory': t.id, transform: `translate(${t.x} ${t.y})` }, nodes);
    svgEl('circle', { class: 'rk-disc', r: 19 }, g);
    const armies = svgEl('text', { class: 'rk-armies', 'text-anchor': 'middle', dy: '0.36em' }, g);
    armies.textContent = '0';
    const name = svgEl('text', { class: 'rk-name', 'text-anchor': 'middle', y: 33 }, g);
    name.textContent = t.name;
    const title = svgEl('title', {}, g);
    title.textContent = t.name;
  }
  rkBuilt = true;
}

const rkPlayer = (id) => S.game.players.find((p) => p.id === id);
const rkName = (id) => (S.game.neutral && id === S.game.neutral.id ? 'Neutral' : escapeHtml(rkPlayer(id)?.name || '?'));
const rkColor = (id) => (S.game.neutral && id === S.game.neutral.id ? S.game.neutral.color : (rkPlayer(id)?.color || RK_GREY));
const rkTerritoryName = (id) => escapeHtml(S.map.territories.find((t) => t.id === id)?.name || id);

function rkBannerHtml(g) {
  const cur = g.currentId ? rkPlayer(g.currentId) : null;
  const who = cur ? `<b style="color:${cur.color}">${escapeHtml(cur.name)}</b>` : '';
  let text;
  switch (g.phase) {
    case 'setup': {
      const open = g.players.filter((p) => !p.eliminated && p.remaining > 0);
      text = `Aufbau: Alle setzen ihre Startarmeen${open.length ? ` – noch offen: ${open.map((p) => `${escapeHtml(p.name)} (${p.remaining})`).join(', ')}` : ''}`;
      break;
    }
    case 'reinforce':
      text = `${who} verstärkt – noch ${g.turn.reinforcements} ${g.turn.reinforcements === 1 ? 'Armee' : 'Armeen'}${cur.cards >= 5 ? ' · muss Karten tauschen' : ''}`;
      break;
    case 'attack': text = `${who} greift an`; break;
    case 'defend': {
      const pa = g.turn.pendingAttack;
      text = `${who} greift ${rkTerritoryName(pa.to)} von ${rkTerritoryName(pa.from)} aus an – <b>${rkName(pa.defenderId)}</b> wählt die Würfel`;
      break;
    }
    case 'occupy': text = `${who} rückt nach ${rkTerritoryName(g.turn.occupy.to)} nach`; break;
    case 'fortify': text = `${who} kann einmal verschieben`; break;
    case 'gameover': text = g.winner ? `🏆 <b>${rkName(g.winner)}</b> erobert die Welt!` : 'Das Spiel ist vorbei.'; break;
    default: text = '';
  }
  return `${text}${S.paused ? ' <span class="rk-paused">⏸ pausiert – Spieler getrennt</span>' : ''}`;
}

function rkShowBattle(b) {
  const box = $('#rk-battle');
  const dice = (list, cls) => list.map((d) => `<span class="rk-die ${cls}">${d}</span>`).join('');
  box.innerHTML = `<div class="rk-battle-head">${rkName(b.attackerId)} ⚔️ ${rkName(b.defenderId)}</div>
    <div class="rk-battle-row"><span>${rkTerritoryName(b.from)}</span>${dice(b.attack, 'att')}</div>
    <div class="rk-battle-row"><span>${rkTerritoryName(b.to)}</span>${dice(b.defend, 'def')}</div>
    <div class="rk-battle-foot">Verluste ${b.attackerLosses} : ${b.defenderLosses}${b.conquered ? ' · erobert!' : ''}</div>`;
  box.classList.remove('hidden');
  clearTimeout(rkBattleTimer);
  rkBattleTimer = setTimeout(() => box.classList.add('hidden'), 6000);
}

/** Neutrale Gebiete nur zählen (Anzeige), der Server führt den Bestand. */
function rkNeutralHtml(g) {
  const own = Object.values(g.territories).filter((t) => t.owner === g.neutral.id);
  const armies = own.reduce((sum, t) => sum + t.armies, 0);
  return `<div class="rk-player neutral" style="--c:${g.neutral.color}"><div class="rk-pname">Neutral</div>
    <div class="rk-pstats">🗺️ ${own.length} · ⚔️ ${armies}</div></div>`;
}

function renderRisiko() {
  $('#lobby').classList.add('hidden');
  $('#game').classList.add('hidden');
  $('#risiko').classList.remove('hidden');
  $('#rk-code').textContent = S.code;
  if (!rkBuilt) buildRisikoMap();
  const g = S.game;

  for (const [id, t] of Object.entries(g.territories)) {
    const node = document.getElementById(`rk-t-${id}`);
    if (!node) continue;
    node.style.setProperty('--owner', rkColor(t.owner));
    node.dataset.owner = t.owner || '';
    const text = node.querySelector('.rk-armies');
    if (text.textContent !== String(t.armies)) text.textContent = String(t.armies);
    node.classList.toggle('active', Boolean(g.currentId) && t.owner === g.currentId);
  }

  // Laufender Angriff: Pfeil zwischen den Gebieten
  const line = $('#rk-attack-line');
  const pa = g.turn && (g.turn.pendingAttack || g.turn.occupy);
  $$('.rk-territory.attacking, .rk-territory.defending').forEach((n) => n.classList.remove('attacking', 'defending'));
  if (pa) {
    const a = S.map.territories.find((t) => t.id === pa.from);
    const b = S.map.territories.find((t) => t.id === pa.to);
    ['x1', 'y1', 'x2', 'y2'].forEach((k, i) => line.setAttribute(k, [a.x, a.y, b.x, b.y][i]));
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
  patch($('#rk-players'), g.players.map((p) => `
    <div class="rk-player ${p.id === g.currentId ? 'current' : ''} ${p.eliminated ? 'out' : ''}" style="--c:${p.color}">
      <div class="rk-pname"><span class="fig">${p.figure || ''}</span>${escapeHtml(p.name)}</div>
      <div class="rk-pstats">🗺️ ${p.territories} · ⚔️ ${p.armies} · 🃏 ${p.cards}</div>
      ${p.continents.length ? `<div class="rk-pconts">${p.continents.map((c) => escapeHtml(S.map.continents.find((x) => x.id === c).name)).join(', ')}</div>` : ''}
    </div>`).join('') + (g.neutral ? rkNeutralHtml(g) : '')
    + `<div class="rk-deck">Kartenstapel: ${g.deckCount}${g.nextTradeValue ? ` · nächster Tausch: ${g.nextTradeValue} Armeen` : ''}</div>`);
  patch($('#rk-log'), g.log.slice(-14).reverse().map((e) => `<li class="k-${e.kind}">${escapeHtml(e.text)}</li>`).join(''));
}
