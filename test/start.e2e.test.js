'use strict';

/*
 * Öffentliche Startseite im Browser: „Neues Spiel starten“ legt einen Raum an und
 * öffnet die Host-Lobby, „Spiel beitreten“ führt mit dem Raumcode zum Handy-Beitritt.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { browserSkip, startServer, launch, openPage, joinRoom, noHorizontalScroll } = require('./helpers');

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
    await phone.fill('#st-code', 'ZZZZ');
    await phone.click('#st-join');
    await phone.waitForFunction(() => /gibt es nicht/.test(document.querySelector('#st-msg').textContent));
    await phone.fill('#st-code', code.toLowerCase());
    assert.equal(await phone.inputValue('#st-code'), code, 'Code wird groß geschrieben');
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
