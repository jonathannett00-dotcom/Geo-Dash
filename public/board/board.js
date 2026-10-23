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
  const input = $('#start-money');
  if (document.activeElement !== input) input.value = S.settings.startMoney;
  const enough = list.length >= S.minPlayers;
  $('#btn-start').disabled = !enough;
  $('#lobby-hint').textContent = enough
    ? `Alle starten mit ${fmtM(S.settings.startMoney)}.`
    : `Mindestens ${S.minPlayers} Spieler werden gebraucht.`;
}

$('#start-money').addEventListener('change', (e) => {
  socket.emit('board:settings', { startMoney: Number(e.target.value) }, (res) => {
    if (!res.ok) { toast(res.error, 'error'); e.target.value = S.settings.startMoney; }
  });
});

$('#btn-start').addEventListener('click', () => {
  socket.emit('board:start', {}, (res) => { if (!res.ok) toast(res.error, 'error'); });
});

/* ---------------- Spiel ---------------- */

function renderGame() {
  $('#lobby').classList.add('hidden');
  $('#game').classList.remove('hidden');
  $('#side-code').textContent = S.code;
  patch($('#center-main'), '<div class="idle-title">Das Spiel hat begonnen!</div>');
}

function render() {
  if (!S) return;
  if (!S.started) renderLobby();
  else renderGame();
}
