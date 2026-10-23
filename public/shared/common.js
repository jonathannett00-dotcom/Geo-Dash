'use strict';

/* Gemeinsame Hilfsfunktionen für Tablet und Handy. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtM = (n) => `${Math.round(n).toLocaleString('de-DE')} M`;

/** Differenz zwischen Server- und lokaler Uhr, damit Countdowns überall gleich laufen. */
const clock = {
  offset: 0,
  sync(serverNow) { if (serverNow) this.offset = serverNow - Date.now(); },
  now() { return Date.now() + this.offset; },
  /** Verbleibende Sekunden bis zu einem Server-Zeitpunkt. */
  left(ts) { return Math.max(0, Math.ceil((ts - this.now()) / 1000)); },
};

/** Ersetzt den Inhalt nur bei Änderungen und behält Eingaben/Fokus bei. */
function patch(el, html) {
  if (!el || el._html === html) return false;
  const saved = {};
  $$('input[id], select[id], textarea[id]', el).forEach((i) => {
    saved[i.id] = { value: i.type === 'checkbox' ? i.checked : i.value, focus: document.activeElement === i };
  });
  el.innerHTML = html;
  el._html = html;
  Object.entries(saved).forEach(([id, s]) => {
    const i = document.getElementById(id);
    if (!i || i.dataset.keep === 'no') return;
    if (i.type === 'checkbox') i.checked = s.value;
    else if (i.tagName !== 'SELECT' || [...i.options].some((o) => o.value === s.value)) i.value = s.value;
    if (s.focus) i.focus();
  });
  return true;
}

/** Aktualisiert alle Countdown-Anzeigen ([data-ends] = Server-Zeitstempel). */
function tickCountdowns() {
  $$('[data-ends]').forEach((el) => {
    const left = clock.left(Number(el.dataset.ends));
    const text = `${left} s`;
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle('urgent', left <= 5);
  });
  $$('[data-bar-ends]').forEach((el) => {
    const ends = Number(el.dataset.barEnds);
    const total = Number(el.dataset.barTotal) || 20000;
    const frac = Math.max(0, Math.min(1, (ends - clock.now()) / total));
    el.style.transform = `scaleX(${frac.toFixed(3)})`;
  });
}
setInterval(tickCountdowns, 250);

function toast(msg, kind = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.dataset.kind = kind;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 4200 : 2600);
}

/** Zählt einen Geldbetrag animiert hoch/runter und zeigt die Differenz an. */
function animateMoney(el, from, to, deltaHost) {
  if (!el) return;
  if (from === to || from === undefined) { el.textContent = fmtM(to); return; }
  const start = performance.now();
  const dur = 900;
  el.classList.remove('up', 'down');
  void el.offsetWidth;
  el.classList.add(to > from ? 'up' : 'down');
  if (deltaHost) {
    const d = document.createElement('span');
    d.className = `delta ${to > from ? 'up' : 'down'}`;
    d.textContent = `${to > from ? '+' : '−'}${fmtM(Math.abs(to - from))}`;
    deltaHost.appendChild(d);
    setTimeout(() => d.remove(), 1600);
  }
  cancelAnimationFrame(el._raf);
  (function step(now) {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = fmtM(from + (to - from) * eased);
    if (t < 1) el._raf = requestAnimationFrame(step);
    else setTimeout(() => el.classList.remove('up', 'down'), 500);
  })(start);
}
