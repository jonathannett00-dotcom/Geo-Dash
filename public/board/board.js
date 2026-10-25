'use strict';

/* =========================================================
 *  Tablet: Spielfeld (nur Anzeige – alle Ergebnisse kommen vom Server)
 * ========================================================= */

const BOARD_KEY = 'monopoly-board-room';
const socket = io();
let S = null;
let roomCode = null;

/* ---------------- Verbindung ---------------- */

function remember(code) {
  roomCode = code;
  try { localStorage.setItem(BOARD_KEY, code); } catch (_) { /* privat-Modus */ }
  const url = new URL(location.href);
  url.searchParams.set('room', code);
  history.replaceState(null, '', url);
}

function createRoom() {
  socket.emit('board:create', {}, (res) => {
    if (res.ok) remember(res.code);
    else toast(res.error, 'error');
  });
}

socket.on('connect', () => {
  let code = new URLSearchParams(location.search).get('room');
  if (!code) { try { code = localStorage.getItem(BOARD_KEY); } catch (_) { code = null; } }
  if (!code) { createRoom(); return; }
  socket.emit('board:watch', { code }, (res) => {
    if (res.ok) remember(res.code);
    else createRoom();
  });
});

socket.on('state', (state) => {
  clock.sync(state.now);
  S = state;
  render();
});

/** Nur für automatische Tests: Würfel vorgeben (der Server ignoriert das außerhalb des Testmodus). */
window.__debugDice = (dice) => new Promise((resolve) => socket.emit('debug:dice', { dice }, resolve));

/* ---------------- Lobby ---------------- */

let qrFor = null;

function renderLobby() {
  $('#lobby').classList.remove('hidden');
  $('#game').classList.add('hidden');
  $('#risiko').classList.add('hidden');
  $('#room-code').textContent = S.code;
  if (qrFor !== S.code) {
    qrFor = S.code;
    $('#qr').src = `/api/qr.svg?room=${S.code}`;
    fetch(`/api/join-url?room=${S.code}`).then((r) => r.json()).then((d) => { $('#join-url').textContent = d.url || ''; }).catch(() => {});
  }
  const list = S.lobby;
  $('#lobby-count').textContent = `${list.length} / ${S.maxPlayers}`;
  patch($('#lobby-players'), list.length
    ? list.map((p) => `<li style="--c:${p.color}" class="${p.connected ? '' : 'off'}"><span class="fig">${p.figure}</span>${escapeHtml(p.name)}${p.connected ? '' : ' <small>(getrennt)</small>'}</li>`).join('')
    : '<li class="empty">Noch niemand da – scannt den QR-Code!</li>');
  patch($('#game-choice'), (S.games || []).map((g) => `<button type="button" id="game-${g.id}" data-game="${g.id}" class="btn ${g.id === S.gameType ? 'primary' : 'ghost'}" aria-pressed="${g.id === S.gameType}">${GAME_ICONS[g.id] || '🎲'} ${escapeHtml(g.name)}<small>${g.minPlayers}–${g.maxPlayers} Spieler</small></button>`).join(''));
  const risiko = S.gameType === 'risiko';
  $('#settings-monopoly').classList.toggle('hidden', risiko);
  $('#settings-risiko').classList.toggle('hidden', !risiko);
  if (risiko) {
    ['cardValues', 'fortify'].forEach((k) => {
      const el = $(`#risiko-${k}`);
      if (document.activeElement !== el) el.value = S.settings[k];
    });
  } else {
    const input = $('#start-money');
    if (document.activeElement !== input) input.value = S.settings.startMoney;
  }
  const enough = list.length >= S.minPlayers;
  const tooMany = list.length > S.maxPlayers;
  $('#btn-start').disabled = !enough || tooMany;
  $('#lobby-hint').textContent = !enough
    ? `Mindestens ${S.minPlayers} Spieler werden gebraucht.`
    : (risiko ? 'Die Gebiete werden zufällig verteilt.' : `Alle starten mit ${fmtM(S.settings.startMoney)}.`);
}

const GAME_ICONS = { monopoly: '🎩', risiko: '🗺️' };

$('#game-choice').addEventListener('click', (e) => {
  const b = e.target.closest('[data-game]');
  if (!b || b.dataset.game === S?.gameType) return;
  socket.emit('board:game', { gameType: b.dataset.game }, (res) => { if (!res.ok) toast(res.error, 'error'); });
});

['cardValues', 'fortify'].forEach((k) => {
  $(`#risiko-${k}`).addEventListener('change', (e) => {
    socket.emit('board:settings', { [k]: e.target.value }, (res) => {
      if (!res.ok) { toast(res.error, 'error'); e.target.value = S.settings[k]; }
    });
  });
});

$('#start-money').addEventListener('change', (e) => {
  socket.emit('board:settings', { startMoney: Number(e.target.value) }, (res) => {
    if (!res.ok) { toast(res.error, 'error'); e.target.value = S.settings.startMoney; }
  });
});

$('#btn-start').addEventListener('click', () => {
  socket.emit('board:start', {}, (res) => { if (!res.ok) toast(res.error, 'error'); });
});

/* ---------------- Spiel: Brett ---------------- */

const ICONS = { go: '⬅️', jail: '🔒', parking: '🅿️', gotojail: '👮', chance: '❓', community: '📦', tax: '💰', railroad: '🚂' };
const LABELS = { go: 'LOS', jail: 'Gefängnis', parking: 'Frei Parken', gotojail: 'Gehe ins Gefängnis', chance: 'Ereignis', community: 'Gemeinschaft' };
const T = (key) => (S.timing[key] || 0) * (S.timing.timeScale || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let built = false;

function cellPos(i) {
  if (i <= 10) return { row: 11, col: 11 - i, side: i % 10 === 0 ? 'corner' : 'bottom' };
  if (i < 20) return { row: 21 - i, col: 1, side: 'left' };
  if (i <= 30) return { row: 1, col: i - 19, side: i % 10 === 0 ? 'corner' : 'top' };
  return { row: i - 29, col: 11, side: 'right' };
}

function buildBoard() {
  const board = $('#board');
  const html = S.board.map((sq, i) => {
    const { row, col, side } = cellPos(i);
    const color = S.groupColors[sq.group] || 'transparent';
    const icon = sq.type === 'utility' ? (sq.name.startsWith('Wasser') ? '🚰' : '💡') : (ICONS[sq.type] || '');
    // weiche Trennstelle vor dem Wortende, damit lange Namen sauber umbrechen
    const label = (LABELS[sq.type] || sq.name).replace(/(straße|allee|platz|bahnhof|werk|steuer)$/i, '\u00AD$1');
    const price = sq.price ? fmtM(sq.price) : (sq.amount ? fmtM(sq.amount) : '');
    return `<div class="cell side-${side} type-${sq.type}" id="cell-${i}" style="grid-row:${row};grid-column:${col};--g:${color}">
      ${sq.type === 'street' ? '<div class="cbar"><span class="houses"></span></div>' : ''}
      <div class="cbody">
        ${icon ? `<div class="cicon">${icon}</div>` : ''}
        <div class="cname">${escapeHtml(label)}</div>
        ${price ? `<div class="cprice">${price}</div>` : ''}
      </div>
    </div>`;
  }).join('');
  board.insertAdjacentHTML('afterbegin', html);
  const center = $('#center-main');
  center.innerHTML = `
    <div class="cm-title">Monopoly-Abend</div>
    <div id="cm-turn" class="cm-turn"></div>
    <div class="dice" id="dice"><div class="die" id="die-0"></div><div class="die" id="die-1"></div></div>
    <div id="cm-status" class="cm-status"></div>
    <ul id="ticker" class="ticker"></ul>`;
  setDie(0, 1);
  setDie(1, 1);
  built = true;
  window.addEventListener('resize', layoutTokens);
}

/* ---------------- Würfel ---------------- */

const PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
function setDie(k, v) {
  $(`#die-${k}`).innerHTML = Array.from({ length: 9 }, (_, i) => `<i class="${PIPS[v].includes(i + 1) ? 'on' : ''}"></i>`).join('');
}

let lastRollSeq = null;
let diceDone = Promise.resolve();

function syncDice(g) {
  const r = g.lastRoll;
  if (!r) return;
  if (lastRollSeq === null) { lastRollSeq = r.seq; setDie(0, r.dice[0]); setDie(1, r.dice[1]); return; }
  if (r.seq === lastRollSeq) return;
  lastRollSeq = r.seq;
  const dice = $('#dice');
  dice.classList.add('rolling');
  dice.classList.remove('doubles');
  diceRolling = true;
  const dur = T('dice');
  const t0 = performance.now();
  diceDone = new Promise((resolve) => {
    dice.classList.remove('landed');
    (function spin() {
      const t = performance.now() - t0;
      if (t < dur - 380) {
        setDie(0, 1 + Math.floor(Math.random() * 6));
        setDie(1, 1 + Math.floor(Math.random() * 6));
        // Würfel werden zum Ende hin langsamer
        setTimeout(spin, 90 + (t / dur) * 160);
      } else {
        setDie(0, r.dice[0]);
        setDie(1, r.dice[1]);
        dice.classList.remove('rolling');
        dice.classList.toggle('doubles', r.doubles);
        restartAnim(dice, 'landed');
        setTimeout(() => { diceRolling = false; resolve(); flushDeferred(); }, 380);
      }
    })();
  });
}

/* ---------------- Figuren ---------------- */

const shown = {};       // angezeigte Position je Spieler
let lastMoveSeq = null;
const moveQueue = [];
let moving = false;

function layoutTokens() {
  if (!S || !S.game) return;
  const layer = $('#tokens');
  layer.style.setProperty('--tstep', `${Math.round(T('step'))}ms`);
  layer.style.setProperty('--tjump', `${Math.round(T('jump'))}ms`);
  const boardRect = $('#board').getBoundingClientRect();
  const unit = Math.min(boardRect.width, boardRect.height) / 12.1;
  const size = Math.max(16, unit * 0.46);
  const bySquare = {};
  S.game.players.filter((p) => !p.bankrupt).forEach((p) => { (bySquare[shown[p.id]] = bySquare[shown[p.id]] || []).push(p); });
  S.game.players.forEach((p) => {
    let el = document.getElementById(`tok-${p.id}`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'token';
      el.id = `tok-${p.id}`;
      el.style.setProperty('--c', p.color);
      el.innerHTML = `<span class="tok-in">${p.figure}</span>`;
      layer.appendChild(el);
    }
    el.classList.toggle('hidden', p.bankrupt);
    el.classList.toggle('jailed', p.inJail && shown[p.id] === 10);
    el.classList.toggle('current', p.id === S.game.currentId);
    if (p.bankrupt) return;
    const group = bySquare[shown[p.id]] || [p];
    const k = group.indexOf(p);
    const cell = document.getElementById(`cell-${shown[p.id]}`).getBoundingClientRect();
    const cols = Math.min(group.length, 3);
    const rows = Math.ceil(group.length / 3);
    const gap = size * 0.78;
    const cx = cell.left - boardRect.left + cell.width / 2 + ((k % 3) - (cols - 1) / 2) * gap;
    const cy = cell.top - boardRect.top + cell.height / 2 + (Math.floor(k / 3) - (rows - 1) / 2) * gap;
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.fontSize = `${size * 0.6}px`;
    el.style.transform = `translate(${(cx - size / 2).toFixed(1)}px, ${(cy - size / 2).toFixed(1)}px)`;
  });
}

function syncMoves(g) {
  if (lastMoveSeq === null) {
    g.players.forEach((p) => { shown[p.id] = p.position; });
    lastMoveSeq = g.moves.reduce((m, x) => Math.max(m, x.seq), 0);
    layoutTokens();
    return;
  }
  g.moves.forEach((m) => {
    if (m.seq > lastMoveSeq) { moveQueue.push(m); lastMoveSeq = m.seq; }
  });
  runMoves();
}

async function runMoves() {
  if (moving) return;
  moving = true;
  while (moveQueue.length) {
    await diceDone;
    const m = moveQueue.shift();
    const tok = document.getElementById(`tok-${m.playerId}`);
    if (tok) tok.classList.add('moving');
    if (m.mode === 'jump') {
      if (tok) tok.classList.add('jumping');
      shown[m.playerId] = m.to;
      layoutTokens();
      await sleep(T('jump'));
      if (tok) tok.classList.remove('jumping');
    } else {
      const dir = m.mode === 'back' ? -1 : 1;
      for (let k = 0; k < m.steps; k++) {
        shown[m.playerId] = (shown[m.playerId] + dir + 40) % 40;
        restartAnim(tok, 'hop');
        layoutTokens();
        await sleep(T('step'));
      }
      restartAnim(tok, 'land');
      highlightCell(shown[m.playerId]);
      await sleep(T('land'));
    }
    if (tok) tok.classList.remove('moving', 'hop');
  }
  moving = false;
  S.game.players.forEach((p) => { shown[p.id] = p.position; });
  layoutTokens();
  flushDeferred();
  showPendingCard();
}

/** Startet eine CSS-Animation neu (Klasse kurz entfernen und wieder setzen). */
function restartAnim(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

/** Feld, auf dem eine Figur landet, kurz aufleuchten lassen. */
function highlightCell(i) {
  restartAnim(document.getElementById(`cell-${i}`), 'pulse');
}

/* ---------------- Felder (Besitz, Häuser) ---------------- */

const shownOwner = {};

function renderCells(g) {
  g.props.forEach((st, i) => {
    if (!st) return;
    const cell = document.getElementById(`cell-${i}`);
    const owner = st.owner ? g.players.find((p) => p.id === st.owner) : null;
    cell.classList.toggle('owned', Boolean(owner));
    if (i in shownOwner && shownOwner[i] !== st.owner && owner) restartAnim(cell, 'flash');
    shownOwner[i] = st.owner;
    cell.classList.toggle('mortgaged', st.mortgaged);
    cell.style.setProperty('--owner', owner ? owner.color : 'transparent');
    const houses = cell.querySelector('.houses');
    if (houses) {
      const html = st.houses === 5 ? '<b class="hotel"></b>' : '<b class="house"></b>'.repeat(st.houses);
      if (houses.innerHTML !== html) houses.innerHTML = html;
    }
  });
  $$('.cell.landed').forEach((c) => c.classList.remove('landed'));
  const cur = g.players.find((p) => p.id === g.currentId);
  if (cur && !moving) document.getElementById(`cell-${cur.position}`).classList.add('landed');
}

/* ---------------- Spielerleiste ---------------- */

const shownMoney = {};

function renderSidebar(g) {
  const wrap = $('#side-players');
  g.players.forEach((p) => {
    let card = document.getElementById(`ps-${p.id}`);
    if (!card) {
      card = document.createElement('div');
      card.className = 'ps';
      card.id = `ps-${p.id}`;
      card.style.setProperty('--c', p.color);
      card.innerHTML = `<div class="ps-top"><span class="ps-fig">${p.figure}</span><span class="ps-name">${escapeHtml(p.name)}</span><span class="ps-status"></span></div>
        <div class="ps-money-wrap"><span class="ps-money money"></span></div><div class="ps-props"></div>`;
      wrap.appendChild(card);
    }
    const lobby = S.lobby.find((l) => l.id === p.id);
    const offline = lobby && !lobby.connected && !p.bankrupt;
    card.classList.toggle('current', p.id === g.currentId && g.phase !== 'gameover');
    card.classList.toggle('bankrupt', p.bankrupt);
    card.classList.toggle('offline', Boolean(offline));
    const badges = [];
    if (p.bankrupt) badges.push(`<b class="bad">${p.quit ? 'aufgegeben' : 'pleite'}</b>`);
    else {
      if (p.inJail) badges.push('<b class="jail">🔒 Gefängnis</b>');
      if (offline) badges.push('<b class="off">📴 getrennt</b>');
      if (p.jailCards) badges.push(`<b title="Gefängnis-Freikarten">🎫${p.jailCards > 1 ? `×${p.jailCards}` : ''}</b>`);
    }
    patch(card.querySelector('.ps-status'), badges.join(''));
    const moneyEl = card.querySelector('.ps-money');
    if (shownMoney[p.id] !== p.money) {
      animateMoney(moneyEl, shownMoney[p.id], p.money, card.querySelector('.ps-money-wrap'));
      shownMoney[p.id] = p.money;
    }
    const owned = g.props.map((st, i) => (st && st.owner === p.id ? i : -1)).filter((i) => i >= 0);
    patch(card.querySelector('.ps-props'), owned.map((i) => {
      const st = g.props[i];
      const h = st.houses === 5 ? 'H' : (st.houses || '');
      return `<span class="pb ${st.mortgaged ? 'mort' : ''}" style="--g:${S.groupColors[S.board[i].group]}" title="${escapeHtml(S.board[i].name)}">${h}</span>`;
    }).join(''));
  });
}

/* ---------------- Brettmitte ---------------- */

const nameOf = (g, id) => (id ? escapeHtml(g.players.find((p) => p.id === id)?.name || '?') : 'die Bank');

function propertyCard(i) {
  const sq = S.board[i];
  const color = S.groupColors[sq.group];
  let rows = '';
  if (sq.type === 'street') {
    const labels = ['Miete', 'mit 1 Haus', 'mit 2 Häusern', 'mit 3 Häusern', 'mit 4 Häusern', 'mit Hotel'];
    rows = sq.rent.map((r, k) => `<tr><td>${labels[k]}</td><td>${fmtM(r)}</td></tr>`).join('') + `<tr><td>Hauspreis</td><td>${fmtM(sq.house)}</td></tr>`;
  } else if (sq.type === 'railroad') {
    rows = [25, 50, 100, 200].map((r, k) => `<tr><td>${k + 1} Bahnhof${k ? 'e' : ''}</td><td>${fmtM(r)}</td></tr>`).join('');
  } else {
    rows = '<tr><td>1 Werk</td><td>4× Augen</td></tr><tr><td>2 Werke</td><td>10× Augen</td></tr>';
  }
  return `<div class="deed"><div class="deed-head" style="--g:${color}">${escapeHtml(sq.name)}</div>
    <table>${rows}</table><div class="deed-price">Preis ${fmtM(sq.price)}</div></div>`;
}

function statusHtml(g) {
  const cur = g.players.find((p) => p.id === g.currentId);
  const name = escapeHtml(cur.name);
  if (g.phase === 'gameover') {
    const w = g.players.find((p) => p.id === g.winner);
    return `<div class="st-win">🏆 ${w ? `${escapeHtml(w.name)} gewinnt das Spiel!` : 'Spiel beendet'}</div>`;
  }
  if (S.paused) {
    const who = g.phase === 'debt' && g.debts[0] ? nameOf(g, g.debts[0].debtorId) : name;
    return `<div class="st-pause">⏸ ${who} ist getrennt – der Zug ist pausiert, bis das Handy wieder verbunden ist.</div>`;
  }
  switch (g.phase) {
    case 'roll': return `<div class="st-line">🎲 ${name} würfelt…</div>`;
    case 'end': return `<div class="st-line st-end">✋ ${name} ist mit Würfeln fertig – kann noch bauen oder handeln und beendet den Zug am Handy.</div>`;
    case 'jail': return `<div class="st-line">🔒 ${name} sitzt im Gefängnis und entscheidet am Handy: ${fmtM(50)} zahlen, Freikarte oder auf einen Pasch würfeln (Versuch ${cur.jailRolls + 1} von 3).</div>`;
    case 'buy': return `<div class="st-row">${propertyCard(g.turn.buyOffer)}<div class="st-line">🤔 ${name} überlegt, ob gekauft wird…</div></div>`;
    case 'auction': {
      const a = g.auction;
      const left = g.players.filter((p) => !p.bankrupt && !a.passed.includes(p.id)).map((p) => escapeHtml(p.name)).join(', ');
      return `<div class="st-row">${propertyCard(a.square)}<div class="auction">
        <div class="au-title">🔨 Versteigerung</div>
        <div class="au-bid">${a.bidderId ? fmtM(a.bid) : '–'}</div>
        <div class="au-by">${a.bidderId ? `Höchstgebot von ${nameOf(g, a.bidderId)}` : 'Noch kein Gebot – Mindestgebot 10 M'}</div>
        <div class="au-time">⏱ <span data-ends="${a.endsAt}"></span></div>
        <div class="au-left">Bieten noch mit: ${left || '–'}</div></div></div>`;
    }
    case 'debt': {
      const d = g.debts[0];
      return `<div class="st-line">💸 ${nameOf(g, d.debtorId)} muss ${fmtM(d.amount)} an ${nameOf(g, d.creditorId)} zahlen und verkauft Häuser oder nimmt Hypotheken auf…</div>`;
    }
    case 'minigame': return '<div class="st-line">🎰 Gleich startet ein Minispiel für alle!</div>';
    default: return '';
  }
}

const TICKER_ICONS = { buy: '🏠', rent: '💸', card: '🃏', trade: '🤝', jail: '🔒', auction: '🔨', build: '🏗️', mortgage: '🏦', bankrupt: '💥', money: '💰', tax: '💰', debt: '⚠️', dice: '🎲', turn: '▶️', win: '🏆', minigame: '🎰', land: '📍' };

function renderCenter(g) {
  const cur = g.players.find((p) => p.id === g.currentId);
  patch($('#cm-turn'), g.phase === 'gameover' ? '' : `<span class="tf" style="--c:${cur.color}">${cur.figure}</span> <b>${escapeHtml(cur.name)}</b> ist am Zug`);
  patch($('#cm-status'), statusHtml(g));
  patch($('#ticker'), g.log.slice(-7).reverse().map((e) =>
    `<li class="k-${e.kind}">${/^\p{Extended_Pictographic}/u.test(e.text) ? '' : `<span>${TICKER_ICONS[e.kind] || '•'}</span>`}${escapeHtml(e.text)}</li>`).join(''));
}

/* Ereignis-/Gemeinschaftskarte groß einblenden, sobald die Figur angekommen ist. */
let lastCardSeq = null;
let pendingCard = null;

function syncCard(g) {
  const c = g.lastCard;
  if (!c) return;
  if (lastCardSeq === null) { lastCardSeq = c.seq; return; }
  if (c.seq === lastCardSeq) return;
  lastCardSeq = c.seq;
  pendingCard = c;
  if (!moving) diceDone.then(showPendingCard);
}

function showPendingCard() {
  if (!pendingCard) return;
  const c = pendingCard;
  pendingCard = null;
  const el = $('#card-pop');
  const who = S.game.players.find((p) => p.id === c.playerId);
  el.innerHTML = `<div class="gcard ${c.deck}"><div class="gc-title">${c.deck === 'chance' ? '❓' : '📦'} ${escapeHtml(c.title)}</div>
    <div class="gc-text">${escapeHtml(c.text)}</div><div class="gc-who">${who ? escapeHtml(who.name) : ''}</div></div>`;
  el.classList.remove('hidden', 'leaving');
  clearTimeout(showPendingCard.t);
  clearTimeout(showPendingCard.t2);
  showPendingCard.t = setTimeout(() => el.classList.add('leaving'), 7000);
  showPendingCard.t2 = setTimeout(() => el.classList.add('hidden'), 7600);
}

let diceRolling = false;
let deferred = false;
const animBusy = () => diceRolling || moving || moveQueue.length > 0;

function renderSettled(g) {
  renderCells(g);
  renderSidebar(g);
  renderCenter(g);
}

/** Nach Würfel- bzw. Figurenanimation den zurückgehaltenen Stand zeigen. */
function flushDeferred() {
  if (!deferred || animBusy() || !S || !S.game) return;
  deferred = false;
  renderSettled(S.game);
  tickCountdowns();
}

function renderGame() {
  $('#lobby').classList.add('hidden');
  $('#risiko').classList.add('hidden');
  $('#game').classList.remove('hidden');
  $('#side-code').textContent = S.code;
  if (!built) buildBoard();
  const g = S.game;
  syncDice(g);
  syncMoves(g);
  syncCard(g);
  // Ergebnis des Wurfs (Kaufangebot, Miete, Ticker) erst zeigen, wenn die Figur angekommen ist
  if (animBusy()) deferred = true;
  else renderSettled(g);
  renderStage();
  layoutTokens();
  tickCountdowns();
}

/* ================= Minispiele in der Brettmitte ================= */

let stageId = null;
let stageCleanup = null;

function renderStage() {
  const m = S.mini;
  const stage = $('#stage');
  $('#stage').classList.toggle('hidden', !m);
  $('#center-main').classList.toggle('hidden', Boolean(m));
  if (!m) {
    if (stageId !== null) resetStage(null);
    return;
  }
  if (stageId !== m.id) resetStage(m.id);
  const fn = STAGES[m.type];
  if (fn) fn(m, stage);
}

function resetStage(id) {
  const stage = $('#stage');
  if (stageCleanup) stageCleanup();
  stageCleanup = null;
  stageId = id;
  stage.innerHTML = '';
  stage._html = null;
  stage._race = null;
  stage._spin = null;
}

const STAGES = {};
const playerName = (m, id) => escapeHtml(m.players.find((p) => p.id === id)?.name || '?');
const playerColor = (m, id) => m.players.find((p) => p.id === id)?.color || '#888';

/** Kopfzeile mit Titel, Countdown und „Fertig“-Status aller Spieler. */
function stageHead(m, title) {
  const betting = m.phase === 'betting';
  return `<div class="sg-head"><div class="sg-title">${title}</div>
    ${betting ? `<div class="sg-timer">⏱ <span data-ends="${m.endsAt}"></span></div>` : ''}</div>
    ${betting ? `<div class="sg-ready">${m.players.map((p) => `<span class="${m.ready.includes(p.id) ? 'ok' : ''}" style="--c:${p.color}">${m.ready.includes(p.id) ? '✓' : '…'} ${escapeHtml(p.name)}</span>`).join('')}</div>` : ''}`;
}

/* ---------------- Pferderennen ---------------- */

STAGES.horserace = (m, stage) => {
  if (!stage.querySelector('.hr')) {
    stage.innerHTML = `<div class="hr sg">
      <div class="hr-top"></div>
      <div class="hr-bet"></div>
      <div class="hr-race hidden">
        <div class="hr-commentary">Die Pferde stehen in den Startboxen…</div>
        <div class="hr-stage"><div class="hr-track"></div>
          <div class="hr-infield"><div class="hr-label">Grand Prix Galopp</div><ol class="hr-live"></ol></div>
          <div class="hr-count hidden"></div></div>
      </div>
      <div class="hr-results hidden"></div>
    </div>`;
  }
  patch(stage.querySelector('.hr-top'), stageHead(m, '🏇 Pferderennen'));
  const backersOf = (i) => [...new Set(m.bets.filter((b) => b.horse === i).map((b) => b.playerId))];

  if (m.phase === 'betting') {
    patch(stage.querySelector('.hr-bet'), `<table class="hr-table"><thead><tr><th>#</th><th>Pferd</th><th>Sieg</th><th>Platz</th><th>Wetten</th></tr></thead><tbody>
      ${m.horses.map((h, i) => `<tr class="${backersOf(i).length ? 'backed' : ''}"><td><b>${i + 1}</b></td>
        <td><span class="silk" style="background:${h.silk}"></span>${escapeHtml(h.name)} <span class="form">${'★'.repeat(h.form)}</span></td>
        <td class="odd">${h.winOdds.toFixed(1)}</td><td class="odd">${h.placeOdds.toFixed(2)}</td>
        <td class="bets">${m.bets.map((b, k) => ({ b, k })).filter(({ b }) => b.horse === i).map(({ b }) =>
          `<span class="bchip" style="--c:${playerColor(m, b.playerId)}">${playerName(m, b.playerId)} ${fmtM(b.amount)} ${b.type === 'win' ? 'S' : 'P'}</span>`).join('')}</td></tr>`).join('')}
      </tbody></table>`);
    return;
  }

  // Rennen: Bahn aufbauen und die Server-Einzelbilder abspielen
  stage.querySelector('.hr-bet').classList.add('hidden');
  stage.querySelector('.hr-race').classList.remove('hidden');
  if (!stage._race) startRaceAnimation(m, stage);
  stage._race.mini = m;
  if (m.phase === 'results') stage._race.resultsReady = true;
};

function startRaceAnimation(m, stage) {
  const track = new RaceTrack(stage.querySelector('.hr-track'), m.horses);
  const backers = m.horses.map((_, i) => [...new Set(m.bets.filter((b) => b.horse === i).map((b) => b.playerId))].map((id) => m.players.find((p) => p.id === id)?.name || '?'));
  track.setBackers(backers);
  const race = { track, mini: m, resultsReady: false, raf: 0, placed: new Set(), lastComment: 0, lastLeader: -1, lastStandings: 0 };
  stage._race = race;
  const count = stage.querySelector('.hr-count');
  const commentary = stage.querySelector('.hr-commentary');
  const live = stage.querySelector('.hr-live');
  const n = m.horses.length;
  const label = (i) => `<span class="silk" style="background:${m.horses[i].silk}"></span>#${i + 1} ${escapeHtml(m.horses[i].name)}${track.isBacked(i) ? ' ★' : ''}`;
  live.innerHTML = '<li class="muted">Gleich geht es los</li>';

  function frame() {
    const v = race.mini;
    const now = clock.now();
    const msToStart = v.startAt - now;
    if (msToStart > 0) {
      const steps = ['3', '2', '1'];
      const k = Math.min(2, Math.floor((1 - msToStart / (v.countdownMs || 3000 * v.timeScale)) * 3));
      count.classList.remove('hidden');
      const txt = steps[Math.max(0, k)];
      if (count.textContent !== txt) count.innerHTML = `<span>${txt}</span>`;
      race.raf = requestAnimationFrame(frame);
      return;
    }
    if (!race.started) {
      race.started = true;
      count.innerHTML = '<span>LOS!</span>';
      setTimeout(() => count.classList.add('hidden'), 600);
      track.setRunning(true);
    }
    const tickF = ((now - v.startAt) / 1000) * v.ticksPerSecond / v.timeScale;
    const fIdx = tickF / v.frameStep;
    const last = v.frames.length - 1;
    const i0 = Math.min(Math.floor(fIdx), last);
    const i1 = Math.min(i0 + 1, last);
    const f = Math.min(1, fIdx - i0);
    const positions = v.frames[i0].map((p, k) => p + (v.frames[i1][k] - p) * f);
    const pts = track.positionHorses(positions);

    if (Math.random() < 0.5) {
      const k = Math.floor(Math.random() * n);
      if (positions[k] < v.trackLength) track.spawnDust(pts[k]);
    }

    if (!race.placed.size && performance.now() - race.lastStandings > 300) {
      const order = positions.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
      live.innerHTML = order.slice(0, 3).map((i, k) => `<li class="${track.isBacked(i) ? 'backed' : ''}"><b>${k + 1}.</b> ${label(i)}</li>`).join('');
      race.lastStandings = performance.now();
    }

    v.finishOrder.forEach((h, place) => {
      if (!race.placed.has(h) && tickF >= v.finishTime[h]) {
        race.placed.add(h);
        track.markFinished(h, place);
        if (place < 3) live.innerHTML = v.finishOrder.slice(0, place + 1).map((i, k) => `<li class="${track.isBacked(i) ? 'backed' : ''}"><b>${k + 1}.</b> ${label(i)}</li>`).join('');
        if (place === 0) commentary.textContent = `🏆 ${m.horses[h].name} gewinnt das Rennen!`;
      }
    });

    if (!race.placed.size && performance.now() - race.lastComment > 1200 / Math.max(v.timeScale, 0.25)) {
      const lead = Math.max(...positions);
      const leader = positions.indexOf(lead);
      const progress = lead / v.trackLength;
      const name = m.horses[leader].name;
      let text;
      if (progress < 0.15) text = `Und sie sind gestartet! ${name} erwischt den besten Start.`;
      else if (leader !== race.lastLeader) text = `Führungswechsel! #${leader + 1} ${name} übernimmt die Spitze!`;
      else if (progress > 0.75) text = `Zielgerade! ${name} vorne – aber dahinter wird es eng!`;
      else text = `${name} führt das Feld an, ${Math.round(progress * 100)} % der Strecke geschafft.`;
      commentary.textContent = text;
      race.lastLeader = leader;
      race.lastComment = performance.now();
    }

    if (tickF < (last * v.frameStep) || !race.resultsReady) race.raf = requestAnimationFrame(frame);
    else { track.setRunning(false); showRaceResults(stage, race.mini); }
  }
  race.raf = requestAnimationFrame(frame);
  stageCleanup = () => { cancelAnimationFrame(race.raf); };
}

function showRaceResults(stage, m) {
  const el = stage.querySelector('.hr-results');
  const order = m.order || m.finishOrder;
  const podium = [order[1], order[0], order[2]];
  const net = new Map();
  (m.results || []).forEach((r) => net.set(r.playerId, (net.get(r.playerId) || 0) + r.payout - r.amount));
  el.innerHTML = `<div class="podium">${podium.map((h, k) => `<div class="step p${[2, 1, 3][k]}"><div class="pos">${[2, 1, 3][k]}</div>
      <span class="silk" style="background:${m.horses[h].silk}"></span>#${h + 1} ${escapeHtml(m.horses[h].name)}</div>`).join('')}</div>
    <ul class="payouts">${(m.results || []).length ? m.results.map((r) => `<li><span><i class="dot" style="background:${playerColor(m, r.playerId)}"></i> ${playerName(m, r.playerId)}: ${fmtM(r.amount)} auf #${r.horse + 1} (${r.type === 'win' ? 'Sieg' : 'Platz'})</span>
      ${r.won ? `<b class="win">+${fmtM(r.payout)}</b>` : `<b class="lose">−${fmtM(r.amount)}</b>`}</li>`).join('') : '<li>Keine Wetten in diesem Rennen.</li>'}</ul>`;
  el.classList.remove('hidden');
}

/* ---------------- Roulette ---------------- */

const R_RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const rColor = (n) => (n === 0 ? 'green' : (R_RED.has(n) ? 'red' : 'black'));
const R_LABEL = { red: 'Rot', black: 'Schwarz', even: 'Gerade', odd: 'Ungerade', low: '1–18', high: '19–36' };
const rBetLabel = (b) => (b.kind === 'straight' ? `Plein ${b.value}` : b.kind === 'dozen' ? `${b.value}. Dutzend` : b.kind === 'column' ? `${b.value}. Kolonne` : R_LABEL[b.kind]);

/** Tableau: Null links, 12 × 3 Zahlen, Kolonnen rechts, darunter Dutzende und einfache Chancen. */
function rouletteTable(m, highlight) {
  const chipsOn = (kind, value) => m.bets.filter((b) => b.kind === kind && (b.value ?? null) === (value ?? null))
    .map((b) => `<span class="rchip" style="--c:${playerColor(m, b.playerId)}">${playerName(m, b.playerId)}<b>${b.amount}</b></span>`).join('');
  const cell = (kind, value, label, cls, style) => `<div class="rc ${cls}" style="${style}">${label}<div class="rchips">${chipsOn(kind, value)}</div></div>`;
  const cells = [cell('straight', 0, '0', `green ${highlight === 0 ? 'hit' : ''}`, 'grid-row:1/4;grid-column:1')];
  for (let n = 1; n <= 36; n++) {
    const row = 3 - ((n - 1) % 3);
    const col = Math.ceil(n / 3) + 1;
    cells.push(cell('straight', n, n, `${rColor(n)} ${highlight === n ? 'hit' : ''}`, `grid-row:${row};grid-column:${col}`));
  }
  [3, 2, 1].forEach((c, k) => cells.push(cell('column', c, '2:1', 'out', `grid-row:${k + 1};grid-column:14`)));
  [1, 2, 3].forEach((d) => cells.push(cell('dozen', d, `${d}. Dutzend`, 'out', `grid-row:4;grid-column:${2 + (d - 1) * 4}/span 4`)));
  ['low', 'even', 'red', 'black', 'odd', 'high'].forEach((k, i) => cells.push(cell(k, null, R_LABEL[k], `out ${k === 'red' ? 'redbg' : k === 'black' ? 'blackbg' : ''}`, `grid-row:5;grid-column:${2 + i * 2}/span 2`)));
  return `<div class="rtable">${cells.join('')}</div>`;
}

function rouletteBetList(m) {
  const by = m.players.map((p) => ({ p, bets: m.bets.filter((b) => b.playerId === p.id) })).filter((x) => x.bets.length);
  if (!by.length) return '<p class="sg-empty">Noch keine Einsätze – setzt eure Chips auf dem Handy!</p>';
  return `<ul class="rlist">${by.map(({ p, bets }) => `<li><b style="color:${p.color}">${escapeHtml(p.name)}</b> ${bets.map((b) => `${fmtM(b.amount)} auf ${rBetLabel(b)}`).join(' · ')}</li>`).join('')}</ul>`;
}

function wheelSvg(order) {
  const step = 360 / order.length;
  const pockets = order.map((n, i) => {
    const a0 = ((i - 0.5) * step - 90) * Math.PI / 180;
    const a1 = ((i + 0.5) * step - 90) * Math.PI / 180;
    const pt = (r, a) => `${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`;
    const fill = { red: '#c8242b', black: '#1b1b1b', green: '#1a8a3a' }[rColor(n)];
    return `<g class="pocket" data-n="${n}"><path d="M${pt(150, a0)} L${pt(200, a0)} A200,200 0 0 1 ${pt(200, a1)} L${pt(150, a1)} A150,150 0 0 0 ${pt(150, a0)} Z" fill="${fill}" stroke="#d9b45a" stroke-width="1.2"/>
      <text transform="rotate(${(i * step).toFixed(2)}) translate(0 -178)" class="wn">${n}</text></g>`;
  }).join('');
  const spokes = [0, 45, 90, 135].map((a) => `<rect x="-4" y="-120" width="8" height="240" rx="4" transform="rotate(${a})" class="spoke"/>`).join('');
  return `<svg viewBox="-225 -225 450 450" class="wheel-svg">
    <circle r="222" class="w-rim"/><circle r="206" class="w-track"/>
    <g class="w-rot">${pockets}<circle r="150" class="w-cone"/>${spokes}<circle r="30" class="w-hub"/></g>
    <g class="w-ball"><circle cx="0" cy="-190" r="8" class="ball"/></g>
  </svg>`;
}

STAGES.roulette = (m, stage) => {
  if (!stage.querySelector('.rl')) {
    stage.innerHTML = `<div class="rl sg"><div class="rl-top"></div><div class="rl-bet"></div>
      <div class="rl-spin hidden"><div class="wheel">${wheelSvg(m.wheel)}<div class="wheel-result hidden"></div></div><div class="rl-results"></div></div></div>`;
  }
  patch(stage.querySelector('.rl-top'), stageHead(m, '🎡 Roulette'));
  if (m.phase === 'betting') {
    patch(stage.querySelector('.rl-bet'), rouletteTable(m) + rouletteBetList(m));
    return;
  }
  stage.querySelector('.rl-bet').classList.add('hidden');
  stage.querySelector('.rl-spin').classList.remove('hidden');
  if (!stage._spin) spinWheel(stage, m);
  stage._spin.mini = m;
  if (m.phase === 'results') stage._spin.whenDone(() => showRouletteResults(stage, m));
};

function spinWheel(stage, m) {
  const step = 360 / m.wheel.length;
  const idx = m.wheel.indexOf(m.result);
  const wheelTurn = 360 * 4 + Math.random() * 360;
  const ballEnd = wheelTurn + idx * step - 360 * 9;
  const rot = stage.querySelector('.w-rot');
  const ball = stage.querySelector('.w-ball');
  const ballDot = stage.querySelector('.ball');
  const elapsed = Math.max(0, clock.now() - (m.spinEndsAt - m.spinMs));
  const dur = Math.max(1, m.spinMs);
  const easing = 'cubic-bezier(.12,.6,.15,1)';
  const anims = [
    rot.animate([{ transform: 'rotate(0deg)' }, { transform: `rotate(${wheelTurn}deg)` }], { duration: dur, easing, fill: 'forwards' }),
    ball.animate([{ transform: 'rotate(0deg)' }, { transform: `rotate(${ballEnd}deg)` }], { duration: dur, easing, fill: 'forwards' }),
    ballDot.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(0)', offset: 0.7 }, { transform: 'translateY(28px)' }], { duration: dur, easing: 'ease-in', fill: 'forwards' }),
  ];
  anims.forEach((a) => { a.currentTime = Math.min(elapsed, dur); });
  const spin = { mini: m, done: false, callbacks: [] };
  spin.whenDone = (fn) => { if (spin.done) fn(); else spin.callbacks.push(fn); };
  anims[0].finished.then(() => {
    spin.done = true;
    const res = stage.querySelector('.wheel-result');
    const name = { red: 'Rot', black: 'Schwarz', green: 'Null' }[rColor(m.result)];
    res.innerHTML = `<b>${m.result}</b><span>${name}</span>`;
    res.className = `wheel-result ${rColor(m.result)}`;
    const pocket = stage.querySelector(`.pocket[data-n="${m.result}"]`);
    if (pocket) pocket.classList.add('hit');
    spin.callbacks.forEach((fn) => fn());
  }).catch(() => {});
  stage._spin = spin;
  stageCleanup = () => anims.forEach((a) => a.cancel());
}

function showRouletteResults(stage, m) {
  const net = new Map();
  (m.results || []).forEach((r) => net.set(r.playerId, (net.get(r.playerId) || 0) + r.payout - r.amount));
  const rows = m.players.filter((p) => net.has(p.id)).map((p) => {
    const v = net.get(p.id);
    const wins = m.results.filter((r) => r.playerId === p.id && r.payout).map((r) => r.label);
    return `<li><span><i class="dot" style="background:${p.color}"></i> ${escapeHtml(p.name)}${wins.length ? ` <small>(${wins.join(', ')})</small>` : ''}</span><b class="${v > 0 ? 'win' : (v < 0 ? 'lose' : '')}">${v > 0 ? '+' : v < 0 ? '−' : '±'}${fmtM(Math.abs(v))}</b></li>`;
  });
  patch(stage.querySelector('.rl-results'), `<ul class="payouts">${rows.join('') || '<li>Niemand hat gesetzt.</li>'}</ul>`);
}

/* ---------------- Blackjack ---------------- */

const BJ_RESULT = { blackjack: 'Blackjack!', win: 'Gewinn', push: 'Push', lose: 'Verloren', bust: 'Überkauft' };

/** Sitzpositionen im Halbkreis um den Dealer, abhängig von der Spielerzahl. */
function seatPositions(n) {
  if (n === 1) return [{ x: 50, y: 74 }];
  // je mehr Spieler, desto weiter und tiefer der Bogen
  const [rx, ry, cy] = n <= 4 ? [37, 58, 20] : (n <= 7 ? [40, 62, 16] : [42, 66, 13]);
  const from = 170;
  const to = 10;
  return Array.from({ length: n }, (_, i) => {
    const a = ((from - (i * (from - to)) / (n - 1)) * Math.PI) / 180;
    return { x: 50 + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
  });
}

STAGES.blackjack = (m, stage) => {
  if (!stage.querySelector('.bj')) {
    stage.innerHTML = '<div class="bj sg"><div class="bj-top"></div><div class="bj-table"></div></div>';
    stage._seen = new Set();
  }
  patch(stage.querySelector('.bj-top'), stageHead(m, '🃏 Blackjack'));
  const seen = stage._seen;
  const ts = m.timeScale ?? 1;
  let fresh = 0;
  const card = (c) => {
    const key = c.hidden ? `h${c.n}` : c.n;
    if (seen.has(key)) return cardHtml(c);
    seen.add(key);
    const step = m.phase === 'dealer' ? (m.dealerCardMs ?? 1400 * ts) : (m.dealMs ?? 800 * ts);
    const delay = ((fresh++ * step) / 1000).toFixed(2);
    return cardHtml(c, `deal" style="animation-delay:${delay}s`);
  };
  // Reihenfolge wie beim Austeilen: erst alle ersten Karten, dann alle zweiten
  const ordered = [];
  m.seats.forEach((s) => s.hands.forEach((h) => h.cards.forEach((c) => ordered.push(c))));
  m.dealer.forEach((c) => ordered.push(c));
  const html = new Map();
  ordered.sort((a, b) => a.n - b.n).forEach((c) => html.set(c.n, card(c)));
  const cardsOf = (list) => list.map((c) => html.get(c.n)).join('');

  const n = m.players.length;
  const pos = seatPositions(n);
  const size = n <= 4 ? 'l' : (n <= 7 ? 'm' : 's');
  const seats = m.players.map((p, i) => {
    const seat = m.seats.find((s) => s.playerId === p.id);
    const bet = m.bets.find((b) => b.playerId === p.id);
    const active = m.turn && m.turn.playerId === p.id;
    let body;
    if (m.phase === 'betting') {
      body = `<div class="bj-bet">${bet ? `<span class="bj-chip">${fmtM(bet.amount)}</span>` : '<span class="muted">–</span>'}</div>`;
    } else if (!seat) {
      body = '<div class="bj-out">setzt aus</div>';
    } else {
      body = seat.hands.map((h, k) => {
        const turnHere = active && m.turn.hand === k;
        const res = h.result ? `<div class="bj-res ${h.result}">${BJ_RESULT[h.result]}${h.payout ? ` +${fmtM(h.payout)}` : ''}</div>` : '';
        return `<div class="bj-hand ${turnHere ? 'turn' : ''}"><div class="bj-cards">${cardsOf(h.cards)}</div>
          <div class="bj-meta"><span class="bj-chip">${fmtM(h.bet)}${h.doubled ? ' ×2' : ''}</span><b>${h.value.total > 21 ? `${h.value.total} 💥` : h.value.total}</b></div>${res}
          ${turnHere ? `<div class="bj-bar"><i data-bar-ends="${m.turn.endsAt}" data-bar-total="${m.decisionMs}"></i></div>` : ''}</div>`;
      }).join('');
    }
    const ready = m.phase === 'betting' && m.ready.includes(p.id) ? ' ✓' : '';
    return `<div class="bj-seat ${size} ${active ? 'active' : ''}" style="left:${pos[i].x}%;top:${pos[i].y}%;--c:${p.color}">
      <div class="bj-name">${escapeHtml(p.name)}${ready}</div>${body}</div>`;
  }).join('');

  const dv = m.dealer.length ? `<b>${m.dealerValue.total}${m.dealer.some((c) => c.hidden) ? ' + ?' : ''}</b>` : '';
  const dealer = `<div class="bj-dealer"><div class="bj-dlabel">Dealer ${dv}</div><div class="bj-cards big">${cardsOf(m.dealer)}</div>
    <div class="bj-rule">Dealer steht auf Soft 17 · Blackjack zahlt 3:2</div></div>`;
  const shoe = `<div class="bj-shoe" title="Karten im Schuh">🂠 ${m.shoeLeft}</div>`;
  patch(stage.querySelector('.bj-table'), `<div class="bj-felt"></div>${dealer}${shoe}${seats}`);
};

function render() {
  if (!S) return;
  if (!S.started || !S.game) renderLobby();
  else if (S.gameType === 'risiko') renderRisiko();
  else renderGame();
}
