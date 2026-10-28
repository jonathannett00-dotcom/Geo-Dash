'use strict';

/*
 * Öffentliche Startseite im Browser: „Neues Spiel starten“ legt einen Raum an und
 * öffnet die Host-Lobby, „Spiel beitreten“ führt mit dem Raumcode zum Handy-Beitritt.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { browserSkip, startServer, launch, openPage, joinRoom, noHorizontalScroll } = require('./helpers');

/** Raumcode in die vier Felder tippen (ersetzt den alten Inhalt). */
async function typeCode(page, code) {
  await page.click('#st-code-1');
  await page.keyboard.type(code);
}
const codeValue = (page) => page.evaluate(() => [...document.querySelectorAll('#st-code .st-cell')].map((c) => c.value).join(''));

test('Startseite: Raum anlegen, Beitritt per Code, Meldung bei unbekanntem Code', { skip: browserSkip(), timeout: 60000 }, async () => {
  const srv = await startServer();
  const browser = await launch();
  const errors = [];
  try {
    const host = await openPage(browser, `${srv.url}/`, { viewport: { width: 1366, height: 768 }, label: 'start', errors });
    assert.equal(await host.textContent('h1'), 'Spieleabend');
    await host.click('#st-create');
    await host.waitForURL(/\/board\?room=[A-Z]{4}$/);
    await host.waitForFunction(() => /^[A-Z]{4}$/.test(document.querySelector('#room-code').textContent));
    const code = await host.textContent('#room-code');
    assert.equal(new URL(host.url()).searchParams.get('room'), code, 'Lobby zeigt den angelegten Raum');
    assert.equal(srv.rooms.size, 1, 'genau ein Raum angelegt');

    const phone = await openPage(browser, `${srv.url}/`, { viewport: { width: 390, height: 844 }, label: 'handy', errors, isMobile: true });
    await typeCode(phone, 'ZZZZ');
    await phone.click('#st-join');
    await phone.waitForFunction(() => /gibt es nicht/.test(document.querySelector('#st-code-msg').textContent));
    await typeCode(phone, code.toLowerCase());
    assert.equal(await codeValue(phone), code, 'Code wird groß geschrieben');
    assert.equal(await noHorizontalScroll(phone), true, 'Startseite am Handy ohne horizontales Scrollen');
    await phone.click('#st-join');
    await phone.waitForURL(new RegExp(`/play\\?room=${code}$`));
    assert.equal(await phone.inputValue('#join-code'), code);
    await joinRoom(phone, 'Anna');
    await host.waitForFunction(() => document.querySelectorAll('#lobby-players li:not(.empty)').length === 1);
    assert.match(await host.textContent('#lobby-hint'), /Noch 1 Spieler fehlt/);

    // Server startet noch (Antwort dauert länger als 3 s): ruhiger Hinweis, danach wieder weg
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const slow = await ctx.newPage();
    slow.on('pageerror', (err) => errors.push(`[langsam] ${err.message}`));
    await slow.route('**/healthz', async (route) => { await new Promise((r) => setTimeout(r, 3600)); await route.continue(); });
    await slow.goto(`${srv.url}/`);
    assert.equal(await slow.isVisible('#st-wait'), false, 'nicht sofort');
    await slow.waitForSelector('#st-wait', { state: 'visible', timeout: 5000 });
    assert.match(await slow.textContent('#st-wait'), /Der Server startet, das dauert bis zu einer Minute\./);
    await slow.waitForSelector('#st-wait', { state: 'hidden', timeout: 5000 });
    await ctx.close();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await srv.close();
  }
});

test('Startseite: Raumcode-Felder, Größen, Rückfall ohne Punktdatei', { skip: browserSkip(), timeout: 60000 }, async () => {
  const srv = await startServer();
  const browser = await launch();
  const errors = [];
  try {
    const phone = await openPage(browser, `${srv.url}/`, { viewport: { width: 390, height: 844 }, label: 'felder', errors, isMobile: true });
    // Tippen springt weiter, Kleinbuchstaben werden groß, Ziffern ignoriert
    await phone.click('#st-code-1');
    await phone.keyboard.type('a1b');
    assert.equal(await codeValue(phone), 'AB');
    assert.equal(await phone.evaluate(() => document.activeElement.id), 'st-code-3');
    // Rücktaste im leeren Feld springt zurück und löscht dort
    await phone.keyboard.press('Backspace');
    assert.equal(await phone.evaluate(() => document.activeElement.id), 'st-code-2');
    assert.equal(await codeValue(phone), 'A');
    // Einfügen aus der Zwischenablage verteilt auf alle Felder
    const paste = (text) => phone.evaluate((t) => {
      const dt = new DataTransfer(); dt.setData('text', t);
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, text);
    await paste(' wx-yz ');
    assert.equal(await codeValue(phone), 'WXYZ');
    assert.equal(await phone.evaluate(() => document.activeElement.id), 'st-code-4');
    await paste('123');
    assert.match(await phone.textContent('#st-code-msg'), /nur aus Buchstaben/);
    // Unvollständig: Fehler am Feld
    await phone.click('#st-code-4');
    await phone.keyboard.press('Delete');
    await phone.click('#st-join');
    assert.match(await phone.textContent('#st-code-msg'), /4 Buchstaben/);
    assert.equal(await phone.getAttribute('#st-code', 'aria-invalid'), 'true');
    assert.equal(await phone.evaluate(() => document.activeElement.id), 'st-code-4');
    assert.equal(await phone.getAttribute('#st-code-1', 'inputmode'), 'text');
    assert.equal(await phone.getAttribute('#st-code-1', 'autocapitalize'), 'characters');

    // Alle Größen: kein horizontales Scrollen, Szenen gezeichnet, Ziele am Handy groß genug
    for (const [width, height] of [[390, 844], [1024, 768], [1366, 768], [1920, 1080]]) {
      const page = await openPage(browser, `${srv.url}/`, { viewport: { width, height }, label: `${width}`, errors, isMobile: width < 500 });
      await page.waitForFunction(() => document.querySelectorAll('.st-game.st-has-canvas').length === 3);
      assert.equal(await noHorizontalScroll(page), true, `${width}x${height} ohne horizontales Scrollen`);
      if (width < 500) {
        const small = await page.evaluate(() => [...document.querySelectorAll('button, a, input')].filter((e) => { const r = e.getBoundingClientRect(); return r.height < 44 || r.width < 44; }).map((e) => e.id));
        assert.deepEqual(small, [], 'Zielgröße mindestens 44 px');
      }
      await page.context().close();
    }

    // Punktdatei fehlt, reduzierte Bewegung: Seite lädt ohne Fehler mit Standbildern
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: 'reduce' });
    const still = await ctx.newPage();
    const own = [];
    still.on('pageerror', (err) => own.push(err.message));
    await still.route('**/globe-points.json', (route) => route.fulfill({ status: 404, body: '' }));
    await still.goto(`${srv.url}/`);
    await still.waitForFunction(() => document.querySelectorAll('.st-game.st-has-canvas').length === 2);
    assert.equal(await still.evaluate(() => window.stHintergrund.running), false, 'keine Bewegung bei reduzierter Bewegung');
    assert.equal(await still.evaluate(() => document.querySelector('.st-game[data-game="risiko"]').classList.contains('st-has-canvas')), false);
    assert.deepEqual(own, []);
    await ctx.close();
    assert.deepEqual(errors, [], 'keine Konsolenfehler');
  } finally {
    await browser.close();
    await srv.close();
  }
});
