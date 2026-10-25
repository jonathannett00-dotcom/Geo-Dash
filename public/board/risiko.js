'use strict';

/* =========================================================
 *  Tablet/TV: Risiko-Weltkarte. Flächen, Marker, Namen und Seewege kommen
 *  aus map-paths.js (erzeugt von scripts/build-map.js aus Natural Earth),
 *  Gebiete und Nachbarschaften aus map.js. Nur Anzeige – Besitz, Armeen
 *  und Würfel kommen vom Server.
 * ========================================================= */

const SVG_NS = 'http://www.w3.org/2000/svg';

/* Farben, Größen und Namenspositionen: public/shared/risiko-farben.js */

let rkBuilt = false;
let rkBattleSeq = 0;
let rkBattleTimer = null;
let rkK = 1;                 // Pixel je Karteneinheit
const rkShown = {};          // angezeigte Armeezahl je Gebiet (für weiche Übergänge)

function svgEl(tag, attrs = {}, parent = null) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  if (parent) parent.appendChild(el);
  return el;
}

/** Karte einmal aufbauen: Ozean, Land, Seen, Gebiete, Kontinentränder, Seewege, Namen, Marker. */
function buildRisikoMap() {
  const geo = window.RISIKO_MAP_PATHS;
  const svg = $('#rk-map');
  svg.innerHTML = '';
  svgEl('rect', { class: 'rk-ocean', id: 'rk-ocean', x: -5000, y: -5000, width: 10000, height: 10000 }, svg);
  svgEl('path', { class: 'rk-other-land', d: geo.otherLand }, svg);

  const areas = svgEl('g', { class: 'rk-areas' }, svg);
  for (const t of S.map.territories) {
    svgEl('path', { class: 'rk-area', id: `rk-a-${t.id}`, 'data-territory': t.id, d: geo.territories[t.id].d }, areas);
  }
  svgEl('g', { class: 'rk-wave', id: 'rk-wave' }, svg);
  svgEl('defs', { id: 'rk-defs' }, svg);
  svgEl('path', { class: 'rk-lakes', d: geo.lakes }, svg);
  const continents = svgEl('g', { class: 'rk-continents' }, svg);
  for (const d of Object.values(geo.continents)) svgEl('path', { d }, continents);

  const lanes = svgEl('g', { class: 'rk-lanes' }, svg);
  for (const lane of geo.seaLanes) svgEl('path', { d: lane.d, 'data-lane': `${lane.a}|${lane.b}` }, lanes);

  svgEl('g', { class: 'rk-highlight', id: 'rk-highlight' }, svg);
  svgEl('g', { class: 'rk-fx', id: 'rk-fx' }, svg);

  const labels = svgEl('g', { class: 'rk-labels' }, svg);
  for (const t of S.map.territories) {
    svgEl('text', { class: 'rk-label', id: `rk-l-${t.id}` }, labels).textContent = t.name;
  }

  const markers = svgEl('g', { class: 'rk-markers' }, svg);
  for (const t of S.map.territories) {
    const g = svgEl('g', { class: 'rk-territory', id: `rk-t-${t.id}`, 'data-territory': t.id }, markers);
    const inner = svgEl('g', { class: 'rk-marker' }, g);
    svgEl('circle', { class: 'rk-disc', r: geo.style.markerR }, inner);
    svgEl('text', { class: 'rk-armies', 'text-anchor': 'middle', dy: '0.35em' }, inner).textContent = '0';
    svgEl('title', {}, g).textContent = t.name;
  }
  svgEl('g', { class: 'rk-top-fx', id: 'rk-top-fx' }, svg);
  rkBuilt = true;
  rkLayout();
}

/* ---------------- Layout: Karte füllt das Fenster, Flächen im Ozean ---------------- */

function rkLayout() {
  const geo = window.RISIKO_MAP_PATHS;
  const root = $('#risiko');
  const svg = $('#rk-map');
  if (!geo || !root.clientWidth) return;
  const W = root.clientWidth;
  const H = root.clientHeight;
  const gap = Math.round(Math.max(8, Math.min(16, Math.min(W, H) * 0.012)));
  root.style.setProperty('--gap', `${gap}px`);
  rkFitPanels(W, H, gap);
  const top = $('.rk-top').offsetHeight;
  const bottom = $('.rk-bottom').offsetHeight;
  // Karte zwischen den Flächen einpassen; überzählige Höhe gleichmäßig als Ozean verteilen
  const availW = W - 2 * gap;
  const availH = H - top - bottom - 4 * gap;
  const k = Math.min(availW / geo.width, availH / geo.height);
  const mapW = geo.width * k;
  const mapH = geo.height * k;
  const x = (W - mapW) / 2;
  const y = gap + top + gap + (availH - mapH) / 2;
  svg.setAttribute('viewBox', `${(-x / k).toFixed(2)} ${(-y / k).toFixed(2)} ${(W / k).toFixed(2)} ${(H / k).toFixed(2)}`);
  if (Math.abs(k - rkK) > 1e-4 || !rkLayout.done) {
    rkK = k;
    rkLayout.done = true;
    rkPlaceMarkersAndLabels();
  }
}
window.addEventListener('resize', () => { if (rkBuilt) rkLayout(); });

/**
 * Ist die Karte durch die Breite begrenzt (z. B. 4:3), bleibt oben und unten Ozean übrig.
 * Dann wachsen Banner und Leisten, solange die Karte ihre volle Breite behält.
 */
function rkFitPanels(W, H, gap) {
  const key = `${W}x${H}:${S.game.players.length + (S.game.neutral ? 1 : 0)}`;
  if (rkFitPanels.key === key) return;
  rkFitPanels.key = key;
  const root = $('#risiko');
  const geo = window.RISIKO_MAP_PATHS;
  const mapH = ((W - 2 * gap) / geo.width) * geo.height;
  const fits = (scale) => {
    root.style.setProperty('--panel-scale', String(scale));
    return H - $('.rk-top').offsetHeight - $('.rk-bottom').offsetHeight - 4 * gap >= mapH;
  };
  let lo = 1; let hi = 1.7;
  if (!fits(lo)) { root.style.setProperty('--panel-scale', '1'); return; }
  for (let i = 0; i < 6; i++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
  root.style.setProperty('--panel-scale', lo.toFixed(3));
  rkPlayerColumns();
}

/** Zweite Kopfzeile nur zeigen, wenn die Spielerliste wirklich zwei Spalten hat. */
function rkPlayerColumns() {
  const list = $('#rk-players');
  const cols = getComputedStyle(list).gridTemplateColumns.split(' ').length;
  list.classList.toggle('one-col', cols < 2);
}

function rkPlaceMarkersAndLabels() {
  const geo = window.RISIKO_MAP_PATHS;
  const { markerScale } = rkSizes(rkK);
  for (const [id, t] of Object.entries(geo.territories)) {
    const [mx, my] = t.marker;
    const node = document.getElementById(`rk-t-${id}`);
    node.setAttribute('transform', `translate(${mx} ${my})`);
    node.firstChild.setAttribute('transform', `scale(${markerScale.toFixed(3)})`);
    const label = document.getElementById(`rk-l-${id}`);
    const pos = rkLabelPos(t, rkK);
    label.setAttribute('x', pos.x.toFixed(2));
    label.setAttribute('y', pos.y.toFixed(2));
    label.setAttribute('text-anchor', pos.anchor);
    label.style.fontSize = `${pos.font.toFixed(2)}px`;
  }
}

/* ---------------- Anzeige ---------------- */

const rkPlayer = (id) => S.game.players.find((p) => p.id === id);
const rkIsNeutral = (id) => Boolean(S.game.neutral) && id === S.game.neutral.id;
const rkName = (id) => (rkIsNeutral(id) ? 'Neutral' : escapeHtml(rkPlayer(id)?.name || '?'));
const rkTone = (id) => (rkIsNeutral(id) ? RK_NEUTRAL : (RK_TONES[rkPlayer(id)?.color] || RK_NEUTRAL));
const rkTerritoryName = (id) => escapeHtml(S.map.territories.find((t) => t.id === id)?.name || id);
/** Ticker-Texte der Engine ohne Emojis – auf der Karte nur Text. */
const rkPlain = (text) => String(text).replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim();
const rkEase = (t) => 1 - (1 - t) ** 3;

/** Zahl im Marker weich auf den neuen Wert zählen. */
function rkSetArmies(id, value, ms = 350) {
  const text = document.querySelector(`#rk-t-${id} .rk-armies`);
  const from = rkShown[id];
  rkShown[id] = value;
  cancelAnimationFrame(text._raf);
  if (from === undefined || from === value || ms <= 0) { text.textContent = String(value); return; }
  const start = performance.now();
  (function step(now) {
    const t = Math.max(0, Math.min(1, (now - start) / ms));
    text.textContent = String(Math.round(from + (value - from) * rkEase(t)));
    if (t < 1) text._raf = requestAnimationFrame(step);
  })(start);
}

/** Banner aus den Phasendaten des Servers; der Name des Spielers am Zug ist farbig unterstrichen. */
function rkBannerHtml(st) {
  if (!st || !st.text) return { key: '', html: '' };
  let text = escapeHtml(st.text);
  const p = st.playerId ? rkPlayer(st.playerId) : null;
  if (p && st.text.startsWith(p.name)) text = `<b class="rk-who" style="--c:${rkTone(p.id)}">${escapeHtml(p.name)}</b>${escapeHtml(st.text.slice(p.name.length))}`;
  const detail = st.detail ? `<span class="rk-detail">${escapeHtml(st.detail)}</span>` : '';
  const paused = S.paused ? '<span class="rk-paused">Pausiert – Spieler getrennt</span>' : '';
  return { key: `${st.phase}|${st.playerId}`, html: `<span class="rk-phase">${text}</span>${detail}${paused}` };
}

/** Banner wechseln: bei neuer Phase sanft aus- und wieder einblenden, sonst nur den Text anpassen. */
function rkSetBanner({ key, html }) {
  const el = $('#rk-banner');
  if (el.dataset.key === key) { patch(el, html); return; }
  el.dataset.key = key;
  clearTimeout(rkSetBanner.t);
  if (RK_REDUCED.matches || !el.innerHTML) { patch(el, html); return; }
  el.classList.add('fading');
  rkSetBanner.t = setTimeout(() => { patch(el, html); el.classList.remove('fading'); }, 220);
}

/* ---------------- Abschlussbild ---------------- */

/** Nach Spielende: Sieger und Zähler je Spieler – erst, wenn die letzte Animation vorbei ist. */
function rkRenderFinal(g) {
  const box = $('#rk-final');
  clearTimeout(rkRenderFinal.t);
  if (g.phase !== 'gameover') {
    box.classList.add('hidden');
    $('#risiko').classList.remove('over');
    return;
  }
  const wait = (S.animUntil || 0) - clock.now();
  if (wait > 0) { rkRenderFinal.t = setTimeout(() => rkRenderFinal(S.game), wait + 400); return; }
  patch(box, rkFinalHtml(g));
  box.classList.remove('hidden');
  $('#risiko').classList.add('over');
}

function rkFinalHtml(g) {
  const w = g.winner ? rkPlayer(g.winner) : null;
  const status = (p) => (p.id === g.winner ? 'Sieger' : p.quit ? 'aufgegeben' : p.eliminated ? 'ausgeschieden' : '');
  const players = [...g.players].sort((a, b) => (b.id === g.winner) - (a.id === g.winner));
  const cols = [
    ['conquests', 'Eroberungen'],
    ['armiesDefeated', 'Armeen besiegt'],
    ['armiesLost', 'Armeen verloren'],
    ['comparisonsWon', 'Würfelvergleiche gewonnen'],
    ['maxTerritories', 'Meiste Gebiete'],
  ];
  const rows = players.map((p) => {
    const st = p.stats || {};
    return `<tr class="${p.id === g.winner ? 'winner' : ''}" style="--c:${rkTone(p.id)}">
      <th scope="row"><span class="rk-swatch"></span>${escapeHtml(p.name)}<small>${status(p)}</small></th>
      ${cols.map(([k]) => `<td>${st[k] ?? 0}</td>`).join('')}</tr>`;
  }).join('');
  const rounds = g.round === 1 ? 'nach 1 Runde' : `nach ${g.round} Runden`;
  const since = g.statsSinceRound > 0
    ? `<p class="rk-final-note">Gezählt ab Runde ${g.statsSinceRound}: Der Spielstand stammt aus einer älteren Version.</p>` : '';
  return `<div class="rk-final-card">
    <h2>${w ? `<b class="rk-who" style="--c:${rkTone(w.id)}">${escapeHtml(w.name)}</b> erobert die Welt` : 'Das Spiel ist vorbei'}</h2>
    <p class="rk-final-sub">${rounds}</p>
    <table class="rk-final-table">
      <thead><tr><th></th>${cols.map(([, label]) => `<th scope="col">${label}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table>${since}
  </div>`;
}

function rkShowBattle(b) {
  const box = $('#rk-battle');
  const dice = (list, cls) => list.map((d) => `<span class="rk-die ${cls}">${d}</span>`).join('');
  box.innerHTML = `<div class="rk-battle-row"><span>${rkTerritoryName(b.from)}</span>${dice(b.attack, 'att')}</div>
    <div class="rk-battle-row"><span>${rkTerritoryName(b.to)}</span>${dice(b.defend, 'def')}</div>
    <div class="rk-battle-foot">Verluste ${b.attackerLosses} : ${b.defenderLosses}${b.conquered ? ' – erobert' : ''}</div>`;
  box.classList.remove('hidden');
  clearTimeout(rkBattleTimer);
  rkBattleTimer = setTimeout(() => box.classList.add('hidden'), 8000);
}

function rkPlayersHtml(g) {
  const row = (cls, tone, name, cells) => `<div class="rk-player ${cls}" style="--c:${tone}">
    <span class="rk-swatch"></span><span class="rk-pname">${name}</span>${cells.map((c) => `<span class="rk-num">${c}</span>`).join('')}</div>`;
  const head = '<div class="rk-player rk-head"><span></span><span></span><span class="rk-num">Armeen</span><span class="rk-num">Karten</span><span class="rk-num">Gebiete</span></div>';
  const list = g.players.map((p) => row(
    `${p.id === g.currentId ? 'current' : ''} ${p.eliminated ? 'out' : ''}`,
    rkTone(p.id),
    escapeHtml(p.name),
    p.eliminated ? ['–', '–', '–'] : [p.armies, p.cards, p.territories],
  ));
  if (g.neutral) {
    const own = Object.values(g.territories).filter((t) => t.owner === g.neutral.id);
    list.push(row('neutral', RK_NEUTRAL, 'Neutral', [own.reduce((s, t) => s + t.armies, 0), '–', own.length]));
  }
  // Bei zwei Spalten bekommt jede ihre Kopfzeile (die zweite blendet sich bei einer Spalte aus)
  return head + (list.length > 1 ? head.replace('rk-head', 'rk-head rk-head-2') : '') + list.join('');
}

function renderRisiko() {
  $('#lobby').classList.add('hidden');
  $('#game').classList.add('hidden');
  $('#risiko').classList.remove('hidden');
  $('#rk-code').textContent = S.code;
  RkAudio.init();
  $('#risiko').classList.toggle('anim-off', S.settings.animation === 'aus');
  const g = S.game;
  rkSetBanner(rkBannerHtml(S.status));
  patch($('#rk-players'), rkPlayersHtml(g));
  patch($('#rk-log'), g.log.slice(-3).reverse().map((e) => `<li>${escapeHtml(rkPlain(e.text))}</li>`).join(''));
  if (!rkBuilt) buildRisikoMap();
  else rkLayout();
  const geo = window.RISIKO_MAP_PATHS;

  rkQueueEvents();
  rkRenderFinal(g);
  const now = clock.now();
  for (const [id, t] of Object.entries(g.territories)) {
    const node = document.getElementById(`rk-t-${id}`);
    if (!node) continue;
    node.classList.toggle('active', Boolean(g.currentId) && t.owner === g.currentId);
    node.classList.toggle('wide', t.armies >= 100);
    if ((rkLocks[id] || 0) > now) continue;      // eine Animation zeigt gerade dieses Gebiet
    rkApplyTerritory(id, t);
  }

  // Angesagter Angriff (Verteidiger wählt noch) oder Nachrücken: Pfeil zwischen den Markern
  const pa = g.turn && (g.turn.pendingAttack || g.turn.occupy);
  $$('.rk-territory.attacking, .rk-territory.defending').forEach((n) => n.classList.remove('attacking', 'defending'));
  let arrow = document.getElementById('rk-attack-arrow');
  if (pa && !rkBattleRunning) {
    if (!arrow) arrow = rkArrow($('#rk-fx'), 'rk-attack-arrow');
    rkSetArrow(arrow, pa.from, pa.to);
    document.getElementById(`rk-t-${pa.from}`).classList.add('attacking');
    document.getElementById(`rk-t-${pa.to}`).classList.add('defending');
  } else if (arrow) {
    arrow.remove();
  }

  rkRenderPreview(pa || rkBattleRunning ? null : S.preview);

  // Ohne Animation (z. B. nach dem Neuladen) die letzte Schlacht direkt zeigen
  if (g.lastBattle && g.lastBattle.seq !== rkBattleSeq && !rkBattleRunning) {
    rkBattleSeq = g.lastBattle.seq;
    rkShowBattle(g.lastBattle);
  }
}

/**
 * Vorauswahl vom Handy: Von- und Nach-Gebiet leuchten ruhig auf, mögliche Ziele sind dezent
 * umrandet, ein dünner Bogen zeigt die Richtung. Ziele berechnet der Server.
 */
function rkRenderPreview(pv) {
  const layer = $('#rk-highlight');
  const key = pv ? `${pv.mode}|${pv.from}|${pv.to}|${pv.targets.join(',')}` : '';
  if (layer.dataset.key === key) return;
  layer.dataset.key = key;
  layer.innerHTML = '';
  if (!pv) return;
  const geo = window.RISIKO_MAP_PATHS;
  const outline = (id, cls) => svgEl('path', { d: geo.territories[id].d, class: `rk-hl ${cls}` }, layer);
  for (const id of pv.targets) if (id !== pv.to) outline(id, 'target');
  outline(pv.from, 'from');
  if (pv.to) {
    outline(pv.to, `to ${pv.mode}`);
    const arrow = rkArrow(layer);
    arrow.classList.add('rk-preview-arrow', pv.mode);
    rkSetArrow(arrow, pv.from, pv.to);
  }
}

function rkApplyTerritory(id, t, ms = 350) {
  const area = document.getElementById(`rk-a-${id}`);
  const node = document.getElementById(`rk-t-${id}`);
  area.style.fill = rkTone(t.owner);
  node.dataset.owner = t.owner || '';
  rkSetArmies(id, t.armies, ms);
}

/* ---------------- Animationen (aus den Ereignissen des Servers) ---------------- */

let rkAnimSeq = null;        // zuletzt übernommenes Ereignis
const rkLocks = {};          // Gebiet → bis wann (Client-Uhr) eine Animation die Anzeige steuert
let rkBattleRunning = 0;
const RK_REDUCED = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
const rkEaseInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const rkMarkerPos = (id) => window.RISIKO_MAP_PATHS.territories[id].marker;

/** Neue Ereignisse einplanen; beim ersten Aufruf wird die Vorgeschichte übersprungen. */
function rkQueueEvents() {
  const anim = S.anim || { seq: 0, events: [] };
  if (rkAnimSeq === null || anim.seq < rkAnimSeq) { rkAnimSeq = anim.seq; return; }
  for (const e of anim.events) {
    if (e.seq <= rkAnimSeq) continue;
    rkAnimSeq = e.seq;
    rkSchedule(e);
  }
}

function rkSchedule(e) {
  const now = clock.now();
  const dur = RK_REDUCED.matches ? 0 : e.dur;
  const delay = Math.max(0, e.at - now);
  const end = now + delay + dur;
  const ids = e.type === 'place' || e.type === 'conquer' ? [e.territory]
    : e.type === 'battle' || e.type === 'move' ? [e.from, e.to] : [];
  for (const id of ids) rkLocks[id] = Math.max(rkLocks[id] || 0, end + 40);
  if (e.type === 'battle') rkBattleRunning++;
  setTimeout(() => {
    try { if (RK_ANIMATIONS[e.type]) RK_ANIMATIONS[e.type](e, dur); } catch (err) { console.warn(err); }
  }, delay);
  // Ton zum passenden Zeitpunkt (Würfel erst, wenn der Pfeil steht und die Würfel rollen)
  const sound = RK_SOUNDS[e.type] && RK_SOUNDS[e.type](e);
  const soundAt = e.type === 'battle' ? (e.steps ? (e.steps.wait + e.steps.arrow) * (dur / (e.dur || 1)) : dur * 0.24) : 0;
  if (sound) setTimeout(() => RkAudio.play(sound), delay + soundAt);
  // Danach den echten Stand übernehmen (falls keine weitere Animation das Gebiet hält)
  setTimeout(() => {
    if (e.type === 'battle') rkBattleRunning--;
    const nowEnd = clock.now();
    for (const id of ids) if ((rkLocks[id] || 0) <= nowEnd + 1 && S.game.territories[id]) rkApplyTerritory(id, S.game.territories[id]);
    if (e.type === 'battle') renderRisiko();
  }, delay + dur + 60);
}

/** Zeitgesteuerte Funktion mit Easing über rAF. */
function rkTween(ms, fn, ease = rkEaseInOut) {
  return new Promise((resolve) => {
    if (ms <= 0) { fn(1); resolve(); return; }
    const start = performance.now();
    (function frame(now) {
      const t = Math.max(0, Math.min(1, (now - start) / ms));
      fn(ease(t));
      if (t < 1) requestAnimationFrame(frame); else resolve();
    })(start);
  });
}
const rkWait = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Geschwungener Pfeil von Marker zu Marker (Rand zu Rand), mit Spitze. */
function rkArrow(parent, id) {
  const g = svgEl('g', { class: 'rk-arrow', ...(id ? { id } : {}) }, parent);
  svgEl('path', { class: 'rk-arrow-line' }, g);
  svgEl('path', { class: 'rk-arrow-head' }, g);
  return g;
}
function rkArrowGeometry(from, to) {
  const [x1, y1] = rkMarkerPos(from);
  const [x2, y2] = rkMarkerPos(to);
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const bend = Math.min(0.28 * len, 26);
  const c = [(x1 + x2) / 2 - ((y2 - y1) / len) * bend, (y1 + y2) / 2 + ((x2 - x1) / len) * bend];
  const r = rkSizes(rkK).r + 1.2;
  const trim = (p, q) => { const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1; return [p[0] + ((q[0] - p[0]) / l) * r, p[1] + ((q[1] - p[1]) / l) * r]; };
  const a = trim([x1, y1], c);
  const b = trim([x2, y2], c);
  const point = (t) => [(1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]];
  return { a, b, c, point };
}
function rkSetArrow(g, from, to, progress = 1) {
  const { a, b, c, point } = rkArrowGeometry(from, to);
  const line = g.firstChild;
  line.setAttribute('d', `M${a[0]} ${a[1]}Q${c[0]} ${c[1]} ${b[0]} ${b[1]}`);
  const total = line.getTotalLength();
  line.style.strokeDasharray = `${total} ${total}`;
  line.style.strokeDashoffset = String(total * (1 - progress));
  const tip = point(Math.max(0.02, progress));
  const back = point(Math.max(0, progress - 0.06));
  const ang = Math.atan2(tip[1] - back[1], tip[0] - back[0]);
  const s = rkSizes(rkK).r * 0.75;
  const pts = [[0, 0], [-s, -s * 0.55], [-s * 0.7, 0], [-s, s * 0.55]].map(([x, y]) => [tip[0] + x * Math.cos(ang) - y * Math.sin(ang), tip[1] + x * Math.sin(ang) + y * Math.cos(ang)]);
  g.lastChild.setAttribute('d', `M${pts.map((p) => p.map((v) => v.toFixed(2)).join(' ')).join('L')}Z`);
  return { point };
}

/** Marker kurz aufpoppen lassen (Web Animations, mit Easing). */
function rkPop(id, ms, scale = 1.35) {
  const inner = document.querySelector(`#rk-t-${id} .rk-marker`);
  const base = rkSizes(rkK).markerScale;
  inner.animate([
    { transform: `scale(${base})` }, { transform: `scale(${base * scale})`, offset: 0.35 }, { transform: `scale(${base})` },
  ], { duration: ms, easing: 'cubic-bezier(.3, 1.4, .5, 1)' });
}

/** Übrige Karte tritt zurück (Entsättigen und Abdunkeln), die genannten Gebiete bleiben im Fokus. */
function rkFocus(ids, on) {
  $$('.rk-focus').forEach((el) => el.classList.remove('rk-focus'));
  $('#risiko').classList.toggle('focus', on);
  if (!on) return;
  for (const id of ids) ['rk-a-', 'rk-t-', 'rk-l-'].forEach((p) => document.getElementById(p + id)?.classList.add('rk-focus'));
}

/** Verlust: Marker blinkt rot, die Zahl zählt herunter und schwingt leicht nach. */
function rkHit(id, value, ms) {
  const node = document.getElementById(`rk-t-${id}`);
  node.classList.remove('hit');
  void node.getBoundingClientRect();
  node.classList.add('hit');
  rkSetArmies(id, value, ms * 0.5);
  const text = node.querySelector('.rk-armies');
  text.animate([
    { transform: 'translateY(0) scale(1)' },
    { transform: 'translateY(-14%) scale(1.28)', offset: 0.25 },
    { transform: 'translateY(4%) scale(.92)', offset: 0.55 },
    { transform: 'translateY(-1%) scale(1.03)', offset: 0.8 },
    { transform: 'translateY(0) scale(1)' },
  ], { duration: ms, easing: 'ease-out' });
}

/** Welcher Ton zu welchem Ereignis gehört (sparsam: kein Ton beim Verschieben). */
const RK_SOUNDS = {
  place: () => 'place',
  battle: () => 'dice',
  conquer: () => 'conquer',
  trade: () => 'trade',
  turn: (e) => (e.newRound ? 'round' : 'turn'),
};

const RK_ANIMATIONS = {
  /** Neuer Zug: kurz und ruhig „Runde 4 · Cem ist am Zug“ unter der Kopfzeile. Bei „aus“ genügt die Kopfzeile. */
  turn(e) {
    const p = rkPlayer(e.playerId);
    if (!e.dur || !p) return;
    const el = $('#rk-announce');
    el.innerHTML = `${e.newRound ? `<span class="rk-ann-round">Runde ${e.round}</span>` : ''}
      <span class="rk-ann-who" style="--c:${rkTone(p.id)}"><b>${escapeHtml(p.name)}</b> ist am Zug</span>`;
    const top = $('.rk-top');
    el.style.top = `${top.offsetTop + top.offsetHeight + 12}px`;
    el.classList.remove('hidden');
    el.getAnimations().forEach((a) => a.cancel());
    const lift = RK_REDUCED.matches ? 0 : 6;
    const a = el.animate([
      { opacity: 0, transform: `translate(-50%, ${lift}px)` },
      { opacity: 1, transform: 'translate(-50%, 0)', offset: 0.15 },
      { opacity: 1, transform: 'translate(-50%, 0)', offset: 0.8 },
      { opacity: 0, transform: 'translate(-50%, 0)' },
    ], { duration: Math.max(1400, e.dur), easing: 'ease-out' });
    a.onfinish = () => el.classList.add('hidden');
  },

  /** Verstärkung: Marker poppt auf, die Zahl zählt hoch. */
  place(e, dur) {
    rkShown[e.territory] = e.from;
    rkSetArmies(e.territory, e.from, 0);
    if (dur > 0) rkPop(e.territory, dur * 0.7);
    rkSetArmies(e.territory, e.to, dur * 0.8);
  },

  /**
   * Angriff: Die übrige Karte tritt zurück, der Pfeil zeichnet
   * sich, die Würfel rollen aus, dann werden die Vergleichspaare nacheinander gezeigt – jeder Verlust
   * blinkt rot und zählt mit leichtem Nachschwingen herunter. Augen und Verluste kommen vom Server.
   */
  async battle(e, dur) {
    document.getElementById('rk-attack-arrow')?.remove();
    const done = () => { rkBattleSeq = S.game.lastBattle ? S.game.lastBattle.seq : rkBattleSeq; rkShowBattle(e); };
    if (dur <= 0) {
      rkSetArmies(e.from, e.attackerArmies - e.attackerLosses, 0);
      rkSetArmies(e.to, e.defenderArmies - e.defenderLosses, 0);
      done();
      return;
    }
    const top = $('#rk-top-fx');
    const pairs = Math.min(e.attack.length, e.defend.length);
    // Abschnitte vom Server (ältere Ereignisse ohne Angabe: feste Anteile der Gesamtdauer)
    const k = dur / (e.dur || dur);
    const st = e.steps
      ? Object.fromEntries(Object.entries(e.steps).map(([key, v]) => [key, v * k]))
      : { wait: dur * 0.06, arrow: dur * 0.18, roll: dur * 0.3, pair: (dur * 0.3) / Math.max(1, pairs), settle: dur * 0.08, fade: dur * 0.12 };
    rkFocus([e.from, e.to], true);
    const arrow = rkArrow($('#rk-fx'));
    document.getElementById(`rk-t-${e.from}`).classList.add('attacking');
    document.getElementById(`rk-t-${e.to}`).classList.add('defending');
    await rkWait(st.wait);
    let geom = rkSetArrow(arrow, e.from, e.to, 0);
    await rkTween(st.arrow, (t) => { geom = rkSetArrow(arrow, e.from, e.to, t); });

    // Würfel neben der Mitte des Bogens, auf der Außenseite
    const size = rkSizes(rkK).r * 1.55;
    const [p0, p1] = [geom.point(0.45), geom.point(0.55)];
    const tl = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
    const nx = -(p1[1] - p0[1]) / tl; const ny = (p1[0] - p0[0]) / tl;
    const [cx0, cy0] = geom.point(0.5);
    // Seite und Abstand so wählen, dass die Würfel keinen der beiden Marker verdecken
    const [ma, mb] = [rkMarkerPos(e.from), rkMarkerPos(e.to)];
    const spots = [];
    for (const k of [1.9, 2.6, 3.4]) for (const sgn of [-1, 1]) spots.push([cx0 + sgn * nx * size * k, cy0 + sgn * ny * size * k]);
    const clear = ([x, y]) => Math.min(Math.hypot(x - ma[0], y - ma[1]), Math.hypot(x - mb[0], y - mb[1]));
    const spot = spots.find((p) => clear(p) > size * 2.6) || spots.reduce((best, p) => (clear(p) > clear(best) ? p : best));
    const dice = svgEl('g', { class: 'rk-dice', transform: `translate(${spot[0]} ${spot[1]})` }, top);
    const dieEls = { att: [], def: [] };
    // Jeder Würfel startet etwas später und kommt trotzdem vor dem ersten Vergleich zur Ruhe
    const stagger = Math.min(st.roll * 0.04, 90);
    const rollMs = st.roll * 0.92 - 2 * stagger;
    const row = (values, y, cls) => values.forEach((v, i) => {
      const x = (i - (values.length - 1) / 2) * size * 1.25;
      const d = svgEl('g', { class: `rk-die-g ${cls}`, transform: `translate(${x} ${y})` }, dice);
      const inner = svgEl('g', { class: 'rk-die-inner' }, d);
      svgEl('rect', { x: -size / 2, y: -size / 2, width: size, height: size, rx: size * 0.22 }, inner);
      svgEl('text', { 'text-anchor': 'middle', dy: '0.35em', style: `font-size:${size * 0.62}px` }, inner).textContent = String(v);
      // Ausrollen mit echtem Abbremsen: zwei Umdrehungen, die immer langsamer werden
      inner.animate([
        { transform: 'rotate(-760deg) scale(.35)', opacity: 0 },
        { transform: 'rotate(-180deg) scale(1.08)', opacity: 1, offset: 0.45 },
        { transform: 'rotate(0deg) scale(1)', opacity: 1 },
      ], { duration: rollMs, delay: i * stagger, easing: 'cubic-bezier(.12, .72, .22, 1)', fill: 'backwards' });
      dieEls[cls].push(d);
    });
    row(e.attack, -size * 0.7, 'att');
    row(e.defend, size * 0.7, 'def');
    await rkWait(st.roll);

    // Vergleichspaare nacheinander: höchster gegen höchsten, zweithöchster gegen zweithöchsten.
    // Es hebt sich immer nur das aktuelle Paar hervor; das vorige tritt zurück.
    const shown = { [e.from]: e.attackerArmies, [e.to]: e.defenderArmies };
    const step = st.pair;
    for (let i = 0; i < pairs; i++) {
      const attackerWins = e.attack[i] > e.defend[i];
      const [win, lose] = attackerWins ? [dieEls.att[i], dieEls.def[i]] : [dieEls.def[i], dieEls.att[i]];
      if (i > 0) [dieEls.att[i - 1], dieEls.def[i - 1]].forEach((d) => d.classList.add('done'));
      win.classList.add('win');
      lose.classList.add('lose');
      lose.firstChild.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-6%)' }, { transform: 'translateX(5%)' }, { transform: 'translateX(0)' }],
        { duration: step * 0.45, easing: 'ease-in-out' });
      const loser = attackerWins ? e.to : e.from;
      shown[loser] -= 1;
      rkHit(loser, shown[loser], step * 0.8);
      await rkWait(step);
    }
    // Übrige Würfel ohne Gegenüber treten zurück
    [...dieEls.att.slice(pairs), ...dieEls.def.slice(pairs)].forEach((d) => d.classList.add('idle'));
    await rkWait(st.settle);
    dice.animate([{ opacity: 1 }, { opacity: 0 }], { duration: st.fade * 0.5, fill: 'forwards' });
    arrow.animate([{ opacity: 1 }, { opacity: 0 }], { duration: st.fade * 0.5, fill: 'forwards' });
    rkFocus([], false);
    await rkWait(st.fade * 0.5);
    dice.remove();
    arrow.remove();
    ['hit', 'attacking', 'defending'].forEach((c) => $$(`.rk-territory.${c}`).forEach((n) => n.classList.remove(c)));
    done();
  },

  /** Eroberung: Welle in der neuen Farbe von der Mitte aus, dann ein sanfter Puls. */
  async conquer(e, dur) {
    const area = document.getElementById(`rk-a-${e.territory}`);
    const tone = rkTone(e.owner);
    if (dur <= 0) { area.style.fill = tone; return; }
    const clipId = `rk-clip-${e.seq}`;
    const clip = svgEl('clipPath', { id: clipId }, $('#rk-defs'));
    svgEl('path', { d: area.getAttribute('d'), 'clip-rule': 'evenodd' }, clip);
    const [cx, cy] = rkMarkerPos(e.territory);
    const bb = area.getBBox();
    const radius = Math.max(...[[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]]
      .map(([x, y]) => Math.hypot(x - cx, y - cy)));
    const wave = svgEl('g', { 'clip-path': `url(#${clipId})` }, $('#rk-wave'));
    const disc = svgEl('circle', { cx, cy, r: 0, fill: tone }, wave);
    const ring = svgEl('circle', { cx, cy, r: 0, fill: 'none', stroke: '#fff', 'stroke-opacity': 0.55, 'vector-effect': 'non-scaling-stroke', 'stroke-width': 3 }, wave);
    await rkTween(dur * 0.55, (t) => { disc.setAttribute('r', radius * t); ring.setAttribute('r', radius * t); ring.setAttribute('stroke-opacity', 0.55 * (1 - t)); }, rkEase);
    area.style.transition = 'none';
    area.style.fill = tone;
    void area.getBoundingClientRect();
    area.style.transition = '';
    const glow = svgEl('path', { d: area.getAttribute('d'), class: 'rk-glow' }, wave);
    disc.remove();
    ring.remove();
    await rkTween(dur * 0.45, (t) => glow.setAttribute('fill-opacity', (0.32 * Math.sin(Math.PI * t)).toFixed(3)), (t) => t);
    wave.remove();
    clip.remove();
  },

  /** Nachrücken und Verschieben: Ein Marker gleitet vom Ursprung ins Ziel. */
  async move(e, dur) {
    const fromNow = (rkShown[e.from] ?? 0) - e.count;
    rkSetArmies(e.from, Math.max(1, fromNow), Math.min(250, dur * 0.3));
    if (dur <= 0) { rkSetArmies(e.to, (rkShown[e.to] || 0) + e.count, 0); return; }
    const { point } = rkArrowGeometry(e.from, e.to);
    const [sx, sy] = rkMarkerPos(e.from);
    const [tx, ty] = rkMarkerPos(e.to);
    const { markerScale } = rkSizes(rkK);
    const g = svgEl('g', { class: 'rk-territory rk-moving' }, $('#rk-top-fx'));
    const inner = svgEl('g', { class: 'rk-marker', transform: `scale(${markerScale})` }, g);
    svgEl('circle', { class: 'rk-disc', r: window.RISIKO_MAP_PATHS.style.markerR * 0.85 }, inner);
    svgEl('text', { class: 'rk-armies', 'text-anchor': 'middle', dy: '0.35em' }, inner).textContent = String(e.count);
    await rkTween(dur * 0.85, (t) => {
      // Start und Ende in der Markermitte, dazwischen auf dem Bogen
      const p = t < 0.08 ? [sx + (point(0)[0] - sx) * (t / 0.08), sy + (point(0)[1] - sy) * (t / 0.08)]
        : t > 0.92 ? [point(1)[0] + (tx - point(1)[0]) * ((t - 0.92) / 0.08), point(1)[1] + (ty - point(1)[1]) * ((t - 0.92) / 0.08)]
          : point((t - 0.08) / 0.84);
      g.setAttribute('transform', `translate(${p[0].toFixed(2)} ${p[1].toFixed(2)})`);
    });
    g.remove();
    rkPop(e.to, dur * 0.15, 1.2);
    rkSetArmies(e.to, (rkShown[e.to] || 0) + e.count, dur * 0.15);
  },
};
