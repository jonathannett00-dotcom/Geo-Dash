'use strict';

/* =========================================================
 *  Handy: Controller für einen Spieler
 * ========================================================= */

const socket = io();
const params = new URLSearchParams(location.search);
let S = null;
let me = null;          // eigene Spieler-ID
let code = (params.get('room') || '').toUpperCase();
let joinInfo = null;    // belegte Farben/Figuren in der Lobby
let pick = { color: null, figure: null };

const tokenKey = (c) => `monopoly-token-${c}`;
const loadToken = (c) => { try { return localStorage.getItem(tokenKey(c)); } catch (_) { return null; } };
const saveToken = (c, t) => { try { localStorage.setItem(tokenKey(c), t); } catch (_) { /* privat-Modus */ } };
const dropToken = (c) => { try { localStorage.removeItem(tokenKey(c)); } catch (_) { /* privat-Modus */ } };

/* ---------------- Verbindung ---------------- */

socket.on('connect', () => {
  const token = code && loadToken(code);
  if (!token) { if (!me) showJoin(); return; }
  socket.emit('player:resume', { code, token }, (res) => {
    if (res.ok) { me = res.playerId; showApp(); return; }
    dropToken(code);
    me = null;
    showJoin(res.error);
  });
});

socket.on('state', (state) => {
  clock.sync(state.now);
  S = state;
  if (me) render();
  else if (!$('#join').classList.contains('hidden')) refreshJoinInfo();
});

/* ---------------- Beitreten ---------------- */

function showJoin(msg) {
  $('#app').classList.add('hidden');
  $('#join').classList.remove('hidden');
  $('#join-code').value = code;
  $('#join-msg').textContent = msg || '';
  refreshJoinInfo();
}

function refreshJoinInfo() {
  const c = $('#join-code').value.trim().toUpperCase();
  if (c.length !== 4) { joinInfo = null; renderPickers(); return; }
  socket.emit('room:info', { code: c }, (res) => {
    if (!res.ok) { joinInfo = null; $('#join-msg').textContent = res.error; renderPickers(); return; }
    joinInfo = res;
    $('#join-msg').textContent = res.started ? 'Das Spiel läuft bereits – Beitritt nicht mehr möglich.' : (res.full ? 'Der Raum ist voll.' : '');
    renderPickers();
  });
}

function renderPickers() {
  const figures = joinInfo?.figures || ['🎩', '🚗', '🐕', '🚢', '👢', '🐈', '🦆', '🦖', '✈️', '🎸'];
  const colors = joinInfo?.colors || [];
  const takenF = new Set((joinInfo?.lobby || []).map((p) => p.figure));
  const takenC = new Set((joinInfo?.lobby || []).map((p) => p.color));
  if (takenF.has(pick.figure)) pick.figure = null;
  if (takenC.has(pick.color)) pick.color = null;
  patch($('#join-figures'), figures.map((f) => `<button type="button" data-figure="${f}" class="${pick.figure === f ? 'sel' : ''}" ${takenF.has(f) ? 'disabled' : ''} aria-label="Figur ${f}">${f}</button>`).join(''));
  patch($('#join-colors'), colors.map((c) => `<button type="button" data-color="${c}" style="--c:${c}" class="${pick.color === c ? 'sel' : ''}" ${takenC.has(c) ? 'disabled' : ''} aria-label="Farbe"></button>`).join(''));
}

$('#join-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  refreshJoinInfo();
});
$('#join-figures').addEventListener('click', (e) => {
  const b = e.target.closest('[data-figure]');
  if (b && !b.disabled) { pick.figure = b.dataset.figure; renderPickers(); }
});
$('#join-colors').addEventListener('click', (e) => {
  const b = e.target.closest('[data-color]');
  if (b && !b.disabled) { pick.color = b.dataset.color; renderPickers(); }
});

$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const c = $('#join-code').value.trim().toUpperCase();
  if (!pick.figure) { $('#join-msg').textContent = 'Bitte wähle eine Spielfigur.'; return; }
  if (!pick.color) { $('#join-msg').textContent = 'Bitte wähle eine Farbe.'; return; }
  socket.emit('player:join', { code: c, name: $('#join-name').value, color: pick.color, figure: pick.figure }, (res) => {
    if (!res.ok) { $('#join-msg').textContent = res.error; refreshJoinInfo(); return; }
    code = res.code;
    me = res.playerId;
    saveToken(code, res.token);
    const url = new URL(location.href);
    url.searchParams.set('room', code);
    history.replaceState(null, '', url);
    showApp();
  });
});

/* ---------------- App ---------------- */

function showApp() {
  $('#join').classList.add('hidden');
  $('#app').classList.remove('hidden');
  render();
}

function lobbyMe() { return S?.lobby.find((p) => p.id === me); }

function renderHeader() {
  const p = lobbyMe();
  if (!p) return;
  document.documentElement.style.setProperty('--me', p.color);
  $('#me-fig').textContent = p.figure;
  $('#me-name').textContent = p.name;
}

function renderWaiting() {
  patch($('#panel-wait'), `
    <div class="waiting">
      <div class="big">⏳</div>
      <h2>Warte auf den Spielstart…</h2>
      <p>Raum <b>${escapeHtml(S.code)}</b> · Start mit ${fmtM(S.settings.startMoney)}</p>
    </div>
    <ul class="lobby-list">${S.lobby.map((p) => `<li style="--c:${p.color}" class="${p.connected ? '' : 'off'}">${p.figure} ${escapeHtml(p.name)}${p.id === me ? ' (du)' : ''}</li>`).join('')}</ul>`);
}

function render() {
  if (!S || !me) return;
  renderHeader();
  if (!S.started) {
    $('#me-money').textContent = fmtM(S.settings.startMoney);
    renderWaiting();
    return;
  }
  patch($('#panel-wait'), '<div class="waiting"><div class="big">🎲</div><h2>Das Spiel hat begonnen!</h2></div>');
}
