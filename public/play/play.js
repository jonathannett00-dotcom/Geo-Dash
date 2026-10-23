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
    if (res.started) $('#join-msg').textContent = 'Das Spiel läuft bereits – Beitritt nicht mehr möglich.';
    else if (res.full) $('#join-msg').textContent = 'Der Raum ist voll.';
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
  $('#join-msg').textContent = '';
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

/* ---------------- Aktionen ---------------- */

/** Schickt eine Absicht an den Server; Ablehnungen erscheinen als Meldung. */
function act(action) {
  return new Promise((resolve) => {
    socket.emit('act', action, (res) => {
      if (!res.ok) toast(res.error, 'error');
      resolve(res);
    });
  });
}
window.__act = act;

/* ---------------- App ---------------- */

let tab = 'turn';
let lastAttention = '';
let miniOpen = null;
let bankruptArmed = 0;

function showApp() {
  $('#join').classList.add('hidden');
  $('#app').classList.remove('hidden');
  render();
}

function setTab(t) {
  tab = t;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  ['turn', 'props', 'trade', 'mini'].forEach((k) => $(`#panel-${k}`).classList.toggle('hidden', !S?.game || k !== t));
  window.scrollTo(0, 0);
}

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b && !b.disabled) setTab(b.dataset.tab);
});

const lobbyMe = () => S?.lobby.find((p) => p.id === me);
const gp = (id) => S.game.players.find((p) => p.id === id);
const pname = (id) => (id ? escapeHtml(gp(id)?.name || '?') : 'die Bank');
const sqName = (i) => escapeHtml(S.board[i].name);
const gcolor = (i) => S.groupColors[S.board[i].group];

let shownMoney;

function renderHeader() {
  const p = lobbyMe();
  if (!p) return;
  document.documentElement.style.setProperty('--me', p.color);
  $('#me-fig').textContent = p.figure;
  $('#me-name').textContent = p.name;
  const g = S.game;
  if (!g) {
    $('#me-money').textContent = fmtM(S.settings.startMoney);
    $('#turn-name').textContent = '–';
    return;
  }
  const mine = gp(me);
  if (shownMoney !== mine.money) {
    animateMoney($('#me-money'), shownMoney, mine.money, $('.me-money-wrap'));
    shownMoney = mine.money;
  }
  const cur = gp(g.currentId);
  const t = $('#turn-name');
  t.textContent = g.phase === 'gameover' ? 'Spielende' : (cur.id === me ? 'Du!' : cur.name);
  t.classList.toggle('mine', cur.id === me && g.phase !== 'gameover');
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

/* ---------------- Tab: Zug ---------------- */

function deed(i) {
  const sq = S.board[i];
  let rows;
  if (sq.type === 'street') {
    const labels = ['Miete', '1 Haus', '2 Häuser', '3 Häuser', '4 Häuser', 'Hotel'];
    rows = sq.rent.map((r, k) => `<tr><td>${labels[k]}</td><td>${fmtM(r)}</td></tr>`).join('') + `<tr><td>Hauspreis</td><td>${fmtM(sq.house)}</td></tr>`;
  } else if (sq.type === 'railroad') {
    rows = [25, 50, 100, 200].map((r, k) => `<tr><td>${k + 1} Bahnhof${k ? 'e' : ''}</td><td>${fmtM(r)}</td></tr>`).join('');
  } else {
    rows = '<tr><td>1 Werk</td><td>4× Augenzahl</td></tr><tr><td>2 Werke</td><td>10× Augenzahl</td></tr>';
  }
  return `<div class="deed"><div class="deed-head" style="--g:${gcolor(i)}">${sqName(i)}</div><table>${rows}</table>
    <div class="deed-price">Kaufpreis ${fmtM(sq.price)}</div></div>`;
}

const btn = (label, action, cls = '', disabled = false) =>
  `<button class="btn huge ${cls}" data-act='${escapeHtml(JSON.stringify(action))}' ${disabled ? 'disabled' : ''}>${label}</button>`;

function turnHtml() {
  const g = S.game;
  const mine = gp(me);
  const cur = gp(g.currentId);
  const myTurn = cur.id === me;
  const out = [];

  if (mine.bankrupt) out.push('<div class="box"><h2>💥 Du bist pleite</h2><p>Du kannst weiter auf dem Tablet zuschauen.</p></div>');

  if (g.phase === 'gameover') {
    const w = gp(g.winner);
    out.push(`<div class="box center"><div class="huge-emoji">🏆</div><h2>${w ? (w.id === me ? 'Du hast gewonnen!' : `${escapeHtml(w.name)} gewinnt!`) : 'Spielende'}</h2></div>`);
  } else if (S.paused && !myTurn) {
    out.push(`<div class="box info">⏸ ${escapeHtml(cur.name)} ist getrennt – der Zug ist pausiert.</div>`);
  } else {
    switch (g.phase) {
      case 'roll':
        out.push(myTurn
          ? '<div class="box mine"><h2>🎲 Du bist dran!</h2><p>Das Tablet würfelt gleich für dich.</p></div>'
          : `<div class="box">🎲 <b>${escapeHtml(cur.name)}</b> ist am Zug.</div>`);
        break;
      case 'jail':
        if (myTurn) {
          out.push(`<div class="box mine"><h2>🔒 Du sitzt im Gefängnis</h2><p>Wie willst du raus? Versuch ${mine.jailRolls + 1} von 3.</p></div>
            ${btn(`${fmtM(50)} zahlen`, { type: 'jail:pay' }, 'primary')}
            ${btn(`Freikarte einsetzen (${mine.jailCards})`, { type: 'jail:card' }, '', mine.jailCards === 0)}
            ${btn('🎲 Würfeln – auf einen Pasch hoffen', { type: 'jail:roll' }, 'go')}`);
        } else out.push(`<div class="box">🔒 <b>${escapeHtml(cur.name)}</b> sitzt im Gefängnis und entscheidet.</div>`);
        break;
      case 'buy': {
        const i = g.turn.buyOffer;
        if (myTurn) {
          out.push(`<div class="box mine"><h2>Kaufen?</h2>${deed(i)}<p class="muted">Du hast ${fmtM(mine.money)}.</p></div>
            ${btn(`Kaufen für ${fmtM(S.board[i].price)}`, { type: 'buy' }, 'go')}
            ${btn('Nicht kaufen → Versteigerung', { type: 'decline' }, 'ghost-dark')}`);
        } else out.push(`<div class="box">🤔 <b>${escapeHtml(cur.name)}</b> überlegt, ob ${sqName(i)} gekauft wird.</div>`);
        break;
      }
      case 'auction': out.push(auctionHtml(g, mine)); break;
      case 'debt': {
        const d = g.debts[0];
        if (d.debtorId === me) {
          const armed = Date.now() - bankruptArmed < 5000;
          out.push(`<div class="box warn"><h2>💸 Du musst ${fmtM(d.amount)} zahlen</h2>
            <p>an ${pname(d.creditorId)} (${escapeHtml(d.reason)}). Du hast ${fmtM(mine.money)}.</p>
            <p>Verkaufe Häuser oder nimm Hypotheken auf – sobald das Geld reicht, wird automatisch bezahlt.</p></div>
            <button class="btn huge primary" data-tab-go="props">🏠 Zum Besitz</button>
            <button class="btn huge danger" id="btn-bankrupt">${armed ? 'Wirklich? Nochmal tippen = pleite' : 'Bankrott erklären'}</button>`);
        } else out.push(`<div class="box">💸 <b>${pname(d.debtorId)}</b> muss ${fmtM(d.amount)} an ${pname(d.creditorId)} zahlen und beschafft Geld.</div>`);
        break;
      }
      case 'minigame':
        out.push(`<div class="box mine"><h2>🎰 Minispiel für alle!</h2><p>Gleich geht es los – schau ins Tab „Minispiel“.</p></div>
          <button class="btn huge primary" data-tab-go="mini" ${S.mini ? '' : 'disabled'}>Zum Minispiel</button>`);
        break;
      default: break;
    }
  }

  if (g.lastRoll) {
    out.push(`<div class="box small"><b>Letzter Wurf:</b> ${pname(g.lastRoll.playerId)} – 🎲 ${g.lastRoll.dice[0]} + ${g.lastRoll.dice[1]} = ${g.lastRoll.sum}${g.lastRoll.doubles ? ' (Pasch)' : ''}</div>`);
  }
  out.push(`<ul class="mini-log">${g.log.slice(-5).reverse().map((e) => `<li>${escapeHtml(e.text)}</li>`).join('')}</ul>`);
  return out.join('');
}

function auctionHtml(g, mine) {
  const a = g.auction;
  const min = a.bidderId ? a.bid + 10 : 10;
  const head = `<div class="box"><h2>🔨 Versteigerung: ${sqName(a.square)}</h2>
    <div class="au-row"><div><div class="muted">Höchstgebot</div><div class="au-bid">${a.bidderId ? fmtM(a.bid) : '–'}</div>
    <div class="muted">${a.bidderId ? `von ${a.bidderId === me ? 'dir' : pname(a.bidderId)}` : 'noch kein Gebot'}</div></div>
    <div class="au-timer">⏱ <span data-ends="${a.endsAt}"></span></div></div></div>`;
  if (mine.bankrupt) return head;
  if (a.passed.includes(me)) return `${head}<div class="box info">Du bist ausgestiegen.</div>`;
  if (a.bidderId === me) return `${head}<div class="box mine">Du hast das Höchstgebot! Warte, ob jemand überbietet.</div>`;
  const quick = [min, min + 40, min + 90].map((v) => `<button class="btn primary" data-act='${JSON.stringify({ type: 'bid', amount: v })}'>${fmtM(v)}</button>`).join('');
  return `${head}${deed(a.square)}
    <div class="box"><div class="muted">Schnell bieten (Mindestschritt 10 M)</div><div class="btn-row three">${quick}</div>
      <div class="bid-custom"><input id="bid-amount" type="number" inputmode="numeric" min="${min}" step="10" placeholder="${min}" /><button class="btn go" id="btn-bid">Bieten</button></div>
      <p class="muted">Du hast ${fmtM(mine.money)}.</p></div>
    ${btn('Aussteigen', { type: 'pass' }, 'ghost-dark')}`;
}

/* ---------------- Tab: Besitz ---------------- */

function propsHtml() {
  const g = S.game;
  const mine = gp(me);
  const locked = g.phase === 'minigame' || g.phase === 'gameover' || mine.bankrupt;
  const owned = g.props.map((st, i) => (st && st.owner === me ? i : -1)).filter((i) => i >= 0);
  const head = `<div class="box"><div class="stat-row">
      <div><div class="muted">Kontostand</div><b>${fmtM(mine.money)}</b></div>
      <div><div class="muted">Beleihbar</div><b>${fmtM(mine.assets)}</b></div>
      <div><div class="muted">Freikarten</div><b>${mine.jailCards}</b></div></div>
    <p class="muted small">Bank: ${g.bank.houses}/32 Häuser · ${g.bank.hotels}/12 Hotels</p>
    ${locked && !mine.bankrupt ? '<p class="note">Während des Minispiels ist Bauen gesperrt.</p>' : ''}</div>`;
  if (!owned.length) return `${head}<div class="box info">Du besitzt noch keine Grundstücke.</div>`;
  const items = owned.map((i) => {
    const sq = S.board[i];
    const st = g.props[i];
    const group = g.props.map((x, j) => (S.board[j].group === sq.group && x ? j : -1)).filter((j) => j >= 0);
    const full = group.every((j) => g.props[j].owner === me);
    let status = st.mortgaged ? 'Hypothek' : (st.houses === 5 ? '🏨 Hotel' : (st.houses ? `${'🏠'.repeat(st.houses)}` : (sq.type === 'street' ? (full ? 'Farbgruppe komplett' : 'unbebaut') : '')));
    const mv = sq.price / 2;
    const buttons = [];
    if (sq.type === 'street') {
      buttons.push(`<button class="btn small go" data-act='${JSON.stringify({ type: 'build', square: i })}' ${locked || !full || st.houses >= 5 || st.mortgaged ? 'disabled' : ''}>+ ${st.houses === 4 ? 'Hotel' : 'Haus'} (${fmtM(sq.house)})</button>`);
      buttons.push(`<button class="btn small" data-act='${JSON.stringify({ type: 'sell', square: i })}' ${locked || !st.houses ? 'disabled' : ''}>− ${st.houses === 5 ? 'Hotel' : 'Haus'} (+${fmtM(sq.house / 2)})</button>`);
    }
    buttons.push(st.mortgaged
      ? `<button class="btn small primary" data-act='${JSON.stringify({ type: 'unmortgage', square: i })}' ${locked ? 'disabled' : ''}>Ablösen (${fmtM(mv + Math.ceil(mv / 10))})</button>`
      : `<button class="btn small" data-act='${JSON.stringify({ type: 'mortgage', square: i })}' ${locked || st.houses ? 'disabled' : ''}>Hypothek (+${fmtM(mv)})</button>`);
    return `<div class="prop ${st.mortgaged ? 'mort' : ''}" style="--g:${gcolor(i)}">
      <div class="prop-head"><b>${sqName(i)}</b><span>${status}</span></div>
      <div class="prop-btns">${buttons.join('')}</div></div>`;
  });
  return head + items.join('');
}

/* ---------------- Tab: Handel ---------------- */

function tradeSide(t, side) {
  const s = t[side];
  const parts = s.props.map((i) => `<span class="chip" style="--g:${gcolor(i)}">${sqName(i)}</span>`);
  if (s.money) parts.push(`<span class="chip money">${fmtM(s.money)}</span>`);
  if (s.jailCards) parts.push(`<span class="chip">🎫 ${s.jailCards}</span>`);
  return parts.join(' ') || '<span class="muted">nichts</span>';
}

function tradeHtml() {
  const g = S.game;
  const mine = gp(me);
  const locked = g.phase === 'minigame' || g.phase === 'gameover' || mine.bankrupt;
  const incoming = g.trades.filter((t) => t.toId === me);
  const outgoing = g.trades.filter((t) => t.fromId === me);
  const out = [];
  incoming.forEach((t) => out.push(`<div class="box offer"><h2>Angebot von ${pname(t.fromId)}</h2>
    <div class="offer-row"><span class="muted">Du bekommst</span><div>${tradeSide(t, 'give')}</div></div>
    <div class="offer-row"><span class="muted">Du gibst</span><div>${tradeSide(t, 'want')}</div></div>
    <div class="btn-row"><button class="btn go" data-act='${JSON.stringify({ type: 'trade:respond', id: t.id, accept: true })}' ${locked ? 'disabled' : ''}>Annehmen</button>
    <button class="btn danger" data-act='${JSON.stringify({ type: 'trade:respond', id: t.id, accept: false })}'>Ablehnen</button></div></div>`));
  outgoing.forEach((t) => out.push(`<div class="box offer mine"><h2>Dein Angebot an ${pname(t.toId)}</h2>
    <div class="offer-row"><span class="muted">Du gibst</span><div>${tradeSide(t, 'give')}</div></div>
    <div class="offer-row"><span class="muted">Du bekommst</span><div>${tradeSide(t, 'want')}</div></div>
    <button class="btn ghost-dark" data-act='${JSON.stringify({ type: 'trade:cancel', id: t.id })}'>Zurückziehen</button></div>`));

  if (mine.bankrupt) return out.join('') || '<div class="box info">Du spielst nicht mehr mit.</div>';
  const partners = g.players.filter((p) => !p.bankrupt && p.id !== me);
  if (!partners.length) return out.join('');
  const sel = $('#tr-partner')?.value;
  const partner = partners.find((p) => p.id === sel) || partners[0];
  const tradable = (pid, prefix) => g.props.map((st, i) => (st && st.owner === pid ? i : -1)).filter((i) => i >= 0).map((i) => {
    const sq = S.board[i];
    const built = sq.type === 'street' && g.props.some((x, j) => x && S.board[j].group === sq.group && x.houses > 0);
    return `<label class="check ${built ? 'off' : ''}" style="--g:${gcolor(i)}"><input type="checkbox" id="${prefix}-${i}" value="${i}" ${built ? 'disabled' : ''} />
      <span>${sqName(i)}${g.props[i].mortgaged ? ' (Hypothek)' : ''}${built ? ' – Häuser' : ''}</span></label>`;
  }).join('') || '<p class="muted small">keine Grundstücke</p>';

  out.push(`<div class="box"><h2>Neues Angebot</h2>
    ${locked ? '<p class="note">Während eines Minispiels ist kein Handel möglich.</p>' : ''}
    <label>Mit<select id="tr-partner">${partners.map((p) => `<option value="${p.id}" ${p.id === partner.id ? 'selected' : ''}>${p.figure} ${escapeHtml(p.name)}</option>`).join('')}</select></label>
    <h3>Du gibst</h3>
    <div class="checks">${tradable(me, 'tg')}</div>
    <div class="two"><label>Geld<input id="tg-money" type="number" min="0" step="10" inputmode="numeric" placeholder="0" /></label>
      <label>Freikarten<input id="tg-cards" type="number" min="0" max="${mine.jailCards}" inputmode="numeric" placeholder="0" /></label></div>
    <h3>Du bekommst von ${escapeHtml(partner.name)}</h3>
    <div class="checks">${tradable(partner.id, `tw-${partner.id}`)}</div>
    <div class="two"><label>Geld<input id="tw-money" type="number" min="0" step="10" inputmode="numeric" placeholder="0" /></label>
      <label>Freikarten<input id="tw-cards" type="number" min="0" max="${partner.jailCards}" inputmode="numeric" placeholder="0" /></label></div>
    <button class="btn huge primary" id="btn-trade" ${locked ? 'disabled' : ''}>Angebot senden</button></div>`);
  return out.join('');
}

function collectTrade() {
  const partner = $('#tr-partner').value;
  const picked = (prefix) => $$(`input[id^="${prefix}-"]:checked`).map((i) => Number(i.value));
  return {
    toId: partner,
    give: { props: picked('tg'), money: Number($('#tg-money').value) || 0, jailCards: Number($('#tg-cards').value) || 0 },
    want: { props: picked(`tw-${partner}`), money: Number($('#tw-money').value) || 0, jailCards: Number($('#tw-cards').value) || 0 },
  };
}

/* ---------------- Tab: Minispiel ---------------- */

const MINI = {};
const miniSel = { horse: null, type: 'win' };
const miniAct = (action) => ({ type: 'mini', action });
const myBets = (m) => (m.bets || []).filter((b) => b.playerId === me);

function miniHtml() {
  const m = S.mini;
  if (!m) return '<div class="box info">Gerade läuft kein Minispiel.</div>';
  const playing = m.players.some((p) => p.id === me);
  if (!playing) return '<div class="box info">Du spielst bei diesem Minispiel nicht mit – schau aufs Tablet.</div>';
  return MINI[m.type] ? MINI[m.type](m) : '';
}

/** Kopf mit Countdown und Mindesteinsatz-Hinweis während der Wettzeit. */
function betHead(m, title) {
  const ready = m.ready.includes(me);
  return `<div class="box mini-head"><div class="mh-row"><h2>${title}</h2>
    ${m.phase === 'betting' ? `<div class="mh-timer">⏱ <span data-ends="${m.endsAt}"></span></div>` : ''}</div>
    ${m.phase === 'betting' ? `<p class="muted small">Mindesteinsatz ${fmtM(m.minBet)} · wer nichts setzt, setzt aus. ${m.ready.length}/${m.players.length} fertig.</p>` : ''}
    ${ready && m.phase === 'betting' ? '<p class="note">✓ Du bist fertig – warte auf die anderen.</p>' : ''}</div>`;
}

const readyBtn = (m) => (m.phase === 'betting' && !m.ready.includes(me)
  ? `<button class="btn huge go" data-act='${JSON.stringify(miniAct({ type: 'ready' }))}'>✓ Fertig</button>` : '');

const amountPicker = (id, placeholder = '0') => `<div class="amount">
    <input id="${id}" type="number" inputmode="numeric" min="10" step="10" placeholder="${placeholder}" />
    <div class="chips">${[10, 50, 100].map((v) => `<button class="btn small" data-amt="${id}:${v}">+${v}</button>`).join('')}<button class="btn small" data-amt="${id}:0">✕</button></div></div>`;

/* ---------- Pferderennen ---------- */

MINI.horserace = (m) => {
  const mine = myBets(m);
  const stake = mine.reduce((s, b) => s + b.amount, 0);
  const betList = mine.length
    ? `<ul class="bet-list">${mine.map((b) => `<li><span class="silk" style="background:${m.horses[b.horse].silk}"></span>#${b.horse + 1} ${escapeHtml(m.horses[b.horse].name)} · ${b.type === 'win' ? 'Sieg' : 'Platz'}<b>${fmtM(b.amount)}</b></li>`).join('')}</ul>`
    : '<p class="muted">Noch keine Wette.</p>';

  if (m.phase === 'betting' && !m.ready.includes(me)) {
    const sel = miniSel.horse;
    const h = sel !== null ? m.horses[sel] : null;
    return `${betHead(m, '🏇 Pferderennen')}
      <div class="box"><div class="muted small">1. Pferd wählen</div>
        <div class="horse-list">${m.horses.map((x, i) => `<button class="hl ${sel === i ? 'sel' : ''}" data-hr-horse="${i}">
          <span class="silk" style="background:${x.silk}"></span><span class="hl-name">#${i + 1} ${escapeHtml(x.name)}</span>
          <span class="hl-odds">S ${x.winOdds.toFixed(1)} · P ${x.placeOdds.toFixed(2)}</span></button>`).join('')}</div>
        <div class="muted small">2. Wettart</div>
        <div class="seg"><button data-hr-type="win" class="${miniSel.type === 'win' ? 'sel' : ''}">Sieg</button><button data-hr-type="place" class="${miniSel.type === 'place' ? 'sel' : ''}">Platz (Top 3)</button></div>
        <div class="muted small">3. Einsatz</div>
        ${amountPicker('hr-amount', String(m.minBet))}
        <button class="btn huge primary" id="btn-hr-bet" ${h ? '' : 'disabled'}>${h ? `Wette auf #${sel + 1} (${miniSel.type === 'win' ? `Quote ${h.winOdds.toFixed(1)}` : `Quote ${h.placeOdds.toFixed(2)}`})` : 'Erst ein Pferd wählen'}</button>
      </div>
      <div class="box"><h3>Deine Wetten ${stake ? `· ${fmtM(stake)}` : ''}</h3>${betList}
        ${mine.length ? `<button class="btn small ghost-dark" data-act='${JSON.stringify(miniAct({ type: 'clear' }))}'>Alle zurücknehmen</button>` : ''}</div>
      ${readyBtn(m)}`;
  }
  if (m.phase === 'betting') return `${betHead(m, '🏇 Pferderennen')}<div class="box"><h3>Deine Wetten</h3>${betList}</div>`;
  if (m.phase === 'running') return `${betHead(m, '🏇 Pferderennen')}<div class="box mine"><h2>🏁 Das Rennen läuft!</h2><p>Schau aufs Tablet.</p></div><div class="box"><h3>Deine Wetten</h3>${betList}</div>`;
  const res = (m.results || []).filter((r) => r.playerId === me);
  const net = res.reduce((s, r) => s + r.payout - r.amount, 0);
  const order = m.order || [];
  return `${betHead(m, '🏇 Zieleinlauf')}
    <div class="box"><ol class="podium-list">${order.slice(0, 3).map((i) => `<li><span class="silk" style="background:${m.horses[i].silk}"></span>#${i + 1} ${escapeHtml(m.horses[i].name)}</li>`).join('')}</ol></div>
    <div class="box ${net > 0 ? 'mine' : ''}"><h2>${res.length ? (net > 0 ? `🎉 +${fmtM(net)}` : (net < 0 ? `−${fmtM(-net)}` : '±0 M')) : 'Du hast nicht gewettet'}</h2>
      <ul class="bet-list">${res.map((r) => `<li>#${r.horse + 1} ${r.type === 'win' ? 'Sieg' : 'Platz'} · ${fmtM(r.amount)}<b class="${r.won ? 'win' : 'lose'}">${r.won ? `+${fmtM(r.payout)}` : 'verloren'}</b></li>`).join('')}</ul></div>`;
};

/* ---------------- Ereignisse ---------------- */

$('#main').addEventListener('click', async (e) => {
  const actBtn = e.target.closest('[data-act]');
  if (actBtn && !actBtn.disabled) {
    actBtn.disabled = true;
    await act(JSON.parse(actBtn.dataset.act));
    actBtn.disabled = false;
    return;
  }
  const go = e.target.closest('[data-tab-go]');
  if (go && !go.disabled) { setTab(go.dataset.tabGo); return; }
  if (e.target.id === 'btn-bid') {
    const v = Number($('#bid-amount').value);
    if (!v) { toast('Bitte einen Betrag eingeben.', 'error'); return; }
    const res = await act({ type: 'bid', amount: v });
    if (res.ok) $('#bid-amount').value = '';
    return;
  }
  if (e.target.id === 'btn-bankrupt') {
    if (Date.now() - bankruptArmed < 5000) { bankruptArmed = 0; act({ type: 'bankrupt' }); } else { bankruptArmed = Date.now(); render(); }
    return;
  }
  const amt = e.target.closest('[data-amt]');
  if (amt) {
    const [id, v] = amt.dataset.amt.split(':');
    const input = document.getElementById(id);
    input.value = Number(v) ? (Number(input.value) || 0) + Number(v) : '';
    return;
  }
  const horse = e.target.closest('[data-hr-horse]');
  if (horse) { miniSel.horse = Number(horse.dataset.hrHorse); render(); return; }
  const htype = e.target.closest('[data-hr-type]');
  if (htype) { miniSel.type = htype.dataset.hrType; render(); return; }
  if (e.target.id === 'btn-hr-bet') {
    const amount = Number($('#hr-amount').value) || 0;
    const res = await act(miniAct({ type: 'bet', horse: miniSel.horse, kind: miniSel.type, amount }));
    if (res.ok) { $('#hr-amount').value = ''; toast('Wette platziert!'); }
    return;
  }
  if (e.target.id === 'btn-trade') {
    const res = await act({ type: 'trade:propose', trade: collectTrade() });
    if (res.ok) {
      toast('Angebot gesendet.');
      $$('#panel-trade input').forEach((i) => { if (i.type === 'checkbox') i.checked = false; else i.value = ''; });
    }
  }
});

$('#main').addEventListener('change', (e) => {
  if (e.target.id === 'tr-partner') render();
});

/* ---------------- Rendern ---------------- */

/** Wechselt automatisch in den passenden Tab, wenn etwas vom Spieler gebraucht wird. */
function attention() {
  const g = S.game;
  const miniActive = Boolean(S.mini);
  if (miniActive && miniOpen !== S.mini.id) {
    miniOpen = S.mini.id;
    miniSel.horse = null;
    miniSel.type = 'win';
    setTab('mini');
    return;
  }
  if (!miniActive && miniOpen !== null) { miniOpen = null; if (tab === 'mini') setTab('turn'); }
  const needsMe = (g.phase === 'buy' || g.phase === 'jail') ? g.currentId === me
    : g.phase === 'auction' ? !gp(me).bankrupt
      : g.phase === 'debt' ? g.debts[0]?.debtorId === me : false;
  const key = `${g.phase}:${g.currentId}:${g.auction?.seq || ''}:${g.debts[0]?.debtorId || ''}`;
  if (needsMe && key !== lastAttention && tab !== 'turn') setTab('turn');
  lastAttention = key;
}

function render() {
  if (!S || !me) return;
  renderHeader();
  if (!S.game) {
    $('#tabs').classList.add('hidden');
    $('#panel-wait').classList.remove('hidden');
    renderWaiting();
    return;
  }
  if (!gp(me)) return;
  $('#panel-wait').classList.add('hidden');
  $('#tabs').classList.remove('hidden');
  attention();
  setTab(tab);
  const miniBtn = $('#tabs [data-tab="mini"]');
  miniBtn.disabled = !S.mini;
  miniBtn.classList.toggle('pulse', Boolean(S.mini));
  const incoming = S.game.trades.filter((t) => t.toId === me).length;
  $('#trade-badge').textContent = incoming;
  $('#trade-badge').classList.toggle('hidden', !incoming);
  const g = S.game;
  const turnTab = $('#tabs [data-tab="turn"]');
  const needs = (['buy', 'jail'].includes(g.phase) && g.currentId === me) || (g.phase === 'debt' && g.debts[0]?.debtorId === me)
    || (g.phase === 'auction' && !g.auction.passed.includes(me) && g.auction.bidderId !== me && !gp(me).bankrupt);
  turnTab.classList.toggle('pulse', needs);
  patch($('#panel-turn'), turnHtml());
  patch($('#panel-props'), propsHtml());
  patch($('#panel-trade'), tradeHtml());
  patch($('#panel-mini'), miniHtml());
  tickCountdowns();
}
