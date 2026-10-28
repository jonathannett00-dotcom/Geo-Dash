'use strict';

/*
 * Gemeinsamer Ablauf für die Browser-Prüfung des Poker-Tisches
 * (poker-layout.e2e.test.js: 2, 3, 6 Spieler; poker-layout-viele.e2e.test.js: 9, 12 Spieler).
 * Poker-Tisch im Browser vermessen: Sperrzonen (Kartenring, Blinds-Feld, Pot-Feld,
 * Handname) dürfen von keinem Platz, Einsatz, Dealer-Button oder fliegenden Chip
 * berührt werden; Plätze, Einsätze und Button überlappen sich auch untereinander
 * nicht. Gemessen wird mit getBoundingClientRect in 1920x1080, 1366x768 und
 * 1024x768 für 2, 3, 6, 9 und 12 Spieler in allen Phasen einer Runde (Pre-Flop,
 * Flop, Turn, River, Showdown) und mitten im Flug der Chips in den Pot.
 * Zusätzlich werden alle vorberechneten Positionen von Einsätzen und Dealer-Button
 * (für jeden Platz) gegen die gemessenen Elemente geprüft.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { browserSkip, startServer, launch } = require('./helpers');
const { AV_IDS } = require('../public/shared/avatare');

const SCREENS = [[1920, 1080], [1366, 768], [1024, 768]];
const NAMES = ['Anna', 'Ben', 'Cem', 'Dana', 'Eli', 'Finn', 'Gina', 'Hugo', 'Ida', 'Jan', 'Kai', 'Lea'];

/** Läuft im Browser: alle Überlappungen als Texte. */
function measure() {
  const tol = 0.5;
  const R = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  const union = (els) => {
    const rs = els.map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height);
    if (!rs.length) return null;
    const x = Math.min(...rs.map((r) => r.left)); const y = Math.min(...rs.map((r) => r.top));
    return { x, y, w: Math.max(...rs.map((r) => r.right)) - x, h: Math.max(...rs.map((r) => r.bottom)) - y };
  };
  const hit = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > tol && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > tol;
  const table = R(document.getElementById('pkt-table').getBoundingClientRect());
  const zones = ['pkt-ring', 'pkt-blinds', 'pkt-potbox', 'pkt-name'].map((id) => {
    const el = document.getElementById(id);
    return { id, r: union([el, ...el.querySelectorAll('*')]) };
  }).filter((z) => z.r);
  const items = [];
  for (const el of document.querySelectorAll('.pkt-seat')) items.push({ id: `Platz ${el.id.slice(6)}`, r: union([el, ...el.querySelectorAll('*')]) });
  for (const el of document.querySelectorAll('.pkt-bet:not(.hidden)')) items.push({ id: `Einsatz ${el.id.slice(6)}`, r: union([el, ...el.querySelectorAll('*')]) });
  const dealer = document.querySelector('#pkt-dealer:not(.hidden)');
  if (dealer) items.push({ id: 'Dealer-Button', r: R(dealer.getBoundingClientRect()) });
  // Vorberechnete Positionen aller Dealer-Buttons und Einsätze (für jeden Platz)
  const g = pkGeom;
  const abs = (r) => ({ x: r.x + table.x, y: r.y + table.y, w: r.w, h: r.h });
  const slots = [...g.dealers.map((r, i) => ({ id: `Dealer-Platz ${i + 1}`, r: abs(r) })), ...g.bets.map((r, i) => ({ id: `Einsatz-Platz ${i + 1}`, r: abs(r) }))];
  const out = [];
  for (const it of [...items, ...slots]) {
    if (!it.r) continue;
    if (it.r.x < table.x - tol || it.r.y < table.y - tol || it.r.x + it.r.w > table.x + table.w + tol || it.r.y + it.r.h > table.y + table.h + tol) out.push(`${it.id} ragt aus dem Tisch`);
    for (const z of zones) if (hit(it.r, z.r)) out.push(`${it.id} in Sperrzone ${z.id}`);
  }
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (items[i].r && items[j].r && hit(items[i].r, items[j].r)) out.push(`${items[i].id} × ${items[j].id}`);
  const seatsAndBets = items.filter((it) => it.id.startsWith('Platz') || it.id.startsWith('Einsatz'));
  for (const s of g.dealers.map((r, i) => ({ id: `Dealer-Platz ${i + 1}`, r: abs(r) }))) {
    for (const it of seatsAndBets) if (hit(s.r, it.r)) out.push(`${s.id} × ${it.id}`);
  }
  // Namensschilder mit Avatar: Avatar, Name und Guthaben im Schild und nicht übereinander
  for (const plate of document.querySelectorAll('.pkt-plate')) {
    const pr = R(plate.getBoundingClientRect());
    const inside = (r) => r.x >= pr.x - tol && r.y >= pr.y - tol && r.x + r.w <= pr.x + pr.w + tol && r.y + r.h <= pr.y + pr.h + tol;
    const parts = ['.av', '.pkt-nm', '.pkt-stack', '.pk-seat'].map((sel) => ({ sel, el: plate.querySelector(sel) })).filter((x) => x.el);
    if (!plate.querySelector('.av')) out.push('Namensschild ohne Avatar');
    for (const { sel, el } of parts) if (!inside(R(el.getBoundingClientRect()))) out.push(`Namensschild: ${sel} ragt heraus`);
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
      if (hit(R(parts[i].el.getBoundingClientRect()), R(parts[j].el.getBoundingClientRect()))) out.push(`Namensschild: ${parts[i].sel} × ${parts[j].sel}`);
    }
  }
  // Fliegende Chips: nie über Gemeinschaftskarten oder Blinds-Feld (der Pot ist ihr Ziel)
  for (const chip of document.querySelectorAll('.pkt-chip.flying')) {
    const r = R(chip.getBoundingClientRect());
    for (const z of zones.filter((x) => x.id === 'pkt-ring' || x.id === 'pkt-blinds')) if (hit(r, z.r)) out.push(`fliegender Chip in Sperrzone ${z.id}`);
  }
  return out;
}

/** Prüfung für n Spieler als node:test-Test anmelden. */
function layoutTest(n) {
  test(`Poker-Tisch: ${n} Spieler ohne Überlappung in allen Phasen und drei Auflösungen`, { skip: browserSkip(), timeout: 60000 }, async () => {
    const srv = await startServer({ timeScale: 0.25 });
    const browser = await launch();
    const errors = [];
    try {
      const pages = [];
      for (const [width, height] of SCREENS) {
        const page = await (await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })).newPage();
        page.on('pageerror', (e) => errors.push(`${width}x${height}: ${e.message}`));
        pages.push({ page, label: `${width}x${height}` });
      }
      const first = pages[0].page;
      await first.goto(`${srv.url}/board`);
      await first.waitForFunction(() => /^[A-Z]{4}$/.test(document.querySelector('#room-code').textContent));
      const code = await first.textContent('#room-code');
      const room = srv.rooms.get(code);
      room.setGameType('poker');
      for (const { page } of pages.slice(1)) await page.goto(`${srv.url}/board?room=${code}`);
      for (let i = 0; i < n; i++) {
        // Gemischte Avatare (Motive und Monogramm)
        const p = room.join({ name: NAMES[i], color: room.colors[i], avatar: AV_IDS[(i * 5) % AV_IDS.length] });
        p.connected = true;
      }
      room.start();
      room.broadcast();
      const game = () => room.game;
      const act = (action) => { room.act(game().actor().id, action); room.touch(); room.broadcast(); };
      const settled = () => Promise.all(pages.map(({ page }) => page.waitForFunction(
        () => typeof S !== 'undefined' && S && S.game && S.animUntil + 80 < clock.now() && !document.querySelector('.pkt-chip.flying')
          && !document.getAnimations().some((a) => a.playState === 'running' && a.effect && a.effect.getTiming().iterations !== Infinity), null, { timeout: 15000, polling: 50 })));
      const check = async (phase) => {
        for (const { page, label } of pages) {
          const problems = await page.evaluate(measure);
          assert.deepEqual(problems, [], `${n} Spieler, ${label}, ${phase}`);
        }
      };

      await settled();
      // Pre-Flop mit Einsätzen: einer erhöht, die übrigen bis auf einen gehen mit
      const opts = () => game().options(game().actor());
      act({ type: 'raise', to: opts().minTo });
      while (game().street === 'preflop') {
        const live = game().players.filter((p) => p.inHand && !p.folded && !p.allIn);
        const pending = live.filter((p) => game().needsToAct(p));
        if (pending.length === 1) break;   // letzter Call kommt gleich: für die Flugmessung
        act({ type: game().toCall(game().actor()) ? 'call' : 'check' });
      }
      await settled();
      await check('Pre-Flop');

      // Letzter Call: die Chips fliegen in den Pot – mitten im Flug anhalten und messen
      act({ type: 'call' });
      for (const { page, label } of pages) {
        await page.waitForFunction(() => document.querySelectorAll('.pkt-chip.flying').length > 0, null, { timeout: 10000, polling: 'raf' });
        await page.evaluate(() => document.getAnimations().forEach((a) => {
          const t = a.effect.getTiming();
          a.pause();
          a.currentTime = (t.delay || 0) + (Number(t.duration) || 0) / 2;
        }));
        const problems = await page.evaluate(measure);
        assert.deepEqual(problems, [], `${n} Spieler, ${label}, Chips im Flug`);
        await page.evaluate(() => document.getAnimations().forEach((a) => a.finish()));
      }
      await settled();
      await check('Flop');

      // Turn mit einem Einsatz, River, Showdown
      act({ type: 'raise', to: game().options(game().actor()).minTo });
      while (game().street === 'flop') act({ type: game().toCall(game().actor()) ? 'call' : 'check' });
      await settled();
      act({ type: 'raise', to: game().options(game().actor()).minTo });
      await settled();
      await check('Turn mit Einsatz');
      while (game().street === 'turn') act({ type: game().toCall(game().actor()) ? 'call' : 'check' });
      await settled();
      await check('River');
      while (game().phase === 'betting') act({ type: game().toCall(game().actor()) ? 'call' : 'check' });
      while (game().phase === 'showdown') { room.act(game().showdown.decider, { type: 'show' }); room.broadcast(); }
      await settled();
      await check('Showdown');
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await srv.close();
    }
  });
}

module.exports = { layoutTest };
