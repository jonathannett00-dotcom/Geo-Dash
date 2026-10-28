'use strict';

/* =========================================================
 *  Handy: Risiko-Controller. Oben die Phase, darunter eine kleine,
 *  zoombare Karte zum Antippen (gleiche Pfade wie auf dem Fernseher),
 *  darunter die Aktionen. Karte und Listen filtern nur die Auswahl vor;
 *  ob eine Aktion erlaubt ist, entscheidet der Server (act).
 * ========================================================= */

/** Auswahl auf dem Handy (bleibt zwischen Snapshots erhalten). */
const rkUi = { place: '', placeCount: '', from: '', to: '', dice: '', defend: '', occupy: '', mFrom: '', mTo: '', mCount: '', cards: [], mode: 'attack' };

const SYMBOL_NAMES = { infanterie: 'Infanterie', kavallerie: 'Kavallerie', artillerie: 'Artillerie', joker: 'Joker' };
const SVG_NS = 'http://www.w3.org/2000/svg';
const VIBRATION_KEY = 'risiko-vibration';

const rkMap = () => Object.fromEntries(S.map.territories.map((t) => [t.id, t]));
const rkP = (id) => S.game.players.find((p) => p.id === id);
const rkWho = (id) => (S.game.neutral && id === S.game.neutral.id ? 'Neutral' : escapeHtml(rkP(id)?.name || '?'));
const rkT = (id) => escapeHtml(S.map.territories.find((t) => t.id === id)?.name || id);
const rkToneOf = (owner) => (S.game.neutral && owner === S.game.neutral.id ? RK_NEUTRAL : (RK_TONES[rkP(owner)?.color] || RK_NEUTRAL));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Wählt den gemerkten Wert, falls er noch gültig ist, sonst den ersten. */
function keep(key, values, fallback = values[0]) {
  if (!values.includes(rkUi[key])) rkUi[key] = fallback === undefined ? '' : fallback;
  return rkUi[key];
}

/** Ausdrückliche Auswahl: ungültige oder fehlende Werte werden leer (Platzhalter „– wählen –“). */
function chosen(key, values) {
  if (!values.includes(rkUi[key])) rkUi[key] = '';
  return rkUi[key];
}
const PLACEHOLDER = '<option value="">– wählen –</option>';

const options = (list, selected) => list.map(([v, label]) => `<option value="${escapeHtml(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${label}</option>`).join('');

function ownIds() {
  const g = S.game;
  return S.map.territories.filter((t) => g.territories[t.id].owner === me).map((t) => t.id);
}

/** Eigene Gebiete, die über eigene Gebiete mit `from` verbunden sind. */
function connectedOwn(from) {
  const g = S.game;
  const map = rkMap();
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    for (const n of map[queue.shift()].neighbors) {
      if (!seen.has(n) && g.territories[n].owner === me) { seen.add(n); queue.push(n); }
    }
  }
  seen.delete(from);
  return [...seen];
}

const terrLabel = (id) => `${rkT(id)} (${S.game.territories[id].armies})`;

/* ---------------- Auswahlregeln (nur Vorfilter, der Server prüft) ---------------- */

function attackSources() {
  const g = S.game; const map = rkMap();
  return ownIds().filter((id) => g.territories[id].armies >= 2 && map[id].neighbors.some((n) => g.territories[n].owner !== me));
}
function attackTargets(from) {
  const g = S.game;
  return from ? rkMap()[from].neighbors.filter((n) => g.territories[n].owner !== me) : [];
}
function fortifyTargets(from) {
  const g = S.game;
  if (!from) return [];
  return g.settings.fortify === 'verbunden' ? connectedOwn(from) : rkMap()[from].neighbors.filter((n) => g.territories[n].owner === me);
}
function fortifySources() {
  return ownIds().filter((id) => S.game.territories[id].armies >= 2 && fortifyTargets(id).length);
}

/** Was ein Antippen auf der Karte gerade bewirkt: 'place', 'attack', 'fortify' oder null. */
function tapMode() {
  const g = S.game;
  const mine = rkP(me);
  if (!mine || mine.eliminated) return null;
  if (g.phase === 'setup') return mine.remaining > 0 ? 'place' : null;
  if (g.currentId !== me) return null;
  if (g.phase === 'reinforce') return g.turn.reinforcements > 0 && mine.cards < 5 ? 'place' : null;
  if (g.phase === 'attack') return rkUi.mode === 'fortify' ? 'fortify' : 'attack';
  if (g.phase === 'fortify') return 'fortify';
  return null;
}

/** Gebiet auf der Karte angetippt: Auswahl setzen oder (erneut angetippt) aufheben. */
function rkTapTerritory(id) {
  const g = S.game;
  const mode = tapMode();
  const t = g.territories[id];
  if (!mode || !t) return;
  if (mode === 'place') {
    if (t.owner !== me) return;
    rkUi.place = rkUi.place === id ? '' : id;
  } else if (mode === 'attack') {
    if (t.owner === me) {
      if (!attackSources().includes(id)) { toast(`${rkT(id)} kann nicht angreifen.`); return; }
      rkUi.to = '';
      rkUi.from = rkUi.from === id ? '' : id;
    } else if (rkUi.from) {
      if (!attackTargets(rkUi.from).includes(id)) { toast(`${rkT(id)} grenzt nicht an ${rkT(rkUi.from)}.`); return; }
      rkUi.to = rkUi.to === id ? '' : id;
    } else {
      toast('Tippe zuerst ein eigenes Gebiet an, von dem du angreifst.');
      return;
    }
  } else if (mode === 'fortify') {
    if (t.owner !== me) return;
    if (rkUi.mFrom && rkUi.mFrom !== id && fortifyTargets(rkUi.mFrom).includes(id)) {
      rkUi.mTo = rkUi.mTo === id ? '' : id;
    } else if (fortifySources().includes(id) || rkUi.mFrom === id) {
      rkUi.mTo = '';
      rkUi.mFrom = rkUi.mFrom === id ? '' : id;
    } else {
      toast(`Von ${rkT(id)} kann nichts verschoben werden.`);
      return;
    }
  }
  renderRisiko();
}

/* ---------------- Aktionskästen ---------------- */

function placeBox(title, max, hint = '') {
  const own = ownIds();
  const place = chosen('place', own);
  const count = Math.min(max, Math.max(1, Number(rkUi.placeCount) || max));
  return `<div class="box mine rk-box">
    <h2>${title}</h2>
    ${hint}
    <label>Gebiet<select id="rk-place-territory" data-rk-key="place" data-keep="no">${PLACEHOLDER}${options(own.map((id) => [id, terrLabel(id)]), place)}</select></label>
    <div class="rk-row">
      <label>Armeen<input id="rk-place-count" data-rk-key="placeCount" data-keep="no" type="number" min="1" max="${max}" value="${count}" inputmode="numeric" /></label>
      <button type="button" class="btn" data-rk-fill="placeCount" data-value="${max}">Alle (${max})</button>
    </div>
    <button type="button" id="rk-place" class="btn primary block" data-rk="place" ${place ? '' : 'disabled'}>${place ? `Nach ${rkT(place)} setzen` : 'Gebiet antippen oder wählen'}</button>
  </div>`;
}

function attackBox() {
  const g = S.game;
  const sources = attackSources();
  if (!sources.length) return '<div class="box rk-box"><h2>Angreifen</h2><p class="hint">Kein Gebiet kann angreifen: Du brauchst mindestens 2 Armeen neben einem fremden Gebiet.</p><button type="button" id="rk-end-attack" class="btn block" data-rk="endAttack" data-confirm="Angriffe wirklich beenden?">Angriff beenden</button></div>';
  const from = chosen('from', sources);
  const targets = attackTargets(from);
  const to = chosen('to', targets);
  const maxDice = from ? Math.min(3, g.territories[from].armies - 1) : 3;
  const dice = keep('dice', Array.from({ length: maxDice }, (_, i) => String(i + 1)), String(maxDice));
  return `<div class="box mine rk-box">
    <h2>Angreifen</h2>
    <label>Von<select id="rk-from" data-rk-key="from" data-keep="no">${PLACEHOLDER}${options(sources.map((id) => [id, terrLabel(id)]), from)}</select></label>
    <label>Nach<select id="rk-to" data-rk-key="to" data-keep="no" ${from ? '' : 'disabled'}>${PLACEHOLDER}${options(targets.map((id) => [id, `${terrLabel(id)} – ${rkWho(g.territories[id].owner)}`]), to)}</select></label>
    <label>Würfel<select id="rk-dice" data-rk-key="dice" data-keep="no">${options(Array.from({ length: maxDice }, (_, i) => [String(i + 1), `${i + 1} Würfel`]), dice)}</select></label>
    <button type="button" id="rk-attack" class="btn danger block" data-rk="attack" ${from && to ? '' : 'disabled'}>${from && to ? `${rkT(to)} angreifen` : 'Von und Nach antippen'}</button>
    <button type="button" id="rk-end-attack" class="btn block" data-rk="endAttack" data-confirm="Angriffe wirklich beenden?">Angriff beenden</button>
  </div>`;
}

function fortifyBox() {
  const g = S.game;
  const sources = fortifySources();
  const endBtn = '<button type="button" id="rk-end-turn" class="btn block" data-rk="endTurn" data-confirm="Zug wirklich beenden?">Zug beenden</button>';
  if (!sources.length) return `<div class="box rk-box"><h2>Verschieben</h2><p class="hint">Gerade kannst du nichts verschieben.</p>${endBtn}</div>`;
  const from = chosen('mFrom', sources);
  const targets = fortifyTargets(from);
  const to = chosen('mTo', targets);
  const max = from ? g.territories[from].armies - 1 : 1;
  const count = Math.min(max, Math.max(1, Number(rkUi.mCount) || max));
  return `<div class="box rk-box ${g.phase === 'fortify' ? 'mine' : ''}">
    <h2>Verschieben <small>(einmal, beendet den Zug)</small></h2>
    <label>Von<select id="rk-move-from" data-rk-key="mFrom" data-keep="no">${PLACEHOLDER}${options(sources.map((id) => [id, terrLabel(id)]), from)}</select></label>
    <label>Nach<select id="rk-move-to" data-rk-key="mTo" data-keep="no" ${from ? '' : 'disabled'}>${PLACEHOLDER}${options(targets.map((id) => [id, terrLabel(id)]), to)}</select></label>
    <label>Armeen<input id="rk-move-count" data-rk-key="mCount" data-keep="no" type="number" min="1" max="${max}" value="${count}" inputmode="numeric" /></label>
    <button type="button" id="rk-fortify" class="btn go block" data-rk="fortify" data-confirm="Verschieben beendet den Zug – sicher?" ${from && to ? '' : 'disabled'}>Verschieben</button>
    ${endBtn}
  </div>`;
}

function defendBox(pa) {
  const values = Array.from({ length: pa.maxDefend }, (_, i) => String(i + 1));
  const dice = keep('defend', values, String(pa.maxDefend));
  return `<div class="box warn rk-box">
    <h2>Du wirst angegriffen</h2>
    <p><b>${rkWho(S.game.turn.playerId)}</b> greift <b>${rkT(pa.to)}</b> von ${rkT(pa.from)} aus mit ${pa.dice} ${pa.dice === 1 ? 'Würfel' : 'Würfeln'} an.</p>
    <div class="rk-dice-pick" role="radiogroup" aria-label="Würfel zur Verteidigung">
      ${values.map((v) => `<label class="rk-pick ${v === dice ? 'sel' : ''}"><input type="radio" name="rk-defend" value="${v}" data-rk-key="defend" ${v === dice ? 'checked' : ''} />${v} Würfel</label>`).join('')}
    </div>
    <button type="button" id="rk-defend" class="btn primary block" data-rk="defend">Verteidigen</button>
  </div>`;
}

function occupyBox(oc) {
  const count = Math.min(oc.max, Math.max(oc.min, Number(rkUi.occupy) || oc.min));
  return `<div class="box mine rk-box">
    <h2>${rkT(oc.to)} erobert</h2>
    <p>Wie viele Armeen rücken aus ${rkT(oc.from)} nach? (${oc.min}–${oc.max})</p>
    <div class="rk-row">
      <label>Armeen<input id="rk-occupy-count" data-rk-key="occupy" data-keep="no" type="number" min="${oc.min}" max="${oc.max}" value="${count}" inputmode="numeric" /></label>
      <button type="button" class="btn" data-rk-fill="occupy" data-value="${oc.max}">Alle (${oc.max})</button>
    </div>
    <button type="button" id="rk-occupy" class="btn primary block" data-rk="occupy">Nachrücken</button>
  </div>`;
}

function cardsBox(canTrade) {
  const cards = S.game.myCards || [];
  rkUi.cards = rkUi.cards.filter((id) => cards.some((c) => c.id === id));
  if (!cards.length) return '<div class="box small rk-box">Noch keine Risikokarten – erobere ein Gebiet, dann gibt es am Zugende eine.</div>';
  const value = S.game.nextTradeValue;
  return `<div class="box rk-box">
    <h2>Deine Karten (${cards.length})</h2>
    <div class="rk-cards">
      ${cards.map((c) => `<label class="rk-card ${rkUi.cards.includes(c.id) ? 'sel' : ''}">
        <input type="checkbox" data-rk-card="${c.id}" ${rkUi.cards.includes(c.id) ? 'checked' : ''} ${canTrade ? '' : 'disabled'} />
        <span>${SYMBOL_NAMES[c.symbol]}</span><small>${c.territory ? rkT(c.territory) : 'für jedes Symbol'}</small></label>`).join('')}
    </div>
    ${canTrade ? `<button type="button" id="rk-trade" class="btn primary block" data-rk="trade" ${rkUi.cards.length === 3 ? '' : 'disabled'}>3 Karten tauschen${value ? ` (${value} Armeen)` : ''}</button>`
      : '<p class="hint">Getauscht wird zu Beginn deines Zuges.</p>'}
  </div>`;
}

function settingsBox() {
  return `<details class="box small rk-box" id="rk-settings"><summary>Einstellungen</summary>
    <label class="rk-switch"><input type="checkbox" id="rk-vibration" data-keep="no" ${rkVibrationOn() ? 'checked' : ''} /> Vibration bei Zugbeginn, Würfeln, Eroberung und Verteidigung</label>
  </details>`;
}

function statusText() {
  return S.status && S.status.text ? `${escapeHtml(S.status.text)}${S.status.detail ? ` – ${escapeHtml(S.status.detail)}` : ''}.` : '';
}

function risikoHtml() {
  const g = S.game;
  const mine = rkP(me);
  if (g.phase === 'gameover') {
    return `<div class="box center ${g.winner === me ? 'mine' : ''}">
      <h2>${g.winner === me ? 'Du hast die Welt erobert!' : `${rkWho(g.winner)} gewinnt.`}</h2><p class="hint">Die Auswertung steht auf dem Fernseher.</p></div>`;
  }
  if (mine.eliminated) return `<div class="box center"><h2>Du bist ausgeschieden.</h2><p class="hint">${statusText()}</p></div>`;

  const myTurn = g.currentId === me;
  const parts = [];
  if (g.phase === 'setup') {
    parts.push(mine.remaining > 0
      ? placeBox(`Startarmeen setzen: noch ${mine.remaining}`, mine.remaining)
      : '<div class="box center"><h2>Alle deine Armeen stehen.</h2><p class="hint">Warte, bis die anderen fertig sind.</p></div>');
  } else if (g.phase === 'defend' && g.turn.pendingAttack.defenderId === me) {
    parts.push(defendBox(g.turn.pendingAttack));
  } else if (!myTurn) {
    parts.push(`<div class="box center"><p>${statusText()}</p></div>`);
  } else if (g.phase === 'reinforce') {
    const must = mine.cards >= 5;
    const hint = must ? '<p class="rk-must">Du hast 5 oder mehr Karten und musst zuerst tauschen.</p>' : '';
    if (g.turn.reinforcements > 0 && !must) parts.push(placeBox(`Verstärken: noch ${g.turn.reinforcements}`, g.turn.reinforcements, hint));
    else parts.push(`<div class="box mine rk-box"><h2>Verstärken</h2>${hint || '<p>Tausche Karten, um Armeen zu bekommen.</p>'}</div>`);
  } else if (g.phase === 'attack') {
    parts.push(attackBox(), fortifyBox());
  } else if (g.phase === 'defend') {
    parts.push(`<div class="box center"><p>Warte, bis ${rkWho(g.turn.pendingAttack.defenderId)} die Würfel wählt …</p></div>`);
  } else if (g.phase === 'occupy') {
    parts.push(occupyBox(g.turn.occupy));
  } else if (g.phase === 'fortify') {
    parts.push(fortifyBox());
  }
  parts.push(cardsBox(myTurn && g.phase === 'reinforce'), settingsBox());
  return parts.join('');
}

/** Große Phasenanzeige oben: Was ist dran, wie weit bin ich? */
function phaseHtml() {
  const g = S.game;
  const mine = rkP(me);
  const st = S.status || {};
  const myTurn = g.currentId === me;
  let title; let detail = ''; let cls = '';
  if (g.phase === 'gameover') { title = 'Spielende'; detail = escapeHtml(st.text || ''); }
  else if (mine.eliminated) { title = 'Ausgeschieden'; detail = escapeHtml(st.text || ''); }
  else if (g.phase === 'setup') {
    title = 'Aufbau'; cls = mine.remaining ? 'mine' : '';
    detail = mine.remaining ? `Noch ${plural(mine.remaining, 'Startarmee', 'Startarmeen')} zu setzen` : 'Warte auf die anderen';
  } else if (g.phase === 'defend' && g.turn.pendingAttack.defenderId === me) {
    title = 'Verteidigen'; cls = 'warn'; detail = `${rkT(g.turn.pendingAttack.to)} wird angegriffen`;
  } else if (!myTurn) {
    const cur = rkP(g.currentId);
    title = escapeHtml(cur ? cur.name : '');
    detail = escapeHtml(st.text && cur ? st.text.replace(cur.name, '').trim() : '');
  } else {
    cls = 'mine';
    title = { reinforce: 'Verstärken', attack: 'Angreifen', defend: 'Angreifen', occupy: 'Nachrücken', fortify: 'Verschieben' }[g.phase] || '';
    if (g.phase === 'reinforce') detail = g.turn.reinforcements ? `Noch ${plural(g.turn.reinforcements, 'Armee', 'Armeen')} zu setzen` : 'Karten tauschen';
    else if (g.phase === 'attack' && rkUi.mode === 'fortify') detail = rkUi.mFrom ? (rkUi.mTo ? `${rkT(rkUi.mFrom)} → ${rkT(rkUi.mTo)}` : 'Ziel antippen') : 'Von und Nach antippen';
    else if (g.phase === 'attack') detail = rkUi.from ? (rkUi.to ? `${rkT(rkUi.from)} → ${rkT(rkUi.to)}` : 'Ziel antippen') : 'Eigenes Gebiet antippen';
    else if (g.phase === 'fortify') detail = rkUi.mFrom ? (rkUi.mTo ? `${rkT(rkUi.mFrom)} → ${rkT(rkUi.mTo)}` : 'Ziel antippen') : 'Einmal verschieben oder Zug beenden';
    else if (g.phase === 'defend') detail = 'Der Gegner wählt seine Würfel';
    else if (g.phase === 'occupy') detail = 'Armeen ins eroberte Gebiet';
  }
  return `<div class="rk-phase-inner ${cls}"><div class="rk-phase-title">${title}</div><div class="rk-phase-detail">${detail}</div></div>`;
}

/* ---------------- Karte zum Antippen ---------------- */

const rkView = { x: 0, y: 0, z: 1 };   // Verschiebung (Karteneinheiten) und Zoom der Handy-Karte
let rkMapBuilt = false;

function svgEl(tag, attrs = {}, parent = null) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  if (parent) parent.appendChild(el);
  return el;
}

function rkEnsureLayout() {
  const panel = $('#panel-risiko');
  if (panel.dataset.built) return;
  panel.dataset.built = '1';
  panel.innerHTML = `<div id="rk-phase" class="rk-phase"></div>
    <div class="rk-mapcard">
      <svg id="rk-pmap" class="rk-pmap" role="img" aria-label="Karte – Gebiete antippen"></svg>
      <div class="rk-mapbtns">
        <button type="button" class="btn" data-zoom="in" aria-label="Vergrößern">+</button>
        <button type="button" class="btn" data-zoom="out" aria-label="Verkleinern">−</button>
        <button type="button" class="btn" data-zoom="fit">Ganze Karte</button>
      </div>
    </div>
    <div id="rk-actions"></div>`;
  rkBuildMap();
}

function rkBuildMap() {
  const geo = window.RISIKO_MAP_PATHS;
  const svg = $('#rk-pmap');
  if (!geo) { svg.closest('.rk-mapcard').classList.add('hidden'); return; }
  svgEl('rect', { class: 'rk-p-ocean', x: -5000, y: -5000, width: 10000, height: 10000 }, svg);
  const view = svgEl('g', { id: 'rk-pview' }, svg);
  svgEl('path', { class: 'rk-p-other', d: geo.otherLand }, view);
  const areas = svgEl('g', {}, view);
  for (const t of S.map.territories) svgEl('path', { class: 'rk-p-area', id: `rk-pa-${t.id}`, 'data-territory': t.id, d: geo.territories[t.id].d }, areas);
  svgEl('path', { class: 'rk-p-lakes', d: geo.lakes }, view);
  const cont = svgEl('g', { class: 'rk-p-cont' }, view);
  for (const d of Object.values(geo.continents)) svgEl('path', { d }, cont);
  svgEl('g', { id: 'rk-psel' }, view);
  const labels = svgEl('g', { class: 'rk-p-labels', id: 'rk-plabels' }, view);
  for (const t of S.map.territories) svgEl('text', { id: `rk-pl-${t.id}` }, labels).textContent = t.name;
  const markers = svgEl('g', {}, view);
  for (const t of S.map.territories) {
    const g = svgEl('g', { class: 'rk-p-marker', id: `rk-pm-${t.id}`, 'data-territory': t.id }, markers);
    const inner = svgEl('g', {}, g);
    svgEl('circle', { r: geo.style.markerR }, inner);
    svgEl('text', { 'text-anchor': 'middle', dy: '0.35em' }, inner).textContent = '0';
  }
  rkMapBuilt = true;
  rkBindGestures(svg);
  if (window.ResizeObserver) new ResizeObserver(() => rkApplyView()).observe(svg);
  rkFit();
}

/** Pixel je Karteneinheit (ohne Zoom). */
function rkPpu() { return ($('#rk-pmap').clientWidth || 360) / window.RISIKO_MAP_PATHS.width; }

function rkFit() {
  const geo = window.RISIKO_MAP_PATHS;
  const svg = $('#rk-pmap');
  const vbH = (svg.clientHeight / rkPpu()) || geo.height;
  Object.assign(rkView, { z: 1, x: 0, y: (vbH - geo.height) / 2 });
  rkApplyView();
}

function rkApplyView() {
  if (!rkMapBuilt) return;
  const geo = window.RISIKO_MAP_PATHS;
  const svg = $('#rk-pmap');
  const ppu = rkPpu();
  const vbW = geo.width;
  const vbH = svg.clientHeight / ppu || geo.height;
  svg.setAttribute('viewBox', `0 0 ${vbW} ${vbH.toFixed(2)}`);
  // Verschieben begrenzen: die Karte bleibt im Bild
  const z = rkView.z;
  rkView.x = Math.min(40, Math.max(vbW - geo.width * z - 40, rkView.x));
  rkView.y = Math.min(vbH / 2, Math.max(vbH / 2 - geo.height * z, rkView.y));
  $('#rk-pview').setAttribute('transform', `translate(${rkView.x.toFixed(2)} ${rkView.y.toFixed(2)}) scale(${z.toFixed(4)})`);
  // Marker bleiben auf dem Bildschirm gleich groß; Namen ab dem Maßstab, für den ihre Lage geprüft ist
  const k = ppu * z;
  const labelsOn = k >= 0.98;
  const scale = labelsOn ? rkSizes(k).markerScale : Math.max(0.4, 7 / (geo.style.markerR * k));
  for (const [id, t] of Object.entries(geo.territories)) {
    const m = document.getElementById(`rk-pm-${id}`);
    m.setAttribute('transform', `translate(${t.marker[0]} ${t.marker[1]})`);
    m.firstChild.setAttribute('transform', `scale(${scale.toFixed(3)})`);
    if (labelsOn) {
      const pos = rkLabelPos(t, k);
      const l = document.getElementById(`rk-pl-${id}`);
      l.setAttribute('x', pos.x.toFixed(2));
      l.setAttribute('y', pos.y.toFixed(2));
      l.setAttribute('text-anchor', pos.anchor);
      l.style.fontSize = `${pos.font.toFixed(2)}px`;
    }
  }
  $('#rk-plabels').classList.toggle('hidden', !labelsOn);
}

/** Zoom um einen Punkt (in Karteneinheiten des viewBox). */
function rkZoomAt(factor, cx, cy) {
  const z = Math.max(1, Math.min(8, rkView.z * factor));
  const f = z / rkView.z;
  rkView.x = cx - (cx - rkView.x) * f;
  rkView.y = cy - (cy - rkView.y) * f;
  rkView.z = z;
  rkApplyView();
}

/** Ein Finger verschiebt, zwei Finger zoomen, kurzes Tippen wählt ein Gebiet. */
function rkBindGestures(svg) {
  const pts = new Map();
  let start = null;
  let pinch = null;
  const local = (e) => { const r = svg.getBoundingClientRect(); const ppu = rkPpu(); return [(e.clientX - r.left) / ppu, (e.clientY - r.top) / ppu]; };
  svg.addEventListener('pointerdown', (e) => {
    try { svg.setPointerCapture(e.pointerId); } catch (_) { /* egal */ }
    pts.set(e.pointerId, local(e));
    if (pts.size === 1) start = { p: local(e), view: { ...rkView }, t: Date.now(), moved: false, client: [e.clientX, e.clientY] };
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: rkView.z, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], view: { ...rkView } };
      if (start) start.moved = true;
    }
  });
  svg.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, local(e));
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const z = Math.max(1, Math.min(8, pinch.z * (d / (pinch.d || 1))));
      const f = z / pinch.z;
      rkView.z = z;
      rkView.x = mid[0] - (pinch.mid[0] - pinch.view.x) * f;
      rkView.y = mid[1] - (pinch.mid[1] - pinch.view.y) * f;
      rkApplyView();
    } else if (start && pts.size === 1) {
      const p = local(e);
      if (Math.hypot(e.clientX - start.client[0], e.clientY - start.client[1]) > 8) start.moved = true;
      if (start.moved) {
        rkView.x = start.view.x + (p[0] - start.p[0]);
        rkView.y = start.view.y + (p[1] - start.p[1]);
        rkApplyView();
      }
    }
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 0 && start) {
      const tap = !start.moved && Date.now() - start.t < 600;
      start = null;
      if (tap && e.type === 'pointerup') {
        const hit = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.closest && el.closest('[data-territory]'));
        if (hit) rkTapTerritory(hit.closest('[data-territory]').dataset.territory);
      }
    }
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [x, y] = local(e);
    rkZoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, x, y);
  }, { passive: false });
}

/** Besitzfarben, Zahlen und Auswahl auf der Handy-Karte. */
function rkUpdateMap() {
  if (!rkMapBuilt) return;
  const g = S.game;
  for (const [id, t] of Object.entries(g.territories)) {
    document.getElementById(`rk-pa-${id}`).style.fill = rkToneOf(t.owner);
    const m = document.getElementById(`rk-pm-${id}`);
    const text = m.querySelector('text');
    if (text.textContent !== String(t.armies)) text.textContent = String(t.armies);
    m.classList.toggle('mine', t.owner === me);
  }
  const mode = tapMode();
  const sel = [];
  if (mode === 'place' && rkUi.place) sel.push([rkUi.place, 'from']);
  if (mode === 'attack' && rkUi.from) {
    sel.push([rkUi.from, 'from']);
    for (const id of attackTargets(rkUi.from)) sel.push([id, id === rkUi.to ? 'to attack' : 'target']);
  }
  if (mode === 'fortify' && rkUi.mFrom) {
    sel.push([rkUi.mFrom, 'from']);
    for (const id of fortifyTargets(rkUi.mFrom)) sel.push([id, id === rkUi.mTo ? 'to' : 'target']);
  }
  const layer = $('#rk-psel');
  const key = sel.map((x) => x.join(':')).join(',');
  if (layer.dataset.key === key) return;
  layer.dataset.key = key;
  layer.innerHTML = '';
  const geo = window.RISIKO_MAP_PATHS;
  // Ziele zuerst, damit Von und Nach obenauf liegen
  const ordered = [...sel.filter((x) => x[1] === 'target'), ...sel.filter((x) => x[1] !== 'target')];
  for (const [id, cls] of ordered) svgEl('path', { d: geo.territories[id].d, class: `rk-p-sel ${cls}` }, layer);
}

/* ---------------- Vibration ---------------- */

function rkVibrationOn() {
  try { return localStorage.getItem(VIBRATION_KEY) !== 'aus'; } catch (_) { return true; }
}
function rkVibrate(pattern) {
  if (!rkVibrationOn() || typeof navigator.vibrate !== 'function') return;
  try { navigator.vibrate(pattern); } catch (_) { /* nicht verfügbar */ }
}

const rkSeen = { seq: null, turnOf: null, defend: null };
/** Vibration bei Zugbeginn, Würfeln, Eroberung und geforderter Verteidigung – zeitgleich mit dem Fernseher. */
function rkHaptics() {
  const g = S.game;
  const anim = S.anim || { seq: 0, events: [] };
  if (rkSeen.seq === null) { rkSeen.seq = anim.seq; rkSeen.turnOf = g.currentId; return; }
  for (const e of anim.events) {
    if (e.seq <= rkSeen.seq) continue;
    rkSeen.seq = e.seq;
    const later = (pattern) => setTimeout(() => rkVibrate(pattern), Math.max(0, e.at - clock.now()));
    if (e.type === 'battle' && (e.attackerId === me || e.defenderId === me)) later([30, 60, 30]);
    if (e.type === 'conquer' && (e.owner === me || e.previous === me)) later(e.owner === me ? [60, 40, 120] : [200]);
  }
  if (g.currentId !== rkSeen.turnOf) {
    rkSeen.turnOf = g.currentId;
    if (g.currentId === me) rkVibrate([80, 60, 80]);
  }
  const defendKey = g.phase === 'defend' && g.turn.pendingAttack.defenderId === me ? JSON.stringify(g.turn.pendingAttack) : null;
  if (defendKey && defendKey !== rkSeen.defend) rkVibrate([150, 80, 150]);
  rkSeen.defend = defendKey;
}

/* ---------------- Darstellung ---------------- */

function renderRisiko() {
  const p = lobbyMe();
  const g = S.game;
  const mine = rkP(me);
  if (!p || !mine) return;
  ['wait', 'turn', 'props', 'trade', 'mini'].forEach((k) => $(`#panel-${k}`).classList.add('hidden'));
  $('#tabs').classList.add('hidden');
  $('#panel-risiko').classList.remove('hidden');
  document.body.classList.add('risiko-mode');
  rkEnsureLayout();
  document.documentElement.style.setProperty('--me', p.color);
  setMeAvatar(p);
  $('#me-name').textContent = p.name;
  $('#me-money').textContent = `${mine.territories} Gebiete · ${mine.armies} Armeen`;
  const cur = g.currentId ? rkP(g.currentId) : null;
  const t = $('#turn-name');
  t.textContent = g.phase === 'gameover' ? 'Spielende' : (g.phase === 'setup' ? 'Aufbau' : (cur.id === me ? 'Du!' : cur.name));
  t.classList.toggle('mine', Boolean(cur) && cur.id === me);
  rkHaptics();
  // Wie bei Monopoly: erst weiter, wenn der Fernseher die Animation gezeigt hat
  clearTimeout(renderRisiko.hold);
  const left = (S.animUntil || 0) - clock.now();
  const hold = left > 0 && g.phase !== 'gameover';
  patch($('#rk-phase'), hold
    ? '<div class="rk-phase-inner"><div class="rk-phase-title">Schau auf den Fernseher</div><div class="rk-phase-detail">Gleich geht es weiter</div></div>'
    : phaseHtml());
  rkUpdateMap();
  if (hold) {
    patch($('#rk-actions'), `<div class="box center rk-hold"><p class="hint">${statusText()}</p></div>`);
    renderRisiko.hold = setTimeout(renderRisiko, left + 60);
    rkSyncPreview(true);
    return;
  }
  patch($('#rk-actions'), risikoHtml());
  rkSyncPreview();
}

/**
 * Vorauswahl an den Server (nur Anzeige auf dem Fernseher). Gesendet wird nur bei
 * Änderungen; ohne Auswahl, außerhalb des eigenen Zuges oder während der Wartezeit wird sie aufgehoben.
 */
function rkSyncPreview(hold = false) {
  const g = S.game;
  let pv = null;
  if (!hold && g.currentId === me) {
    if (g.phase === 'reinforce' && rkUi.place) pv = { mode: 'place', from: rkUi.place };
    else if (g.phase === 'attack' && rkUi.mode === 'attack' && rkUi.from) pv = { mode: 'attack', from: rkUi.from, to: rkUi.to || null };
    else if ((g.phase === 'attack' || g.phase === 'fortify') && rkUi.mode === 'fortify' && rkUi.mFrom) pv = { mode: 'fortify', from: rkUi.mFrom, to: rkUi.mTo || null };
    else if (g.phase === 'fortify' && rkUi.mFrom) pv = { mode: 'fortify', from: rkUi.mFrom, to: rkUi.mTo || null };
  }
  const key = JSON.stringify(pv);
  if (key === (rkSyncPreview.last ?? 'null')) return;
  rkSyncPreview.last = key;
  socket.emit('act', { type: 'preview', ...(pv || {}) }, () => {});
}

/* ---------------- Eingaben ---------------- */

$('#panel-risiko').addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 'rk-vibration') {
    try { localStorage.setItem(VIBRATION_KEY, el.checked ? 'an' : 'aus'); } catch (_) { /* privat-Modus */ }
    if (el.checked) rkVibrate(40);
    return;
  }
  if (el.dataset.rkCard) {
    const id = el.dataset.rkCard;
    rkUi.cards = el.checked ? [...rkUi.cards, id].slice(-3) : rkUi.cards.filter((c) => c !== id);
  } else if (el.dataset.rkKey) {
    rkUi[el.dataset.rkKey] = el.value;
    if (['from', 'to'].includes(el.dataset.rkKey)) rkUi.mode = 'attack';
    if (['mFrom', 'mTo'].includes(el.dataset.rkKey)) rkUi.mode = 'fortify';
  }
  renderRisiko();
});

$('#panel-risiko').addEventListener('input', (e) => {
  if (e.target.type === 'number' && e.target.dataset.rkKey) rkUi[e.target.dataset.rkKey] = e.target.value;
});

/** Unumkehrbare Aktionen brauchen ein zweites Tippen innerhalb von 4 Sekunden. */
function rkArm(b) {
  if (b.dataset.armed) return true;
  $$('[data-armed]').forEach((x) => { delete x.dataset.armed; x.textContent = x.dataset.label; x.classList.remove('armed'); });
  b.dataset.label = b.textContent;
  b.dataset.armed = '1';
  b.classList.add('armed');
  b.textContent = `${b.dataset.confirm} Nochmal tippen`;
  clearTimeout(rkArm.t);
  rkArm.t = setTimeout(() => {
    if (b.isConnected && b.dataset.armed) { delete b.dataset.armed; b.textContent = b.dataset.label; b.classList.remove('armed'); }
  }, 4000);
  return false;
}

$('#panel-risiko').addEventListener('click', async (e) => {
  const zoom = e.target.closest('[data-zoom]');
  if (zoom) {
    const geo = window.RISIKO_MAP_PATHS;
    const vbH = $('#rk-pmap').clientHeight / rkPpu();
    if (zoom.dataset.zoom === 'fit') rkFit();
    else rkZoomAt(zoom.dataset.zoom === 'in' ? 1.6 : 1 / 1.6, geo.width / 2, vbH / 2);
    return;
  }
  const fill = e.target.closest('[data-rk-fill]');
  if (fill) { rkUi[fill.dataset.rkFill] = fill.dataset.value; renderRisiko(); return; }
  const b = e.target.closest('[data-rk]');
  if (!b || b.disabled) return;
  if (b.dataset.confirm && !rkArm(b)) return;
  const num = (sel) => Number($(sel)?.value);
  const actions = {
    place: () => ({ type: 'place', territory: rkUi.place, count: num('#rk-place-count') }),
    attack: () => ({ type: 'attack', from: rkUi.from, to: rkUi.to, dice: Number(rkUi.dice) }),
    endAttack: () => ({ type: 'endAttack' }),
    defend: () => ({ type: 'defend', dice: Number(rkUi.defend) }),
    occupy: () => ({ type: 'occupy', count: num('#rk-occupy-count') }),
    fortify: () => ({ type: 'fortify', from: rkUi.mFrom, to: rkUi.mTo, count: num('#rk-move-count') }),
    endTurn: () => ({ type: 'endTurn' }),
    trade: () => ({ type: 'trade', cards: rkUi.cards.slice() }),
  };
  const make = actions[b.dataset.rk];
  if (!make) return;
  b.disabled = true;
  const res = await act(make());
  if (res.ok) {
    if (b.dataset.rk === 'trade') rkUi.cards = [];
    if (b.dataset.rk === 'endAttack') rkUi.mode = 'fortify';
    if (['endTurn', 'fortify'].includes(b.dataset.rk)) Object.assign(rkUi, { from: '', to: '', mFrom: '', mTo: '', mode: 'attack' });
    rkUi.placeCount = '';
    rkUi.occupy = '';
    rkUi.mCount = '';
    rkUi.defend = '';
  }
  b.disabled = false;
});
