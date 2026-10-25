'use strict';

/*
 * Poker im Browser: Tablet wählt Poker in der Lobby und stellt das Startguthaben
 * ein, drei Handys treten bei und spielen eine Runde bis zum Ende. Geprüft wird,
 * dass jedes Handy nur die eigenen Karten bekommt (verdeckt, Halten zeigt sie) und
 * der Fernseher die Gemeinschaftskarten zeigt, aber keine verdeckten Handkarten.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { browserSkip, startServer, launch, openPage, joinRoom, noHorizontalScroll } = require('./helpers');

const SHOTS = process.env.E2E_SHOTS;
const [SCREEN_W, SCREEN_H] = (process.env.E2E_SCREEN || '1024x768').split('x').map(Number);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `poker-${name}.png`) }); };
const until = (page, fn, arg, timeout = 20000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });

/** Alle Kartenkürzel in einem Snapshot (z. B. 'As'). */
const cardsInState = (page) => page.evaluate(() => {
  const out = new Set();
  const walk = (x) => {
    if (typeof x === 'string') { if (/^[2-9TJQKA][shdc]$/.test(x)) out.add(x); } else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  };
  walk(S);
  document.querySelectorAll('[data-card]').forEach((el) => out.add(el.dataset.card));
  return [...out];
});

test('Poker: drei Handys spielen eine Runde, Karten nur am eigenen Handy', { skip: browserSkip(), timeout: 120000 }, async () => {
  const srv = await startServer();
  const browser = await launch();
  const errors = [];
  try {
    /* ---------- Lobby: Poker auswählen und einstellen ---------- */
    const board = await openPage(browser, `${srv.url}/board`, { viewport: { width: SCREEN_W, height: SCREEN_H }, label: 'tablet', errors });
    await board.waitForFunction(() => /^[A-Z]{4}$/.test(document.querySelector('#room-code').textContent));
    const code = await board.textContent('#room-code');
    await board.click('#game-poker');
    await until(board, () => S.gameType === 'poker' && !document.querySelector('#settings-poker').classList.contains('hidden'));
    assert.match(await board.textContent('#game-poker'), /2 bis 12 Spieler/);
    await board.fill('#poker-startMoney', '25,50');
    await board.press('#poker-startMoney', 'Tab');
    await until(board, () => S.settings.startMoney === 2550);
    // Ungültiger Big Blind: Der Server lehnt ab, das Feld springt zurück
    await board.fill('#poker-bigBlind', '0,05');
    await board.press('#poker-bigBlind', 'Tab');
    await board.waitForSelector('#toast.show');
    assert.match(await board.textContent('#toast'), /Big Blind muss mindestens so groß sein wie der Small Blind/);
    await until(board, () => document.querySelector('#poker-bigBlind').value === '0,20');

    const phones = {};
    for (const name of ['Anna', 'Ben', 'Cem']) {
      phones[name] = await openPage(browser, `${srv.url}/play?room=${code}`, { viewport: { width: 390, height: 844 }, label: name, errors, isMobile: true });
      await joinRoom(phones[name], name);
    }
    await board.waitForFunction(() => !document.querySelector('#btn-start').disabled);
    await shot(board, 'lobby');
    await board.click('#btn-start');
    await board.waitForSelector('#poker:not(.hidden)');
    assert.equal(await board.locator('#pkt-table .pkt-seat').count(), 3);

    const room = srv.rooms.get(code);
    const game = () => room.game;
    const pageOf = (id) => phones[game().player(id).name];
    const holes = () => Object.fromEntries(game().players.map((p) => [p.name, p.cards.slice()]));

    /* ---------- Karten: nur die eigenen, verdeckt bis zum Halten ---------- */
    for (const [name, page] of Object.entries(phones)) {
      await page.waitForSelector('#panel-poker:not(.hidden)');
      await until(page, () => S.game.me && S.game.me.cards.length === 2 && document.querySelectorAll('#pk-hole .pk-card').length === 2);
      const own = holes()[name];
      const seen = await cardsInState(page);
      for (const [other, cards] of Object.entries(holes())) {
        for (const c of cards) {
          if (other === name) assert.ok(seen.includes(c), `${name} bekommt die eigene Karte ${c}`);
          else assert.ok(!seen.includes(c), `${name} sieht ${other}s Karte ${c}`);
        }
      }
      // Verdeckt: im Bild nur Rückseiten
      assert.equal(await page.locator('#pk-hole .pk-card.back').count(), 2, `${name}: Karten liegen verdeckt`);
      assert.ok(await noHorizontalScroll(page), `${name}: kein seitliches Scrollen`);
      // Erst nach der Austeil-Animation auf dem Fernseher zeigt das Handy den neuen Stand
      await until(page, () => (S.animUntil || 0) < clock.now() && !document.querySelector('#pk-status').textContent.includes('Fernseher'));
      if (name === 'Anna') await shot(page, 'handy-verdeckt-390x844');
      // Halten zeigt sie, Loslassen deckt zu
      const box = await page.locator('#pk-hole').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await until(page, () => document.querySelectorAll('#pk-hole .pk-card[data-card]').length === 2);
      const shown = await page.$$eval('#pk-hole .pk-card[data-card]', (els) => els.map((e) => e.dataset.card));
      assert.deepEqual(shown, own, `${name} sieht beim Halten die eigenen Karten`);
      if (name === 'Anna') await shot(page, 'handy-aufgedeckt-390x844');
      await page.mouse.up();
      await until(page, () => document.querySelectorAll('#pk-hole .pk-card.back').length === 2);
    }
    // Der Fernseher kennt keine Handkarten
    const tvSeen = await cardsInState(board);
    for (const cards of Object.values(holes())) for (const c of cards) assert.ok(!tvSeen.includes(c), `Fernseher sieht Handkarte ${c}`);
    await shot(board, 'tv-preflop');

    /* ---------- Eine Runde spielen: mitgehen bzw. checken bis zum Ende ---------- */
    const dealt = holes();
    let raiseShot = false;
    for (let i = 0; i < 40 && game().handNo === 1 && game().phase !== 'between'; i++) {
      const g = game();
      const seq = g.anim.seq;
      if (g.phase === 'showdown') {
        const page = pageOf(g.showdown.decider);
        await page.waitForSelector('#pk-extra [data-pk="muck"]', { timeout: 20000 });
        await page.click('#pk-extra [data-pk="muck"]');
      } else {
        const page = pageOf(g.actor().id);
        await page.waitForSelector('#pk-bar [data-pk="call"], #pk-bar [data-pk="check"]', { timeout: 20000 });
        if (!raiseShot) {
          raiseShot = true;
          await page.click('#pk-bar [data-pk="raise-toggle"]');
          await page.waitForSelector('#pk-raise-range');
          await shot(page, 'handy-aktionsleiste-390x844');
          await page.click('#pk-bar [data-pk="raise-toggle"]');
        }
        await page.click('#pk-bar [data-pk="call"], #pk-bar [data-pk="check"]');
      }
      await until(board, (s) => S.anim.seq > s, seq);
    }
    assert.ok(game().phase === 'between' || game().handNo === 2, 'Runde ist zu Ende');

    /* ---------- Fernseher zeigt die Gemeinschaftskarten ---------- */
    const boardCards = game().board.slice();
    assert.equal(boardCards.length, 5);
    await until(board, () => document.querySelectorAll('#pkt-board .pk-card[data-card]').length === 5, null, 30000);
    const onTv = await board.$$eval('#pkt-board .pk-card[data-card]', (els) => els.map((e) => e.dataset.card));
    assert.deepEqual(onTv, boardCards);
    await until(board, () => S.anim.events.some((e) => e.type === 'win') && document.querySelector('#pkt-msg').textContent.includes('€'), null, 30000);
    await shot(board, 'tv-showdown');
    // Weggeworfene Karten erscheinen nirgends außer am eigenen Handy
    const shownIds = new Set(game().players.filter((p) => p.shown).map((p) => p.name));
    const tvAfter = await cardsInState(board);
    for (const [name, cards] of Object.entries(dealt)) {
      if (shownIds.has(name)) continue;
      for (const c of cards) {
        assert.ok(!tvAfter.includes(c), `Fernseher sieht verdeckte Karte ${c} von ${name}`);
        for (const [other, page] of Object.entries(phones)) if (other !== name) assert.ok(!(await cardsInState(page)).includes(c), `${other} sieht ${name}s Karte ${c}`);
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await srv.close();
  }
});
