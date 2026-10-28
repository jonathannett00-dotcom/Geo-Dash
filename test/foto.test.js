'use strict';

/*
 * Spielerfotos: Prüfung am Dateikopf (Format, Maße, Größe), Rate-Limit, Speicherung im
 * Raumzustand, Auslieferung über /api/avatar, Löschen mit dem Raum, alte Räume mit Emoji-Figur.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { checkFoto, jpegSize, webpSize } = require('../server/foto');
const { RoomManager, COLORS, FIGURES, UserError } = require('../server/rooms');
const { createServer } = require('../server');

const fail = (msg) => { throw new UserError(msg); };

/** Minimaler JPEG-Kopf mit SOF0 (Maße), optional mit EXIF-Segment. */
function jpeg(w, h, { exif = false, pad = 200 } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])];
  parts.push(Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
  if (exif) {
    const body = Buffer.from('Exif\0\0GPSLatitude 52.52 GPSLongitude 13.40');
    const len = Buffer.alloc(2); len.writeUInt16BE(body.length + 2);
    parts.push(Buffer.from([0xff, 0xe1]), len, body);
  }
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7);
  parts.push(sof, Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.alloc(pad, 0x55), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

/** Minimale WebP-Köpfe (VP8, VP8L, VP8X). */
function webp(kind, w, h, pad = 200) {
  let chunk;
  if (kind === 'VP8 ') {
    chunk = Buffer.alloc(10 + pad);
    chunk[3] = 0x9d; chunk[4] = 0x01; chunk[5] = 0x2a;
    chunk.writeUInt16LE(w, 6); chunk.writeUInt16LE(h, 8);
  } else if (kind === 'VP8L') {
    chunk = Buffer.alloc(5 + pad);
    chunk[0] = 0x2f;
    chunk.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 1);
  } else {
    chunk = Buffer.alloc(10 + pad);
    chunk.writeUIntLE(w - 1, 4, 3); chunk.writeUIntLE(h - 1, 7, 3);
  }
  const head = Buffer.alloc(20);
  head.write('RIFF', 0, 'ascii'); head.write('WEBP', 8, 'ascii'); head.write(kind, 12, 'ascii');
  head.writeUInt32LE(chunk.length, 16);
  const buf = Buffer.concat([head, chunk]);
  buf.writeUInt32LE(buf.length - 8, 4);
  return buf;
}

test('Foto-Prüfung: Maße aus dem Dateikopf von JPEG und WebP (VP8, VP8L, VP8X)', () => {
  assert.deepEqual(jpegSize(jpeg(128, 128, { exif: true })), { width: 128, height: 128 });
  assert.deepEqual(jpegSize(jpeg(300, 200)), { width: 300, height: 200 });
  for (const kind of ['VP8 ', 'VP8L', 'VP8X']) assert.deepEqual(webpSize(webp(kind, 128, 128)), { width: 128, height: 128 }, kind);
  assert.equal(checkFoto(jpeg(128, 128), fail).type, 'image/jpeg');
  assert.equal(checkFoto(webp('VP8 ', 128, 128), fail).type, 'image/webp');
  assert.equal(checkFoto(webp('VP8L', 128, 128).toString('base64'), fail).type, 'image/webp', 'auch als Base64');
});

test('Foto-Prüfung: zu groß, falsches Format, falsche Maße und Leeres werden abgelehnt', () => {
  assert.throws(() => checkFoto(jpeg(128, 128, { pad: 25 * 1024 }), fail), /zu groß \(höchstens 24 KB\)/);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
  assert.throws(() => checkFoto(png, fail), /Nur WebP und JPEG|nur WebP und JPEG/);
  assert.throws(() => checkFoto(Buffer.from('GIF89a' + 'x'.repeat(100)), fail), /WebP und JPEG/);
  assert.throws(() => checkFoto(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), fail), /WebP und JPEG/);
  // Die Behauptung des Clients zählt nicht: ein „data:image/jpeg“ mit PNG-Inhalt bleibt PNG
  assert.throws(() => checkFoto(`data:image/jpeg;base64,${png.toString('base64')}`, fail), /WebP und JPEG/);
  assert.throws(() => checkFoto(jpeg(64, 64), fail), /genau 128 × 128/);
  assert.throws(() => checkFoto(jpeg(128, 129), fail), /genau 128 × 128/);
  assert.throws(() => checkFoto(webp('VP8X', 256, 128), fail), /genau 128 × 128/);
  assert.throws(() => checkFoto(webp('VP8L', 128, 127), fail), /genau 128 × 128/);
  assert.throws(() => checkFoto(Buffer.alloc(0), fail), /kein Foto/);
  assert.throws(() => checkFoto(undefined, fail), /kein Foto/);
  assert.throws(() => checkFoto({ type: 'image/jpeg' }, fail), /kein Foto/);
  // Abgeschnittenes WebP (Größe im Kopf passt nicht)
  const cut = webp('VP8 ', 128, 128).subarray(0, 40);
  assert.throws(() => checkFoto(cut, fail), /WebP und JPEG/);
});

function lobbyRoom(n = 2, gameType = 'monopoly') {
  const manager = new RoomManager({ testMode: true, timeScale: 0.01 });
  const room = manager.create(gameType);
  const colors = room.colors;
  const players = Array.from({ length: n }, (_, i) => room.join({ name: `S${i}`, color: colors[i], avatar: 'stern' }));
  return { manager, room, players };
}

test('Fotos: höchstens 3 Wechsel pro Spieler und Minute, ein Foto pro Spieler, 12 je Raum', () => {
  const { manager, room, players: [a, b] } = lobbyRoom(2);
  const t0 = 1_000_000;
  room.setFoto(a.id, jpeg(128, 128), t0);
  room.setFoto(a.id, webp('VP8 ', 128, 128), t0 + 1000);
  assert.equal(a.photo.type, 'image/webp', 'neues Foto ersetzt das alte');
  assert.equal(a.photo.v, 2);
  room.setFoto(a.id, null, t0 + 2000);
  assert.equal(a.photo, null);
  assert.throws(() => room.setFoto(a.id, jpeg(128, 128), t0 + 3000), /gerade oft gewechselt/);
  room.setFoto(a.id, jpeg(128, 128), t0 + 61_000);
  assert.ok(a.photo, 'nach einer Minute wieder erlaubt');
  // Abgelehnte Dateien verbrauchen keinen Wechsel
  assert.throws(() => room.setFoto(b.id, jpeg(64, 64), t0), /128 × 128/);
  assert.equal(b.photoTimes.length, 0);
  // Grenze je Raum (Spieler sind höchstens 12, hier künstlich mehr Fotos)
  for (let i = 0; i < 12; i++) room.players.push({ id: `x${i}`, photo: { type: 'image/jpeg', data: jpeg(128, 128), v: 1 } });
  assert.throws(() => room.setFoto(b.id, jpeg(128, 128), t0), /schon 12 Fotos/);
  manager.shutdown();
});

test('Fotos: Snapshot enthält nur einen Verweis, nie das Bild; Host blendet aus', () => {
  const { manager, room, players: [a, b] } = lobbyRoom(2);
  const img = jpeg(128, 128);
  room.setFoto(a.id, img);
  const snap = JSON.stringify(room.snapshot('board'));
  const phone = JSON.stringify(room.snapshot('player', b.id));
  for (const s of [snap, phone]) {
    assert.ok(!s.includes(img.toString('base64').slice(0, 40)), 'keine Bilddaten im Snapshot');
    assert.ok(!/data:image|base64/.test(s));
  }
  const entry = room.snapshot().lobby.find((p) => p.id === a.id);
  assert.equal(entry.photo, `/api/avatar/${room.code}/${a.id}?v=1`);
  assert.equal(entry.avatar, 'stern', 'Avatar bleibt als Rückfall');
  room.hideFoto(a.id, true);
  const hidden = room.snapshot().lobby.find((p) => p.id === a.id);
  assert.equal(hidden.photo, null);
  assert.equal(hidden.photoHidden, true);
  assert.equal(room.fotoOf(a.id), null);
  room.hideFoto(a.id, false);
  assert.ok(room.fotoOf(a.id));
  manager.shutdown();
});

/** Speicher wie in test/persistence.test.js (Ersatz für Postgres, mit JSON-Umwandlung). */
function memoryStore() {
  const rows = new Map();
  return {
    rows,
    async init() {},
    async save(code, state) { rows.set(code, JSON.stringify(state)); },
    async loadAll() { return [...rows.values()].map((s) => JSON.parse(s)); },
    async remove(code) { rows.delete(code); },
    async close() {},
  };
}

test('Fotos: gespeichert mit dem Raum, nach Neustart wieder da, gelöscht mit dem Raum (Schließen und Aufräumen)', async () => {
  const store = memoryStore();
  const m1 = new RoomManager({ testMode: true, timeScale: 0.01, store });
  const room = m1.create('poker');
  const a = room.join({ name: 'Anna', color: room.colors[0], avatar: 'wellen' });
  room.setFoto(a.id, webp('VP8L', 128, 128));
  await m1.saveNow(room);
  assert.match(store.rows.get(room.code), /"photo":\{"type":"image\/webp","data":"UklGR/);
  m1.shutdown();

  const m2 = new RoomManager({ testMode: true, timeScale: 0.01, store });
  assert.equal(await m2.loadFromStore(), 1);
  const back = m2.get(room.code);
  assert.ok(Buffer.isBuffer(back.fotoOf(a.id).data));
  assert.equal(back.players[0].avatar, 'wellen');
  m2.close(room.code);
  await new Promise((r) => setImmediate(r));
  assert.equal(store.rows.size, 0, 'Schließen löscht Raum samt Foto aus dem Speicher');
  assert.equal(m2.get(room.code), undefined);

  // Aufräumen: leerer Raum nach 30 Minuten
  const r2 = m2.create();
  const b = r2.join({ name: 'Ben', color: COLORS[0] });
  r2.setFoto(b.id, jpeg(128, 128));
  await m2.saveNow(r2);
  assert.equal(store.rows.size, 1);
  r2.players = [];
  m2.sweep(Date.now() + 31 * 60 * 1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(store.rows.size, 0, 'Aufräumen löscht Raum samt Foto');
  // Beschädigtes Foto im Speicher: Rückfall auf den Avatar statt Absturz
  const data = r2.serialize();
  data.code = 'KAPU';
  data.players = [{ id: 'p1', token: 't', name: 'C', color: COLORS[1], avatar: 'ringe', photo: { type: 'image/jpeg', data: 'AAAA', v: 1 } }];
  store.rows.set('KAPU', JSON.stringify(data));
  await m2.loadFromStore();
  assert.equal(m2.get('KAPU').players[0].photo, null);
  m2.shutdown();
});

test('Alter Spielstand mit Emoji-Figur lädt: Figur bleibt lesbar, Anzeige nutzt den Avatar', async () => {
  const store = memoryStore();
  const v1 = require(path.join(__dirname, 'fixtures', 'monopoly-raum-v1.json'));
  store.rows.set(v1.code, JSON.stringify({ ...v1, lastActivity: Date.now() }));
  // Lobby-Raum im Format vor den Avataren (Version 2, nur figure)
  const lobby = {
    version: 2, code: 'ALTE', gameType: 'risiko', settings: {}, started: false, lastActivity: Date.now(), game: null,
    players: [
      { id: 'pa', token: 'ta', name: 'Anna', color: COLORS[0], figure: FIGURES[2] },
      { id: 'pb', token: 'tb', name: 'Ben', color: COLORS[1], figure: null },
    ],
  };
  store.rows.set('ALTE', JSON.stringify(lobby));
  const manager = new RoomManager({ testMode: true, timeScale: 0.01, store });
  try {
  assert.equal(await manager.loadFromStore(), 2);
  const mono = manager.get(v1.code);
  assert.deepEqual(mono.players.map((p) => p.avatar), ['ringe', 'streifen'], '🎩 und 🚗 werden zu Motiven');
  assert.deepEqual(mono.players.map((p) => p.figure), ['🎩', '🚗'], 'Feld figure bleibt lesbar');
  const snap = mono.snapshot('board');
  assert.ok(snap.game, 'Partie läuft weiter');
  assert.ok(snap.lobby.every((p) => p.avatar && !('figure' in p) && p.photo === null));
  // Speichern behält figure für ältere Stände, neue Spieler haben keins
  assert.equal(mono.serialize().players[0].figure, '🎩');
  const alt = manager.get('ALTE');
  assert.deepEqual(alt.players.map((p) => p.avatar), ['stern', 'monogramm'], '🐕 → drittes Motiv, ohne Figur Monogramm');
  const neu = alt.join({ name: 'Cem', color: COLORS[2], avatar: 'rauten' });
  assert.ok(!('figure' in alt.serialize().players[2]));
  assert.equal(neu.avatar, 'rauten');
  alt.setGameType('monopoly');
  alt.start();
  assert.equal(alt.game.engine.players.length, 3, 'Monopoly startet ohne Spielfiguren');
  } finally {
    manager.shutdown();
  }
});

test('Fotos über HTTP: nur mit Raum, feste Header, nach dem Schließen weg', async () => {
  const srv = createServer({ testMode: true });
  const port = await srv.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const room = srv.rooms.create();
    const a = room.join({ name: 'Anna', color: COLORS[0] });
    const img = jpeg(128, 128);
    room.setFoto(a.id, img);
    const res = await fetch(`${base}/api/avatar/${room.code}/${a.id}?v=1`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('cache-control'), /max-age=60/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), img);
    assert.equal((await fetch(`${base}/api/avatar/ZZZZ/${a.id}`)).status, 404, 'unbekannter Raum');
    assert.equal((await fetch(`${base}/api/avatar/${room.code}/gibtsnicht`)).status, 404);
    room.hideFoto(a.id, true);
    assert.equal((await fetch(`${base}/api/avatar/${room.code}/${a.id}`)).status, 404, 'ausgeblendet');
    room.hideFoto(a.id, false);
    // Nie öffentlich gelistet: weder Raumabfrage noch Startseite nennen Fotos
    const info = await (await fetch(`${base}/api/rooms/${room.code}`)).text();
    assert.doesNotMatch(info, /avatar|photo|foto/i);
    srv.rooms.close(room.code);
    assert.equal((await fetch(`${base}/api/avatar/${room.code}/${a.id}`)).status, 404, 'Foto weg mit dem Raum');
  } finally {
    await srv.close();
  }
});
