'use strict';

/*
 * Avatare und eigene Fotos im Browser: Avatar wählen, Foto zuschneiden und hochladen
 * (nur 128 × 128, höchstens 20 KB, ohne EXIF/Ortsdaten), Anzeige in Lobby, auf dem
 * Monopoly-Brett und im Endstand, Ausblenden durch den Host, Rückfall ohne kaputtes Bild.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { browserSkip, startServer, launch, openPage, joinRoom, noHorizontalScroll } = require('./helpers');

const SHOTS = process.env.E2E_SHOTS;

/** Ein echtes JPEG (800 × 600) aus dem Browser, dazu ein EXIF-Segment mit Ortsdaten direkt nach SOI. */
const jpegMitOrt = (page) => page.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 800; c.height = 600;
  const g = c.getContext('2d');
  g.fillStyle = '#6aa7c9'; g.fillRect(0, 0, 800, 600);
  g.fillStyle = '#e9c46a'; g.beginPath(); g.arc(400, 260, 150, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#2a4d3a'; g.fillRect(0, 460, 800, 140);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const text = new TextEncoder().encode('Exif\0\0MM\0*GPSLatitude=52.5200N GPSLongitude=13.4050E Kamera=Testhandy');
  const seg = new Uint8Array(4 + text.length);
  seg.set([0xff, 0xe1, (text.length + 2) >> 8, (text.length + 2) & 255]);
  seg.set(text, 4);
  const out = new Uint8Array(bytes.length + seg.length);
  out.set(bytes.subarray(0, 2)); out.set(seg, 2); out.set(bytes.subarray(2), 2 + seg.length);
  let bin = '';
  out.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
});

test('Avatar und Foto: wählen, zuschneiden, hochladen, Lobby, Brett und Endstand', { skip: browserSkip(), timeout: 60000 }, async () => {
  const srv = await startServer();
  const browser = await launch();
  const errors = [];
  try {
    const board = await openPage(browser, `${srv.url}/board`, { viewport: { width: 1366, height: 768 }, label: 'tv', errors });
    await board.waitForFunction(() => /^[A-Z]{4}$/.test(document.querySelector('#room-code').textContent));
    const code = await board.textContent('#room-code');

    // Handy 1: Farbe, Avatar „Stern“, dann eigenes Foto
    const phone = await openPage(browser, `${srv.url}/play?room=${code}`, { viewport: { width: 390, height: 844 }, label: 'anna', errors, isMobile: true });
    await phone.waitForSelector('#join-form[data-game="monopoly"]', { state: 'attached' });
    await phone.fill('#join-name', 'Anna');
    await phone.click('#join-colors button:nth-child(2)');
    await phone.click('#join-figures [data-avatar="stern"]');
    assert.equal(await phone.getAttribute('#join-figures [data-avatar="stern"]', 'aria-pressed'), 'true');
    assert.equal(await phone.locator('#join-figures [data-avatar] svg').count(), 24, '24 Motive als Vektor, dazu das Monogramm');
    assert.match(await phone.textContent('#join-figures [data-avatar="monogramm"]'), /^A$/);
    await phone.waitForSelector('#join.lb-go');
    await phone.waitForTimeout(1200);   // Eingangsanimation fertig
    await phone.locator('#join-figure-set').scrollIntoViewIfNeeded();
    if (SHOTS) await phone.screenshot({ path: path.join(SHOTS, 'handy-avatar-auswahl-390x844.png') });

    await phone.click('#foto-open');
    assert.equal(await phone.textContent('.jn-foto-hint'), 'Dein Foto ist nur in diesem Raum sichtbar und wird nach dem Spiel gelöscht.');
    assert.equal(await phone.getAttribute('#foto-file', 'accept'), 'image/*');
    const original = Buffer.from(await jpegMitOrt(phone), 'base64');
    assert.ok(original.includes(Buffer.from('GPSLatitude')), 'Ausgangsbild enthält Ortsdaten');
    await phone.setInputFiles('#foto-file', { name: 'urlaub.jpg', mimeType: 'image/jpeg', buffer: original });
    await phone.waitForSelector('#foto-crop:not(.hidden)');
    await phone.evaluate(() => { window.__fotoZuschnitt.setZoom(1.6); window.__fotoZuschnitt.nudge(0.15, -0.1); });
    await phone.locator('#foto-crop').scrollIntoViewIfNeeded();
    if (SHOTS) await phone.screenshot({ path: path.join(SHOTS, 'handy-foto-zuschnitt-390x844.png') });
    assert.equal(await noHorizontalScroll(phone), true);

    // Was gesendet wird, mitschneiden (nur das kleine Bild, nie das Original)
    await phone.evaluate(() => {
      const emit = socket.emit.bind(socket);
      socket.emit = (ev, data, ...rest) => {
        if (ev === 'avatar:foto') window.__gesendet = data.foto.byteLength;
        return emit(ev, data, ...rest);
      };
    });
    await phone.click('#foto-ok');
    await phone.waitForSelector('#foto-chosen:not(.hidden) .av-foto');
    await phone.click('#btn-join');
    await phone.waitForSelector('#app:not(.hidden)');
    await phone.waitForFunction(() => window.__gesendet > 0);
    const sent = await phone.evaluate(() => window.__gesendet);
    assert.ok(sent <= 20 * 1024, `höchstens 20 KB gesendet (${sent} Bytes)`);
    assert.ok(sent < original.length / 2, 'nicht das Original');

    // Gespeichertes Foto: 128 × 128, WebP oder JPEG, ohne EXIF und Ortsdaten
    await board.waitForFunction(() => S.lobby[0] && S.lobby[0].photo);
    const url = await board.evaluate(() => S.lobby[0].photo);
    const res = await board.evaluate(async (u) => {
      const r = await fetch(u);
      const b = new Uint8Array(await r.arrayBuffer());
      return { type: r.headers.get('content-type'), bytes: [...b] };
    }, url);
    const stored = Buffer.from(res.bytes);
    assert.match(res.type, /^image\/(webp|jpeg)$/);
    assert.ok(stored.length <= 20 * 1024);
    for (const s of ['Exif', 'GPSLatitude', 'Testhandy']) assert.equal(stored.includes(Buffer.from(s)), false, `kein ${s} im Foto`);
    await board.waitForFunction(() => { const i = document.querySelector('#lobby-players .av-foto'); return i && i.complete && i.naturalWidth === 128 && i.naturalHeight === 128; });
    assert.ok(!JSON.stringify(await board.evaluate(() => S)).includes(stored.toString('base64').slice(0, 32)), 'Snapshot ohne Bild');

    // Handy 2 mit Avatar aus dem Set
    const phone2 = await openPage(browser, `${srv.url}/play?room=${code}`, { viewport: { width: 390, height: 844 }, label: 'ben', errors, isMobile: true });
    await joinRoom(phone2, 'Ben');
    await board.waitForFunction(() => document.querySelectorAll('#lobby-players li.lb-player').length === 2);
    assert.equal(await board.locator('#lobby-players li.lb-player:nth-child(2) .av svg').count(), 1);

    // Host blendet das Foto aus und wieder ein
    await board.click('#lobby-players [data-foto]');
    await board.waitForFunction(() => !document.querySelector('#lobby-players .av-foto') && document.querySelector('#lobby-players li.lb-player .av svg'));
    assert.match(await board.textContent('#lobby-players [data-foto]'), /Foto zeigen/);
    await phone.waitForFunction(() => !document.querySelector('#me-fig .av-foto'));
    await board.click('#lobby-players [data-foto]');
    await board.waitForSelector('#lobby-players .av-foto');

    // Fehlendes Bild: Rückfall auf das Motiv, nie ein kaputtes Bild
    const fallback = await board.evaluate(async () => {
      const box = document.createElement('div');
      box.innerHTML = avatarHtml({ name: 'X', color: '#2a9d8f', avatar: 'wellen', photo: '/api/avatar/ZZZZ/nix' }, 'L');
      document.body.appendChild(box);
      await new Promise((r) => setTimeout(r, 400));
      const out = { img: box.querySelectorAll('img').length, svg: box.querySelectorAll('svg').length };
      box.remove();
      return out;
    });
    assert.deepEqual(fallback, { img: 0, svg: 1 });

    // Monopoly: Marken mit Avatar bzw. Foto
    await board.setViewportSize({ width: 1920, height: 1080 });
    await board.click('#btn-start');
    await board.waitForSelector('#game:not(.hidden)');
    await board.waitForFunction(() => document.querySelectorAll('.token .tok-in .av').length === 2 && document.querySelector('.token .av-foto'));
    assert.equal(await board.locator('#side-players .ps-fig .av').count(), 2);
    const emoji = await board.evaluate(() => /[\u{1F3A9}\u{1F697}\u{1F415}\u{1F6A2}\u{1F462}\u{1F408}\u{1F986}\u{1F996}\u{2708}\u{1F3B8}]/u.test(document.querySelector('#game').innerText));
    assert.equal(emoji, false, 'keine Emoji-Spielfiguren mehr');
    await board.waitForTimeout(600);
    if (SHOTS) await board.screenshot({ path: path.join(SHOTS, 'monopoly-brett-marken-1920x1080.png') });

    // Endstand mit Avataren (Fernseher und Handy)
    await board.click('#game [data-host="end"]');
    await board.click('#host-dialog [data-host="confirm"]');
    await board.waitForSelector('#host-final:not(.hidden) .es-table .av');
    assert.equal(await board.locator('#host-final .es-table .av').count(), 2);
    await board.waitForSelector('#host-final .es-table .av-foto');
    await phone.waitForSelector('#panel-final .es-table .av');
    if (SHOTS) await board.screenshot({ path: path.join(SHOTS, 'endstand-avatare-1920x1080.png') });

    // Raum schließen: Foto ist weg
    await board.click('#host-after [data-host="close"]');
    await board.click('#host-dialog [data-host="confirm"]');
    await board.waitForURL(/\/\?fehler=/);
    const gone = await board.evaluate((u) => fetch(u, { cache: 'no-store' }).then((r) => r.status), url);
    assert.equal(gone, 404);
    assert.deepEqual(errors.filter((e) => !/404/.test(e)), []);
  } finally {
    await browser.close();
    await srv.close();
  }
});
