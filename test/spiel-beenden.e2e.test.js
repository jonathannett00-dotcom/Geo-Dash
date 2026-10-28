'use strict';

/*
 * Spiel beenden im Browser: Der Host drückt „Spiel beenden“, bricht einmal ab, bestätigt
 * dann mit „Ja, beenden“. Die Handys zeigen „Das Spiel wurde beendet“ mit Endstand, der
 * Fernseher den Poker-Endstand und die Knöpfe „Zurück zur Lobby“ und „Raum schließen“.
 * Danach zurück in die Lobby, ein neues Spiel, wieder beenden und den Raum schließen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { browserSkip, startServer, launch, openPage, joinRoom } = require('./helpers');

const SHOTS = process.env.E2E_SHOTS;
const [SCREEN_W, SCREEN_H] = (process.env.E2E_SCREEN || '1024x768').split('x').map(Number);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
const until = (page, fn, arg, timeout = 20000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });

test('Spiel beenden: Bestätigung am Fernseher, Endstand auf den Handys, Lobby und Raum schließen', { skip: browserSkip(), timeout: 120000 }, async () => {
  const srv = await startServer();
  const browser = await launch();
  const errors = [];
  try {
    const board = await openPage(browser, `${srv.url}/board`, { viewport: { width: SCREEN_W, height: SCREEN_H }, label: 'tablet', errors });
    await board.waitForFunction(() => /^[A-Z]{4}$/.test(document.querySelector('#room-code').textContent));
    const code = await board.textContent('#room-code');
    await board.click('#game-poker');
    await until(board, () => S.gameType === 'poker');
    const phones = {};
    for (const name of ['Anna', 'Ben', 'Cem']) {
      phones[name] = await openPage(browser, `${srv.url}/play?room=${code}`, { viewport: { width: 390, height: 844 }, label: name, errors, isMobile: true });
      await joinRoom(phones[name], name);
    }
    await board.waitForFunction(() => !document.querySelector('#btn-start').disabled);
    await board.click('#btn-start');
    await board.waitForSelector('#poker:not(.hidden)');
    const room = srv.rooms.get(code);
    // Etwas spielen, damit Geld im Pot liegt
    const g = room.game;
    room.act(g.actor().id, { type: 'call' });
    room.broadcast();

    // Handys haben keinen Knopf zum Beenden
    for (const page of Object.values(phones)) assert.equal(await page.locator('[data-host="end"]').count(), 0);

    /* ---------- Beenden: erst abbrechen, dann bestätigen ---------- */
    const endBtn = board.locator('#poker [data-host="end"]');
    await endBtn.waitFor({ state: 'visible' });
    await endBtn.click();
    await board.waitForSelector('#host-dialog:not(.hidden)');
    assert.equal(await board.textContent('#host-dialog-title'), 'Spiel wirklich beenden?');
    await shot(board, `spiel-beenden-dialog-${SCREEN_W}x${SCREEN_H}`);
    await board.click('#host-dialog [data-host="cancel"]');
    await board.waitForSelector('#host-dialog.hidden', { state: 'attached' });
    assert.equal(room.game.isOver(), false, 'Abbrechen beendet nichts');
    await endBtn.click();
    await board.click('#host-dialog [data-host="confirm"]');
    await until(board, () => S.final && S.final.reason === 'host');
    assert.equal(room.game.isOver(), true);

    /* ---------- Endstand ---------- */
    for (const [name, page] of Object.entries(phones)) {
      await page.waitForSelector('#panel-final:not(.hidden) .es-table', { timeout: 20000 });
      assert.match(await page.textContent('#panel-final'), /Das Spiel wurde beendet/, name);
      assert.match(await page.textContent('#panel-final'), /Gewinn\/Verlust/, name);
      assert.equal(await page.locator('#panel-final tbody tr').count(), 3, name);
    }
    await shot(phones.Anna, 'poker-handy-endstand-390x844');
    await board.waitForSelector('#pkt-final:not(.hidden) .es-table');
    await board.waitForSelector('#host-after:not(.hidden)');
    assert.match(await board.textContent('#pkt-final'), /Spiel vom Host beendet/);
    await shot(board, `poker-endstand-${SCREEN_W}x${SCREEN_H}`);
    assert.equal(await board.locator('#poker [data-host="end"]').isVisible(), false, 'kein Beenden mehr nach dem Ende');

    /* ---------- Zurück zur Lobby ---------- */
    await board.click('#host-after [data-host="lobby"]');
    await board.waitForSelector('#lobby:not(.hidden)');
    await until(board, () => !S.started && S.lobby.length === 3);
    for (const page of Object.values(phones)) await page.waitForSelector('#panel-wait:not(.hidden)');
    assert.equal(await board.isVisible('#host-after'), false);

    /* ---------- Neues Spiel, beenden, Raum schließen ---------- */
    await board.click('#game-risiko');
    await until(board, () => S.gameType === 'risiko');
    await board.click('#btn-start');
    await board.waitForSelector('#risiko:not(.hidden)');
    await board.click('#risiko [data-host="end"]');
    await board.click('#host-dialog [data-host="confirm"]');
    await board.waitForSelector('#rk-final:not(.hidden)');
    assert.match(await board.textContent('#rk-final'), /Spiel vom Host beendet/);
    assert.match(await board.textContent('#rk-final'), /Gebiete/);
    await board.waitForSelector('#host-after:not(.hidden)');
    await board.click('#host-after [data-host="close"]');
    assert.equal(await board.textContent('#host-dialog-title'), 'Raum wirklich schließen?');
    await board.click('#host-dialog [data-host="confirm"]');
    await board.waitForURL(/\/\?fehler=/);
    assert.equal(srv.rooms.get(code), undefined, 'Raum ist gelöscht');
    for (const page of Object.values(phones)) {
      await page.waitForSelector('#join:not(.hidden)');
      assert.match(await page.textContent('#join-msg'), /Raum wurde geschlossen/);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await srv.close();
  }
});
