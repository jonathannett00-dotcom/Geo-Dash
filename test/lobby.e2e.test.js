'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, launch, openPage, joinRoom, noHorizontalScroll } = require('./helpers');

test('Lobby: Tablet erstellt Raum mit QR-Code, Handys treten bei und verbinden sich neu', { timeout: 60000 }, async () => {
  const srv = await startServer();
  const browser = await launch();
  const errors = [];
  try {
    const board = await openPage(browser, `${srv.url}/board`, { viewport: { width: 1024, height: 768 }, label: 'tablet', errors });
    await board.waitForFunction(() => /^[A-Z]{4}$/.test(document.querySelector('#room-code').textContent));
    const code = await board.textContent('#room-code');

    // QR-Code wird vom Server als SVG geliefert und zeigt auf /play?room=CODE
    await board.waitForFunction(() => document.querySelector('#qr').complete && document.querySelector('#qr').naturalWidth > 0);
    const joinUrl = await board.evaluate(() => fetch(`/api/join-url?room=${document.querySelector('#room-code').textContent}`).then((r) => r.json()));
    assert.equal(joinUrl.url, `${srv.url}/play?room=${code}`);

    const phones = [];
    for (const name of ['Anna', 'Ben', 'Cem']) {
      const page = await openPage(browser, `${srv.url}/play?room=${code}`, { viewport: { width: 375, height: 740 }, label: name, errors, isMobile: true });
      await joinRoom(page, name);
      phones.push(page);
    }
    await board.waitForFunction(() => document.querySelectorAll('#lobby-players li:not(.empty)').length === 3);
    assert.equal(await board.isEnabled('#btn-start'), true);

    // Doppelter Name wird abgelehnt
    const dup = await openPage(browser, `${srv.url}/play?room=${code}`, { viewport: { width: 375, height: 740 }, label: 'dup', errors, isMobile: true });
    await dup.waitForSelector('#join:not(.hidden)');
    await dup.fill('#join-name', 'anna');
    await dup.waitForSelector('#join-figures button:not([disabled])');
    await dup.click('#join-figures button:not([disabled])');
    await dup.click('#join-colors button:not([disabled])');
    await dup.click('#btn-join');
    await dup.waitForFunction(() => /schon vergeben/.test(document.querySelector('#join-msg').textContent));
    await dup.context().close();

    // Neuladen: Token aus localStorage verbindet wieder
    await phones[1].reload();
    await phones[1].waitForSelector('#app:not(.hidden)');
    assert.equal(await phones[1].textContent('#me-name'), 'Ben');

    // Startbetrag einstellen und starten
    await board.fill('#start-money', '2000');
    await board.dispatchEvent('#start-money', 'change');
    await phones[0].waitForFunction(() => document.querySelector('#me-money').textContent.includes('2.000'));
    await board.click('#btn-start');
    await board.waitForSelector('#game:not(.hidden)');

    for (const p of phones) assert.equal(await noHorizontalScroll(p), true, 'Handy ohne horizontales Scrollen');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await srv.close();
  }
});
