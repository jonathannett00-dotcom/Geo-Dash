'use strict';

/* =========================================================
 *  Handy: Risiko-Controller. Die Listen filtern nur die Auswahl
 *  vor; ob eine Aktion erlaubt ist, entscheidet der Server (act).
 * ========================================================= */

/** Auswahl auf dem Handy (bleibt zwischen Snapshots erhalten). */
const rkUi = { place: '', placeCount: '', from: '', to: '', dice: '', defend: '', occupy: '', mFrom: '', mTo: '', mCount: '', cards: [] };

const SYMBOL_ICONS = { infanterie: '🪖 Infanterie', kavallerie: '🐎 Kavallerie', artillerie: '💣 Artillerie', joker: '🃏 Joker' };

const rkMap = () => Object.fromEntries(S.map.territories.map((t) => [t.id, t]));
const rkP = (id) => S.game.players.find((p) => p.id === id);
const rkWho = (id) => (S.game.neutral && id === S.game.neutral.id ? 'Neutral' : escapeHtml(rkP(id)?.name || '?'));
const rkT = (id) => escapeHtml(S.map.territories.find((t) => t.id === id)?.name || id);

/** Wählt den gemerkten Wert, falls er noch gültig ist, sonst den ersten. */
function keep(key, values, fallback = values[0]) {
  if (!values.includes(rkUi[key])) rkUi[key] = fallback === undefined ? '' : fallback;
  return rkUi[key];
}

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

function placeBox(title, max, hint = '') {
  const own = ownIds();
  const place = keep('place', own);
  const count = Math.min(max, Math.max(1, Number(rkUi.placeCount) || max));
  return `<div class="box mine rk-box">
    <h2>${title}</h2>
    ${hint}
    <label>Gebiet<select id="rk-place-territory" data-rk-key="place" data-keep="no">${options(own.map((id) => [id, terrLabel(id)]), place)}</select></label>
    <div class="rk-row">
      <label>Armeen<input id="rk-place-count" data-rk-key="placeCount" data-keep="no" type="number" min="1" max="${max}" value="${count}" inputmode="numeric" /></label>
      <button type="button" class="btn" data-rk-fill="placeCount" data-value="${max}">Alle (${max})</button>
    </div>
    <button type="button" id="rk-place" class="btn primary block" data-rk="place">Setzen</button>
  </div>`;
}

function attackBox() {
  const g = S.game;
  const map = rkMap();
  const sources = ownIds().filter((id) => g.territories[id].armies >= 2 && map[id].neighbors.some((n) => g.territories[n].owner !== me));
  if (!sources.length) return '<div class="box rk-box"><h2>Angreifen</h2><p class="hint">Kein Gebiet kann angreifen: Du brauchst mindestens 2 Armeen neben einem fremden Gebiet.</p></div>';
  const from = keep('from', sources);
  const targets = map[from].neighbors.filter((n) => g.territories[n].owner !== me);
  const to = keep('to', targets);
  const maxDice = Math.min(3, g.territories[from].armies - 1);
  const dice = keep('dice', Array.from({ length: maxDice }, (_, i) => String(i + 1)), String(maxDice));
  return `<div class="box mine rk-box">
    <h2>⚔️ Angreifen</h2>
    <label>Von<select id="rk-from" data-rk-key="from" data-keep="no">${options(sources.map((id) => [id, terrLabel(id)]), from)}</select></label>
    <label>Nach<select id="rk-to" data-rk-key="to" data-keep="no">${options(targets.map((id) => [id, `${terrLabel(id)} – ${rkWho(g.territories[id].owner)}`]), to)}</select></label>
    <label>Würfel<select id="rk-dice" data-rk-key="dice" data-keep="no">${options(Array.from({ length: maxDice }, (_, i) => [String(i + 1), `${i + 1} Würfel`]), dice)}</select></label>
    <button type="button" id="rk-attack" class="btn danger block" data-rk="attack">Angreifen</button>
    <button type="button" id="rk-end-attack" class="btn block" data-rk="endAttack">Angriff beenden</button>
  </div>`;
}

function fortifyBox() {
  const g = S.game;
  const map = rkMap();
  const reach = (id) => (g.settings.fortify === 'verbunden' ? connectedOwn(id) : map[id].neighbors.filter((n) => g.territories[n].owner === me));
  const sources = ownIds().filter((id) => g.territories[id].armies >= 2 && reach(id).length);
  const endBtn = '<button type="button" id="rk-end-turn" class="btn block" data-rk="endTurn">Zug beenden</button>';
  if (!sources.length) return `<div class="box rk-box"><h2>🚚 Verschieben</h2><p class="hint">Gerade kannst du nichts verschieben.</p>${endBtn}</div>`;
  const from = keep('mFrom', sources);
  const targets = reach(from);
  const to = keep('mTo', targets);
  const max = g.territories[from].armies - 1;
  const count = Math.min(max, Math.max(1, Number(rkUi.mCount) || max));
  return `<div class="box rk-box">
    <h2>🚚 Verschieben <small>(einmal, beendet den Zug)</small></h2>
    <label>Von<select id="rk-move-from" data-rk-key="mFrom" data-keep="no">${options(sources.map((id) => [id, terrLabel(id)]), from)}</select></label>
    <label>Nach<select id="rk-move-to" data-rk-key="mTo" data-keep="no">${options(targets.map((id) => [id, terrLabel(id)]), to)}</select></label>
    <label>Armeen<input id="rk-move-count" data-rk-key="mCount" data-keep="no" type="number" min="1" max="${max}" value="${count}" inputmode="numeric" /></label>
    <button type="button" id="rk-fortify" class="btn go block" data-rk="fortify">Verschieben</button>
    ${endBtn}
  </div>`;
}

function defendBox(pa) {
  const values = Array.from({ length: pa.maxDefend }, (_, i) => String(i + 1));
  const dice = keep('defend', values, String(pa.maxDefend));
  return `<div class="box warn rk-box">
    <h2>🛡️ Du wirst angegriffen!</h2>
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
    <h2>🚩 ${rkT(oc.to)} erobert!</h2>
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
  if (!cards.length) return '<div class="box small rk-box">🃏 Noch keine Risikokarten – erobere ein Gebiet, dann gibt es am Zugende eine.</div>';
  const value = S.game.nextTradeValue;
  return `<div class="box rk-box">
    <h2>🃏 Deine Karten (${cards.length})</h2>
    <div class="rk-cards">
      ${cards.map((c) => `<label class="rk-card ${rkUi.cards.includes(c.id) ? 'sel' : ''}">
        <input type="checkbox" data-rk-card="${c.id}" ${rkUi.cards.includes(c.id) ? 'checked' : ''} ${canTrade ? '' : 'disabled'} />
        <span>${SYMBOL_ICONS[c.symbol]}</span><small>${c.territory ? rkT(c.territory) : 'für jedes Symbol'}</small></label>`).join('')}
    </div>
    ${canTrade ? `<button type="button" id="rk-trade" class="btn primary block" data-rk="trade" ${rkUi.cards.length === 3 ? '' : 'disabled'}>3 Karten tauschen${value ? ` (${value} Armeen)` : ''}</button>`
      : '<p class="hint">Getauscht wird zu Beginn deines Zuges.</p>'}
  </div>`;
}

function ownListBox() {
  const g = S.game;
  const own = ownIds();
  if (!own.length) return '';
  return `<details class="box small rk-box" id="rk-own"><summary>🗺️ Deine Gebiete (${own.length})</summary>
    <ul class="rk-own">${S.map.continents.map((c) => {
      const mine = c.territories.filter((id) => g.territories[id].owner === me);
      if (!mine.length) return '';
      const full = mine.length === c.territories.length;
      return `<li><b>${escapeHtml(c.name)}${full ? ` ✅ +${c.bonus}` : ` ${mine.length}/${c.territories.length}`}</b> ${mine.map((id) => `${rkT(id)} ${g.territories[id].armies}`).join(' · ')}</li>`;
    }).join('')}</ul></details>`;
}

function statusText(g) {
  const cur = g.currentId ? rkP(g.currentId) : null;
  switch (g.phase) {
    case 'setup': return 'Aufbau: Alle setzen ihre Startarmeen.';
    case 'reinforce': return `${escapeHtml(cur.name)} verstärkt.`;
    case 'attack': return `${escapeHtml(cur.name)} greift an.`;
    case 'defend': return `${escapeHtml(cur.name)} greift ${rkT(g.turn.pendingAttack.to)} an – ${rkWho(g.turn.pendingAttack.defenderId)} verteidigt.`;
    case 'occupy': return `${escapeHtml(cur.name)} rückt nach.`;
    case 'fortify': return `${escapeHtml(cur.name)} kann verschieben.`;
    default: return '';
  }
}

function risikoHtml() {
  const g = S.game;
  const mine = rkP(me);
  if (g.phase === 'gameover') {
    return `<div class="box center ${g.winner === me ? 'mine' : ''}"><div class="huge-emoji">🏆</div>
      <h2>${g.winner === me ? 'Du hast die Welt erobert!' : `${rkWho(g.winner)} gewinnt.`}</h2></div>`;
  }
  if (mine.eliminated) return `<div class="box center"><h2>Du bist ausgeschieden.</h2><p class="hint">${statusText(g)}</p></div>${ownListBox()}`;

  const myTurn = g.currentId === me;
  const parts = [];
  const lb = g.lastBattle;
  if (lb && (lb.attackerId === me || lb.defenderId === me)) {
    parts.push(`<div class="box small rk-box">🎲 Letzter Kampf ${rkT(lb.from)} → ${rkT(lb.to)}: ${lb.attack.join('-')} gegen ${lb.defend.join('-')}, Verluste ${lb.attackerLosses}:${lb.defenderLosses}${lb.conquered ? ' – erobert' : ''}</div>`);
  }
  if (g.phase === 'setup') {
    parts.push(mine.remaining > 0
      ? placeBox(`Startarmeen setzen: noch ${mine.remaining}`, mine.remaining)
      : '<div class="box center"><h2>Alle deine Armeen stehen.</h2><p class="hint">Warte, bis die anderen fertig sind.</p></div>');
  } else if (g.phase === 'defend' && g.turn.pendingAttack.defenderId === me) {
    parts.push(defendBox(g.turn.pendingAttack));
  } else if (!myTurn) {
    parts.push(`<div class="box center"><p>${statusText(g)}</p></div>`);
  } else if (g.phase === 'reinforce') {
    const must = mine.cards >= 5;
    const hint = must ? '<p class="rk-must">Du hast 5 oder mehr Karten und musst zuerst tauschen.</p>' : '';
    if (g.turn.reinforcements > 0 && !must) parts.push(placeBox(`Verstärken: noch ${g.turn.reinforcements}`, g.turn.reinforcements, hint));
    else parts.push(`<div class="box mine rk-box"><h2>Verstärken</h2>${hint || '<p>Tausche Karten, um Armeen zu bekommen.</p>'}</div>`);
  } else if (g.phase === 'attack') {
    parts.push(attackBox(), fortifyBox());
  } else if (g.phase === 'defend') {
    parts.push(`<div class="box center"><p>Warte, bis ${rkWho(g.turn.pendingAttack.defenderId)} die Würfel wählt…</p></div>`);
  } else if (g.phase === 'occupy') {
    parts.push(occupyBox(g.turn.occupy));
  } else if (g.phase === 'fortify') {
    parts.push(fortifyBox());
  }
  parts.push(cardsBox(myTurn && g.phase === 'reinforce'), ownListBox());
  return parts.join('');
}

function renderRisiko() {
  const p = lobbyMe();
  const g = S.game;
  const mine = rkP(me);
  if (!p || !mine) return;
  ['wait', 'turn', 'props', 'trade', 'mini'].forEach((k) => $(`#panel-${k}`).classList.add('hidden'));
  $('#tabs').classList.add('hidden');
  $('#panel-risiko').classList.remove('hidden');
  document.documentElement.style.setProperty('--me', p.color);
  $('#me-fig').textContent = p.figure;
  $('#me-name').textContent = p.name;
  $('#me-money').textContent = `🗺️ ${mine.territories} · ⚔️ ${mine.armies}`;
  const cur = g.currentId ? rkP(g.currentId) : null;
  const t = $('#turn-name');
  t.textContent = g.phase === 'gameover' ? 'Spielende' : (g.phase === 'setup' ? 'Aufbau' : (cur.id === me ? 'Du!' : cur.name));
  t.classList.toggle('mine', Boolean(cur) && cur.id === me);
  patch($('#panel-risiko'), risikoHtml());
}

/* ---------------- Eingaben ---------------- */

$('#panel-risiko').addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.rkCard) {
    const id = el.dataset.rkCard;
    rkUi.cards = el.checked ? [...rkUi.cards, id].slice(-3) : rkUi.cards.filter((c) => c !== id);
  } else if (el.dataset.rkKey) {
    rkUi[el.dataset.rkKey] = el.value;
  }
  renderRisiko();
});

$('#panel-risiko').addEventListener('input', (e) => {
  if (e.target.type === 'number' && e.target.dataset.rkKey) rkUi[e.target.dataset.rkKey] = e.target.value;
});

$('#panel-risiko').addEventListener('click', async (e) => {
  const fill = e.target.closest('[data-rk-fill]');
  if (fill) { rkUi[fill.dataset.rkFill] = fill.dataset.value; renderRisiko(); return; }
  const b = e.target.closest('[data-rk]');
  if (!b || b.disabled) return;
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
    rkUi.placeCount = '';
    rkUi.occupy = '';
    rkUi.mCount = '';
    rkUi.defend = '';
  }
  b.disabled = false;
});
