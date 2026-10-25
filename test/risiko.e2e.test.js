'use strict';

/*
 * Risiko im Browser: Tablet wählt Risiko in der Lobby, zwei Handys treten bei,
 * setzen ihre Startarmeen, verstärken und kämpfen (der Verteidiger wählt seine
 * Würfel auf dem Handy). Würfel kommen über das Debug-Flag (nur im Testmodus).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, launch, openPage, joinRoom, noHorizontalScroll } = require('./helpers');

const SHOTS = process.env.E2E_SHOTS;
const [SCREEN_W, SCREEN_H] = (process.env.E2E_SCREEN || '1024x768').split('x').map(Number);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `risiko-${name}.png`) }); };
const until = (page, fn, arg, timeout = 20000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });
const armiesOnBoard = (board, id) => board.evaluate((t) => Number(document.querySelector(`#rk-t-${t} .rk-armies`).textContent), id);

test('Risiko: Spielauswahl, Startarmeen, Verstärkung und Angriff mit Verteidigung am Handy', { timeout: 120000 }, async () => {
  const srv = await startServer();
  const browser = await launch();
  const errors = [];
  try {
    /* ---------- Lobby: Risiko auswählen ---------- */
    const board = await openPage(browser, `${srv.url}/board`, { viewport: { width: SCREEN_W, height: SCREEN_H }, label: 'tablet', errors });
    await board.waitForFunction(() => /^[A-Z]{4}$/.test(document.querySelector('#room-code').textContent));
    const code = await board.textContent('#room-code');
    await board.click('#game-risiko');
    await until(board, () => S.gameType === 'risiko' && !document.querySelector('#settings-risiko').classList.contains('hidden'));
    assert.equal(await board.isVisible('#start-money'), false, 'kein Startbetrag bei Risiko');

    const phones = {};
    for (const name of ['Anna', 'Ben']) {
      phones[name] = await openPage(browser, `${srv.url}/play?room=${code}`, { viewport: { width: 375, height: 740 }, label: name, errors, isMobile: true });
      await joinRoom(phones[name], name);
    }
    await board.waitForFunction(() => !document.querySelector('#btn-start').disabled);
    await shot(board, 'lobby');
    await board.click('#btn-start');
    await board.waitForSelector('#risiko:not(.hidden)');
    assert.equal(await board.locator('#rk-map .rk-territory').count(), 42, 'Karte mit 42 Gebieten');

    /* ---------- Aufbau: Angriff vorbereiten ---------- */
    // Startspieler, ein eigenes Gebiet A und ein Nachbar B des anderen Spielers
    const plan = await board.evaluate(() => {
      const g = S.game;
      const first = g.startPlayerId;
      const other = g.players.find((p) => p.id !== first).id;
      for (const t of S.map.territories) {
        if (g.territories[t.id].owner !== first) continue;
        const target = t.neighbors.find((n) => g.territories[n].owner === other);
        if (target) {
          const otherHome = S.map.territories.find((x) => g.territories[x.id].owner === other && x.id !== target).id;
          return { first, other, from: t.id, to: target, otherHome };
        }
      }
      return null;
    });
    assert.ok(plan, 'Startspieler hat ein Gebiet neben dem Gegner');
    const nameOf = (id) => board.evaluate((pid) => S.game.players.find((p) => p.id === pid).name, id);
    const attacker = phones[await nameOf(plan.first)];
    const defender = phones[await nameOf(plan.other)];
    await shot(board, 'aufbau');

    for (const [page, territory] of [[attacker, plan.from], [defender, plan.otherHome]]) {
      await page.waitForSelector('#rk-place');
      await page.selectOption('#rk-place-territory', territory);
      await page.click('[data-rk-fill="placeCount"]');
      await page.click('#rk-place');
    }
    await until(board, () => S.game.phase === 'reinforce');

    /* ---------- Verstärkung ---------- */
    const before = await armiesOnBoard(board, plan.from);
    const reinforcements = await board.evaluate(() => S.game.turn.reinforcements);
    assert.ok(reinforcements >= 3);
    await attacker.waitForSelector('#rk-place');
    await attacker.selectOption('#rk-place-territory', plan.from);
    await attacker.fill('#rk-place-count', String(reinforcements));
    await attacker.dispatchEvent('#rk-place-count', 'change');
    await attacker.click('#rk-place');
    await until(board, () => S.game.phase === 'attack');
    await until(board, ([t, n]) => Number(document.querySelector(`#rk-t-${t} .rk-armies`).textContent) === n, [plan.from, before + reinforcements]);

    /* ---------- Angriff: Verteidiger wählt seine Würfel ---------- */
    await board.evaluate(() => window.__debugDice([[6, 6], [6, 1]]));
    await attacker.waitForSelector('#rk-attack');
    await attacker.selectOption('#rk-from', plan.from);
    await attacker.selectOption('#rk-to', plan.to);
    assert.equal(await attacker.inputValue('#rk-dice'), '3', 'höchste Würfelzahl vorausgewählt');
    await attacker.click('#rk-attack');

    await until(board, () => S.game.phase === 'defend');
    await defender.waitForSelector('#rk-defend');
    assert.equal(await defender.isChecked('input[name="rk-defend"][value="1"]'), true, 'mit 1 Armee: 1 Würfel vorausgewählt');
    assert.equal(await board.evaluate(() => S.game.lastBattle), null, 'vor der Wahl wird nicht gewürfelt');
    await shot(board, 'angriff');
    await defender.click('#rk-defend');

    // 6-6-6 gegen 1 → erobert, Angreifer rückt nach
    await until(board, () => S.game.phase === 'occupy');
    await attacker.waitForSelector('#rk-occupy');
    await attacker.click('[data-rk-fill="occupy"]');
    await attacker.click('#rk-occupy');
    await until(board, ([t, owner]) => S.game.phase === 'attack' && S.game.territories[t].owner === owner, [plan.to, plan.first]);
    assert.deepEqual(await board.evaluate(() => [S.game.lastBattle.attack, S.game.lastBattle.defend]), [[6, 6, 6], [1]]);
    assert.ok(await armiesOnBoard(board, plan.to) >= 3, 'Armeen auf dem eroberten Gebiet sichtbar');
    await until(board, () => document.querySelector('#rk-battle') && !document.querySelector('#rk-battle').classList.contains('hidden'));
    await shot(board, 'erobert');

    // Abgelehnte Aktion: der Verteidiger ist nicht am Zug
    const res = await defender.evaluate(() => window.__act({ type: 'endTurn' }));
    assert.equal(res.ok, false);
    assert.match(res.error, /nicht am Zug/);

    for (const p of [attacker, defender]) assert.equal(await noHorizontalScroll(p), true, 'Handy ohne horizontales Scrollen');
    await shot(attacker, 'handy');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await srv.close();
  }
});
