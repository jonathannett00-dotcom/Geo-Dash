'use strict';

/* Gemeinsame Helfer für die Browser-Tests (Playwright, Chromium aus /opt/pw-browsers). */

const { chromium } = require('playwright');
const { createServer } = require('../server');

const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

async function startServer(options = {}) {
  const instance = createServer({ testMode: true, seed: 'e2e', timeScale: 0.2, ...options });
  const port = await instance.listen(0);
  return { ...instance, url: `http://127.0.0.1:${port}` };
}

async function launch() {
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
  await page.waitForSelector('#join-figures button:not([disabled])');
  await page.click('#join-figures button:not([disabled])');
  await page.click('#join-colors button:not([disabled])');
  await page.click('#btn-join');
  await page.waitForSelector('#app:not(.hidden)');
}

/** Breite ohne horizontales Scrollen? */
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

module.exports = { startServer, launch, openPage, joinRoom, noHorizontalScroll };
