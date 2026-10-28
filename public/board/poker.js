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
    <div class="pkt-zone pkt-ring" id="pkt-ring"><div class="pkt-board" id="pkt-board"></div></div>
    <div class="pkt-zone pkt-blinds" id="pkt-blinds"></div>
    <div class="pkt-zone pkt-potbox" id="pkt-potbox"><div class="pkt-pot" id="pkt-pot"></div></div>
    <div class="pkt-zone pkt-name" id="pkt-name"><div class="pkt-msg" id="pkt-msg" aria-live="polite"></div></div>
    ${g.players.map((p) => `<div class="pkt-bet hidden" id="pkt-b-${p.id}"></div>`).join('')}
    <div class="pkt-dealer hidden" id="pkt-dealer" aria-label="Dealer">D</div>
    ${g.players.map((p) => `<div class="pkt-seat" id="pkt-s-${p.id}" style="--c:${p.color};--ink:${lbInkOn(p.color)}"></div>`).join('')}
    <div class="pkt-fx" id="pkt-fx"></div>`;
  $('#poker').classList.toggle('many', g.players.length >= 9);
}

/**
 * Tisch als flache Flächen: schmale Holzkante, dunkle Polsterkante, Filz mit sehr feinem
 * Webmuster (Linien, keine Unschärfe) und eine feine Linie an der Filzkante.
 */
function pkFeltSvg(w, h, u) {
  const cx = w / 2;
  const cy = h / 2;
  const e = (inset, attrs) => `<ellipse cx="${cx}" cy="${cy}" rx="${Math.max(1, cx - inset)}" ry="${Math.max(1, cy - inset)}" ${attrs}/>`;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <defs><pattern id="pkt-weave" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
      <rect width="5" height="5" fill="#1e5f45"/><path d="M0 0V5" stroke="#236a4d" stroke-width="1"/></pattern></defs>
    ${e(0, 'fill="#5b4331"')}
    ${e(0.22 * u, 'fill="none" stroke="#3f2e22" stroke-width="1"')}
    ${e(0.42 * u, 'fill="#1a2420"')}
    ${e(0.75 * u, 'fill="none" stroke="#2a3631" stroke-width="1"')}
    ${e(1.45 * u, 'fill="url(#pkt-weave)"')}
    ${e(1.45 * u, 'fill="none" stroke="#164c37" stroke-width="2"')}
    ${e(2.1 * u, 'fill="none" stroke="#2a7354" stroke-width="1"')}
  </svg>`;
}

/** Element genau auf ein Rechteck (Pixel) setzen. */
function pkPlace(el, r) {
  Object.assign(el.style, { left: `${r.x.toFixed(1)}px`, top: `${r.y.toFixed(1)}px`, width: `${r.w.toFixed(1)}px`, height: `${r.h.toFixed(1)}px` });
}

/**
 * Plätze, Einsätze, Dealer-Button und Sperrzonen aus poker-layout.js. Plätze gleichmäßig auf einer
 * Ellipse (Platz 1 unten, dann im Uhrzeigersinn); ab 9 Spielern kleinere Plätze und Karten.
 */
function pkLayout(force = false) {
  const table = $('#pkt-table');
  const W = table.clientWidth;
  const H = table.clientHeight;
  const n = S.game.players.length;
  const key = `${W}x${H}:${n}`;
  if (!W || !H || (!force && key === pkLayoutKey)) return;
  pkLayoutKey = key;
  const L = pkComputeLayout(W, H, n);
  const u = L.u;
  table.style.setProperty('--u', `${u.toFixed(2)}px`);
  pkPlace($('#pkt-felt'), { x: L.cx - L.rx, y: L.cy - L.ry, w: 2 * L.rx, h: 2 * L.ry });
  $('#pkt-felt').innerHTML = pkFeltSvg(2 * L.rx, 2 * L.ry, u);
  pkPlace($('#pkt-ring'), L.zones.ring);
  pkPlace($('#pkt-blinds'), L.zones.blinds);
  pkPlace($('#pkt-potbox'), L.zones.pot);
  pkPlace($('#pkt-name'), L.zones.name);
  const pos = {};
  S.game.players.forEach((p, i) => {
    const seat = L.seats[i];
    const bet = L.bets[i];
    const el = document.getElementById(`pkt-s-${p.id}`);
    pkPlace(el, seat);
    el.style.setProperty('--dx', `${(L.cx - seat.cx).toFixed(1)}px`);
    el.style.setProperty('--dy', `${(L.cy - seat.cy).toFixed(1)}px`);
    // Einsatz: volle Größe, bei Platzmangel verkleinert (scale) – gemessen wird die sichtbare Größe
    const b = document.getElementById(`pkt-b-${p.id}`);
    const fw = bet.w / bet.scale;
    const fh = bet.h / bet.scale;
    pkPlace(b, { x: bet.cx - fw / 2, y: bet.cy - fh / 2, w: fw, h: fh });
    b.style.transform = bet.scale < 1 ? `scale(${bet.scale})` : '';
    b.style.setProperty('--dx', `${(seat.cx - bet.cx).toFixed(1)}px`);
    b.style.setProperty('--dy', `${(seat.cy - bet.cy).toFixed(1)}px`);
    pos[p.id] = { seat: { x: seat.cx, y: seat.cy }, bet: { x: bet.cx, y: bet.cy }, dealer: L.dealers[i] };
  });
  const pot = L.zones.pot;
  pkGeom = { ...L, pos, potAt: { x: pot.x + pot.w * 0.28, y: pot.y + pot.h / 2 } };
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
  // Laufende Ereignisse: Einsätze gehen nacheinander in den Pot, der Pot wächst mit jedem Spieler;
  // ein Gewinn erreicht den Gewinner erst am Ende der Bewegung
  const steps = [];
  for (const e of events) {
    if (e.at > now || now >= e.at + e.dur) continue;
    if (e.type === 'collect') {
      const ids = Object.keys(e.bets || {});
      const slot = (e.dur * 0.85) / Math.max(1, ids.length);
      ids.forEach((id, k) => {
        const depart = e.at + k * slot;
        const arrive = e.at + (k + 1) * slot;
        if (now < depart && players[id]) players[id].bet += e.bets[id];
        if (now < arrive) pot -= e.bets[id];
        steps.push(depart, arrive);
      });
    } else if (e.type === 'win') {
      const arrive = e.at + e.dur * 0.85;
      if (now < arrive) {
        for (const w of e.winners) if (players[w.id]) players[w.id].stack -= w.amount;
        pot += e.amount;
      }
      steps.push(arrive);
    }
  }
  const applied = events.filter((e) => e.at <= now);
  const win = [...applied].reverse().find((e) => e.type === 'win') || null;
  const hand = [...applied].reverse().find((e) => e.type === 'hand');
  const times = [...pending.map((e) => e.at), ...steps.filter((t) => t > now)];
  const nextAt = times.length ? Math.min(...times) : null;
  return { players, board, pot, win, handNo: hand ? hand.handNo : g.handNo, nextAt, busy: pending.length > 0 };
}

/* ---------------- Darstellung ---------------- */

function pkSeatInner(g, p, v, d) {
  const winners = d.win ? d.win.winners.map((w) => w.id) : [];
  const best = new Set(d.win && d.win.cards ? d.win.cards : []);
  let cards = '';
  if (v.shown) cards = v.shown.map((c) => pkCardHtml(c, `mini ${best.has(c) ? 'best' : best.size ? 'dim' : ''}`)).join('');
  else if (v.hasCards) cards = pkCardHtml(null, 'mini') + pkCardHtml(null, 'mini');
  const plaques = [];
  if (p.id === g.sbId && g.phase !== 'between' && g.phase !== 'gameover') plaques.push('<i class="pkt-pq">SB</i>');
  if (p.id === g.bbId && g.phase !== 'between' && g.phase !== 'gameover') plaques.push('<i class="pkt-pq">BB</i>');
  if (v.allIn && !v.folded && p.inHand) plaques.push('<i class="pkt-pq allin">All-in</i>');
  let action = '';
  if (v.shown && v.handLabel) action = escapeHtml(v.handLabel.split(',')[0]);
  else if (v.folded && p.inHand) action = 'Fold';
  else if (v.lastAction && !['Small Blind', 'Big Blind', 'All-in'].includes(v.lastAction)) action = escapeHtml(v.lastAction);
  const lp = S.lobby.find((x) => x.id === p.id);
  if (p.status === 'sitout' || p.pendingRebuy) action = 'setzt aus';
  if (p.status === 'left') action = 'gegangen';
  if (p.status === 'out') action = 'pleite';
  if (lp && !lp.connected && p.status !== 'left') action = 'getrennt';
  const won = winners.includes(p.id) ? d.win.winners.find((w) => w.id === p.id).amount : 0;
  // Zugzeit als feiner Ring um das Schild (nur mit Zugzeit und nur beim Spieler am Zug)
  const timed = !d.busy && S.deadline && S.deadlineFor === p.id && g.settings.turnTime;
  let ring = '';
  if (timed) {
    const total = (S.deadlineFor === (g.actorId || g.decider) && g.phase === 'betting') ? g.settings.turnTime * 1000 : Math.max(1, S.deadline - clock.now());
    const left = Math.max(0, S.deadline - clock.now());
    ring = `<svg class="pkt-ring-timer" aria-hidden="true" style="--total:${Math.round(total)}ms;--delay:${Math.round(left - total)}ms"><rect pathLength="100"/></svg>`;
  }
  return `<div class="pkt-cards">${cards}</div>
    <div class="pkt-plate">
      <div class="pkt-name">${pkSeatHtml(p)}<span class="pkt-nm">${escapeHtml(p.name)}</span></div>
      <div class="pkt-stack">${pkEuro(v.stack)}</div>
      <div class="pkt-act">${plaques.join('')}${won ? `<span class="pkt-won">+${pkEuro(won)}</span>` : action ? `<span>${action}</span>` : ''}</div>
      ${ring}
    </div>`;
}

function pkRenderTable(g, d) {
  const actor = g.actorId || g.decider;
  const winners = d.win ? d.win.winners.map((w) => w.id) : [];
  const many = g.players.length >= 9;
  for (const p of g.players) {
    const v = d.players[p.id];
    const el = document.getElementById(`pkt-s-${p.id}`);
    patch(el, pkSeatInner(g, p, v, d));
    el.classList.toggle('active', !d.busy && actor === p.id && (g.phase === 'betting' || g.phase === 'showdown'));
    el.classList.toggle('folded', Boolean(p.inHand && v.folded) || (!p.inHand && g.phase !== 'between' && g.phase !== 'gameover'));
    el.classList.toggle('out', p.status !== 'playing' || p.pendingRebuy);
    el.classList.toggle('winner', winners.includes(p.id));
    const b = document.getElementById(`pkt-b-${p.id}`);
    b.classList.toggle('hidden', !(v.bet > 0));
    if (v.bet > 0) patch(b, `<div class="pkt-bet-chips">${pkChipStacksSvg(v.bet, { maxStacks: many ? 2 : 3, maxChips: 4, unit: many ? 1.5 : 1.8 })}</div><div class="pkt-bet-amt">${pkEuro(v.bet)}</div>`);
  }
  // Dealer-Button
  const dealer = $('#pkt-dealer');
  const pos = g.buttonId && pkGeom && pkGeom.pos[g.buttonId];
  dealer.classList.toggle('hidden', !pos);
  if (pos) pkPlace(dealer, pos.dealer);
  // Mitte: Gemeinschaftskarten im Ring, Pot und Blinds in ihren Feldern, Handname darunter
  const best = new Set(d.win && d.win.cards ? d.win.cards : []);
  const cards = d.board.map((c) => pkCardHtml(c, best.has(c) ? 'best' : best.size ? 'dim' : ''));
  while (cards.length < 5) cards.push(pkSlotHtml());
  patch($('#pkt-board'), cards.join(''));
  const bets = Object.values(d.players).reduce((s, v) => s + Math.max(0, v.bet), 0);
  // Pot einschließlich der Einsätze dieser Setzrunde; die Chips im Feld zeigen, was schon in der Mitte liegt
  patch($('#pkt-pot'), `<div class="pkt-pot-chips">${pkChipStacksSvg(d.pot, { maxStacks: many ? 3 : 4, maxChips: 4, unit: many ? 1.7 : 2 })}</div>
    <div class="pkt-pot-text"><span class="pkt-field-label">Pot</span><b>${pkEuro(d.pot + bets)}</b></div>`);
  patch($('#pkt-blinds'), `<span class="pkt-field-label">Blinds</span><b>${pkEuroPlain(g.settings.smallBlind)} / ${pkEuro(g.settings.bigBlind)}</b>`);
  patch($('#pkt-msg'), pkWinText(g, d));
}

/** Gewinner mit Handname, z. B. „Ben gewinnt 1,20 € · Full House, Damen über Achten“. */
function pkWinText(g, d) {
  const w = d.win;
  if (!w) return '';
  const names = pkNames(w.winners.map((x) => escapeHtml(pkPlayer(x.id)?.name || '?')));
  const what = w.side ? `Side-Pot ${w.pot}` : '';
  const verb = w.winners.length > 1 ? 'teilen' : 'gewinnt';
  return `${w.label ? `<span class="pkt-label">${escapeHtml(w.label)}</span>` : ''}<span class="pkt-win">${what ? `${what}: ` : ''}${names} ${verb} ${pkEuro(w.amount)}</span>`;
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
  patch($('#pkt-meta'), `<span>Runde <b>${d.handNo}</b></span><span>Start ${pkEuro(g.settings.startMoney)}${g.settings.rebuy ? ', Nachkaufen an' : ''}</span>`);
  patch($('#pkt-list'), pkSideHtml(g, d));
  patch($('#pkt-log'), g.log.slice(-4).reverse().map((e) => `<li>${escapeHtml(e.text)}</li>`).join(''));
  const finalBox = $('#pkt-final');
  const showFinal = g.phase === 'gameover' && !d.busy;
  finalBox.classList.toggle('hidden', !showFinal);
  if (showFinal) patch(finalBox, endstandHtml(S.final, { heading: 'Endstand' }));
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

/** Ein Chip fliegt von a nach b – um Kartenring und Blinds-Feld herum (pkFlightPath). */
function pkFly(from, to, duration, delay = 0, chip = PK_CHIPS[6]) {
  const pts = pkFlightPath(from, to, pkGeom);
  const lengths = pts.map((p, i) => (i ? Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0));
  const total = lengths.reduce((a, b) => a + b, 0) || 1;
  let run = 0;
  const frames = pts.map((p, i) => {
    run += lengths[i];
    return { transform: `translate(${(p.x - from.x).toFixed(1)}px, ${(p.y - from.y).toFixed(1)}px)`, offset: run / total };
  });
  const el = document.createElement('i');
  el.className = 'pkt-chip flying';
  el.innerHTML = pkChipTopSvg(chip);
  const size = PK_CHIP * pkGeom.u;
  pkPlace(el, { x: from.x - size / 2, y: from.y - size / 2, w: size, h: size });
  $('#pkt-fx').appendChild(el);
  const a = el.animate(frames, { duration, delay, easing: 'ease-in-out', fill: 'both' });
  a.onfinish = () => el.remove();
  return a;
}

/** Bis zu max Chips, aus denen ein Betrag besteht (größte zuerst) – für den Flug. */
function pkChipsFor(cents, max = 4) {
  const out = [];
  for (const { chip, count } of pkChipBreakdown(cents)) for (let i = 0; i < count && out.length < max; i++) out.push(chip);
  return out.length ? out : [PK_CHIPS[PK_CHIPS.length - 1]];
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
      // An der Ablage einblenden (leicht wachsend) – berührt so auch in der Bewegung nie den Platz
      if (b) b.animate([{ scale: '.82', opacity: 0 }, { scale: '1', opacity: 1 }], { duration: Math.min(450, e.dur * 0.8), easing: 'cubic-bezier(.2,.7,.3,1)' });
      return;
    }
    case 'collect':
    case 'return':
    case 'win': {
      if (e.type === 'win') PkAudio.play('win'); else PkAudio.play('chips');
      if (!motion || !geo) return;
      if (e.type === 'collect') {
        // Spieler für Spieler: ihre Chips fliegen einzeln nacheinander in den Pot
        const ids = Object.keys(e.bets || {});
        const slot = (e.dur * 0.85) / Math.max(1, ids.length);
        ids.forEach((id, k) => {
          const chips = pkChipsFor(e.bets[id]);
          chips.forEach((chip, j) => pkFly(geo.pos[id].bet, geo.potAt, slot * 0.75, k * slot + (j * slot * 0.25) / chips.length, chip));
        });
      } else if (e.type === 'return') {
        pkChipsFor(e.amount, 3).forEach((chip, j) => pkFly(geo.pos[e.playerId].bet, geo.pos[e.playerId].seat, e.dur * 0.6, j * e.dur * 0.08, chip));
      } else {
        const delay = e.dur * 0.35;
        for (const w of e.winners) {
          const chips = pkChipsFor(w.amount);
          chips.forEach((chip, j) => pkFly(geo.potAt, geo.pos[w.id].seat, e.dur * 0.4, delay + (j * e.dur * 0.1) / chips.length, chip));
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
