'use strict';

/* Weckseite: weckt den schlafenden Render-Server und leitet weiter, sobald er antwortet.
 * Adresse des Servers – nur hier ändern. */
const SERVER = 'https://monopoly-abend.onrender.com';

const TIMEOUT_MS = 10000;      // eine Anfrage an /healthz
const RETRY_MS = 3000;         // Pause nach einem Fehlversuch
const MAX_WAIT_MS = 180000;    // danach aufgeben
const EXPECTED_MS = 60000;     // so lange füllt sich der Balken
const OPAQUE_AFTER = 3;        // CORS-Fehler in Folge, ab denen der no-cors-Rückfall mitläuft

const base = SERVER.replace(/\/+$/, '');
const $ = (sel) => document.querySelector(sel);

let state = 'waking';          // waking | ready | failed
let pending = null;            // Ziel-URL, sobald der Server bereit ist
let startedAt = 0;
let corsFails = 0;
let barTimer = null;

/* ---------------- Server wecken ---------------- */

/** Fragt /healthz ab. 'ready' nur bei JSON mit ok: true; 'cors' bei Netzwerk- oder CORS-Fehler. */
async function probe() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/healthz`, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) return 'no';
    const data = await res.json().catch(() => null);
    return data && data.ok === true ? 'ready' : 'no';
  } catch (err) {
    return err.name === 'AbortError' ? 'timeout' : 'cors';
  } finally {
    clearTimeout(timer);
  }
}

/** Rückfall ohne CORS-Freigabe: Status und Inhalt bleiben verborgen, es zählt nur, dass etwas antwortet. */
async function probeOpaque() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    await fetch(`${base}/healthz`, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
    return true;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function wake() {
  state = 'waking';
  startedAt = Date.now();
  corsFails = 0;
  render();
  barTimer = setInterval(renderBar, 500);
  while (Date.now() - startedAt < MAX_WAIT_MS) {
    const result = await probe();
    if (result === 'ready') return ready();
    corsFails = result === 'cors' ? corsFails + 1 : 0;
    if (corsFails >= OPAQUE_AFTER && await probeOpaque()) return ready();
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
  state = 'failed';
  clearInterval(barTimer);
  render();
}

function ready() {
  state = 'ready';
  clearInterval(barTimer);
  render();
  if (pending) location.assign(pending);
}

/* ---------------- Aktionen ---------------- */

function go(url, text) {
  pending = url;
  if (state === 'ready') { location.assign(url); return; }
  $('#pending').textContent = text;
  render();
}

$('#btn-new').addEventListener('click', () => {
  markChosen('#btn-new');
  go(`${base}/board`, 'Du wirst gleich weitergeleitet und startest ein neues Spiel …');
});

$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const group = $('#join-code');
  const code = codeValue();
  let error = '';
  if (!code) error = 'Bitte gib den Raumcode ein.';
  else if (!/^[A-Z]{4}$/.test(code)) error = 'Der Raumcode hat 4 Buchstaben.';
  $('#join-msg').textContent = error;
  group.setAttribute('aria-invalid', error ? 'true' : 'false');
  if (error) { cells[firstEmpty()].focus(); return; }
  markChosen('#btn-join');
  go(`${base}/play?room=${encodeURIComponent(code)}`, `Du wirst gleich weitergeleitet und trittst Raum ${code} bei …`);
});

/* Raumcode in vier Feldern: wie der Server nur Buchstaben, automatisch weiter,
 * Einfügen verteilt auf die Felder, Rücktaste im leeren Feld springt zurück. */
const cells = [...document.querySelectorAll('#join-code .cell')];
const onlyLetters = (text) => String(text || '').toUpperCase().replace(/[^A-Z]/g, '');
const codeValue = () => cells.map((c) => c.value).join('');
const firstEmpty = () => { const i = cells.findIndex((c) => !c.value); return i < 0 ? cells.length - 1 : i; };

function clearError() {
  $('#join-msg').textContent = '';
  $('#join-code').removeAttribute('aria-invalid');
}

/** Buchstaben ab Feld `from` verteilen. */
function fillFrom(from, letters) {
  let i = from;
  for (const ch of letters) {
    if (i >= cells.length) break;
    cells[i].dataset.before = ch;
    cells[i++].value = ch;
  }
  cells[Math.min(i, cells.length - 1)].focus();
}

cells.forEach((cell, i) => {
  cell.addEventListener('input', () => {
    // Ein schon belegtes Feld: nur das Neue zählt (Feld ohne maxlength, damit Einfügen ankommt)
    let letters = onlyLetters(cell.value);
    const before = cell.dataset.before || '';
    if (before && letters.length > 1 && letters.startsWith(before)) letters = letters.slice(before.length);
    clearError();
    cell.value = '';
    if (letters.length >= cells.length) cells.forEach((c) => { c.value = ''; });
    if (letters) fillFrom(letters.length >= cells.length ? 0 : i, letters);
  });
  cell.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !cell.value && i > 0) {
      e.preventDefault();
      cells[i - 1].value = '';
      cells[i - 1].focus();
      clearError();
    } else if (e.key === 'ArrowLeft' && i > 0) {
      e.preventDefault(); cells[i - 1].focus();
    } else if (e.key === 'ArrowRight' && i < cells.length - 1) {
      e.preventDefault(); cells[i + 1].focus();
    } else if (e.key.length === 1 && /[a-z]/i.test(e.key) && cell.value && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      cell.value = e.key.toUpperCase();
      clearError();
      if (i < cells.length - 1) cells[i + 1].focus();
    }
  });
  cell.addEventListener('paste', (e) => {
    e.preventDefault();
    const letters = onlyLetters(e.clipboardData && e.clipboardData.getData('text'));
    if (!letters) return;
    clearError();
    if (letters.length >= cells.length) cells.forEach((c) => { c.value = ''; });
    fillFrom(letters.length >= cells.length ? 0 : i, letters);
  });
  cell.addEventListener('focus', () => { cell.dataset.before = cell.value; cell.select(); });
  cell.addEventListener('keyup', () => { cell.dataset.before = cell.value; });
});

$('#btn-retry').addEventListener('click', () => wake());

function markChosen(sel) {
  document.querySelectorAll('.btn.chosen').forEach((b) => b.classList.remove('chosen'));
  $(sel).classList.add('chosen');
}

/* ---------------- Anzeige ---------------- */

const STATUS = {
  waking: 'Der Server startet, das dauert bis zu einer Minute.',
  ready: 'Bereit',
  failed: 'Der Server antwortet gerade nicht. Versuch es gleich noch einmal.',
};

function render() {
  $('#status').dataset.state = state;
  $('#status-text').textContent = STATUS[state];
  $('#pending').classList.toggle('hidden', !pending || state === 'failed');
  $('#btn-retry').classList.toggle('hidden', state !== 'failed');
  renderBar();
}

/** Balken füllt sich in etwa einer Minute bis 90 %, bei Bereit ganz. */
function renderBar() {
  const pct = state === 'ready' ? 100 : Math.min(90, ((Date.now() - startedAt) / EXPECTED_MS) * 90);
  $('#bar-fill').style.width = `${pct}%`;
  $('.bar').setAttribute('aria-valuenow', String(Math.round(pct)));
}

wake();
