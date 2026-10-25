'use strict';

/*
 * Gemeinsame Helfer für die Browser-Tests (Playwright, Chromium aus CHROMIUM_PATH).
 * Playwright und der Server werden erst beim Start geladen: Fehlt Chromium,
 * überspringen die Tests, ohne Abhängigkeiten zu laden oder etwas zu starten.
 */

const fs = require('fs');

const CHROMIUM = process.env.CHROMIUM_PATH;

/** Grund zum Überspringen, falls kein Chromium da ist – sonst false (für test(…, { skip })). */
function browserSkip() {
  if (!CHROMIUM) return 'CHROMIUM_PATH fehlt (nur lokal)';
  try {
    if (fs.statSync(CHROMIUM).isFile()) return false;
  } catch (_) { /* Datei fehlt */ }
  return 'CHROMIUM_PATH fehlt (nur lokal)';
}

async function startServer(options = {}) {
  const { createServer } = require('../server');
  const instance = createServer({ testMode: true, seed: 'e2e', timeScale: 0.2, ...options });
  const port = await instance.listen(0);
  return { ...instance, url: `http://127.0.0.1:${port}` };
}

async function launch() {
  const { chromium } = require('playwright');
  return chromium.launch({ executablePath: CHROMIUM, headless: true });
}

/** Neuer Browser-Kontext mit Fehlersammlung (Konsole + Seitenfehler). */
async function openPage(browser, url, { viewport, label, errors, isMobile = false }) {
  const context = await browser.newContext({ viewport, isMobile, hasTouch: isMobile, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`[${label}] console: ${msg.text()}`); });
  page.on('pageerror', (err) => errors.push(`[${label}] pageerror: ${err.message}`));
  await page.goto(url);
  return page;
}

/** Tritt auf dem Handy einem Raum bei (Figur/Farbe = erste freie). */
async function joinRoom(page, name) {
  await page.waitForSelector('#join:not(.hidden)');
  await page.fill('#join-name', name);
  // Erst wenn der Raum bekannt ist, steht fest, ob eine Spielfigur gewählt wird (nur Monopoly)
  await page.waitForSelector('#join-form[data-game]:not([data-game=""])', { state: 'attached' });
  if (await page.isVisible('#join-figure-set')) {
    await page.waitForSelector('#join-figures button:not([disabled])');
    await page.click('#join-figures button:not([disabled])');
  }
  await page.waitForSelector('#join-colors button:not([disabled])');
  await page.click('#join-colors button:not([disabled])');
  await page.click('#btn-join');
  await page.waitForSelector('#app:not(.hidden)');
}

/** Breite ohne horizontales Scrollen? */
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

module.exports = { browserSkip, startServer, launch, openPage, joinRoom, noHorizontalScroll };
