'use strict';

/* Weckseite (wake/) im Browser: echte Cross-Origin-Abfrage von einem zweiten Port.
 * Die Server-Adresse in wake.js wird beim Ausliefern ersetzt, der committete Code bleibt unverändert. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createServer } = require('../server');
const { browserSkip, launch, openPage } = require('./helpers');

const WAKE_DIR = path.join(__dirname, '..', 'wake');
const SHOTS = process.env.E2E_SHOTS;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

/** Liefert wake/ aus, mit SERVER auf die lokale Spiel-Adresse umgebogen. */
async function serveWake(gameUrl) {
  const srv = http.createServer((req, res) => {
    const name = req.url.split('?')[0] === '/' ? 'index.html' : path.basename(req.url.split('?')[0]);
    const file = path.join(WAKE_DIR, name);
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    let body = fs.readFileSync(file, 'utf8');
    if (name === 'wake.js') body = body.replace(/const SERVER = '[^']*';/, `const SERVER = '${gameUrl}';`);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] });
    res.end(body);
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

/** Freier Port, auf dem (noch) niemand lauscht. */
async function freePort() {
  const s = http.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

async function startGame(port, wakeOrigin) {
  const game = createServer({ testMode: true, wakeOrigin: wakeOrigin || '' });
  await game.listen(port);
  return game;
}

const shot = (page, name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, `wake-${name}.png`) }) : null);

test('Weckseite: wartet auf den gestoppten Server und leitet erst danach weiter', { skip: browserSkip(), timeout: 90000 }, async () => {
  const port = await freePort();
  const gameUrl = `http://127.0.0.1:${port}`;
  const wake = await serveWake(gameUrl);
  const browser = await launch();
  const errors = [];
  // Raum schon anlegen, der Server lauscht aber erst später
  const game = createServer({ testMode: true, wakeOrigin: wake.url });
  const code = game.rooms.create().code;
  let listening = false;
  try {
    for (const [label, viewport, isMobile] of [['390x844', { width: 390, height: 844 }, true], ['1920x1080', { width: 1920, height: 1080 }, false]]) {
      const page = await openPage(browser, wake.url, { viewport, label, errors, isMobile });
      await page.waitForFunction(() => document.querySelector('#bar-fill').style.width !== '0%');
      assert.equal(await page.textContent('#status-text'), 'Der Server startet, das dauert bis zu einer Minute.');
      await page.waitForTimeout(1500);
      await shot(page, `startet-${label}`);
      await page.context().close();
    }

    // Beitreten mit Code, solange der Server schläft: Klick wird gemerkt, keine Weiterleitung
    const page = await openPage(browser, wake.url, { viewport: { width: 390, height: 844 }, label: 'handy', errors, isMobile: true });
    await page.click('#btn-join');
    assert.equal(await page.textContent('#join-msg'), 'Bitte gib den Raumcode ein.');
    await page.fill('#join-code', 'ab');
    await page.press('#join-code', 'Enter');
    assert.equal(await page.textContent('#join-msg'), 'Der Raumcode hat 4 Buchstaben.');

    await page.fill('#join-code', '');
    await page.keyboard.insertText(` ${code.toLowerCase()} `);
    assert.equal(await page.inputValue('#join-code'), code, 'Leerzeichen entfernt, Großbuchstaben');
    await page.press('#join-code', 'Enter');
    await page.waitForSelector('#pending:not(.hidden)');
    assert.match(await page.textContent('#pending'), new RegExp(`Raum ${code}`));
    await page.waitForTimeout(4000);
    assert.equal(new URL(page.url()).origin, wake.url, 'keine Weiterleitung, solange der Server schläft');

    // Server startet (mit Freigabe für die Weckseite): Weiterleitung nach /play?room=CODE
    await game.listen(port);
    listening = true;
    await page.waitForURL(`${gameUrl}/play?room=${code}`, { timeout: 15000 });
    await page.waitForSelector('#join:not(.hidden)');
    assert.equal(await page.inputValue('#join-code'), code, 'Raumcode ist auf der Handy-Seite übernommen');
    await page.context().close();
    assert.deepEqual(errors.filter((e) => !/Failed to load resource|ERR_CONNECTION_REFUSED/.test(e)), []);
  } finally {
    await browser.close();
    if (listening) await game.close();
    else game.rooms.shutdown();
    await wake.close();
  }
});

test('Weckseite: laufender Server ist sofort bereit, Neues Spiel öffnet /board', { skip: browserSkip(), timeout: 60000 }, async () => {
  const port = await freePort();
  const gameUrl = `http://127.0.0.1:${port}`;
  const wake = await serveWake(gameUrl);
  const game = await startGame(port, wake.url);
  const browser = await launch();
  const errors = [];
  try {
    for (const [label, viewport, isMobile] of [['390x844', { width: 390, height: 844 }, true], ['1920x1080', { width: 1920, height: 1080 }, false]]) {
      const page = await openPage(browser, wake.url, { viewport, label, errors, isMobile });
      await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'ready', null, { timeout: 5000 });
      assert.equal(await page.textContent('#status-text'), 'Bereit');
      await page.waitForTimeout(700);
      await shot(page, `bereit-${label}`);
      if (!isMobile) {
        await page.click('#btn-new');
        await page.waitForURL(`${gameUrl}/board`);
        await page.waitForFunction(() => /^[A-Z]{4}$/.test(document.querySelector('#room-code').textContent));
      }
      await page.context().close();
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await game.close();
    await wake.close();
  }
});

test('Weckseite: ohne WAKE_ORIGIN greift der no-cors-Rückfall', { skip: browserSkip(), timeout: 60000 }, async () => {
  const port = await freePort();
  const gameUrl = `http://127.0.0.1:${port}`;
  const wake = await serveWake(gameUrl);
  const game = await startGame(port, '');
  const browser = await launch();
  const errors = [];
  try {
    const page = await openPage(browser, wake.url, { viewport: { width: 390, height: 844 }, label: 'handy', errors, isMobile: true });
    await page.click('#btn-new');
    await page.waitForURL(`${gameUrl}/board`, { timeout: 30000 });
    // Die CORS-Fehler vor dem Rückfall sind erwartet
    assert.ok(errors.some((e) => /CORS/.test(e)), 'CORS-Abfrage wurde blockiert');
  } finally {
    await browser.close();
    await game.close();
    await wake.close();
  }
});
