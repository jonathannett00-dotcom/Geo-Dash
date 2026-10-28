'use strict';

/*
 * Host-Token im Browser: Der Host legt über die Startseite einen Raum an (Token nur in
 * localStorage, nie in der Adresse) und steuert; ein zweites Fenster ohne Token sieht nur zu
 * (keine Host-Knöpfe); mit dem Host-Code übernimmt es die Host-Rolle, das alte Fenster wird
 * Zuschauer. Mit E2E_SHOTS=<ordner> entstehen die Bildschirmfotos für docs/.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { browserSkip, startServer, launch, openPage } = require('./helpers');

const SHOTS = process.env.E2E_SHOTS;
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
const VIEW = { width: 1920, height: 1080 };

/** Sichtbare Host-Knöpfe einer Seite (sollte beim Zuschauer leer sein). */
const visibleHostButtons = (page) => page.evaluate(() => [...document.querySelectorAll('[data-host], [data-foto], #btn-start, .lb-game, .lb-settings input, .lb-settings select')]
  .filter((el) => el.offsetParent !== null && !el.disabled && !el.closest('.hidden') && !['cancel', 'confirm'].includes(el.dataset.host))
  .map((el) => el.id || el.dataset.host || el.className));

test('Host-Token: Host steuert, zweites Fenster sieht nur zu, Übernahme per Host-Code', { skip: browserSkip(), timeout: 60000 }, async () => {
  const srv = await startServer();
  const browser = await launch();
  const errors = [];
  try {
    // Host legt den Raum über die Startseite an
    const host = await openPage(browser, `${srv.url}/`, { viewport: VIEW, label: 'host', errors });
    await host.click('#st-create');
    await host.waitForURL(/\/board\?room=[A-Z]{4}$/);
    await host.waitForFunction(() => /^[A-Z]{4}$/.test(document.querySelector('#room-code').textContent));
    const code = await host.textContent('#room-code');
    const room = srv.rooms.get(code);
    assert.equal(new URL(host.url()).search, `?room=${code}`, 'Token steht nicht in der Adresse');
    assert.equal(await host.evaluate((c) => localStorage.getItem(`spieleabend-host:${c}`), code), room.hostToken, 'Token in localStorage');
    await host.waitForSelector('#lb-hostcode');
    assert.equal((await host.textContent('#lb-hostcode')).replace(/\s/g, ''), room.hostCode, 'Lobby zeigt dem Host den Host-Code');

    // Spieler (direkt am Server) und Spielwahl durch den Host
    for (const [i, name] of ['Anna', 'Ben', 'Cem'].entries()) {
      room.join({ name, color: room.colors[i], avatar: ['ringe', 'stern', 'monogramm'][i] }).connected = true;
    }
    room.broadcast();
    await host.click('#game-poker');
    await host.waitForFunction(() => S.gameType === 'poker' && !document.querySelector('#btn-start').disabled);
    await host.waitForTimeout(900);
    await shot(host, 'host-lobby-host-code-1920x1080');

    // Zweites Fenster ohne Token: nur ansehen
    const viewer = await openPage(browser, `${srv.url}/board?room=${code}`, { viewport: VIEW, label: 'zuschauer', errors });
    await viewer.waitForSelector('#lb-host [data-viewer="claim"]');
    await viewer.waitForFunction(() => document.querySelectorAll('#lobby-players li.lb-player').length === 3);
    assert.equal(await viewer.evaluate(() => document.body.classList.contains('zuschauer')), true);
    assert.deepEqual(await visibleHostButtons(viewer), [], 'Zuschauer hat keine Host-Knöpfe');
    assert.equal(await viewer.locator('#lb-hostcode').count(), 0, 'kein Host-Code beim Zuschauer');
    assert.equal((await viewer.content()).includes(room.hostCode), false);
    assert.match(await viewer.textContent('#lobby-hint'), /Nur der Host kann/);
    await viewer.waitForTimeout(900);
    await shot(viewer, 'zuschauer-lobby-1920x1080');
    // Auch per Hand ausgelöst lehnt der Server ab
    const forced = await viewer.evaluate(() => new Promise((r) => socket.emit('board:start', {}, r)));
    assert.equal(forced.ok, false);
    assert.equal(room.started, false);

    // Der Host startet; im Spiel hat der Zuschauer kein „Spiel beenden“
    await host.click('#btn-start');
    await viewer.waitForSelector('#poker:not(.hidden)');
    await host.waitForSelector('#poker [data-host="end"]:visible');
    assert.equal(await viewer.isVisible('#poker [data-host="end"]'), false);
    assert.deepEqual(await visibleHostButtons(viewer), []);
    // Host-Menü mit Host-Code
    await host.click('#poker [data-host="code"]');
    await host.waitForSelector('#code-dialog:not(.hidden)');
    assert.equal((await host.textContent('#code-dialog-show')).replace(/\s/g, ''), room.hostCode);
    await host.click('#code-dialog [data-code="close"]');

    // Übernahme per Host-Code: erst falsch, dann richtig
    await viewer.click('#poker [data-viewer="claim"]');
    await viewer.waitForSelector('#code-dialog:not(.hidden) #code-input');
    const wrong = String((Number(room.hostCode) + 1) % 1000000).padStart(6, '0');
    await viewer.fill('#code-input', wrong);
    await viewer.click('#code-ok');
    await viewer.waitForFunction(() => /stimmt nicht/.test(document.querySelector('#code-msg').textContent));
    await viewer.fill('#code-input', room.hostCode);
    await shot(viewer, 'host-code-eingabe-1920x1080');
    const oldToken = room.hostToken;
    await viewer.click('#code-ok');
    await viewer.waitForSelector('#code-dialog.hidden', { state: 'attached' });
    await viewer.waitForSelector('#poker [data-host="end"]:visible');
    assert.notEqual(room.hostToken, oldToken, 'neues Token');
    assert.equal(await viewer.evaluate((c) => localStorage.getItem(`spieleabend-host:${c}`), code), room.hostToken);

    // Das alte Fenster ist jetzt Zuschauer und bleibt es auch nach dem Neuladen
    await host.waitForFunction(() => document.body.classList.contains('zuschauer'));
    assert.equal(await host.isVisible('#poker [data-host="end"]'), false);
    await host.reload();
    await host.waitForSelector('#poker:not(.hidden)');
    await host.waitForFunction(() => document.body.classList.contains('zuschauer'));
    assert.deepEqual(await visibleHostButtons(host), []);

    // Der neue Host beendet das Spiel
    await viewer.click('#poker [data-host="end"]');
    await viewer.click('#host-dialog [data-host="confirm"]');
    await viewer.waitForSelector('#host-after:not(.hidden)', { timeout: 20000 });
    assert.equal(room.game.isOver(), true);
    assert.equal(await host.isVisible('#host-after'), false, 'Zuschauer hat keine Knöpfe nach dem Ende');

    // Neuverbindung des Hosts nach einem Abbruch: gleiches Token, weiterhin Host
    await viewer.evaluate(() => { socket.disconnect(); socket.connect(); });
    await viewer.waitForFunction(() => socket.connected);
    await viewer.waitForSelector('#host-after:not(.hidden)');
    await viewer.click('#host-after [data-host="lobby"]');
    await viewer.waitForSelector('#lobby:not(.hidden) #lb-hostcode');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await srv.close();
  }
});
