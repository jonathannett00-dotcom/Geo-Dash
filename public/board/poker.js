'use strict';

/* =========================================================
 *  Tablet/TV: Poker-Tisch. Ovaler Tisch in ruhigem Grün, bis zu 12 Plätze
 *  gleichmäßig verteilt, Gemeinschaftskarten und Pot in der Mitte, Spieler-
 *  liste am Rand. Nur Anzeige – Karten, Einsätze und Gewinner kommen vom
 *  Server; Handkarten sieht der Fernseher erst, wenn sie aufgedeckt werden.
 *
 *  Animationen: Der Server schickt Ereignisse mit Startzeit und Dauer
 *  (strikt nacheinander). Angezeigt wird der Stand des Servers, bei dem
 *  noch nicht begonnene Ereignisse zurückgerechnet sind; beim Start eines
 *  Ereignisses läuft seine Bewegung (Austeilen, Chips, Aufdecken, Gewinn).
 * ========================================================= */

const PK_REDUCED = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
const PK_ACTIONS = { fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise', allin: 'All-in', sb: 'Small Blind', bb: 'Big Blind' };

let pkBuiltFor = '';
let pkEffectSeq = null;     // letztes Ereignis, dessen Bewegung gelaufen ist
let pkTimer = null;
let pkGeom = null;          // Positionen der Plätze, Einsätze und der Mitte
let pkLayoutKey = '';

const pkMotion = () => !PK_REDUCED.matches && S.settings.animation !== 'aus';
const pkPlayer = (id) => S.game.players.find((p) => p.id === id);

/* ---------------- Aufbau und Layout ---------------- */

function pkBuildTable(g) {
  const key = g.players.map((p) => p.id).join(',');
  if (pkBuiltFor === key) return;
  pkBuiltFor = key;
  pkLayoutKey = '';
  const table = $('#pkt-table');
  table.innerHTML = `
    <div class="pkt-felt" id="pkt-felt"></div>
    <div class="pkt-center" id="pkt-center">
      <div class="pkt-board" id="pkt-board"></div>
      <div class="pkt-pot" id="pkt-pot"></div>
      <div class="pkt-msg" id="pkt-msg" aria-live="polite"></div>
    </div>
    ${g.players.map((p) => `<div class="pkt-bet hidden" id="pkt-b-${p.id}"></div>`).join('')}
    <div class="pkt-dealer hidden" id="pkt-dealer" aria-label="Dealer">D</div>
    ${g.players.map((p) => `<div class="pkt-seat" id="pkt-s-${p.id}" style="--c:${p.color};--ink:${lbInkOn(p.color)}"></div>`).join('')}
    <div class="pkt-fx" id="pkt-fx"></div>`;
  $('#poker').classList.toggle('many', g.players.length >= 9);
}

/**
 * Plätze gleichmäßig auf einer Ellipse: Platz 1 unten in der Mitte, dann im Uhrzeigersinn.
 * Die Größe richtet sich nach der Tischfläche; ab 9 Spielern kleinere Karten und Schrift.
 */
function pkLayout(force = false) {
  const table = $('#pkt-table');
  const W = table.clientWidth;
  const H = table.clientHeight;
  const n = S.game.players.length;
  const key = `${W}x${H}:${n}`;
  if (!W || !H || (!force && key === pkLayoutKey)) return;
  pkLayoutKey = key;
  const many = n >= 9;
  const u = Math.max(9, Math.min(W / (many ? 66 : 58), H / (many ? 47 : 42)));
  table.style.setProperty('--u', `${u.toFixed(2)}px`);
  const seatW = u * (many ? 8.6 : 10);
  const seatH = u * (many ? 6.4 : 7.4);
  const cx = W / 2;
  const cy = H / 2;
  const rx = W / 2 - seatW / 2 - u * 0.4;
  const ry = H / 2 - seatH / 2 - u * 0.4;
  const felt = $('#pkt-felt');
  Object.assign(felt.style, { left: `${cx - rx}px`, top: `${cy - ry}px`, width: `${2 * rx}px`, height: `${2 * ry}px` });
  const pos = {};
  S.game.players.forEach((p, i) => {
    const t = Math.PI / 2 + (i * 2 * Math.PI) / n;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const seat = { x: cx + rx * c, y: cy + ry * s };
    // Einsatz vor dem Platz Richtung Mitte: Abstand so, dass er den Platz in jeder Richtung freilässt
    const len = Math.hypot(cx - seat.x, cy - seat.y) || 1;
    const ux = (cx - seat.x) / len;
    const uy = (cy - seat.y) / len;
    const dist = Math.abs(ux) * (seatW / 2 + u * 3.6) + Math.abs(uy) * (seatH / 2 + u * 1.3);
    const bet = { x: seat.x + ux * dist, y: seat.y + uy * dist };
    // Nicht in die Mitte (Karten und Pot) ragen: notfalls näher an den Platz
    const half = { w: u * (many ? 10.6 : 12.2) + u * 3, h: u * 6.2 + u * 0.9 };
    const minDist = Math.abs(ux) * (seatW / 2 + u * 2.9) + Math.abs(uy) * (seatH / 2 + u * 0.9);
    let d2 = dist;
    while (d2 > minDist && Math.abs(bet.x - cx) < half.w && Math.abs(bet.y - cy) < half.h) {
      d2 -= u * 0.2;
      bet.x = seat.x + ux * d2;
      bet.y = seat.y + uy * d2;
    }
    // Dealer-Button neben dem Einsatz, quer zur Richtung zur Mitte (im Uhrzeigersinn)
    const side = u * (Math.abs(uy) > 0.6 ? 4.6 : 2.2);
    const dealer = { x: bet.x - uy * side, y: bet.y + ux * side };
    pos[p.id] = { seat, bet, dealer };
    const el = document.getElementById(`pkt-s-${p.id}`);
    el.style.left = `${seat.x}px`;
    el.style.top = `${seat.y}px`;
    el.style.setProperty('--dx', `${(cx - seat.x).toFixed(1)}px`);
    el.style.setProperty('--dy', `${(cy - seat.y).toFixed(1)}px`);
    const b = document.getElementById(`pkt-b-${p.id}`);
    b.style.left = `${bet.x}px`;
    b.style.top = `${bet.y}px`;
    b.style.setProperty('--dx', `${(seat.x - bet.x).toFixed(1)}px`);
    b.style.setProperty('--dy', `${(seat.y - bet.y).toFixed(1)}px`);
  });
  pkGeom = { cx, cy, pos, u };
}
window.addEventListener('resize', () => { if (pkBuiltFor && S && S.gameType === 'poker' && S.game) { pkLayout(); renderPoker(); } });

/* ---------------- Angezeigter Stand ---------------- */

/** Stand des Servers, bei dem noch nicht begonnene Ereignisse zurückgerechnet sind. */
function pkDisplay(g, now) {
  const players = Object.fromEntries(g.players.map((p) => [p.id, {
    stack: p.stack, bet: p.bet, folded: p.folded, hasCards: p.hasCards, allIn: p.allIn, lastAction: p.lastAction,
    shown: p.shown, handLabel: p.handLabel,
  }]));
  let board = g.board.slice();
  let pot = g.potCollected;
  const events = (S.anim && S.anim.events) || [];
  const pending = events.filter((e) => e.at > now).sort((a, b) => b.seq - a.seq);
  for (const e of pending) {
    const P = e.playerId ? players[e.playerId] : null;
    switch (e.type) {
      case 'bet':
        if (!P) break;
        P.stack += e.amount; P.bet -= e.amount; P.lastAction = null;
        if (e.action === 'fold') { P.folded = false; P.hasCards = true; }
        if (e.allIn) P.allIn = false;
        break;
      case 'collect':
        for (const [id, amount] of Object.entries(e.bets || {})) if (players[id]) players[id].bet += amount;
        pot -= e.amount;
        break;
      case 'return': if (P) { P.stack -= e.amount; P.bet += e.amount; } break;
      case 'street': board = board.slice(0, Math.max(0, board.length - e.cards.length)); break;
      case 'reveal': if (P) { P.shown = null; P.handLabel = null; P.lastAction = null; } break;
      case 'muck': if (P) { P.folded = false; P.hasCards = true; P.lastAction = null; } break;
      case 'win':
        for (const w of e.winners) if (players[w.id]) players[w.id].stack -= w.amount;
        pot += e.amount;
        break;
      case 'deal': for (const id of e.order) players[id].hasCards = false; break;
      case 'rebuy': if (P) P.stack -= e.amount; break;
      default: break;
    }
  }
  const applied = events.filter((e) => e.at <= now);
  const win = [...applied].reverse().find((e) => e.type === 'win') || null;
  const hand = [...applied].reverse().find((e) => e.type === 'hand');
  const nextAt = pending.length ? Math.min(...pending.map((e) => e.at)) : null;
  return { players, board, pot, win, handNo: hand ? hand.handNo : g.handNo, nextAt, busy: pending.length > 0 };
}

/* ---------------- Darstellung ---------------- */

function pkSeatInner(g, p, v, d) {
  const winners = d.win ? d.win.winners.map((w) => w.id) : [];
  const best = new Set(d.win && d.win.cards ? d.win.cards : []);
  let cards = '';
  if (v.shown) cards = v.shown.map((c) => pkCardHtml(c, best.has(c) ? 'best' : best.size ? 'dim' : '')).join('');
  else if (v.hasCards) cards = pkCardHtml(null) + pkCardHtml(null);
  const tags = [];
  if (p.id === g.sbId && g.phase !== 'between') tags.push('SB');
  if (p.id === g.bbId && g.phase !== 'between') tags.push('BB');
  let action = '';
  if (v.shown && v.handLabel) action = escapeHtml(v.handLabel.split(',')[0]);
  else if (v.allIn && !v.folded && p.inHand) action = 'All-in';
  else if (v.folded && p.inHand) action = 'Fold';
  else if (v.lastAction && !['Small Blind', 'Big Blind'].includes(v.lastAction)) action = escapeHtml(v.lastAction);
  const lp = S.lobby.find((x) => x.id === p.id);
  if (p.status === 'sitout' || p.pendingRebuy) action = 'setzt aus';
  if (p.status === 'left') action = 'gegangen';
  if (p.status === 'out') action = 'pleite';
  if (lp && !lp.connected && p.status !== 'left') action = 'getrennt';
  const won = winners.includes(p.id) ? d.win.winners.find((w) => w.id === p.id).amount : 0;
  return `<div class="pkt-cards">${cards}</div>
    <div class="pkt-plate">
      <div class="pkt-name">${pkSeatHtml(p)}<span>${escapeHtml(p.name)}</span>${tags.map((t) => `<i>${t}</i>`).join('')}</div>
      <div class="pkt-stack">${pkEuro(v.stack)}</div>
      <div class="pkt-act ${v.allIn && !v.folded ? 'allin' : ''}">${won ? `+${pkEuro(won)}` : action || '&nbsp;'}</div>
    </div>`;
}

function pkRenderTable(g, d) {
  const actor = g.actorId || g.decider;
  const winners = d.win ? d.win.winners.map((w) => w.id) : [];
  for (const p of g.players) {
    const v = d.players[p.id];
    const el = document.getElementById(`pkt-s-${p.id}`);
    patch(el, pkSeatInner(g, p, v, d));
    el.classList.toggle('active', !d.busy && actor === p.id && (g.phase === 'betting' || g.phase === 'showdown'));
    el.classList.toggle('folded', Boolean(p.inHand && v.folded) || (!p.inHand && g.phase !== 'between' && g.phase !== 'gameover'));
    el.classList.toggle('out', p.status !== 'playing' || p.pendingRebuy);
    el.classList.toggle('allin', Boolean(v.allIn && !v.folded && p.inHand));
    el.classList.toggle('winner', winners.includes(p.id));
    const b = document.getElementById(`pkt-b-${p.id}`);
    b.classList.toggle('hidden', !v.bet);
    if (v.bet) patch(b, `<i class="pkt-chip"></i>${pkEuro(v.bet)}`);
  }
  // Dealer-Button
  const dealer = $('#pkt-dealer');
  const pos = g.buttonId && pkGeom && pkGeom.pos[g.buttonId];
  dealer.classList.toggle('hidden', !pos);
  if (pos) { dealer.style.left = `${pos.dealer.x}px`; dealer.style.top = `${pos.dealer.y}px`; }
  // Mitte: Gemeinschaftskarten, Pot, Gewinn
  const best = new Set(d.win && d.win.cards ? d.win.cards : []);
  const cards = d.board.map((c) => pkCardHtml(c, best.has(c) ? 'best' : best.size ? 'dim' : ''));
  while (cards.length < 5) cards.push(pkSlotHtml());
  patch($('#pkt-board'), cards.join(''));
  const bets = Object.values(d.players).reduce((s, v) => s + Math.max(0, v.bet), 0);
  // Pot einschließlich der Einsätze dieser Setzrunde (die Chips liegen noch vor den Spielern)
  patch($('#pkt-pot'), d.pot + bets > 0 ? `Pot <b>${pkEuro(d.pot + bets)}</b>` : '');
  patch($('#pkt-msg'), pkWinText(g, d));
}

/** Gewinner mit Handname, z. B. „Ben gewinnt 1,20 € · Full House, Damen über Achten“. */
function pkWinText(g, d) {
  const w = d.win;
  if (!w) return '';
  const names = w.winners.map((x) => escapeHtml(pkPlayer(x.id)?.name || '?')).join(' und ');
  const what = w.side ? `Side-Pot ${w.pot}` : '';
  const verb = w.winners.length > 1 ? 'teilen' : 'gewinnt';
  return `<span class="pkt-win">${what ? `${what}: ` : ''}${names} ${verb} ${pkEuro(w.amount)}</span>${w.label ? `<span class="pkt-label">${escapeHtml(w.label)}</span>` : ''}`;
}

function pkSideHtml(g, d) {
  const rows = g.players.map((p) => {
    const v = d.players[p.id];
    const lp = S.lobby.find((x) => x.id === p.id);
    const state = p.status === 'left' ? 'gegangen' : p.status === 'out' ? 'pleite' : (p.status === 'sitout' || p.pendingRebuy) ? 'setzt aus'
      : lp && !lp.connected ? 'getrennt' : '';
    const cur = (g.actorId || g.decider) === p.id && !d.busy;
    return `<li class="${cur ? 'cur' : ''} ${state ? 'dim' : ''}">${pkSeatHtml(p)}<span class="pkt-l-name">${escapeHtml(p.name)}</span>
      <span class="pkt-l-stack">${pkEuro(v.stack)}</span>
      <small>${p.rebuys ? `${p.rebuys}× nachgekauft` : 'kein Nachkauf'}${state ? ` · ${state}` : ''}</small></li>`;
  });
  return rows.join('');
}

function pkBannerHtml(g, d) {
  const st = S.status || {};
  let text = escapeHtml(st.text || '');
  const p = st.playerId ? pkPlayer(st.playerId) : null;
  if (p && st.text && st.text.startsWith(p.name)) text = `${pkSeatHtml(p)} <b>${escapeHtml(p.name)}</b>${escapeHtml(st.text.slice(p.name.length))}`;
  if (d.busy && g.phase !== 'gameover') text = g.phase === 'between' || g.phase === 'showdown' ? 'Showdown' : `Runde ${d.handNo}`;
  const street = g.phase === 'betting' ? `<span class="pkt-street">${escapeHtml(st.title || '')}</span>` : '';
  const timer = !d.busy && S.deadline && S.deadlineFor ? `<span class="pkt-timer" data-ends="${S.deadline}"></span>` : '';
  const detail = !d.busy && st.detail ? `<span class="pkt-detail">${escapeHtml(st.detail)}</span>` : '';
  const paused = S.paused ? '<span class="pkt-paused">Pausiert – Spieler getrennt</span>' : '';
  return `${street}<span class="pkt-phase">${text}</span>${detail}${timer}${paused}`;
}

function pkFinalHtml(g) {
  const ranking = g.players.slice().sort((a, b) => b.stack - a.stack);
  const w = g.winner ? pkPlayer(g.winner) : null;
  return `<div class="pkt-final-box"><h2>${w ? `${escapeHtml(w.name)} gewinnt` : 'Spielende'}</h2>
    <p>Nach ${g.handNo} Runden</p>
    <ol>${ranking.map((p) => `<li>${pkSeatHtml(p)}<span>${escapeHtml(p.name)}</span><b>${pkEuro(p.stack)}</b>
      <small>${p.net >= 0 ? '+' : ''}${pkEuro(p.net)} · ${p.rebuys ? `${p.rebuys}× nachgekauft` : 'kein Nachkauf'}</small></li>`).join('')}</ol></div>`;
}

function renderPoker() {
  $('#lobby').classList.add('hidden');
  $('#game').classList.add('hidden');
  $('#risiko').classList.add('hidden');
  const root = $('#poker');
  root.classList.remove('hidden');
  root.classList.toggle('anim-off', S.settings.animation === 'aus');
  $('#pkt-code').textContent = S.code;
  const g = S.game;
  pkBuildTable(g);
  pkLayout();
  const now = clock.now();
  const d = pkDisplay(g, now);
  pkRenderTable(g, d);
  patch($('#pkt-banner'), pkBannerHtml(g, d));
  patch($('#pkt-meta'), `Blinds <b>${pkEuroPlain(g.settings.smallBlind)} / ${pkEuro(g.settings.bigBlind)}</b><span>Runde ${d.handNo}</span><span>Start ${pkEuro(g.settings.startMoney)}${g.settings.rebuy ? ', Nachkaufen an' : ''}</span>`);
  patch($('#pkt-list'), pkSideHtml(g, d));
  patch($('#pkt-log'), g.log.slice(-4).reverse().map((e) => `<li>${escapeHtml(e.text)}</li>`).join(''));
  const finalBox = $('#pkt-final');
  const showFinal = g.phase === 'gameover' && !d.busy;
  finalBox.classList.toggle('hidden', !showFinal);
  if (showFinal) patch(finalBox, pkFinalHtml(g));
  pkRunEffects(now);
  clearTimeout(pkTimer);
  if (d.nextAt !== null) pkTimer = setTimeout(renderPoker, Math.max(0, d.nextAt - clock.now()) + 15);
  tickCountdowns();
}

/* ---------------- Bewegungen beim Start eines Ereignisses ---------------- */

/** Neue Ereignisse, die gerade begonnen haben, mit Bewegung und Ton zeigen; Vorgeschichte überspringen. */
function pkRunEffects(now) {
  const events = ((S.anim && S.anim.events) || []).filter((e) => e.at <= now);
  if (pkEffectSeq === null || (S.anim && S.anim.seq < pkEffectSeq)) {
    pkEffectSeq = events.length ? events[events.length - 1].seq : (S.anim ? S.anim.seq : 0);
    return;
  }
  for (const e of events) {
    if (e.seq <= pkEffectSeq) continue;
    pkEffectSeq = e.seq;
    if (now > e.at + e.dur + 400) continue;   // längst vorbei (z. B. Tab im Hintergrund)
    try { pkEffect(e); } catch (err) { console.warn(err); }
  }
}

function pkEffect(e) {
  const motion = pkMotion();
  const fx = $('#pkt-fx');
  const geo = pkGeom;
  switch (e.type) {
    case 'deal': {
      const per = e.order.length ? e.dur / (e.order.length * 2) : 0;
      PkAudio.play('deal', { cards: e.order.length * 2, gap: per / 1000 || 0.1 });
      if (!motion) return;
      e.order.forEach((id, k) => {
        const cards = $$(`#pkt-s-${id} .pkt-cards .pk-card`);
        cards.forEach((c, r) => {
          c.style.setProperty('--delay', `${Math.round((r * e.order.length + k) * per)}ms`);
          c.classList.remove('deal');
          void c.offsetWidth;
          c.classList.add('deal');
        });
      });
      return;
    }
    case 'bet': {
      if (e.amount > 0) PkAudio.play('chips');
      if (!motion || !e.amount) return;
      const b = document.getElementById(`pkt-b-${e.playerId}`);
      if (b) b.animate([{ transform: 'translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) scale(.6)', opacity: 0 }, { transform: 'translate(-50%, -50%)', opacity: 1 }], { duration: Math.min(500, e.dur * 0.8), easing: 'cubic-bezier(.2,.7,.3,1)' });
      return;
    }
    case 'collect':
    case 'return':
    case 'win': {
      if (e.type === 'win') PkAudio.play('win'); else PkAudio.play('chips');
      if (!motion || !geo) return;
      const moves = e.type === 'collect' ? Object.keys(e.bets || {}).map((id) => [geo.pos[id].bet, { x: geo.cx, y: geo.cy + geo.u * 4.2 }])
        : e.type === 'return' ? [[geo.pos[e.playerId].bet, geo.pos[e.playerId].seat]]
          : e.winners.map((w) => [{ x: geo.cx, y: geo.cy + geo.u * 4.2 }, geo.pos[w.id].seat]);
      const delay = e.type === 'win' ? e.dur * 0.35 : 0;
      for (const [from, to] of moves) {
        const chip = document.createElement('i');
        chip.className = 'pkt-chip flying';
        chip.style.left = `${from.x}px`;
        chip.style.top = `${from.y}px`;
        fx.appendChild(chip);
        const a = chip.animate([{ transform: 'translate(-50%, -50%)', opacity: 1 }, { transform: `translate(calc(-50% + ${to.x - from.x}px), calc(-50% + ${to.y - from.y}px))`, opacity: 1 }, { transform: `translate(calc(-50% + ${to.x - from.x}px), calc(-50% + ${to.y - from.y}px))`, opacity: 0 }],
          { duration: Math.max(300, e.dur * (e.type === 'win' ? 0.5 : 0.85)), delay, easing: 'ease-in-out', fill: 'both' });
        a.onfinish = () => chip.remove();
      }
      if (e.type === 'win' && motion) {
        for (const w of e.winners) {
          const seat = document.querySelector(`#pkt-s-${w.id} .pkt-plate`);
          if (seat) seat.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: Math.max(600, e.dur * 0.8), delay });
        }
      }
      return;
    }
    case 'street': {
      const cards = $$('#pkt-board .pk-card:not(.slot)').slice(-e.cards.length);
      const step = e.dur / (e.cards.length + 0.6);
      cards.forEach((c, i) => {
        setTimeout(() => PkAudio.play('flip'), i * step);
        if (!motion) return;
        c.animate([{ transform: 'rotateY(90deg)', opacity: 0 }, { transform: 'rotateY(90deg)', opacity: 0, offset: 0.01 }, { transform: 'rotateY(0deg)', opacity: 1 }], { duration: Math.min(450, step * 0.9), delay: i * step, fill: 'backwards', easing: 'ease-out' });
      });
      return;
    }
    case 'reveal': {
      PkAudio.play('flip');
      if (!motion) return;
      $$(`#pkt-s-${e.playerId} .pkt-cards .pk-card`).forEach((c, i) => {
        c.animate([{ transform: 'rotateY(90deg)' }, { transform: 'rotateY(0deg)' }], { duration: 380, delay: i * 120, fill: 'backwards', easing: 'ease-out' });
      });
      return;
    }
    default:
  }
}
