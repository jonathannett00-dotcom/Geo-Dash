'use strict';

/* Startseite: neues Spiel anlegen (öffnet die Host-Lobby) oder per Code beitreten. */

const $s = (sel) => document.querySelector(sel);
const SLOW_MS = 3000;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/* ---------------- Wortmarke und Eingang ---------------- */

// Wortmarke in Buchstaben teilen (für das Reveal); der Text bleibt „Spieleabend“
(function splitMark() {
  const mark = $s('#st-mark');
  const text = mark.textContent;
  mark.setAttribute('aria-label', text);
  mark.textContent = '';
  [...text].forEach((ch, i) => {
    const span = document.createElement('span');
    span.className = 'st-ch';
    span.style.setProperty('--c', i);
    span.setAttribute('aria-hidden', 'true');
    span.textContent = ch;
    mark.appendChild(span);
  });
}());
requestAnimationFrame(() => document.documentElement.classList.add('st-go'));

/* ---------------- Meldungen und Anfragen ---------------- */

/** Allgemeine Meldung im Kopf (z. B. Grenze erreicht). */
function say(text) { $s('#st-msg').textContent = text || ''; }

/** Meldung direkt am Raumcode. */
function sayCode(text) {
  const group = $s('#st-code');
  $s('#st-code-msg').textContent = text || '';
  if (text) {
    group.setAttribute('aria-invalid', 'true');
    group.classList.remove('st-shake');
    void group.offsetWidth; // Animation neu starten
    group.classList.add('st-shake');
  } else {
    group.removeAttribute('aria-invalid');
  }
}

/**
 * Anfrage an den Server. Dauert sie länger als 3 Sekunden (der Server auf Render
 * schläft und startet erst), erscheint ein ruhiger Hinweis.
 */
let waiting = 0;
async function request(url, options = {}) {
  waiting++;
  const wait = setTimeout(() => $s('#st-wait').classList.remove('hidden'), SLOW_MS);
  try {
    const res = await fetch(url, { cache: 'no-store', ...options });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (_) {
    return { ok: false, status: 0, data: { error: 'Der Server ist gerade nicht erreichbar. Bitte versuche es gleich noch einmal.' } };
  } finally {
    clearTimeout(wait);
    if (--waiting === 0) $s('#st-wait').classList.add('hidden');
  }
}

function busy(btn, on) {
  btn.disabled = on;
  btn.setAttribute('aria-busy', String(on));
}

/** Sanft ausblenden, dann weiter. */
function leave(url) {
  if (reduceMotion.matches) { location.href = url; return; }
  document.body.classList.add('st-leaving');
  setTimeout(() => { location.href = url; }, 220);
}

$s('#st-create').addEventListener('click', async () => {
  const btn = $s('#st-create');
  busy(btn, true);
  say('');
  const res = await request('/api/rooms', { method: 'POST' });
  if (res.ok && res.data.code) { leave(`/board?room=${encodeURIComponent(res.data.code)}`); return; }
  busy(btn, false);
  say(res.data.error || 'Das hat nicht geklappt. Bitte versuche es noch einmal.');
});

// „Spiel beitreten“ im Kopf springt zum Code und setzt den Fokus ins erste Feld
$s('#st-to-join').addEventListener('click', (e) => {
  e.preventDefault();
  $s('#beitreten').scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'center' });
  cells[firstEmpty()].focus({ preventScroll: true });
});

/* ---------------- Raumcode in vier Feldern ---------------- */

const cells = [...document.querySelectorAll('.st-cell')];
const clean = (text) => String(text || '').toUpperCase().replace(/[^A-Z]/g, '');
const codeValue = () => cells.map((c) => c.value).join('');
const firstEmpty = () => { const i = cells.findIndex((c) => !c.value); return i < 0 ? cells.length - 1 : i; };

/** Buchstaben ab Feld `from` verteilen (Einfügen, Autovervollständigen, schnelles Tippen). */
function fill(from, letters) {
  let i = from;
  for (const ch of letters) {
    if (i >= cells.length) break;
    cells[i].value = ch;
    pop(cells[i]);
    i++;
  }
  cells[Math.min(i, cells.length - 1)].focus();
}

function pop(cell) {
  cell.classList.remove('st-filled');
  void cell.offsetWidth;
  cell.classList.add('st-filled');
}

cells.forEach((cell, i) => {
  cell.addEventListener('input', () => {
    const letters = clean(cell.value);
    sayCode('');
    if (!letters) { cell.value = ''; return; }
    if (letters.length === 1) {
      cell.value = letters;
      pop(cell);
      if (i < cells.length - 1) cells[i + 1].focus();
      return;
    }
    fill(i, letters);
  });
  cell.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !cell.value && i > 0) {
      e.preventDefault();
      cells[i - 1].value = '';
      cells[i - 1].focus();
      sayCode('');
    } else if (e.key === 'ArrowLeft' && i > 0) {
      e.preventDefault(); cells[i - 1].focus();
    } else if (e.key === 'ArrowRight' && i < cells.length - 1) {
      e.preventDefault(); cells[i + 1].focus();
    } else if (e.key.length === 1 && /[a-z]/i.test(e.key) && cell.value && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Feld schon belegt: überschreiben statt anhängen
      e.preventDefault();
      cell.value = e.key.toUpperCase();
      pop(cell);
      sayCode('');
      if (i < cells.length - 1) cells[i + 1].focus();
    }
  });
  cell.addEventListener('paste', (e) => {
    e.preventDefault();
    const letters = clean(e.clipboardData && e.clipboardData.getData('text'));
    if (!letters) { sayCode('Der Raumcode besteht nur aus Buchstaben.'); return; }
    sayCode('');
    // Ein ganzer Code ersetzt alles, sonst ab diesem Feld weiter
    if (letters.length >= cells.length) cells.forEach((c) => { c.value = ''; });
    fill(letters.length >= cells.length ? 0 : i, letters);
  });
  cell.addEventListener('focus', () => cell.select());
});

$s('#st-join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = codeValue();
  if (code.length !== 4) { sayCode('Der Raumcode hat 4 Buchstaben.'); cells[firstEmpty()].focus(); return; }
  const btn = $s('#st-join');
  busy(btn, true);
  const res = await request(`/api/rooms/${code}`);
  if (res.ok && res.data.exists) { leave(`/play?room=${encodeURIComponent(res.data.code)}`); return; }
  busy(btn, false);
  sayCode(res.data.error || 'Diesen Raum gibt es nicht. Bitte prüfe den Code.');
});

// Von der Host-Ansicht hierher geschickt (z. B. Raumlimit erreicht)
const fehler = new URLSearchParams(location.search).get('fehler');
if (fehler) {
  say(fehler.slice(0, 300));
  history.replaceState(null, '', '/');
}
// Server früh wecken: Schläft er, steht der Hinweis schon da, bevor jemand klickt
request('/healthz');
