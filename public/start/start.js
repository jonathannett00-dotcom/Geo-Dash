'use strict';

/* Startseite: neues Spiel anlegen (öffnet die Host-Lobby) oder per Code beitreten. */

const $s = (sel) => document.querySelector(sel);
const SLOW_MS = 3000;

lbBackground($s('#st-bg'), 'monopoly');

/** Meldung unten (z. B. Grenze erreicht oder Raum nicht gefunden). */
function say(text) { $s('#st-msg').textContent = text || ''; }

/**
 * Anfrage an den Server. Dauert sie länger als 3 Sekunden (der Server auf Render
 * schläft und startet erst), erscheint ein ruhiger Hinweis.
 */
async function request(url, options = {}) {
  const wait = setTimeout(() => $s('#st-wait').classList.remove('hidden'), SLOW_MS);
  try {
    const res = await fetch(url, { cache: 'no-store', ...options });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (_) {
    return { ok: false, status: 0, data: { error: 'Der Server ist gerade nicht erreichbar. Bitte versuche es gleich noch einmal.' } };
  } finally {
    clearTimeout(wait);
    $s('#st-wait').classList.add('hidden');
  }
}

function busy(btn, on) {
  btn.disabled = on;
  btn.setAttribute('aria-busy', String(on));
}

$s('#st-create').addEventListener('click', async () => {
  const btn = $s('#st-create');
  busy(btn, true);
  say('');
  const res = await request('/api/rooms', { method: 'POST' });
  if (res.ok && res.data.code) { location.href = `/board?room=${encodeURIComponent(res.data.code)}`; return; }
  busy(btn, false);
  say(res.data.error || 'Das hat nicht geklappt. Bitte versuche es noch einmal.');
});

const codeInput = $s('#st-code');
codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  say('');
});

$s('#st-join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = codeInput.value;
  if (code.length !== 4) { say('Der Raumcode hat 4 Buchstaben.'); codeInput.focus(); return; }
  const btn = $s('#st-join');
  busy(btn, true);
  const res = await request(`/api/rooms/${code}`);
  busy(btn, false);
  if (res.ok && res.data.exists) { location.href = `/play?room=${encodeURIComponent(res.data.code)}`; return; }
  say(res.data.error || 'Diesen Raum gibt es nicht. Bitte prüfe den Code.');
});

// Von der Host-Ansicht hierher geschickt (z. B. Raumlimit erreicht)
const fehler = new URLSearchParams(location.search).get('fehler');
if (fehler) {
  say(fehler.slice(0, 300));
  history.replaceState(null, '', '/');
}
// Server früh wecken: Schläft er, steht der Hinweis schon da, bevor jemand klickt
request('/healthz');
