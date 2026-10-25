'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { browserSkip, launch } = require('./helpers');

test('Alte Einzelversion (legacy/index.html, style.css, game.js) läuft weiterhin eigenständig', { skip: browserSkip(), timeout: 60000 }, async () => {
  const browser = await launch();
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    // Externe Schriftarten sind offline nicht erreichbar – das ist kein Fehler des Spiels
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    page.on('console', (m) => { if (m.type() === 'error' && !/fonts|ERR_FAILED/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(pathToFileURL(path.join(__dirname, '..', 'legacy', 'index.html')).href);
    await page.fill('#player-inputs input >> nth=0', 'Anna');
    await page.fill('#player-inputs input >> nth=1', 'Ben');
    await page.click('#setup-form button[type="submit"]');
    await page.waitForSelector('#game:not(.hidden) #track svg');
    assert.equal(await page.locator('#track .horse').count(), 6);
    await page.fill('#bet-amount', '50');
    await page.click('#bet-form button[type="submit"]');
    await page.waitForSelector('#track .horse.backed');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
