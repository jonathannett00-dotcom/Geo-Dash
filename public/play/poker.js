'use strict';

/* =========================================================
 *  Handy: Poker-Controller (Texas Hold'em). Oben, wer am Zug ist, Pot,
 *  Blinds und Einsätze; in der Mitte die eigenen zwei Karten (verdeckt,
 *  Antippen und Halten zeigt sie); unten die Aktionsleiste. Der Server
 *  schickt nur die eigenen Karten und prüft jede Aktion selbst.
 * ========================================================= */

const PK_VIBRATION_KEY = 'poker-vibration';
const PK_REVEAL_KEY = 'poker-aufdecken';
const PK_STREETS = { preflop: 'Pre-Flop', flop: 'Flop', turn: 'Turn', river: 'River', showdown: 'Showdown' };

/** Auswahl auf dem Handy (bleibt zwischen Snapshots erhalten). */
const pkUi = { raiseOpen: false, raiseTo: null, raiseText: '', raiseKey: '', holding: false, settled: null, seen: { turn: '', extra: '' }, built: false };

const pkP = (g, id) => g.players.find((p) => p.id === id);
const pkName = (g, id) => escapeHtml(pkP(g, id)?.name || '?');

function pkStore(key, value) { try { localStorage.setItem(key, value); } catch (_) { /* privat-Modus */ } }
function pkLoad(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
const pkRevealAlways = () => pkLoad(PK_REVEAL_KEY) === 'an';
const pkVibrationOn = () => pkLoad(PK_VIBRATION_KEY) !== 'aus';
function pkVibrate(pattern) {
  if (!pkVibrationOn() || typeof navigator.vibrate !== 'function') return;
  try { navigator.vibrate(pattern); } catch (_) { /* nicht verfügbar */ }
}

/** Gerüst einmal anlegen; danach werden nur die Teile neu gezeichnet, die sich ändern. */
function pkBuild() {
  if (pkUi.built) return;
  pkUi.built = true;
  $('#panel-poker').innerHTML = `
    <div id="pk-status" class="pk-status" aria-live="polite"></div>
    <div id="pk-boardrow" class="pk-boardrow" aria-label="Gemeinschaftskarten"></div>
    <section class="pk-holebox">
      <div id="pk-hole" class="pk-hole" role="button" tabindex="0" aria-label="Deine Karten – zum Ansehen gedrückt halten"></div>
      <div class="pk-holefoot">
        <div id="pk-handlabel" class="pk-handlabel"></div>
        <label class="pk-switch"><input type="checkbox" id="pk-reveal" data-keep="no" /> Dauerhaft aufdecken</label>
      </div>
    </section>
    <div id="pk-extra" class="pk-extra"></div>
    <div id="pk-info" class="pk-info"></div>
    <div id="pk-table" class="pk-table" aria-label="Spieler am Tisch"></div>
    <details id="pk-settings" class="pk-settings">
      <summary>Einstellungen</summary>
      <label class="pk-switch"><input type="checkbox" id="pk-vibration" data-keep="no" /> Vibration, wenn du am Zug bist</label>
      <button type="button" class="btn pk-leave" data-pk="leave" data-confirm="Tisch verlassen?">Tisch verlassen</button>
    </details>
    <div id="pk-bar" class="pk-bar"></div>`;
  $('#pk-reveal').checked = pkRevealAlways();
  $('#pk-vibration').checked = pkVibrationOn();
  const hole = $('#pk-hole');
  const show = (e) => { if (e) e.preventDefault(); pkUi.holding = true; pkRenderHole(); };
  const hide = () => { if (!pkUi.holding) return; pkUi.holding = false; pkRenderHole(); };
  hole.addEventListener('pointerdown', show);
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => hole.addEventListener(t, hide));
  hole.addEventListener('contextmenu', (e) => e.preventDefault());
  hole.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') show(e); });
  hole.addEventListener('keyup', hide);
  window.addEventListener('blur', hide);
}

/* ---------------- Anzeige ---------------- */

/** Spieler am Zug, Phase und Zugzeit. */
function pkStatusHtml(g, hold) {
  if (hold) return '<div class="pk-status-inner"><div class="pk-st-title">Schau auf den Fernseher</div><div class="pk-st-detail">Gleich geht es weiter</div></div>';
  const st = S.status || {};
  const mine = st.playerId === me && (g.phase === 'betting' || g.phase === 'showdown' || g.me?.mustDecide);
  const timer = S.deadline && S.deadlineFor === me ? ` · <span data-ends="${S.deadline}"></span>` : '';
  let title = escapeHtml(st.text || '');
  if (g.phase === 'betting' && st.playerId === me) title = 'Du bist am Zug';
  if (g.phase === 'gameover') title = 'Spielende';
  const street = g.phase === 'betting' ? `${PK_STREETS[g.street]} · Runde ${g.handNo}` : g.phase === 'showdown' ? 'Showdown' : g.phase === 'between' ? `Nach Runde ${g.handNo}` : '';
  return `<div class="pk-status-inner ${mine ? 'mine' : ''}"><div class="pk-st-title">${title}</div><div class="pk-st-detail">${street}${timer}${S.paused ? ' · pausiert, ein Spieler ist getrennt' : ''}</div></div>`;
}

function pkInfoHtml(g) {
  const mine = pkP(g, me);
  const toCall = g.phase === 'betting' ? Math.max(0, Math.min(g.currentBet - mine.bet, mine.stack)) : 0;
  const cell = (label, value, cls = '') => `<div class="pk-cell ${cls}"><span>${label}</span><b>${value}</b></div>`;
  return [
    cell('Pot', pkEuro(g.pot), 'pot'),
    cell('Zum Mitgehen', mine.inHand && !mine.folded && !mine.allIn ? pkEuro(toCall) : '–', toCall ? 'call' : ''),
    cell('Dein Einsatz', pkEuro(mine.bet)),
    cell('Höchstgebot', pkEuro(g.currentBet)),
    cell('Blinds', `${pkEuroPlain(g.settings.smallBlind)} / ${pkEuro(g.settings.bigBlind)}`, 'wrap'),
    cell('Dealer', g.buttonId ? pkName(g, g.buttonId) : '–'),
  ].join('');
}

function pkBoardHtml(g) {
  const cards = g.board.map((c) => pkCardHtml(c));
  while (cards.length < 5) cards.push(pkSlotHtml());
  return cards.join('');
}

/** Eigene Karten: verdeckt, beim Halten (oder dauerhaft) offen. */
function pkRenderHole() {
  const g = pkUi.settled || S.game;
  const mine = g.me;
  const cards = mine && mine.cards.length ? mine.cards : null;
  const open = cards && (pkUi.holding || pkRevealAlways());
  const folded = pkP(g, me)?.folded;
  const html = cards
    ? cards.map((c) => pkCardHtml(open ? c : null, folded ? 'dim' : '')).join('')
    : '<p class="pk-nocards">Keine Karten in dieser Runde</p>';
  const hole = $('#pk-hole');
  patch(hole, html);
  hole.classList.toggle('open', Boolean(open));
  const label = open && mine.hand ? escapeHtml(mine.hand) : cards ? (open ? '' : 'Gedrückt halten zum Ansehen') : '';
  patch($('#pk-handlabel'), label);
}

/** Andere Spieler: Sitz, Name, Guthaben, Einsatz und Lage. */
function pkTableHtml(g) {
  return g.players.map((p) => {
    const tags = [];
    if (p.id === g.buttonId) tags.push('<i class="pk-tag dealer">Dealer</i>');
    if (g.phase === 'betting' && p.id === g.sbId) tags.push('<i class="pk-tag">SB</i>');
    if (g.phase === 'betting' && p.id === g.bbId) tags.push('<i class="pk-tag">BB</i>');
    if (p.allIn && p.inHand && !p.folded) tags.push('<i class="pk-tag allin">All-in</i>');
    else if (p.folded && p.inHand) tags.push('<i class="pk-tag muted">Fold</i>');
    if (p.status === 'sitout' || p.pendingRebuy) tags.push('<i class="pk-tag muted">setzt aus</i>');
    if (p.status === 'left') tags.push('<i class="pk-tag muted">gegangen</i>');
    if (p.status === 'out') tags.push('<i class="pk-tag muted">pleite</i>');
    const lp = S.lobby.find((x) => x.id === p.id);
    if (lp && !lp.connected && p.status !== 'left') tags.push('<i class="pk-tag muted">getrennt</i>');
    const active = (g.actorId || g.decider) === p.id;
    return `<div class="pk-row ${active ? 'active' : ''} ${p.folded || p.status !== 'playing' ? 'out' : ''} ${p.id === me ? 'me' : ''}">
      ${pkSeatHtml(p)}${avatarHtml(p, 'S', S.lobby)}<span class="pk-row-name">${escapeHtml(p.name)}${p.id === me ? ' (du)' : ''}</span>
      <span class="pk-row-tags">${tags.join('')}</span>
      <span class="pk-row-bet">${p.bet ? pkEuro(p.bet) : ''}</span>
      <span class="pk-row-stack">${pkEuro(p.stack)}${p.rebuys ? `<small>${p.rebuys}× nachgekauft</small>` : ''}</span></div>`;
  }).join('');
}

/** Showdown-Entscheidung, Nachkaufen, Ergebnis der Runde oder Endstand. */
function pkExtraHtml(g) {
  const m = g.me;
  if (m?.showdownChoice) {
    const timer = S.deadline && S.deadlineFor === me ? ` (<span data-ends="${S.deadline}"></span>)` : '';
    return `<div class="pk-box warn"><h2>Du kannst nicht gewinnen</h2><p>Zeigen oder verdeckt wegwerfen?${timer}</p>
      <div class="pk-two"><button type="button" class="btn pk-btn" data-pk="muck">Verdeckt wegwerfen</button><button type="button" class="btn pk-btn" data-pk="show">Karten zeigen</button></div></div>`;
  }
  if (m?.mustDecide || m?.canRebuy) {
    const timer = m.mustDecide && S.deadline && S.deadlineFor === me ? ` Ohne Entscheidung setzt du aus (<span data-ends="${S.deadline}"></span>).` : '';
    return `<div class="pk-box warn"><h2>${m.mustDecide ? 'Dein Guthaben ist aufgebraucht' : 'Du setzt aus'}</h2>
      <p>Nachkaufen zum Startbetrag von ${pkEuro(g.settings.startMoney)} – du spielst ab der nächsten Runde wieder mit.${timer}</p>
      <div class="pk-two">${m.mustDecide ? '<button type="button" class="btn pk-btn" data-pk="sitout">Aussetzen</button>' : ''}<button type="button" class="btn pk-btn go" data-pk="rebuy">Nachkaufen (${pkEuro(g.settings.startMoney)})</button></div></div>`;
  }
  if (g.phase === 'between' && g.result) {
    const lines = g.result.pots.map((pot) => {
      const names = pkNames(pot.winners.map((w) => pkName(g, w.id)));
      const what = pot.side ? 'Side-Pot' : g.result.pots.length > 1 ? 'Hauptpot' : 'Pot';
      return `<li>${names} ${pot.winners.length > 1 ? 'teilen' : 'gewinnt'} ${what} ${pkEuro(pot.amount)}${pot.label ? ` – ${escapeHtml(pot.label)}` : ''}</li>`;
    });
    return `<div class="pk-box"><h2>Runde ${g.handNo}</h2><ul class="pk-result">${lines.join('')}</ul></div>`;
  }
  return '';
}

/** Aktionsleiste: Fold, Check/Call, Raise (mit Regler). Nur am Zug aktiv. */
function pkBarHtml(g, hold) {
  const o = g.me?.options;
  const mine = pkP(g, me);
  if (hold || !o) {
    let text = '';
    if (hold) text = 'Der Fernseher zeigt gerade, was passiert.';
    else if (g.phase === 'betting' && g.actorId) text = mine.inHand && !mine.folded ? (mine.allIn ? 'Du bist All-in.' : `Warte auf ${pkName(g, g.actorId)}.`) : 'Du spielst in dieser Runde nicht mit.';
    else if (g.phase === 'between') text = 'Gleich beginnt die nächste Runde.';
    else if (g.phase === 'showdown') text = 'Showdown – die Karten werden aufgedeckt.';
    else if (g.phase === 'gameover') text = 'Das Spiel ist vorbei.';
    return `<div class="pk-bar-wait">${text}</div>`;
  }
  const callAllIn = o.canCall && o.callAmount >= o.stack;
  const callLabel = o.canCheck ? 'Check' : callAllIn ? `All-in ${pkEuro(o.callAmount)}` : `Call ${pkEuro(o.callAmount)}`;
  const raiseWord = o.currentBet === 0 ? 'Bet' : 'Raise';
  let panel = '';
  if (pkUi.raiseOpen && o.canRaise) {
    const steps = pkRaiseSteps(o, g);
    const to = pkClampRaise(pkUi.raiseTo ?? o.minTo, o);
    const k = pkStepIndex(steps, to);
    const quick = pkQuick(o, g);
    const allIn = to >= o.maxTo;
    panel = `<div class="pk-raise">
      <div class="pk-raise-row"><label for="pk-raise-input">${raiseWord} auf</label>
        <input id="pk-raise-input" class="pk-raise-input" inputmode="decimal" autocomplete="off" value="${escapeHtml(pkUi.raiseText || pkEuroPlain(to))}" aria-label="Betrag in Euro" /><span>€</span></div>
      <input id="pk-raise-range" class="pk-range" type="range" min="0" max="${steps.length - 1}" step="1" value="${k}" aria-label="Betrag wählen" />
      <div class="pk-quick">${quick.map(([label, v]) => `<button type="button" class="btn" data-pk-quick="${v}">${label}</button>`).join('')}</div>
      <button type="button" class="btn pk-btn raise ${allIn ? 'allin' : ''}" data-pk="raise" data-to="${to}" ${allIn ? 'data-confirm="All-in?"' : ''}>${allIn ? `All-in ${pkEuro(to)}` : `${raiseWord} auf ${pkEuro(to)}`}</button>
    </div>`;
  }
  return `${panel}<div class="pk-bar-btns">
    <button type="button" class="btn pk-btn fold" data-pk="fold" ${o.canCheck ? 'data-confirm="Fold, obwohl Check geht?"' : ''}>Fold</button>
    <button type="button" class="btn pk-btn call ${callAllIn ? 'allin' : ''}" data-pk="${o.canCheck ? 'check' : 'call'}" ${callAllIn ? 'data-confirm="All-in?"' : ''}>${callLabel}</button>
    <button type="button" class="btn pk-btn raise-toggle ${pkUi.raiseOpen ? 'sel' : ''}" data-pk="raise-toggle" ${o.canRaise ? '' : 'disabled'} title="${o.canRaise ? '' : escapeHtml(o.raiseBlock || '')}">${raiseWord}</button>
  </div>${!o.canRaise && o.raiseBlock ? `<p class="pk-bar-note">${escapeHtml(o.raiseBlock)}</p>` : ''}`;
}

/* ---------------- Raise: Regler in Small-Blind-Schritten, Eingabe auf den Cent ---------------- */

/** Rasterpunkte des Reglers: Mindestbetrag, dann Vielfache des Small Blinds, zuletzt All-in. */
function pkRaiseSteps(o, g) {
  const sb = Math.max(1, g.settings.smallBlind);
  const steps = [o.minTo];
  let v = Math.ceil((o.minTo + 1) / sb) * sb;
  // Sehr viele Schritte (großes Guthaben, kleiner Blind): Regler bleibt bedienbar
  const stride = Math.max(1, Math.ceil((o.maxTo - o.minTo) / sb / 400)) * sb;
  for (; v < o.maxTo; v += stride) if (v > steps[steps.length - 1]) steps.push(v);
  if (steps[steps.length - 1] !== o.maxTo) steps.push(o.maxTo);
  return steps;
}
const pkStepIndex = (steps, to) => steps.reduce((best, v, i) => (Math.abs(v - to) < Math.abs(steps[best] - to) ? i : best), 0);
const pkClampRaise = (to, o) => Math.max(o.minTo, Math.min(o.maxTo, Math.round(to)));

/** Schnellwahl: Min, halber Pot, Pot, All-in (Pot-Erhöhung = Einsatz + Pot nach dem Mitgehen). */
function pkQuick(o, g) {
  const potAfterCall = g.pot + o.toCall;
  const clamp = (v) => pkClampRaise(v, o);
  return [
    ['Min', o.minTo],
    ['½ Pot', clamp(o.currentBet + Math.round(potAfterCall / 2))],
    ['Pot', clamp(o.currentBet + potAfterCall)],
    ['All-in', o.maxTo],
  ];
}

/* ---------------- Rendern ---------------- */

function pkHaptics(g) {
  const anim = S.anim || { seq: 0 };
  const myTurn = g.phase === 'betting' && g.actorId === me;
  const turnKey = myTurn ? `${g.handNo}:${g.street}:${anim.seq}` : '';
  if (turnKey && turnKey !== pkUi.seen.turn) pkVibrate([80, 60, 80]);
  pkUi.seen.turn = turnKey;
  const extraKey = g.me?.showdownChoice || g.me?.mustDecide ? `${g.handNo}:${g.phase}` : '';
  if (extraKey && extraKey !== pkUi.seen.extra) pkVibrate([150, 80, 150]);
  pkUi.seen.extra = extraKey;
}

function renderPoker() {
  const lp = lobbyMe();
  const live = S.game;
  if (!lp || !pkP(live, me)) return;
  ['wait', 'turn', 'props', 'trade', 'mini', 'risiko'].forEach((k) => $(`#panel-${k}`).classList.add('hidden'));
  $('#tabs').classList.add('hidden');
  $('#panel-poker').classList.remove('hidden');
  document.body.classList.add('poker-mode');
  pkBuild();

  // Wie bei Risiko: Das Handy zeigt neue Karten und Ergebnisse erst, wenn der Fernseher sie gezeigt hat
  clearTimeout(renderPoker.hold);
  const left = (S.animUntil || 0) - clock.now();
  const hold = left > 0 && live.phase !== 'gameover';
  if (!hold || !pkUi.settled) pkUi.settled = live;
  const g = pkUi.settled;
  const mine = pkP(g, me);

  document.documentElement.style.setProperty('--me', mine.color);
  const fig = $('#me-fig');
  fig.textContent = String(mine.seat);
  fig.style.color = lbInkOn(mine.color);
  $('#me-name').textContent = `${lp.name} · Platz ${mine.seat}`;
  $('#me-money').textContent = pkEuro(mine.stack);
  const t = $('#turn-name');
  const cur = g.actorId || g.decider;
  t.textContent = g.phase === 'gameover' ? 'Spielende' : cur ? (cur === me ? 'Du!' : pkP(g, cur).name) : '–';
  t.classList.toggle('mine', cur === me);

  // Raise-Auswahl gilt nur für diesen Zug
  const key = `${g.handNo}:${g.street}:${g.currentBet}:${g.actorId}`;
  if (key !== pkUi.raiseKey) { pkUi.raiseKey = key; pkUi.raiseOpen = false; pkUi.raiseTo = null; pkUi.raiseText = ''; }

  patch($('#pk-status'), pkStatusHtml(g, hold));
  patch($('#pk-info'), pkInfoHtml(g));
  patch($('#pk-boardrow'), pkBoardHtml(g));
  pkRenderHole();
  patch($('#pk-extra'), hold ? '' : pkExtraHtml(g));
  patch($('#pk-table'), pkTableHtml(g));
  const leave = $('.pk-leave');
  leave.disabled = mine.status === 'left' || g.phase === 'gameover';
  patch($('#pk-bar'), pkBarHtml(g, hold));
  document.body.classList.toggle('pk-bar-open', pkUi.raiseOpen && !hold);
  if (!hold) pkHaptics(g);
  if (hold) renderPoker.hold = setTimeout(render, left + 60);
  tickCountdowns();
}

/* ---------------- Eingaben ---------------- */

/** Zweites Tippen innerhalb von 4 Sekunden bestätigt (All-in, Fold trotz Check, Tisch verlassen). */
function pkArm(b) {
  if (b.dataset.armed) return true;
  $$('#panel-poker [data-armed]').forEach((x) => { delete x.dataset.armed; x.textContent = x.dataset.label; x.classList.remove('armed'); });
  b.dataset.label = b.textContent;
  b.dataset.armed = '1';
  b.classList.add('armed');
  b.textContent = `${b.dataset.confirm} Nochmal tippen`;
  clearTimeout(pkArm.t);
  pkArm.t = setTimeout(() => {
    if (b.isConnected && b.dataset.armed) { delete b.dataset.armed; b.textContent = b.dataset.label; b.classList.remove('armed'); }
  }, 4000);
  return false;
}

$('#panel-poker').addEventListener('click', async (e) => {
  const quick = e.target.closest('[data-pk-quick]');
  if (quick) { pkUi.raiseTo = Number(quick.dataset.pkQuick); pkUi.raiseText = ''; renderPoker(); return; }
  const b = e.target.closest('[data-pk]');
  if (!b || b.disabled) return;
  const kind = b.dataset.pk;
  if (kind === 'raise-toggle') { pkUi.raiseOpen = !pkUi.raiseOpen; renderPoker(); return; }
  if (b.dataset.confirm && !pkArm(b)) return;
  const action = kind === 'raise' ? { type: 'raise', to: Number(b.dataset.to) } : { type: kind };
  b.disabled = true;
  const res = await act(action);
  if (res.ok) { pkUi.raiseOpen = false; pkUi.raiseTo = null; pkUi.raiseText = ''; }
  b.disabled = false;
  renderPoker();
});

$('#panel-poker').addEventListener('input', (e) => {
  const o = S.game?.me?.options;
  if (!o) return;
  if (e.target.id === 'pk-raise-range') {
    const steps = pkRaiseSteps(o, S.game);
    pkUi.raiseTo = steps[Number(e.target.value)] ?? o.minTo;
    pkUi.raiseText = '';
    // Nur Betrag und Knopf aktualisieren, damit der Regler beim Ziehen nicht neu gezeichnet wird
    const input = $('#pk-raise-input');
    if (input) input.value = pkEuroPlain(pkUi.raiseTo);
    pkSyncRaiseButton(o);
  } else if (e.target.id === 'pk-raise-input') {
    pkUi.raiseText = e.target.value;
    const cents = pkParseEuro(e.target.value);
    e.target.classList.toggle('bad', cents === null || cents < o.minTo || cents > o.maxTo);
    if (cents !== null) pkUi.raiseTo = cents;
    pkSyncRaiseButton(o, cents === null);
  }
});

/** Knopf unter dem Regler auf den gewählten Betrag setzen (ohne den Rest neu zu zeichnen). */
function pkSyncRaiseButton(o, invalid = false) {
  const b = $('#pk-bar [data-pk="raise"]');
  if (!b) return;
  const to = pkClampRaise(pkUi.raiseTo ?? o.minTo, o);
  const exact = pkUi.raiseTo === to;
  const allIn = to >= o.maxTo;
  const word = o.currentBet === 0 ? 'Bet' : 'Raise';
  b.dataset.to = String(to);
  b.disabled = invalid || !exact;
  b.classList.toggle('allin', allIn);
  if (allIn) b.dataset.confirm = 'All-in?'; else delete b.dataset.confirm;
  delete b.dataset.armed;
  b.classList.remove('armed');
  b.textContent = invalid || !exact
    ? `Betrag zwischen ${pkEuro(o.minTo)} und ${pkEuro(o.maxTo)}`
    : allIn ? `All-in ${pkEuro(to)}` : `${word} auf ${pkEuro(to)}`;
  const range = $('#pk-raise-range');
  if (range && document.activeElement !== range) range.value = String(pkStepIndex(pkRaiseSteps(o, S.game), to));
}

$('#panel-poker').addEventListener('change', (e) => {
  if (e.target.id === 'pk-reveal') { pkStore(PK_REVEAL_KEY, e.target.checked ? 'an' : 'aus'); pkRenderHole(); }
  if (e.target.id === 'pk-vibration') { pkStore(PK_VIBRATION_KEY, e.target.checked ? 'an' : 'aus'); if (e.target.checked) pkVibrate(40); }
  if (e.target.id === 'pk-raise-input') {
    // Nach der Eingabe: gültigen Betrag übernehmen und auf den erlaubten Bereich begrenzen
    const o = S.game?.me?.options;
    const cents = pkParseEuro(e.target.value);
    if (o && cents !== null) { pkUi.raiseTo = pkClampRaise(cents, o); pkUi.raiseText = ''; }
  }
  if (e.target.id === 'pk-raise-range' || e.target.id === 'pk-raise-input') renderPoker();
});
