'use strict';

/*
 * Host-Token im Browser: Der Host legt über die Startseite einen Raum an (Token nur in
 * localStorage, nie in der Adresse) und steuert; ein zweites Fenster ohne Token sieht nur zu
 * (keine Host-Knöpfe). „Host übernehmen“ wird abgelehnt, solange der Host verbunden ist (auch
 * beim kurzen Neuladen), und klappt, wenn er weg ist; das alte Fenster ist danach Zuschauer.
 * Mit E2E_SHOTS=<ordner> entstehen die Bildschirmfotos für docs/.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { browserSkip, startServer, launch, openPage } = require('./helpers');

const SHOTS = process.env.E2E_SHOTS;
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
const VIEW = { width: 1920, height: 1080 };
/** Toleranz nach einem Verbindungsabbruch – im Test kürzer als die 15 s im Betrieb. */
const GRACE_MS = 3000;

/** Sichtbare Host-Knöpfe einer Seite (sollte beim Zuschauer leer sein). */
const visibleHostButtons = (page) => page.evaluate(() => [...document.querySelectorAll('[data-host], [data-foto], #btn-start, .lb-game, .lb-settings input, .lb-settings select')]
  .filter((el) => el.offsetParent !== null && !el.disabled && !el.closest('.hidden') && !['cancel', 'confirm'].includes(el.dataset.host))
  .map((el) => el.id || el.dataset.host || el.className));

const toastText = (page) => page.evaluate(() => { const t = document.querySelector('#toast.show'); return t ? t.textContent : ''; });

test('Host-Token: Host steuert, zweites Fenster sieht nur zu, „Host übernehmen“ nur ohne verbundenen Host', { skip: browserSkip(), timeout: 60000 }, async () => {
  const srv = await startServer({ hostGraceMs: GRACE_MS });
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
    const boardUrl = `${srv.url}/board?room=${code}`;
    assert.equal(new URL(host.url()).search, `?room=${code}`, 'Token steht nicht in der Adresse');
    assert.equal(await host.evaluate((c) => localStorage.getItem(`spieleabend-host:${c}`), code), room.hostToken, 'Token in localStorage');
    await host.waitForFunction(() => /Dieses Gerät ist Host/.test(document.querySelector('#lb-host').textContent));
    assert.equal(await host.locator('[data-viewer="takeover"]:visible').count(), 0);

    // Spieler (direkt am Server) und Spielwahl durch den Host
    for (const [i, name] of ['Anna', 'Ben', 'Cem'].entries()) {
      room.join({ name, color: room.colors[i], avatar: ['ringe', 'stern', 'monogramm'][i] }).connected = true;
    }
    room.broadcast();
    await host.click('#game-poker');
    await host.waitForFunction(() => S.gameType === 'poker' && !document.querySelector('#btn-start').disabled);
    await host.waitForTimeout(900);
    await shot(host, 'host-lobby-1920x1080');

    // Zweites Fenster ohne Token: nur ansehen
    const viewer = await openPage(browser, boardUrl, { viewport: VIEW, label: 'zuschauer', errors });
    await viewer.waitForSelector('#lb-host [data-viewer="takeover"]');
    await viewer.waitForFunction(() => document.querySelectorAll('#lobby-players li.lb-player').length === 3);
    assert.equal(await viewer.evaluate(() => document.body.classList.contains('zuschauer')), true);
    assert.deepEqual(await visibleHostButtons(viewer), [], 'Zuschauer hat keine Host-Knöpfe');
    assert.match(await viewer.textContent('#lobby-hint'), /Nur der Host kann/);
    await viewer.waitForTimeout(900);
    await shot(viewer, 'zuschauer-lobby-1920x1080');
    // Auch per Hand ausgelöst lehnt der Server ab
    const forced = await viewer.evaluate(() => new Promise((r) => socket.emit('board:start', {}, r)));
    assert.equal(forced.ok, false);
    assert.equal(room.started, false);

    // Der Host startet; im Spiel hat der Zuschauer kein „Spiel beenden“, aber „Host übernehmen“
    await host.click('#btn-start');
    await viewer.waitForSelector('#poker:not(.hidden)');
    await host.waitForSelector('#poker [data-host="end"]:visible');
    assert.equal(await host.isVisible('#poker [data-viewer="takeover"]'), false);
    assert.equal(await viewer.isVisible('#poker [data-host="end"]'), false);
    assert.deepEqual(await visibleHostButtons(viewer), []);

    // Host verbunden: Übernahme abgelehnt
    await viewer.click('#poker [data-viewer="takeover"]');
    await viewer.waitForFunction(() => document.querySelector('#toast.show')?.textContent === 'Der Host ist verbunden.');
    await shot(viewer, 'host-uebernehmen-abgelehnt-1920x1080');
    assert.equal(await viewer.evaluate(() => document.body.classList.contains('zuschauer')), true);

    // Kurzes Neuladen des Hosts: in dieser Zeit verdrängt ihn niemand
    const oldToken = room.hostToken;
    const reload = host.reload();
    const during = await viewer.evaluate(() => new Promise((r) => socket.emit('host:takeover', {}, r)));
    assert.equal(during.error, 'Der Host ist verbunden.');
    await reload;
    await host.waitForSelector('#poker [data-host="end"]:visible');
    assert.equal(room.hostToken, oldToken);

    // Host-Fenster weg (Seite verlassen, localStorage bleibt): nach der Toleranz klappt die Übernahme
    await host.goto('about:blank');
    await viewer.waitForTimeout(GRACE_MS + 500);
    await viewer.click('#poker [data-viewer="takeover"]');
    await viewer.waitForSelector('#poker [data-host="end"]:visible');
    assert.notEqual(room.hostToken, oldToken, 'neues Token');
    assert.equal(await viewer.evaluate((c) => localStorage.getItem(`spieleabend-host:${c}`), code), room.hostToken);
    assert.match(await toastText(viewer), /jetzt der Host/);

    // Das alte Fenster kommt zurück: altes Token ungültig, nur Zuschauer
    await host.goto(boardUrl);
    await host.waitForSelector('#poker:not(.hidden)');
    await host.waitForFunction(() => document.body.classList.contains('zuschauer'));
    assert.match(await toastText(host), /anderes Gerät ist jetzt Host/);
    assert.deepEqual(await visibleHostButtons(host), []);
    assert.equal(await host.evaluate((c) => localStorage.getItem(`spieleabend-host:${c}`), code), null, 'altes Token gelöscht');

    // Der neue Host beendet das Spiel
    await viewer.click('#poker [data-host="end"]');
    await viewer.click('#host-dialog [data-host="confirm"]');
    await viewer.waitForSelector('#host-after:not(.hidden)', { timeout: 20000 });
    assert.equal(room.game.isOver(), true);
    assert.equal(await host.isVisible('#host-after'), false, 'Zuschauer hat keine Knöpfe nach dem Ende');
    await viewer.click('#host-after [data-host="lobby"]');
    await viewer.waitForSelector('#lobby:not(.hidden)');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await srv.close();
  }
});
