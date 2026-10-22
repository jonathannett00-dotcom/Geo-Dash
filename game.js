'use strict';

/* =========================================================
 *  Grand Prix Galopp – Pferderennen-Wettspiel
 * ========================================================= */

const STORAGE_KEY = 'grand-prix-galopp-v1';
const HORSES_PER_RACE = 6;
const TRACK_LENGTH = 1000;
const TICKS_PER_SECOND = 60;
const HOUSE_MARGIN = 0.9;       // 10 % Buchmacher-Marge
const ODDS_SIMULATIONS = 1500;  // Monte-Carlo-Läufe zur Quotenberechnung

const PLAYER_COLORS = ['#e63946', '#1d72d8', '#2a9d8f', '#f4a261', '#8e44ad', '#e9c46a', '#ff6fb5', '#264653'];
const SILK_COLORS = ['#e63946', '#1d72d8', '#f1c40f', '#2ecc71', '#9b59b6', '#ff7f11', '#00b8d4', '#ec407a'];
const COAT_COLORS = ['#6b3e1f', '#3b2416', '#8a5a2b', '#1f1a17', '#a0703f', '#c9b8a3', '#5b4636'];

const NAME_PARTS_A = ['Blitz', 'Donner', 'Silber', 'Gold', 'Sturm', 'Schatten', 'Feuer', 'Wüsten', 'Nacht', 'Morgen', 'Eis', 'Sonnen', 'Wind', 'Stern', 'Glücks', 'Turbo'];
const NAME_PARTS_B = ['pfeil', 'hufe', 'mähne', 'läufer', 'falke', 'prinz', 'königin', 'rakete', 'traum', 'wolke', 'kobold', 'baron', 'blitz', 'tänzer', 'komet', 'jäger'];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let state = null;
let racing = false;

/* ---------------- Persistence ---------------- */

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) { /* privat-Modus */ }
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

/* ---------------- Helpers ---------------- */

const fmt = (n) => `${Math.round(n).toLocaleString('de-DE')} ${state.currency}`;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const playerById = (id) => state.players.find((p) => p.id === id);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2500);
}

function log(text) {
  state.history.unshift({ time: Date.now(), text });
  state.history = state.history.slice(0, 300);
}

/* ---------------- Race simulation ---------------- */

/**
 * Simuliert ein komplettes Rennen. Gibt die Zielreihenfolge zurück und
 * (optional) jede Position pro Tick zum Abspielen der Animation.
 */
function simulateRace(horses, recordFrames = false) {
  const n = horses.length;
  const pos = new Array(n).fill(0);
  const vel = horses.map((h) => h.speed * 0.6);
  const target = horses.map((h) => h.speed);
  const finishTime = new Array(n).fill(Infinity);
  const frames = recordFrames ? [] : null;
  let tick = 0;
  let finished = 0;

  while (finished < n && tick < 5000) {
    for (let i = 0; i < n; i++) {
      if (finishTime[i] !== Infinity) {
        // Pferd trabt nach dem Ziel aus
        pos[i] += vel[i] * 0.4;
        continue;
      }
      const h = horses[i];
      if (Math.random() < 0.02) {
        target[i] = h.speed * rand(0.8, 1.2);
      }
      // Endspurt: Ausdauer entscheidet im letzten Viertel
      let t = target[i];
      if (pos[i] > TRACK_LENGTH * 0.72) t *= 1 + (h.stamina - 0.5) * 0.14;
      vel[i] += (t - vel[i]) * 0.05;
      const prev = pos[i];
      pos[i] += vel[i];
      if (pos[i] >= TRACK_LENGTH) {
        finishTime[i] = tick + (TRACK_LENGTH - prev) / (pos[i] - prev);
        finished++;
      }
    }
    if (frames) frames.push(pos.slice());
    tick++;
  }

  const order = [...Array(n).keys()].sort((a, b) => finishTime[a] - finishTime[b]);
  return { order, frames, finishTime };
}

function computeOdds(horses) {
  const wins = new Array(horses.length).fill(0);
  const places = new Array(horses.length).fill(0);
  for (let s = 0; s < ODDS_SIMULATIONS; s++) {
    const { order } = simulateRace(horses);
    wins[order[0]]++;
    for (let k = 0; k < 3; k++) places[order[k]]++;
  }
  horses.forEach((h, i) => {
    const pWin = Math.max(wins[i], 1) / ODDS_SIMULATIONS;
    const pPlace = Math.max(places[i], 1) / ODDS_SIMULATIONS;
    h.winOdds = Math.max(1.1, Math.round((HOUSE_MARGIN / pWin) * 10) / 10);
    h.placeOdds = Math.max(1.05, Math.round((HOUSE_MARGIN / pPlace) * 20) / 20);
  });
}

function generateHorses() {
  const names = new Set();
  const silks = [...SILK_COLORS].sort(() => Math.random() - 0.5);
  const horses = [];
  for (let i = 0; i < HORSES_PER_RACE; i++) {
    let name;
    do { name = pick(NAME_PARTS_A) + pick(NAME_PARTS_B); } while (names.has(name));
    names.add(name);
    const base = 1000 / (TICKS_PER_SECOND * 18);   // ~18 Sekunden Renndauer
    horses.push({
      name: name.charAt(0).toUpperCase() + name.slice(1),
      speed: base * rand(0.985, 1.015),
      stamina: Math.random(),
      silk: silks[i],
      coat: pick(COAT_COLORS),
    });
  }
  computeOdds(horses);
  // Formwert 1–5 für die Anzeige (abgeleitet aus der Siegchance)
  const maxP = Math.max(...horses.map((h) => 1 / h.winOdds));
  horses.forEach((h) => { h.form = Math.max(1, Math.round(((1 / h.winOdds) / maxP) * 5)); });
  return horses;
}

/* ---------------- Rendering ---------------- */

/* ---------- Ovale Bahn ---------- */

// Geometrie der Bahn im SVG-Koordinatensystem: zwei Geraden + zwei Halbkreise
const OVAL = { W: 1000, H: 560, cx: 500, cy: 280, a: 230, r0: 118, lane: 22 };

/** Pfad eines Ovals mit Kurvenradius r (Start unten Mitte, gegen den Uhrzeigersinn). */
function ovalPath(r) {
  const { cx, cy, a } = OVAL;
  return `M${cx - a},${cy + r} L${cx + a},${cy + r} A${r},${r} 0 0 0 ${cx + a},${cy - r}`
    + ` L${cx - a},${cy - r} A${r},${r} 0 0 0 ${cx - a},${cy + r} Z`;
}

/** Punkt + Laufrichtung auf Bahn k bei Rundenanteil t (0 = Ziellinie). */
function trackPoint(k, t) {
  const { cx, cy, a } = OVAL;
  const r = OVAL.r0 + OVAL.lane * (k + 0.5);
  const arc = Math.PI * r;
  let s = (((t % 1) + 1) % 1) * (4 * a + 2 * arc);
  if (s < a) return { x: cx + s, y: cy + r, dx: 1, dy: 0 };
  s -= a;
  if (s < arc) {
    const f = s / r;
    return { x: cx + a + r * Math.sin(f), y: cy + r * Math.cos(f), dx: Math.cos(f), dy: -Math.sin(f) };
  }
  s -= arc;
  if (s < 2 * a) return { x: cx + a - s, y: cy - r, dx: -1, dy: 0 };
  s -= 2 * a;
  if (s < arc) {
    const f = s / r;
    return { x: cx - a - r * Math.sin(f), y: cy - r * Math.cos(f), dx: -Math.cos(f), dy: Math.sin(f) };
  }
  s -= arc;
  return { x: cx - a + s, y: cy + r, dx: 1, dy: 0 };
}

function horseSVG(h, number) {
  return `
    <g class="bob">
      <path class="tail" d="M20 30 Q8 34 6 50 Q14 42 22 36 Z" fill="${h.coat}" style="filter:brightness(.7)"/>
      <rect class="leg b" x="26" y="38" width="5" height="26" rx="2" fill="${h.coat}" style="filter:brightness(.75)"/>
      <rect class="leg a" x="58" y="38" width="5" height="26" rx="2" fill="${h.coat}" style="filter:brightness(.75)"/>
      <ellipse cx="44" cy="34" rx="25" ry="11" fill="${h.coat}"/>
      <rect class="leg a" x="31" y="38" width="5" height="26" rx="2" fill="${h.coat}"/>
      <rect class="leg b" x="63" y="38" width="5" height="26" rx="2" fill="${h.coat}"/>
      <path d="M58 30 L72 10 L80 14 L70 38 Z" fill="${h.coat}"/>
      <path d="M71 8 L92 15 L94 21 L87 24 L75 18 Z" fill="${h.coat}"/>
      <path d="M73 9 L75 2 L78 9 Z" fill="${h.coat}"/>
      <path d="M62 27 L71 10 L67 9 L58 24 Z" fill="#1a1410"/>
      <circle cx="84" cy="15" r="1.4" fill="#000"/>
      <rect x="36" y="25" width="20" height="12" rx="2" fill="${h.silk}"/>
      <text class="num" x="46" y="34.5" font-size="8" font-weight="900" text-anchor="middle" fill="#fff">${number}</text>
      <path d="M44 25 L50 8 L58 10 L54 26 Z" fill="${h.silk}"/>
      <path d="M54 14 L66 20" stroke="${h.silk}" stroke-width="4" stroke-linecap="round"/>
      <circle cx="54" cy="5" r="5" fill="#f2c9a0"/>
      <path d="M49 4 A5 5 0 0 1 59 4 L61 5 L49 5 Z" fill="${h.silk}"/>
      <path d="M48 26 L44 36" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
    </g>`;
}

function renderTrack() {
  const { W, H, cx, cy, r0, lane } = OVAL;
  const n = state.horses.length;
  const outer = r0 + lane * n;
  const dividers = [...Array(n - 1)].map((_, k) =>
    `<path d="${ovalPath(r0 + lane * (k + 1))}" class="t-divider"/>`).join('');
  const laneNos = state.horses.map((_, k) =>
    `<text x="${cx - 18}" y="${cy + r0 + lane * (k + 0.5) + 4}" class="t-laneno">${k + 1}</text>`).join('');

  $('#track').innerHTML = `
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Ovale Rennbahn mit ${n} Pferden">
    <defs>
      <pattern id="checker" width="8" height="8" patternUnits="userSpaceOnUse">
        <rect width="8" height="8" fill="#fff"/><rect width="4" height="4" fill="#111"/><rect x="4" y="4" width="4" height="4" fill="#111"/>
      </pattern>
      <pattern id="mow" width="80" height="80" patternUnits="userSpaceOnUse" patternTransform="rotate(30)">
        <rect width="40" height="80" class="t-mow"/>
      </pattern>
    </defs>
    <rect width="${W}" height="${H}" class="t-turf"/>
    <rect width="${W}" height="${H}" fill="url(#mow)"/>
    <path d="${ovalPath((r0 + outer) / 2)}" class="t-dirt" stroke-width="${outer - r0}"/>
    <path d="${ovalPath(r0)}" class="t-infield"/>
    <path d="${ovalPath(r0)}" fill="url(#mow)"/>
    ${dividers}
    <path d="${ovalPath(r0)}" class="t-rail"/>
    <path d="${ovalPath(outer)}" class="t-rail"/>
    <rect x="${cx - 5}" y="${cy + r0}" width="10" height="${outer - r0}" fill="url(#checker)"/>
    <rect x="${cx - 2}" y="${cy + outer}" width="4" height="22" class="t-post"/>
    <circle cx="${cx}" cy="${cy + outer + 24}" r="7" class="t-postcap"/>
    ${laneNos}
    <g id="dust"></g>
    <g id="horses">
      ${state.horses.map((h, i) => `
        <g class="horse" id="horse-${i}">
          <ellipse class="glow" cx="0" cy="-2" rx="34" ry="11"/>
          <g class="sprite"><g transform="translate(-33,-42) scale(0.66)">${horseSVG(h, i + 1)}</g></g>
        </g>`).join('')}
    </g>
  </svg>`;
  lastZOrder = '';
  positionHorses(new Array(n).fill(0));
  updateBetMarkers();
}

/** Hebt Pferde hervor, auf die gewettet wurde: Leuchten + Farbpunkte der Spieler. */
function updateBetMarkers() {
  state.horses.forEach((_, i) => {
    const el = document.getElementById(`horse-${i}`);
    if (!el) return;
    el.querySelector('.bet-mark')?.remove();
    const backers = [...new Set(state.bets.filter((b) => b.horse === i).map((b) => b.playerId))].map(playerById);
    el.classList.toggle('backed', backers.length > 0);
    if (!backers.length) return;
    const mark = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    mark.setAttribute('class', 'bet-mark');
    const start = -((backers.length - 1) * 12) / 2;
    mark.innerHTML = backers.map((p, k) =>
      `<circle cx="${start + k * 12}" cy="-52" r="5.5" fill="${p.color}"/>`).join('')
      + `<path d="M-4,-44 L4,-44 L0,-39 Z" class="bet-arrow"/>`;
    el.appendChild(mark);
  });
}

const isBacked = (i) => state.bets.some((b) => b.horse === i);

let lastZOrder = '';

/** Setzt jedes Pferd auf seine Bahn; positions in Streckeneinheiten (0 … TRACK_LENGTH). */
function positionHorses(positions) {
  const pts = positions.map((p, i) => {
    const t = Math.min(p / TRACK_LENGTH, 1.06);   // nach dem Ziel noch ein Stück auslaufen
    return trackPoint(i, t);
  });
  pts.forEach((pt, i) => {
    const el = document.getElementById(`horse-${i}`);
    if (!el) return;
    const face = pt.dx < -1e-6 ? -1 : 1;
    const tilt = Math.max(-22, Math.min(22, (Math.atan2(pt.dy, Math.abs(pt.dx)) * 180) / Math.PI));
    el.setAttribute('transform', `translate(${pt.x.toFixed(1)} ${pt.y.toFixed(1)})`);
    el.querySelector('.sprite').setAttribute('transform', `scale(${face} 1) rotate(${tilt.toFixed(1)})`);
    // Startnummer bleibt lesbar, auch wenn das Pferd nach links läuft
    el.querySelector('.num').setAttribute('transform', face < 0 ? 'translate(92 0) scale(-1 1)' : '');
    el.dataset.face = face;
  });
  // Pferde weiter unten im Bild werden vorne gezeichnet
  const order = pts.map((pt, i) => [pt.y, i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
  const key = order.join(',');
  if (key !== lastZOrder) {
    const layer = document.getElementById('horses');
    order.forEach((i) => layer.appendChild(document.getElementById(`horse-${i}`)));
    lastZOrder = key;
  }
  return pts;
}

function renderOdds() {
  const sel = Number($('#bet-horse').value);
  $('#odds-body').innerHTML = state.horses.map((h, i) => `
    <tr class="clickable ${i === sel ? 'selected' : ''} ${isBacked(i) ? 'backed' : ''}" data-horse="${i}">
      <td><strong>${i + 1}</strong></td>
      <td><span class="silk" style="background:${h.silk}"></span>${escapeHtml(h.name)}${backerDots(i)}</td>
      <td><span class="form-bar" style="width:${h.form * 10}px"></span></td>
      <td class="odd">${h.winOdds.toFixed(1)}</td>
      <td class="odd">${h.placeOdds.toFixed(2)}</td>
    </tr>`).join('');
}

function backerDots(i) {
  const ids = [...new Set(state.bets.filter((b) => b.horse === i).map((b) => b.playerId))];
  return ids.map((id) => `<span class="dot backer" title="${escapeHtml(playerById(id).name)}" style="background:${playerById(id).color}"></span>`).join('');
}

function renderWallets() {
  const wrap = $('#wallets');
  wrap.innerHTML = state.players.map((p) => {
    const pending = state.bets.filter((b) => b.playerId === p.id).reduce((s, b) => s + b.amount, 0);
    const diff = p.balance + pending - p.deposited;
    return `
    <div class="wallet" id="wallet-${p.id}" style="--c:${p.color}">
      <div class="name"><span class="dot" style="background:${p.color}"></span>${escapeHtml(p.name)}</div>
      <div class="balance" data-value="${p.balance}">${fmt(p.balance)}</div>
      <div class="meta">${pending ? `Im Spiel: ${fmt(pending)} · ` : ''}Bilanz: ${diff >= 0 ? '+' : ''}${fmt(diff)}</div>
      <div class="actions">
        <button class="in" data-deposit="${p.id}">+ Einzahlen</button>
        <button class="out" data-withdraw="${p.id}">− Auszahlen</button>
      </div>
    </div>`;
  }).join('');
}

function renderSelects() {
  const ps = $('#bet-player');
  const prevP = ps.value;
  ps.innerHTML = state.players.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} (${fmt(p.balance)})</option>`).join('');
  if (prevP && playerById(prevP)) ps.value = prevP;

  const hs = $('#bet-horse');
  const prevH = hs.value;
  hs.innerHTML = state.horses.map((h, i) => `<option value="${i}">${i + 1} – ${escapeHtml(h.name)}</option>`).join('');
  if (prevH !== '' && Number(prevH) < state.horses.length) hs.value = prevH;
}

function renderBets() {
  const list = $('#bet-list');
  if (!state.bets.length) {
    list.innerHTML = '<li class="empty">Noch keine Wetten platziert.</li>';
  } else {
    list.innerHTML = state.bets.map((b, idx) => {
      const p = playerById(b.playerId);
      const h = state.horses[b.horse];
      const odds = b.type === 'win' ? h.winOdds : h.placeOdds;
      return `<li>
        <span class="dot" style="background:${p.color}"></span>
        <span class="who">${escapeHtml(p.name)}</span>
        <span class="grow">${fmt(b.amount)} auf <span class="silk" style="background:${h.silk}"></span>#${b.horse + 1} ${escapeHtml(h.name)}
          (${b.type === 'win' ? 'Sieg' : 'Platz'} @ ${odds.toFixed(2)})</span>
        <button title="Wette zurücknehmen" data-remove-bet="${idx}" ${racing ? 'disabled' : ''}>✕</button>
      </li>`;
    }).join('');
  }
  $('#btn-start-race').disabled = racing;
  renderOdds();
  if (document.getElementById('horses')) updateBetMarkers();
}

function renderPreview() {
  const amount = Number($('#bet-amount').value) || 0;
  const h = state.horses[Number($('#bet-horse').value)];
  if (!h || amount <= 0) { $('#bet-preview').textContent = ''; return; }
  const odds = $('#bet-type').value === 'win' ? h.winOdds : h.placeOdds;
  $('#bet-preview').textContent = `Möglicher Gewinn: ${fmt(amount * odds)} (Quote ${odds.toFixed(2)})`;
}

function renderAll() {
  $('#race-label').textContent = `Rennen #${state.raceNo}`;
  renderWallets();
  renderSelects();
  renderOdds();
  renderBets();
  renderPreview();
}

/** Animiert eine Kontostand-Änderung (Zähler + schwebende Differenz). */
function animateBalance(playerId, from, to) {
  const card = $(`#wallet-${playerId}`);
  if (!card || from === to) return;
  const el = card.querySelector('.balance');
  const up = to > from;
  card.classList.add(up ? 'flash-up' : 'flash-down');
  const delta = document.createElement('div');
  delta.className = `delta ${up ? 'up' : 'down'}`;
  delta.textContent = `${up ? '+' : '−'}${fmt(Math.abs(to - from))}`;
  card.appendChild(delta);

  const start = performance.now();
  const dur = 900;
  (function step(now) {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
    else setTimeout(() => { card.classList.remove('flash-up', 'flash-down'); delta.remove(); }, 600);
  })(start);
}

/** Ändert den Kontostand eines Spielers und zeigt die Animation. */
function changeBalance(player, amount) {
  const from = player.balance;
  player.balance = Math.round((player.balance + amount) * 100) / 100;
  renderWallets();
  renderSelects();
  animateBalance(player.id, from, player.balance);
}

/* ---------------- Setup ---------------- */

function addPlayerInput(name = '') {
  const wrap = $('#player-inputs');
  const idx = wrap.children.length;
  if (idx >= PLAYER_COLORS.length) { toast(`Maximal ${PLAYER_COLORS.length} Spieler`); return; }
  const row = document.createElement('div');
  row.className = 'player-input';
  row.innerHTML = `
    <span class="swatch" style="background:${PLAYER_COLORS[idx]}"></span>
    <input type="text" placeholder="Spieler ${idx + 1}" value="${escapeHtml(name)}" maxlength="20" />
    <button type="button" title="Entfernen">✕</button>`;
  row.querySelector('button').onclick = () => {
    if (wrap.children.length <= 1) return;
    row.remove();
    recolorPlayerInputs();
  };
  wrap.appendChild(row);
}

function recolorPlayerInputs() {
  $$('#player-inputs .player-input').forEach((row, i) => {
    row.querySelector('.swatch').style.background = PLAYER_COLORS[i];
    row.querySelector('input').placeholder = `Spieler ${i + 1}`;
  });
}

function startGame(e) {
  e.preventDefault();
  const startAmount = Math.floor(Number($('#start-amount').value));
  const currency = $('#currency').value.trim() || 'M';
  if (!(startAmount > 0)) { toast('Bitte einen gültigen Startbetrag eingeben'); return; }

  const names = $$('#player-inputs input').map((inp, i) => inp.value.trim() || `Spieler ${i + 1}`);
  const lower = names.map((n) => n.toLowerCase());
  if (new Set(lower).size !== lower.length) { toast('Jeder Spieler braucht einen eigenen Namen'); return; }

  state = {
    startAmount,
    currency,
    raceNo: 1,
    players: names.map((name, i) => ({
      id: `p${i}`,
      name,
      color: PLAYER_COLORS[i],
      balance: startAmount,
      deposited: startAmount,  // Summe aller Einzahlungen (inkl. Start) für die Bilanz
    })),
    horses: generateHorses(),
    bets: [],
    history: [],
  };
  log(`Neues Spiel – alle ${names.length} Spieler starten mit ${fmt(startAmount)}.`);
  save();
  showGame();
}

function showGame() {
  $('#setup').classList.add('hidden');
  $('#game').classList.remove('hidden');
  renderAll();
  renderTrack();
  resetInfield();
  $('#commentary').textContent = 'Die Pferde stehen in den Startboxen… Jetzt Wetten platzieren!';
}

function showSetup() {
  $('#game').classList.add('hidden');
  $('#setup').classList.remove('hidden');
  $('#player-inputs').innerHTML = '';
  addPlayerInput();
  addPlayerInput();
}

/* ---------------- Wallet: Ein- & Auszahlung ---------------- */

function openMoneyDialog(playerId, mode) {
  if (racing) { toast('Während des Rennens nicht möglich'); return; }
  const p = playerById(playerId);
  const dlg = $('#money-dialog');
  $('#money-title').textContent = mode === 'in' ? `${p.name}: Geld einzahlen` : `${p.name}: Geld auszahlen`;
  $('#money-text').textContent = mode === 'in'
    ? 'Geld, das du bei Monopoly verdient hast, in deine Wett-Geldbörse übertragen.'
    : `Geld zurück zu Monopoly übertragen. Verfügbar: ${fmt(p.balance)}`;
  const input = $('#money-amount');
  input.value = '';
  input.max = mode === 'out' ? p.balance : '';
  dlg.returnValue = '';
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const amount = Math.floor(Number(input.value));
    if (!(amount > 0)) return;
    if (mode === 'in') {
      p.deposited += amount;
      changeBalance(p, amount);
      log(`${p.name} zahlt ${fmt(amount)} aus Monopoly ein.`);
    } else {
      if (amount > p.balance) { toast('So viel Geld ist nicht in der Geldbörse'); return; }
      p.deposited -= amount;
      changeBalance(p, -amount);
      log(`${p.name} zahlt ${fmt(amount)} an Monopoly aus.`);
    }
    save();
  };
  dlg.showModal();
  input.focus();
}

/* ---------------- Betting ---------------- */

function placeBet(e) {
  e.preventDefault();
  if (racing) return;
  const p = playerById($('#bet-player').value);
  const horse = Number($('#bet-horse').value);
  const type = $('#bet-type').value;
  const amount = Math.floor(Number($('#bet-amount').value));
  if (!p) return;
  if (!(amount > 0)) { toast('Bitte einen Einsatz eingeben'); return; }
  if (amount > p.balance) { toast(`${p.name} hat nur ${fmt(p.balance)}`); return; }

  state.bets.push({ playerId: p.id, horse, type, amount });
  changeBalance(p, -amount);
  log(`${p.name} setzt ${fmt(amount)} auf #${horse + 1} ${state.horses[horse].name} (${type === 'win' ? 'Sieg' : 'Platz'}).`);
  save();
  renderBets();
  $('#bet-amount').value = '';
  renderPreview();
  toast('Wette platziert!');
}

function removeBet(idx) {
  if (racing) return;
  const [b] = state.bets.splice(idx, 1);
  const p = playerById(b.playerId);
  changeBalance(p, b.amount);
  log(`${p.name} nimmt die Wette über ${fmt(b.amount)} zurück.`);
  save();
  renderBets();
}

/* ---------------- Race ---------------- */

function spawnDust(pt) {
  const d = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  d.setAttribute('class', 'dust');
  d.setAttribute('cx', (pt.x - Math.sign(pt.dx || 1) * 16).toFixed(1));
  d.setAttribute('cy', (pt.y - 2).toFixed(1));
  d.setAttribute('r', '4');
  $('#dust').appendChild(d);
  setTimeout(() => d.remove(), 650);
}

function resetInfield() {
  $('#infield-race').textContent = `Rennen #${state.raceNo}`;
  $('#live').innerHTML = '<li class="muted">Wetten offen</li>';
}

function renderLiveStandings(positions) {
  const order = positions.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  $('#live').innerHTML = order.slice(0, 3).map((i, k) =>
    `<li class="${isBacked(i) ? 'backed' : ''}"><b>${k + 1}.</b> <span class="silk" style="background:${state.horses[i].silk}"></span>#${i + 1} ${escapeHtml(state.horses[i].name)}${isBacked(i) ? ' ★' : ''}</li>`).join('');
}

/** Eigene Bestätigung im Spiel (Browser-confirm() steht nicht überall zur Verfügung). */
function askConfirm(text, okLabel) {
  const dlg = $('#confirm-dialog');
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => { dlg.onclose = () => resolve(dlg.returnValue === 'ok'); });
}

function countdown() {
  const el = $('#countdown');
  el.classList.remove('hidden');
  return new Promise((resolve) => {
    const steps = ['3', '2', '1', 'LOS!'];
    let i = 0;
    (function next() {
      if (i === steps.length) { el.classList.add('hidden'); el.innerHTML = ''; resolve(); return; }
      el.innerHTML = `<span>${steps[i++]}</span>`;
      setTimeout(next, i === steps.length ? 600 : 800);
    })();
  });
}

async function startRace() {
  if (racing) return;
  if (!state.bets.length
    && !(await askConfirm('Es wurden noch keine Wetten platziert. Trotzdem starten?', 'Rennen starten'))) return;
  if (racing) return;
  racing = true;
  renderBets();
  $$('#bet-form button, #bet-form select, #bet-form input').forEach((el) => { el.disabled = true; });

  const { order, frames, finishTime } = simulateRace(state.horses, true);
  renderTrack();
  $('#commentary').textContent = 'Achtung, die Pferde sind bereit…';
  await countdown();

  const track = $('#track');
  track.classList.add('running');
  const horsesEl = state.horses.map((_, i) => document.getElementById(`horse-${i}`));
  const n = state.horses.length;
  const placed = new Set();
  let lastComment = 0;
  let lastLeader = -1;
  let lastStandings = 0;
  const start = performance.now();
  const totalTicks = frames.length;

  await new Promise((resolve) => {
    function frame(now) {
      const tickF = ((now - start) / 1000) * TICKS_PER_SECOND;
      const i0 = Math.min(Math.floor(tickF), totalTicks - 1);
      const i1 = Math.min(i0 + 1, totalTicks - 1);
      const f = tickF - i0;
      const positions = frames[i0].map((p, k) => p + (frames[i1][k] - p) * f);
      const pts = positionHorses(positions);

      // Staubwolken
      if (Math.random() < 0.5) {
        const k = Math.floor(Math.random() * n);
        if (positions[k] < TRACK_LENGTH) spawnDust(pts[k]);
      }

      if (!placed.size && now - lastStandings > 300) {
        renderLiveStandings(positions);
        lastStandings = now;
      }

      // Zieleinlauf-Badges
      order.forEach((h, place) => {
        if (!placed.has(h) && tickF >= finishTime[h]) {
          placed.add(h);
          horsesEl[h].classList.add('finished');
          const badge = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          badge.setAttribute('class', 'place-badge');
          badge.innerHTML = `<rect x="-13" y="-84" width="26" height="17" rx="8.5"/><text x="0" y="-71.5">${place + 1}.</text>`;
          horsesEl[h].appendChild(badge);
          if (place < 3) {
            $('#live').innerHTML = order.slice(0, place + 1).map((i, k) =>
              `<li class="${isBacked(i) ? 'backed' : ''}"><b>${k + 1}.</b> <span class="silk" style="background:${state.horses[i].silk}"></span>#${i + 1} ${escapeHtml(state.horses[i].name)}${isBacked(i) ? ' ★' : ''}</li>`).join('');
          }
          if (place === 0) $('#commentary').textContent = `🏆 ${state.horses[h].name} gewinnt das Rennen!`;
        }
      });

      // Kommentar
      if (!placed.size && now - lastComment > 1200) {
        const leader = positions.indexOf(Math.max(...positions));
        const progress = Math.max(...positions) / TRACK_LENGTH;
        const name = state.horses[leader].name;
        let text;
        if (progress < 0.15) text = `Und sie sind gestartet! ${name} erwischt den besten Start.`;
        else if (leader !== lastLeader) text = `Führungswechsel! #${leader + 1} ${name} übernimmt die Spitze!`;
        else if (progress > 0.75) text = `Zielgerade! ${name} vorne – aber dahinter wird es eng!`;
        else text = `${name} führt das Feld an, ${Math.round(progress * 100)} % der Strecke geschafft.`;
        $('#commentary').textContent = text;
        lastLeader = leader;
        lastComment = now;
      }

      if (tickF < totalTicks - 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });

  track.classList.remove('running');
  settleRace(order);
}

function settleRace(order) {
  const top3 = order.slice(0, 3);
  const results = state.bets.map((b) => {
    const h = state.horses[b.horse];
    const won = b.type === 'win' ? order[0] === b.horse : top3.includes(b.horse);
    const odds = b.type === 'win' ? h.winOdds : h.placeOdds;
    return { ...b, won, payout: won ? Math.round(b.amount * odds) : 0 };
  });

  log(`Rennen #${state.raceNo}: 1. ${state.horses[order[0]].name}, 2. ${state.horses[order[1]].name}, 3. ${state.horses[order[2]].name}.`);
  results.forEach((r) => {
    const p = playerById(r.playerId);
    if (r.won) {
      p.balance += r.payout;
      log(`${p.name} gewinnt ${fmt(r.payout)} mit #${r.horse + 1} ${state.horses[r.horse].name}.`);
    } else {
      log(`${p.name} verliert ${fmt(r.amount)} auf #${r.horse + 1} ${state.horses[r.horse].name}.`);
    }
  });
  state.bets = [];
  save();

  // Ergebnis-Dialog
  const classes = ['p2', 'p1', 'p3'];
  const podiumOrder = [order[1], order[0], order[2]];
  $('#result-title').textContent = `Zieleinlauf – Rennen #${state.raceNo}`;
  $('#podium').innerHTML = podiumOrder.map((h, i) => `
    <div class="step ${classes[i]}">
      <div class="pos">${[2, 1, 3][i]}</div>
      <span class="silk" style="background:${state.horses[h].silk}"></span>
      #${h + 1} ${escapeHtml(state.horses[h].name)}
    </div>`).join('');

  $('#payouts').innerHTML = results.length
    ? results.map((r) => {
      const p = playerById(r.playerId);
      const label = `${escapeHtml(p.name)}: ${fmt(r.amount)} auf #${r.horse + 1} (${r.type === 'win' ? 'Sieg' : 'Platz'})`;
      return `<li><span>${label}</span>${r.won
        ? `<span class="win">+${fmt(r.payout)}</span>`
        : `<span class="lose">−${fmt(r.amount)}</span>`}</li>`;
    }).join('')
    : '<li><span>Keine Wetten in diesem Rennen.</span></li>';

  const dlg = $('#result-dialog');
  dlg.showModal();

  // Kontostände animiert aktualisieren
  const oldBalances = {};
  results.forEach((r) => {
    const p = playerById(r.playerId);
    if (!(p.id in oldBalances)) oldBalances[p.id] = p.balance - results.filter((x) => x.playerId === p.id).reduce((s, x) => s + x.payout, 0);
  });
  renderWallets();
  Object.entries(oldBalances).forEach(([id, from]) => animateBalance(id, from, playerById(id).balance));
}

function nextRace() {
  $('#result-dialog').close();
  state.raceNo++;
  state.horses = generateHorses();
  save();
  racing = false;
  $$('#bet-form button, #bet-form select, #bet-form input').forEach((el) => { el.disabled = false; });
  renderAll();
  renderTrack();
  resetInfield();
  $('#commentary').textContent = `Rennen #${state.raceNo}: Neues Starterfeld! Jetzt Wetten platzieren.`;
  const broke = state.players.filter((p) => p.balance <= 0);
  if (broke.length) toast(`${broke.map((p) => p.name).join(', ')}: Geldbörse leer – zahl Monopoly-Geld ein!`);
}

function showHistory() {
  $('#history-list').innerHTML = state.history.map((h) => `
    <li><time>${new Date(h.time).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</time>${escapeHtml(h.text)}</li>`).join('')
    || '<li>Noch keine Einträge.</li>';
  $('#history-dialog').showModal();
}

/* ---------------- Events ---------------- */

function bindEvents() {
  $('#add-player').onclick = () => addPlayerInput();
  $('#setup-form').onsubmit = startGame;
  $('#bet-form').onsubmit = placeBet;
  $('#btn-start-race').onclick = startRace;
  $('#btn-next-race').onclick = nextRace;
  $('#result-dialog').addEventListener('cancel', (e) => { e.preventDefault(); nextRace(); });
  $('#btn-history').onclick = showHistory;
  $('#btn-history-close').onclick = () => $('#history-dialog').close();
  $('#btn-reset').onclick = async () => {
    if (racing) return;
    if (!(await askConfirm('Wirklich ein neues Spiel starten? Alle Geldbörsen werden zurückgesetzt.', 'Neues Spiel'))) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* privat-Modus */ }
    state = null;
    showSetup();
  };

  ['#bet-amount', '#bet-type', '#bet-horse'].forEach((s) => $(s).addEventListener('input', () => { renderPreview(); renderOdds(); }));

  $('.chips').addEventListener('click', (e) => {
    const chip = e.target.dataset.chip;
    if (!chip) return;
    const input = $('#bet-amount');
    const p = playerById($('#bet-player').value);
    if (chip === 'clear') input.value = '';
    else if (chip === 'all') input.value = Math.floor(p.balance);
    else input.value = Math.min((Number(input.value) || 0) + Number(chip), Math.floor(p.balance));
    renderPreview();
  });

  $('#odds-body').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-horse]');
    if (!row || racing) return;
    $('#bet-horse').value = row.dataset.horse;
    renderOdds();
    renderPreview();
  });

  $('#wallets').addEventListener('click', (e) => {
    const t = e.target;
    if (t.dataset.deposit) openMoneyDialog(t.dataset.deposit, 'in');
    if (t.dataset.withdraw) openMoneyDialog(t.dataset.withdraw, 'out');
  });

  $('#bet-list').addEventListener('click', (e) => {
    const idx = e.target.dataset.removeBet;
    if (idx !== undefined) removeBet(Number(idx));
  });
}

/* ---------------- Init ---------------- */

bindEvents();
state = load();
if (state && state.players && state.players.length) showGame();
else showSetup();
