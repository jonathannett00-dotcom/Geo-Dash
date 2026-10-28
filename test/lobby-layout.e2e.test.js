'use strict';

/*
 * Host-Lobby im Browser: Raster ohne Überlappung und ohne Scrollen für 0, 4, 8 und 12
 * Spieler, jedes Spiel gewählt, in 1920×1080, 1366×768 und 1024×768. Dazu der Beitritt
 * am Handy (390×844). Mit E2E_SHOTS=<ordner> entstehen die Bildschirmfotos für docs/.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { browserSkip, startServer, launch, openPage, noHorizontalScroll } = require('./helpers');

const SHOTS = process.env.E2E_SHOTS;
const SCREENS = [[1920, 1080], [1366, 768], [1024, 768]];
const NAMES = ['Anna', 'Ben', 'Cem', 'Dora', 'Emil', 'Fiona', 'Gustav', 'Hanna', 'Ilias', 'Jule', 'Konstantin', 'Lea'];

/** Prüft das Raster im Browser und liefert eine Liste der Fehler (leer = in Ordnung). */
function measure() {
  const W = window.innerWidth; const H = window.innerHeight;
  const out = [];
  const r = (el) => el.getBoundingClientRect();
  const name = (el) => el.id ? `#${el.id}` : `.${[...el.classList].join('.')}`;
  const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
  const inside = (a, b) => a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
  const shown = (el) => el && el.offsetParent !== null && r(el).width > 0;

  if (document.documentElement.scrollWidth > W) out.push('horizontales Scrollen');
  if (document.documentElement.scrollHeight > H) out.push('vertikales Scrollen');

  const blocks = ['.lb-head', '.lb-codecard', '.lb-qrcard', '.lb-playercard', '.lb-setup > .lb-label', '#game-choice', '.lb-settings', '.lb-startrow']
    .map((s) => document.querySelector(s));
  blocks.forEach((el, i) => {
    if (!shown(el)) { out.push(`fehlt: ${i}`); return; }
    const a = r(el);
    if (a.left < -0.5 || a.top < -0.5 || a.right > W + 0.5 || a.bottom > H + 0.5) out.push(`außerhalb: ${name(el)}`);
    if (el.scrollHeight > el.clientHeight + 1) out.push(`Inhalt läuft über: ${name(el)}`);
    blocks.slice(i + 1).forEach((other) => { if (shown(other) && overlap(a, r(other))) out.push(`Überlappung: ${name(el)} / ${name(other)}`); });
  });

  // Raumcode, QR-Code und Adresse in ihren Karten
  const code = document.querySelector('#room-code');
  if (!inside(r(code), r(document.querySelector('.lb-codecard'))) || code.scrollWidth > code.clientWidth + 1) out.push('Raumcode passt nicht');
  ['#qr', '#join-url'].forEach((s) => { if (!inside(r(document.querySelector(s)), r(document.querySelector('.lb-qrcard')))) out.push(`${s} außerhalb der Karte`); });

  // Spielerkarten: im Raster, untereinander frei
  const list = document.querySelector('#lobby-players');
  const items = [...list.children];
  items.forEach((li, i) => {
    const a = r(li);
    if (!inside(a, r(list))) out.push(`Spieler ${i + 1} außerhalb der Liste`);
    if (a.height < 20) out.push(`Spieler ${i + 1} zu klein`);
    items.slice(i + 1).forEach((other, k) => { if (overlap(a, r(other))) out.push(`Spieler ${i + 1} / ${i + k + 2} überlappen`); });
    [...li.children].forEach((c) => { if (!inside(r(c), a)) out.push(`Spieler ${i + 1}: Inhalt ragt heraus`); });
  });

  // Spielkarten: Glas-Karte ganz sichtbar, Plakette „Gewählt“ nicht darüber
  [...document.querySelectorAll('.lb-game')].forEach((g) => {
    const card = g.querySelector('.lb-game-card');
    const gr = r(g);
    if (!inside(r(card), gr)) out.push(`${g.id}: Text ragt heraus`);
    if (card.scrollHeight > card.clientHeight + 1) out.push(`${g.id}: Text läuft über`);
    const badge = g.querySelector('.lb-game-state');
    if (g.classList.contains('sel') && overlap(r(badge), r(card))) out.push(`${g.id}: Plakette über dem Text`);
  });

  // Einstellungen: Felder in der Karte, untereinander frei
  const settings = document.querySelector('.lb-settings');
  const fields = [...settings.querySelectorAll('.lb-field, .lb-note, .lb-group-title')].filter(shown);
  fields.forEach((f, i) => {
    if (!inside(r(f), r(settings))) out.push(`Einstellung außerhalb: ${f.textContent.trim().slice(0, 20)}`);
    fields.slice(i + 1).forEach((o) => { if (overlap(r(f), r(o))) out.push(`Einstellungen überlappen: ${f.textContent.trim().slice(0, 15)} / ${o.textContent.trim().slice(0, 15)}`); });
  });
  const hint = document.querySelector('#lobby-hint');
  if (hint.scrollWidth > hint.clientWidth + 1) out.push('Hinweis unter dem Start-Knopf abgeschnitten');
  return out;
}

test('Lobby-Raster: 0, 4, 8 und 12 Spieler, alle Spiele, drei Auflösungen ohne Überlappung', { skip: browserSkip(), timeout: 60000 }, async () => {
  const srv = await startServer();
  const browser = await launch();
  const errors = [];
  try {
    const [w0, h0] = SCREENS[0];
    const board = await openPage(browser, `${srv.url}/board`, { viewport: { width: w0, height: h0 }, label: 'lobby', errors });
    await board.waitForFunction(() => /^[A-Z]{4}$/.test(document.querySelector('#room-code').textContent));
    const code = await board.textContent('#room-code');
    await board.waitForFunction(() => document.querySelector('#qr').complete && document.querySelector('#qr').naturalWidth > 0);
    await board.waitForFunction(() => document.querySelector('#join-url').textContent.length > 0);

    // Spieler treten über eigene Verbindungen bei (schneller als zwölf Handy-Seiten)
    const helper = await openPage(browser, `${srv.url}/play?room=${code}`, { viewport: { width: 390, height: 844 }, label: 'helfer', errors });
    await helper.waitForFunction(() => typeof io === 'function');
    // Gemischt: Motive, Monogramm und bei jedem dritten Spieler ein eigenes Foto (wie am Handy erzeugt)
    const addPlayers = (names) => helper.evaluate(async ({ names, code }) => {
      window.extra = window.extra || [];
      for (const name of names) {
        const s = io({ forceNew: true });
        const n = window.extra.length;
        window.extra.push(s);
        const info = await new Promise((res) => s.emit('room:info', { code }, res));
        const takenC = new Set(info.lobby.map((p) => p.color));
        const color = info.colors.find((c) => !takenC.has(c));
        const avatar = AV_IDS[(n * 7) % AV_IDS.length];
        const res = await new Promise((r) => s.emit('player:join', { code, name, color, avatar }, r));
        if (!res.ok) throw new Error(res.error);
        if (n % 3 === 1) {
          const c = document.createElement('canvas');
          c.width = 128; c.height = 128;
          const g = c.getContext('2d');
          g.fillStyle = `hsl(${n * 47}, 45%, 62%)`; g.fillRect(0, 0, 128, 128);
          g.fillStyle = `hsl(${n * 47 + 180}, 35%, 30%)`; g.beginPath(); g.arc(64, 54, 26, 0, Math.PI * 2); g.fill();
          g.fillRect(28, 88, 72, 50);
          const blob = await fotoKodieren(c);
          const up = await new Promise((r) => s.emit('avatar:foto', { foto: blob }, r));
          if (!up.ok) throw new Error(up.error);
        }
      }
    }, { names, code });

    const choose = async (game) => {
      await board.click(`#game-${game}`);
      await board.waitForFunction((g) => S.gameType === g && document.querySelector(`#game-${g}`).classList.contains('sel'), game);
    };
    const settle = () => board.waitForTimeout(900); // Eingang, Auswahlwechsel und Hineingleiten sind dann fertig
    const check = async (label, shotName) => {
      for (const [w, h] of SCREENS) {
        await board.setViewportSize({ width: w, height: h });
        await settle();
        const problems = await board.evaluate(measure);
        assert.deepEqual(problems, [], `${label} bei ${w}×${h}`);
        if (SHOTS && shotName) await board.screenshot({ path: path.join(SHOTS, `${shotName}-${w}x${h}.png`) });
      }
    };

    const count = () => board.evaluate(() => document.querySelectorAll('#lobby-players li:not(.empty)').length);
    await check('leer, Monopoly', 'lobby-leer');
    await choose('risiko'); await check('leer, Risiko', 'lobby-risiko');
    await choose('poker'); await check('leer, Poker', 'lobby-poker');
    await choose('monopoly');

    await addPlayers(NAMES.slice(0, 4));
    await board.waitForFunction(() => document.querySelectorAll('#lobby-players li:not(.empty)').length === 4);
    assert.match(await board.textContent('#lobby-count'), /4\s*von 10/);
    assert.equal(await board.isEnabled('#btn-start'), true);
    await check('4 Spieler, Monopoly', 'lobby-4-spieler');
    await choose('risiko'); await check('4 Spieler, Risiko');
    await choose('poker'); await check('4 Spieler, Poker');
    await choose('monopoly');

    await addPlayers(NAMES.slice(4, 8));
    await board.waitForFunction(() => document.querySelectorAll('#lobby-players li:not(.empty)').length === 8);
    // Fotos sind geladen (nie ein kaputtes Bild)
    await board.waitForFunction(() => [...document.querySelectorAll('#lobby-players .av-foto')].length === 3
      && [...document.querySelectorAll('#lobby-players .av-foto')].every((i) => i.complete && i.naturalWidth === 128));
    await check('8 Spieler, Monopoly, gemischte Avatare und Fotos', 'lobby-8-spieler-avatare');
    await choose('poker'); await check('8 Spieler, Poker');

    await addPlayers(NAMES.slice(8, 12));
    await board.waitForFunction(() => document.querySelectorAll('#lobby-players li:not(.empty)').length === 12);
    assert.equal(await count(), 12);
    assert.match(await board.textContent('#lobby-count'), /12\s*von 12/);
    await check('12 Spieler, Poker', 'lobby-12-spieler');

    // Zu wenige Spieler: Start gesperrt mit klarer Meldung
    const fresh = await openPage(browser, `${srv.url}/board?room=`, { viewport: { width: 1366, height: 768 }, label: 'neu', errors });
    await fresh.waitForFunction(() => /^[A-Z]{4}$/.test(document.querySelector('#room-code').textContent));
    assert.equal(await fresh.isEnabled('#btn-start'), false);
    assert.match(await fresh.textContent('#lobby-hint'), /Noch 2 Spieler fehlen/);

    // Beitritt am Handy im gleichen Design
    const phone = await openPage(browser, `${srv.url}/play?room=${code}`, { viewport: { width: 390, height: 844 }, label: 'handy', errors, isMobile: true });
    await phone.waitForSelector('#join:not(.hidden)');
    await phone.waitForSelector('#join-form[data-game="poker"]', { state: 'attached' });
    await phone.waitForTimeout(900);
    assert.equal(await noHorizontalScroll(phone), true, 'Beitritt ohne horizontales Scrollen');
    assert.match(await phone.textContent('#join-game'), /Poker · 12 von 12/);
    if (SHOTS) await phone.screenshot({ path: path.join(SHOTS, 'handy-beitritt-voll-390x844.png') });
    await phone.context().close();

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await srv.close();
  }
});

test('Beitritt am Handy: Avatar wählen, Design ohne Scrollen', { skip: browserSkip(), timeout: 60000 }, async () => {
  const srv = await startServer();
  const browser = await launch();
  const errors = [];
  try {
    const board = await openPage(browser, `${srv.url}/board`, { viewport: { width: 1024, height: 768 }, label: 'tablet', errors });
    await board.waitForFunction(() => /^[A-Z]{4}$/.test(document.querySelector('#room-code').textContent));
    const code = await board.textContent('#room-code');
    const phone = await openPage(browser, `${srv.url}/play?room=${code}`, { viewport: { width: 390, height: 844 }, label: 'handy', errors, isMobile: true });
    await phone.waitForSelector('#join-form[data-game="monopoly"]', { state: 'attached' });
    await phone.fill('#join-name', 'Anna');
    await phone.click('#join-figures button:not([disabled])');
    await phone.click('#join-colors button:not([disabled])');
    await phone.waitForTimeout(900);
    assert.equal(await noHorizontalScroll(phone), true);
    if (SHOTS) await phone.screenshot({ path: path.join(SHOTS, 'handy-beitritt-390x844.png') });
    await phone.click('#btn-join');
    await phone.waitForSelector('#app:not(.hidden)');
    await board.waitForFunction(() => document.querySelector('#lobby-players li.lb-player .av svg'));

    // Risiko: anderes Design-Thema, Avatar-Wahl wie bei jedem Spiel
    await board.click('#game-risiko');
    const phone2 = await openPage(browser, `${srv.url}/play?room=${code}`, { viewport: { width: 390, height: 844 }, label: 'handy2', errors, isMobile: true });
    await phone2.waitForSelector('#join-form[data-game="risiko"]', { state: 'attached' });
    assert.equal(await phone2.isVisible('#join-figure-set'), true);
    assert.equal(await phone2.locator('#join-figures button').count(), 25, '24 Motive und Monogramm');
    await phone2.waitForTimeout(900);
    assert.equal(await noHorizontalScroll(phone2), true);
    if (SHOTS) await phone2.screenshot({ path: path.join(SHOTS, 'handy-beitritt-risiko-390x844.png') });

    // Reduzierte Bewegung: Standbilder statt Animation, Lobby trotzdem vollständig
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: 'reduce' });
    const still = await ctx.newPage();
    still.on('pageerror', (err) => errors.push(`[still] ${err.message}`));
    still.on('console', (msg) => { if (msg.type() === 'error') errors.push(`[still] ${msg.text()}`); });
    await still.goto(`${srv.url}/board?room=${code}`);
    await still.waitForFunction(() => document.querySelectorAll('.lb-game.st-has-canvas').length === 3);
    assert.equal(await still.evaluate(() => window.stHintergrund.running), false, 'keine Bewegung bei reduzierter Bewegung');
    await ctx.close();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await srv.close();
  }
});
