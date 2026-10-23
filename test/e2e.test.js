'use strict';

/*
 * Kompletter Durchlauf mit 1 Tablet und 3 Handys: Lobby, Kauf, Miete,
 * Versteigerung, abgelehnte Aktionen und erzwungene Minispiele.
 * Würfel kommen über das Debug-Flag (nur im Testmodus des Servers).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, launch, openPage, joinRoom, noHorizontalScroll } = require('./helpers');

const SHOTS = process.env.E2E_SHOTS;
// Bildschirm des Spielfelds: Standard Tablet 1024×768, per E2E_SCREEN=1920x1080 z. B. Fernseher
const [SCREEN_W, SCREEN_H] = (process.env.E2E_SCREEN || '1024x768').split('x').map(Number);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

/** Wartet, bis das Tablet eine Bedingung über den Spielstand erfüllt sieht. */
const until = (board, fn, arg, timeout = 30000) => board.waitForFunction(fn, arg, { timeout, polling: 100 });
const phaseIs = (board, phase, currentName) => until(board, ([ph, name]) => S && S.game && S.game.phase === ph
  && (!name || S.game.players.find((p) => p.id === S.game.currentId).name === name), [phase, currentName]);
const money = (board, name) => board.evaluate((n) => S.game.players.find((p) => p.name === n).money, name);

/** Zug ist abgewickelt → der Spieler tippt auf „Zug beenden“, danach ist der Nächste dran. */
async function endTurn(board, page, name) {
  await phaseIs(board, 'end', name);
  await page.click('button:has-text("Zug beenden")');
  await until(board, (n) => S.game.players.find((p) => p.id === S.game.currentId).name !== n, name);
}

/** Letzte Toast-Meldung auf dem Handy abwarten. */
const toastText = async (page, re) => {
  await page.waitForFunction((src) => {
    const t = document.querySelector('#toast.show');
    return t && new RegExp(src).test(t.textContent);
  }, re.source, { timeout: 10000 });
  return page.textContent('#toast');
};

test('Spielabend: Lobby, Kauf, Miete, Versteigerung, Handel, Ablehnungen und Minispiele', { timeout: 240000 }, async () => {
  const srv = await startServer();
  const browser = await launch();
  const errors = [];
  try {
    /* ---------- Lobby ---------- */
    const board = await openPage(browser, `${srv.url}/board`, { viewport: { width: SCREEN_W, height: SCREEN_H }, label: 'tablet', errors });
    await board.waitForFunction(() => /^[A-Z]{4}$/.test(document.querySelector('#room-code').textContent));
    const code = await board.textContent('#room-code');
    const names = ['Anna', 'Ben', 'Cem'];
    const phones = {};
    for (const name of names) {
      phones[name] = await openPage(browser, `${srv.url}/play?room=${code}`, { viewport: { width: 375, height: 740 }, label: name, errors, isMobile: true });
      await joinRoom(phones[name], name);
    }
    let [A, B, C] = names.map((n) => phones[n]);

    // Wächter: Während Würfel/Figur laufen, darf weder Tablet noch Handy das Ergebnis verraten
    const watchBoard = () => board.evaluate(() => {
      window.__spoiler = [];
      setInterval(() => {
        if (typeof animBusy !== 'function' || !animBusy()) return;
        const st = document.querySelector('#cm-status');
        if (st && /überlegt|Versteigerung|Miete/.test(st.textContent)) window.__spoiler.push(st.textContent);
      }, 15);
    });
    const watchPhone = (page) => page.evaluate(() => {
      window.__spoiler = [];
      setInterval(() => {
        if (!S || !S.game || clock.now() >= S.animUntil) return;
        if (document.querySelector('#panel-turn [data-act*="buy"], #panel-turn [data-act*="endTurn"]')) window.__spoiler.push('Kaufen/Zug beenden zu früh sichtbar');
      }, 15);
    });
    await watchBoard();
    for (const p of [A, B, C]) await watchPhone(p);

    // Würfel für die ganze Partie vorgeben
    await board.evaluate(() => window.__debugDice([[1, 2], [1, 2], [1, 4], [3, 4], [2, 6], [1, 5]]));
    await board.waitForFunction(() => !document.querySelector('#btn-start').disabled);
    await board.click('#btn-start');
    // Erster Wurf: solange die Figur läuft, zeigt das Handy nur „Die Würfel rollen…“
    await A.waitForSelector('.rolling-box', { timeout: 10000 });
    await board.waitForSelector('#game:not(.hidden)');

    /* ---------- Runde 1: Anna kauft die Turmstraße ---------- */
    await phaseIs(board, 'buy', 'Anna');
    await A.waitForSelector('button:has-text("Kaufen für 60 M")');

    // Ben ist nicht dran → Server lehnt ab, Handy zeigt die Meldung
    await B.evaluate(() => window.__act({ type: 'buy' }));
    assert.match(await toastText(B, /nicht am Zug/), /Du bist nicht am Zug – gerade ist Anna dran/);

    await shot(board, '01-kaufen');
    await A.click('button:has-text("Kaufen für 60 M")');
    await phaseIs(board, 'end', 'Anna');
    await A.waitForSelector('button:has-text("Zug beenden")');
    await shot(A, '01b-zug-beenden');
    // Nur wer dran ist, kann den Zug beenden
    await B.evaluate(() => window.__act({ type: 'endTurn' }));
    assert.match(await toastText(B, /nicht am Zug/), /Du bist nicht am Zug – gerade ist Anna dran/);
    await endTurn(board, A, 'Anna');
    assert.equal(await money(board, 'Anna'), 1440);
    await board.waitForSelector('#cell-3.owned');

    /* ---------- Ben zahlt Miete ---------- */
    await endTurn(board, B, 'Ben');
    await phaseIs(board, 'buy', 'Cem');
    assert.equal(await money(board, 'Ben'), 1496);
    assert.equal(await money(board, 'Anna'), 1444);
    await until(board, () => [...document.querySelectorAll('#ticker li')].some((li) => /Miete an Anna/.test(li.textContent)));

    /* ---------- Cem lehnt ab → Versteigerung ---------- */
    await C.click('button:has-text("Nicht kaufen")');
    await phaseIs(board, 'auction');
    await A.waitForSelector('#bid-amount');
    // zu wenig Geld → verständliche Ablehnung
    await A.fill('#bid-amount', '99999');
    await A.click('#btn-bid');
    assert.match(await toastText(A, /Nicht genug Geld/), /Nicht genug Geld: Du hast nur 1\.444 M/);
    // Besitz-Tab: Bauen ohne komplette Farbgruppe wird abgelehnt
    await A.click('#tabs [data-tab="props"]');
    await A.waitForSelector('.prop:has-text("Turmstraße")');
    await A.evaluate(() => window.__act({ type: 'build', square: 3 }));
    assert.match(await toastText(A, /Farbgruppe/), /kompletten Farbgruppe/);
    await A.click('#tabs [data-tab="turn"]');

    await A.click('button:has-text("10 M")');
    await until(board, () => S.game.auction && S.game.auction.bid === 10);
    await shot(board, '02-versteigerung');
    await B.click('button:has-text("Aussteigen")');
    await C.click('button:has-text("Aussteigen")');
    await until(board, () => S.game.props[5].owner && S.game.players.find((p) => p.id === S.game.props[5].owner).name === 'Anna');
    assert.equal(await money(board, 'Anna'), 1434);
    await endTurn(board, C, 'Cem');


    /* ---------- Anna würfelt 3 + 4 = 7 → Pferderennen für alle ---------- */
    await until(board, () => S.mini && S.mini.type === 'horserace');
    await A.waitForSelector('[data-hr-horse="0"]');
    await A.click('[data-hr-horse="0"]');
    await A.fill('#hr-amount', '50');
    await A.click('#btn-hr-bet');
    await B.waitForSelector('[data-hr-horse="1"]');
    await B.click('[data-hr-horse="1"]');
    await B.click('[data-hr-type="place"]');
    await B.fill('#hr-amount', '20');
    await B.click('#btn-hr-bet');
    await C.waitForSelector('[data-hr-horse="2"]');
    await C.click('[data-hr-horse="2"]');
    await C.fill('#hr-amount', '99999');
    await C.click('#btn-hr-bet');
    assert.match(await toastText(C, /Nicht genug Geld/), /Nicht genug Geld/);
    await board.waitForSelector('.hr-table .bchip:has-text("Anna")');
    await board.waitForSelector('.hr-table .bchip:has-text("Ben")');
    assert.equal(await money(board, 'Anna'), 1384, 'Einsatz sofort vom Monopoly-Konto');
    await shot(board, '05-rennen-wetten');
    await shot(B, '06-handy-rennen');
    for (const p of [A, B, C]) await p.click('button:has-text("Fertig")');
    await until(board, () => S.mini && S.mini.phase === 'running');
    await board.waitForSelector('.hr-track .horse.backed');
    await board.waitForSelector('.hr-track .trail text');
    await board.waitForTimeout(1600);
    await shot(board, '07-rennen');
    await until(board, () => S.mini && S.mini.phase === 'results');
    await board.waitForSelector('.hr-results:not(.hidden)');
    const raceResult = await board.evaluate(() => S.mini.results);
    const annaId = await board.evaluate(() => S.game.players.find((p) => p.name === 'Anna').id);
    const annaWin = raceResult.filter((r) => r.playerId === annaId).reduce((sum, r) => sum + r.payout, 0);
    assert.equal(await money(board, 'Anna'), 1384 + annaWin);
    await shot(board, '08-zieleinlauf');
    await until(board, () => !S.mini, null, 60000);
    await endTurn(board, A, 'Anna');

    /* ---------- Layout-Prüfungen ---------- */
    for (const p of [A, B, C]) assert.equal(await noHorizontalScroll(p), true, 'Handy (375 px) ohne horizontales Scrollen');
    const fit = await board.evaluate(() => {
      const r = document.querySelector('#board').getBoundingClientRect();
      return { right: r.right, bottom: r.bottom, scrollH: document.documentElement.scrollHeight, scrollW: document.documentElement.scrollWidth };
    });
    assert.ok(fit.right <= SCREEN_W && fit.bottom <= SCREEN_H, `Brett passt auf ${SCREEN_W}×${SCREEN_H} (${JSON.stringify(fit)})`);
    assert.ok(fit.scrollH <= SCREEN_H && fit.scrollW <= SCREEN_W, 'Spielfeld ohne Scrollen');

    /* ---------- Neuladen eines Handys mitten im Spiel ---------- */
    await C.reload();
    await C.waitForSelector('#app:not(.hidden)');
    await C.waitForSelector('#tabs:not(.hidden)');
    assert.equal(await C.textContent('#me-name'), 'Cem');

    /* ---------- Wiedereinstieg aus einem anderen Browser (ohne Token) ---------- */
    await C.context().close();
    await until(board, () => S.lobby.find((p) => p.name === 'Cem' && !p.connected));
    C = await openPage(browser, `${srv.url}/play?room=${code}`, { viewport: { width: 375, height: 740 }, label: 'Cem-neu', errors, isMobile: true });
    await C.waitForSelector('[data-reclaim]');
    assert.equal(await C.isVisible('#btn-join'), false, 'neuer Beitritt im laufenden Spiel nicht möglich');
    await C.click('[data-reclaim]:has-text("Cem")');
    await C.waitForSelector('#tabs:not(.hidden)');
    assert.equal(await C.textContent('#me-name'), 'Cem');
    phones.Cem = C;
    await watchPhone(C);

    /* ---------- Handel über das Handy ---------- */
    await phaseIs(board, 'buy', 'Ben'); // Ben steht auf der Seestraße – Handel ist jederzeit erlaubt
    await A.click('#tabs [data-tab="trade"]');
    const benId = await board.evaluate(() => S.game.players.find((p) => p.name === 'Ben').id);
    await A.selectOption('#tr-partner', benId);
    const annaBefore = await money(board, 'Anna');
    await A.check('#tg-5');
    await A.fill('#tw-money', '150');
    await A.click('#btn-trade');
    await B.waitForSelector('#trade-badge:not(.hidden)');
    await B.click('#tabs [data-tab="trade"]');
    await B.click('.offer button:has-text("Annehmen")');
    await until(board, () => S.game.players.find((p) => p.id === S.game.props[5].owner).name === 'Ben');
    assert.equal(await money(board, 'Anna'), annaBefore + 150);
    await until(board, () => [...document.querySelectorAll('#ticker li')].some((li) => /Handel/.test(li.textContent)));
    await B.click('#tabs [data-tab="turn"]');
    await A.click('#tabs [data-tab="turn"]');

    /* ---------- Ben kauft die Seestraße, 2 + 6 = 8 → Roulette ---------- */
    await B.click('button:has-text("Kaufen für 140 M")');
    await until(board, () => S.mini && S.mini.type === 'roulette');
    const before = { Anna: await money(board, 'Anna'), Ben: await money(board, 'Ben'), Cem: await money(board, 'Cem') };
    await A.waitForSelector('[data-rl-chip="25"]');
    await A.click('[data-rl-chip="25"]');
    await A.click('.rs:has-text("Rot")');
    await B.waitForSelector('[data-rl-chip="10"]');
    await B.click('.rnums .rs:text-is("17")');
    await B.click('.rnums .rs:has-text("17")');
    // Ganz nach unten scrollen – Einsätze der anderen dürfen die Seite nicht nach oben springen lassen
    const scrolled = await B.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); return window.scrollY; });
    assert.ok(scrolled > 200, `Roulette-Seite ist scrollbar (${scrolled})`);
    await C.waitForSelector('[data-rl-chip="5"]');
    await C.click('[data-rl-chip="5"]');
    await C.click('.rs.zero');
    await C.click('button:has-text("Fertig")');
    assert.match(await toastText(C, /Mindesteinsatz/), /Mindesteinsatz ist 10 M/);
    await C.click('.rs.zero');
    await board.waitForSelector('.rtable .rchip:has-text("Anna")');
    await board.waitForSelector('.rtable .rchip:has-text("Ben")');
    await board.waitForSelector('.rtable .rchip:has-text("Cem")');
    assert.equal(await B.evaluate(() => window.scrollY), scrolled, 'Scrollposition bleibt beim Neuzeichnen erhalten');
    await until(board, () => S.mini.bets.filter((b) => b.kind === 'straight' && b.value === 0).reduce((t, b) => t + b.amount, 0) === 10);
    assert.equal(await money(board, 'Anna'), before.Anna - 25);
    await board.waitForTimeout(300);
    await shot(board, '09-roulette-tableau');
    await shot(B, '10-handy-roulette');
    for (const p of [A, B, C]) await p.click('button:has-text("Fertig")');
    await until(board, () => S.mini && S.mini.phase === 'spinning');
    await board.waitForSelector('.rl-spin:not(.hidden) .wheel-svg');
    await board.waitForTimeout(500);
    await shot(board, '11-roulette-rad');
    await until(board, () => S.mini && S.mini.phase === 'results');
    await board.waitForSelector('.wheel-result:not(.hidden)');
    await board.waitForSelector('.rl-results .payouts li');
    const roulette = await board.evaluate(() => ({ n: S.mini.result, results: S.mini.results, players: S.mini.players }));
    for (const name of names) {
      const id = roulette.players.find((p) => p.name === name).id;
      const net = roulette.results.filter((r) => r.playerId === id).reduce((t, r) => t + r.payout - r.amount, 0);
      assert.equal(await money(board, name), before[name] + net, `Roulette-Abrechnung ${name} (Zahl ${roulette.n})`);
    }
    await shot(board, '12-roulette-ergebnis');
    await until(board, () => !S.mini, null, 60000);
    await endTurn(board, B, 'Ben');

    /* ---------- Cem würfelt 1 + 5 = 6: Miete an Ben, dann Blackjack ---------- */
    await until(board, () => S.mini && S.mini.type === 'blackjack');
    assert.equal(await money(board, 'Cem'), before.Cem + roulette.results.filter((r) => r.playerId === roulette.players[2].id).reduce((t, r) => t + r.payout - r.amount, 0) - 10, 'Cem zahlt 10 M Miete für die Seestraße');
    const bjBefore = { Anna: await money(board, 'Anna'), Ben: await money(board, 'Ben'), Cem: await money(board, 'Cem') };
    await A.waitForSelector('.bjp-q');
    await A.click('.bjp-q:has-text("20 M")');
    await A.waitForSelector('.bjp-cur b:has-text("20 M")');
    await shot(A, '13b-handy-bj-einsatz');
    await B.waitForSelector('.bjp-more summary');
    await B.click('.bjp-more summary');
    await B.fill('#bj-amount', '5');
    await B.click('#btn-bj-bet');
    assert.match(await toastText(B, /Mindesteinsatz/), /Mindesteinsatz ist 10 M/);
    await B.fill('#bj-amount', '10');
    await B.click('#btn-bj-bet');
    await board.waitForSelector('.bj-seat .bj-chip:has-text("20 M")');
    await shot(board, '13-blackjack-einsaetze');
    for (const p of [A, B, C]) await p.click('button:has-text("Fertig")');
    await until(board, () => S.mini && S.mini.phase !== 'betting');
    await board.waitForSelector('.bj-seat .bj-hand .pcard');

    // Entscheidungen auf den Handys treffen, bis der Dealer abrechnet
    let rejected = false;
    let shotTaken = false;
    while (await board.evaluate(() => S.mini && ['playing', 'dealer'].includes(S.mini.phase))) {
      const turn = await board.evaluate(() => S.mini && S.mini.turn && S.mini.players.find((p) => p.id === S.mini.turn.playerId).name);
      if (turn) {
        if (!shotTaken) { await board.waitForTimeout(400); await shot(board, '14-blackjack-tisch'); await shot(phones[turn], '15-handy-blackjack'); shotTaken = true; }
        if (!rejected) {
          const other = turn === 'Anna' ? B : A;
          await other.evaluate(() => window.__act({ type: 'mini', action: { type: 'hit' } }));
          assert.match(await toastText(other, /nicht dran/), new RegExp(`Du bist nicht dran – gerade entscheidet ${turn}`));
          rejected = true;
        }
        const page = phones[turn];
        await page.waitForSelector('.bj-controls button:has-text("Stand"):not([disabled])', { timeout: 10000 }).catch(() => {});
        if (await page.$('.bj-controls button:has-text("Stand"):not([disabled])')) await page.click('.bj-controls button:has-text("Stand")');
      }
      await board.waitForTimeout(150);
    }
    await until(board, () => S.mini && S.mini.phase === 'results');
    await board.waitForSelector('.bj-res');
    const bj = await board.evaluate(() => ({ seats: S.mini.seats, players: S.mini.players }));
    for (const name of names) {
      const id = bj.players.find((p) => p.name === name).id;
      const seat = bj.seats.find((x) => x.playerId === id);
      const net = seat ? seat.hands.reduce((t, h) => t + h.payout - h.bet, 0) : 0;
      assert.equal(await money(board, name), bjBefore[name] + net, `Blackjack-Abrechnung ${name}`);
    }
    await shot(board, '16-blackjack-ergebnis');
    await until(board, () => !S.mini, null, 60000);
    await endTurn(board, C, 'Cem');

    await shot(board, '03-brett');
    await shot(A, '04-handy');
    assert.deepEqual(await board.evaluate(() => window.__spoiler), [], 'Tablet verrät das Landefeld nicht zu früh');
    for (const p of [A, B, C]) assert.deepEqual(await p.evaluate(() => window.__spoiler), [], 'Handy verrät das Landefeld nicht zu früh');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await srv.close();
  }
});
