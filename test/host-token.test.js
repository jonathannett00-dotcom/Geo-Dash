'use strict';

/*
 * Host-Token und Host-Code: Nur der Host eines Raums darf Host-Aktionen auslösen.
 * Geprüft werden gültiges, falsches, fehlendes und ersetztes Token für jede Host-Aktion,
 * Zuschauer ohne Token, Übernahme per Host-Code mit Sperre, Neustart mit dem Ersatz-Speicher,
 * alte Räume ohne Token, Handys sowie dass Token und Code nie in Snapshots, Logs oder an
 * Handys gelangen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { RoomManager, FIGURES } = require('../server/rooms');
const { createServer } = require('../server');

function memoryStore() {
  const rows = new Map();
  return {
    rows,
    async init() {},
    async save(code, state) { rows.set(code, JSON.stringify(state)); },
    async load(code) { return rows.has(code) ? JSON.parse(rows.get(code)) : null; },
    async loadAll() { return [...rows.values()].map((s) => JSON.parse(s)); },
    async remove(code) { rows.delete(code); },
    async close() {},
  };
}

/** Ersatz für Socket.IO; jede Nachricht wird mit Ziel gesammelt (auch an einzelne Sockets). */
function fakeIo() {
  const sent = [];
  const io = { sent, to: (target) => ({ emit: (event, data) => sent.push({ target, event, data }) }) };
  let n = 0;
  const socket = (manager, ip = '10.0.0.1') => {
    const handlers = {};
    const s = {
      id: `s${++n}`, data: {}, rooms: new Set(), handshake: { headers: { 'x-forwarded-for': ip }, address: ip }, nsp: { server: io },
      on: (ev, fn) => { handlers[ev] = fn; },
      join: (r) => s.rooms.add(r),
      call: (ev, payload = {}) => new Promise((resolve) => handlers[ev](payload, resolve)),
      disconnect: () => handlers.disconnect && handlers.disconnect(),
    };
    manager.bindSocket(s);
    return s;
  };
  return { io, sent, socket };
}

const newManager = (store = null) => new RoomManager({ testMode: true, seed: 'host', timeScale: 0.01, store });

/** Raum mit Host-Ansicht und zwei Handys (Monopoly, Lobby). */
async function setup(store = null) {
  const manager = newManager(store);
  const net = fakeIo();
  manager.io = net.io;
  const host = net.socket(manager);
  const created = await host.call('board:create');
  assert.ok(created.ok, created.error);
  const room = manager.get(created.code);
  const phones = [];
  for (const [i, name] of ['Anna', 'Ben'].entries()) {
    const phone = net.socket(manager, `10.0.1.${i + 1}`);
    const res = await phone.call('player:join', { code: room.code, name, color: room.colors[i], figure: FIGURES[i] });
    assert.ok(res.ok, res.error);
    phones.push(phone);
  }
  return { manager, net, host, phones, room, code: room.code, token: created.hostToken, hostCode: created.hostCode };
}

/** Zustand ohne Zeitstempel – damit „keine Änderung“ prüfbar ist. */
const stateOf = (room) => { const s = room.serialize(); delete s.lastActivity; return JSON.stringify(s); };

/** Alle Teilstücke des Tokens ab 8 Zeichen (auch kein Teilstring darf irgendwo auftauchen). */
function containsPart(text, secret, min = 8) {
  for (let i = 0; i + min <= secret.length; i++) if (text.includes(secret.slice(i, i + min))) return true;
  return false;
}

/** Fängt alle Konsolenausgaben ein (Logs dürfen das Token nie enthalten). */
function captureLogs() {
  const lines = [];
  const saved = {};
  for (const k of ['log', 'error', 'warn', 'info']) {
    saved[k] = console[k];
    console[k] = (...args) => lines.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  }
  return { lines, restore: () => Object.assign(console, saved) };
}

test('board:create liefert Token (24 Byte, Base64url) und sechsstelligen Host-Code nur in der Antwort', async () => {
  const { manager, net, token, hostCode, room } = await setup();
  assert.match(token, /^[A-Za-z0-9_-]{32}$/, '24 Bytes Base64url = 32 Zeichen ohne Auffüllung');
  assert.equal(Buffer.from(token, 'base64url').length, 24);
  assert.match(hostCode, /^\d{6}$/);
  assert.equal(room.hostToken, token);
  // Snapshots für Host-Ansicht und Handys enthalten weder Token noch Code
  for (const snap of [room.snapshot('board'), room.snapshot('player', room.players[0].id)]) {
    const json = JSON.stringify(snap);
    assert.equal(containsPart(json, token), false);
    assert.equal(json.includes(`"${hostCode}"`), false);
    assert.equal(/hostToken|hostCode/.test(json), false);
  }
  // Nichts, was gesendet wurde (Broadcasts), enthält Token oder Code
  const all = JSON.stringify(net.sent);
  assert.equal(containsPart(all, token), false);
  assert.equal(all.includes(`"${hostCode}"`), false);
  manager.shutdown();
});

test('Jede Host-Aktion: gültiges Token geht, falsches, fehlendes und ersetztes werden ohne Änderung abgelehnt', async () => {
  const { manager, net, host, room, token } = await setup();
  const fotoPlayer = room.players[0].id;
  const actions = [
    ['board:settings', { startMoney: 2000 }],
    ['board:game', { gameType: 'risiko' }],
    ['board:foto', { playerId: fotoPlayer, hidden: true }],
    ['debug:dice', { dice: [[1, 2]] }],
    ['board:start', {}],
    ['board:end', {}],
    ['board:lobby', {}],
    ['board:close', {}],
  ];
  // Eine zweite Host-Ansicht ohne Token (Zuschauer) für die Ablehnungen
  const viewer = net.socket(manager, '10.0.9.9');
  const watched = await viewer.call('board:watch', { code: room.code });
  assert.equal(watched.host, false);
  const otherToken = crypto.randomBytes(24).toString('base64url');
  for (const [event, payload] of actions) {
    for (const [label, bad] of [['fehlend', undefined], ['falsch', otherToken], ['leer', ''], ['kein Text', { length: 32 }], ['Teilstück', token.slice(0, 31)]]) {
      for (const sock of [viewer, host]) {
        const before = stateOf(room);
        const res = await sock.call(event, { ...payload, ...(bad === undefined ? {} : { hostToken: bad }) });
        assert.equal(res.ok, false, `${event} mit ${label}em Token muss abgelehnt werden`);
        assert.match(res.error, /Nur der Host kann .+Dieses Gerät sieht nur zu/);
        assert.equal(stateOf(room), before, `${event} (${label}): keine Zustandsänderung`);
        assert.ok(manager.get(room.code), 'Raum besteht weiter');
      }
    }
    const res = await host.call(event, { ...payload, hostToken: token });
    assert.ok(res.ok, `${event} mit gültigem Token: ${res.error}`);
    if (event === 'board:game') assert.equal(room.gameType, 'risiko');
    if (event === 'board:foto') assert.equal(room.players[0].photoHidden, true);
  }
  assert.equal(manager.get(room.code), undefined, 'Raum mit gültigem Token geschlossen');
  manager.shutdown();
});

test('Altes (ersetztes) Token: nach der Übernahme per Host-Code gilt nur noch das neue', async () => {
  const { manager, net, host, room, token, hostCode } = await setup();
  const tablet = net.socket(manager, '10.0.5.5');
  assert.equal((await tablet.call('board:watch', { code: room.code })).host, false);
  const claim = await tablet.call('host:claim', { code: hostCode });
  assert.ok(claim.ok, claim.error);
  assert.notEqual(claim.hostToken, token);
  assert.match(claim.hostCode, /^\d{6}$/);
  assert.equal(room.hostToken, claim.hostToken);
  // Das alte Gerät bekommt Bescheid und darf nichts mehr
  assert.ok(net.sent.some((m) => m.event === 'host:revoked' && Array.isArray(m.target) && m.target.includes(host.id)));
  const before = stateOf(room);
  const old = await host.call('board:settings', { startMoney: 3000, hostToken: token });
  assert.equal(old.ok, false);
  assert.match(old.error, /Nur der Host kann das Spiel einstellen/);
  assert.equal(stateOf(room), before);
  // Neu laden mit dem alten Token: Zuschauer mit Hinweis
  const reload = await net.socket(manager).call('board:watch', { code: room.code, hostToken: token });
  assert.equal(reload.host, false);
  assert.equal(reload.tokenInvalid, true);
  assert.equal('hostCode' in reload || 'hostToken' in reload, false);
  // Der alte Host-Code gilt auch nicht mehr
  if (claim.hostCode !== hostCode) assert.equal((await host.call('host:claim', { code: hostCode })).ok, false);
  assert.ok((await tablet.call('board:settings', { startMoney: 3000, hostToken: claim.hostToken })).ok);
  assert.equal(room.settings.startMoney, 3000);
  manager.shutdown();
});

test('Zuschauer ohne Token: Spielansicht ohne Host-Rechte, weder Token noch Code in der Antwort', async () => {
  const { manager, net, room } = await setup();
  const viewer = net.socket(manager);
  const res = await viewer.call('board:watch', { code: room.code });
  assert.ok(res.ok);
  assert.deepEqual(res, { ok: true, code: room.code, host: false });
  // Der Zuschauer bekommt dieselben Snapshots wie die Host-Ansicht (Spielansicht)
  assert.ok(viewer.rooms.has(`${room.code}:board`));
  const start = await viewer.call('board:start', {});
  assert.equal(start.ok, false);
  assert.equal(room.started, false);
  manager.shutdown();
});

test('Host-Code: richtig, falsch, Sperre nach 5 Fehlversuchen pro Minute und IP', async () => {
  const { manager, net, room, hostCode } = await setup();
  const wrong = String((Number(hostCode) + 1) % 1000000).padStart(6, '0');
  const tablet = net.socket(manager, '10.0.7.7');
  await tablet.call('board:watch', { code: room.code });
  // Falsch (auch Unsinn zählt als Fehlversuch)
  const bad = await tablet.call('host:claim', { code: wrong });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Der Host-Code stimmt nicht/);
  for (const c of ['12345', 'abcdef', '']) assert.equal((await tablet.call('host:claim', { code: c })).ok, false);
  assert.equal((await tablet.call('host:claim', { code: wrong })).ok, false);   // 5. Fehlversuch
  const locked = await tablet.call('host:claim', { code: hostCode });
  assert.equal(locked.ok, false, 'nach 5 Fehlversuchen ist auch der richtige Code gesperrt');
  assert.match(locked.error, /Zu viele falsche Host-Codes\. Bitte warte eine Minute/);
  // Nach einer Minute geht es wieder (Zeit vorgestellt)
  const later = manager.claimHost(room, hostCode, { ip: '10.0.7.7', now: Date.now() + 61 * 1000 });
  assert.match(later.hostToken, /^[A-Za-z0-9_-]{32}$/);
  // Leerzeichen im Code sind erlaubt („482 913“)
  const other = net.socket(manager, '10.0.7.8');
  await other.call('board:watch', { code: room.code });
  const spaced = await other.call('host:claim', { code: `${later.hostCode.slice(0, 3)} ${later.hostCode.slice(3)}` });
  assert.ok(spaced.ok, spaced.error);
  assert.equal(room.hostToken, spaced.hostToken);
  manager.shutdown();
});

test('Host-Code: Sperre nach 10 Fehlversuchen pro Raum und Stunde, auch von verschiedenen IPs', async () => {
  const { manager, net, room, hostCode } = await setup();
  const wrong = String((Number(hostCode) + 7) % 1000000).padStart(6, '0');
  for (let i = 0; i < 10; i++) {
    const s = net.socket(manager, `10.1.0.${i}`);
    await s.call('board:watch', { code: room.code });
    assert.equal((await s.call('host:claim', { code: wrong })).ok, false);
  }
  const s = net.socket(manager, '10.2.0.1');
  await s.call('board:watch', { code: room.code });
  const locked = await s.call('host:claim', { code: hostCode });
  assert.equal(locked.ok, false);
  assert.match(locked.error, /zu viele falsche Host-Codes\. Die Übernahme ist für eine Stunde gesperrt/);
  assert.equal(room.hostCode, hostCode, 'nichts geändert');
  // Nach einer Stunde wieder möglich
  assert.ok(manager.claimHost(room, hostCode, { ip: '10.2.0.2', now: Date.now() + 61 * 60 * 1000 }).hostToken);
  manager.shutdown();
});

test('Handys: keine Host-Aktionen, auch nicht mit Token im richtigen Format oder dem echten Token', async () => {
  const { manager, phones, room, token, hostCode } = await setup();
  const guessed = crypto.randomBytes(24).toString('base64url');
  for (const hostToken of [undefined, guessed, token]) {
    for (const event of ['board:settings', 'board:game', 'board:start', 'board:end', 'board:lobby', 'board:close', 'board:foto', 'debug:dice']) {
      const before = stateOf(room);
      const res = await phones[0].call(event, { hostToken, gameType: 'poker', startMoney: 999, playerId: room.players[1].id });
      assert.equal(res.ok, false, `${event} vom Handy`);
      assert.equal(stateOf(room), before);
    }
  }
  // Host-Code am Handy einzugeben geht nicht
  const claim = await phones[0].call('host:claim', { code: hostCode });
  assert.equal(claim.ok, false);
  assert.match(claim.error, /nur in der Host-Ansicht/);
  // Spielabsicht „Spiel beenden“ geht nicht
  assert.equal((await phones[0].call('act', { type: 'end', hostToken: token })).ok, false);
  assert.ok(manager.get(room.code));
  manager.shutdown();
});

test('Token und Host-Code erreichen nie ein Handy und stehen nie in Logs', async () => {
  const logs = captureLogs();
  let ctx;
  try {
    ctx = await setup();
    const { manager, net, host, room, token, hostCode } = ctx;
    await host.call('board:settings', { startMoney: 1800, hostToken: token });
    await host.call('board:settings', { startMoney: -5, hostToken: token });     // Ablehnung mit Meldung
    await host.call('board:start', { hostToken: token });
    await ctx.phones[0].call('act', { type: 'roll' });
    await ctx.phones[1].call('board:end', { hostToken: token });
    const viewer = net.socket(manager);
    await viewer.call('board:watch', { code: room.code, hostToken: `${token}x` });
    await viewer.call('host:claim', { code: '000000' === hostCode ? '111111' : '000000' });
    // Interner Fehler wird geloggt – ohne Token
    const saved = room.endGame;
    room.endGame = () => { throw new Error('kaputt'); };
    const res = await host.call('board:end', { hostToken: token });
    room.endGame = saved;
    assert.match(res.error, /Interner Fehler/);
    assert.ok(logs.lines.length > 0, 'es wurde etwas geloggt');
    const phoneIds = new Set(ctx.phones.map((p) => p.id));
    const toPhones = net.sent.filter((m) => m.target === `${room.code}:players` || (Array.isArray(m.target) && m.target.some((t) => phoneIds.has(t))));
    assert.ok(toPhones.length > 0);
    const phoneText = JSON.stringify(toPhones);
    assert.equal(containsPart(phoneText, token), false);
    assert.equal(/hostCode|hostToken/.test(phoneText), false);
    assert.equal(phoneText.includes(`"${hostCode}"`), false);
    assert.equal(containsPart(JSON.stringify(net.sent), token), false, 'auch kein Broadcast an die Host-Ansicht');
    assert.equal(containsPart(logs.lines.join('\n'), token), false, 'Logs ohne Token');
    assert.equal(logs.lines.join('\n').includes(hostCode), false, 'Logs ohne Host-Code');
  } finally {
    logs.restore();
    if (ctx) ctx.manager.shutdown();
  }
});

test('Vergleich zeitkonstant mit crypto.timingSafeEqual', async () => {
  const { manager, room, token } = await setup();
  const original = crypto.timingSafeEqual;
  let calls = 0;
  crypto.timingSafeEqual = (a, b) => { calls++; return original(a, b); };
  try {
    assert.equal(room.isHostToken(token), true);
    assert.equal(room.isHostToken('x'), false);
    assert.ok(calls >= 2);
  } finally {
    crypto.timingSafeEqual = original;
    manager.shutdown();
  }
});

test('Neustart mit Ersatz-Speicher: der Host ist nicht ausgesperrt, Zuschauer bleiben Zuschauer', async () => {
  const store = memoryStore();
  const first = await setup(store);
  first.room.broadcast();
  await first.manager.flush();
  const saved = JSON.parse(store.rows.get(first.code));
  assert.equal(saved.hostToken, first.token, 'Token liegt im Raumzustand');
  assert.equal(saved.hostCode, first.hostCode);
  first.manager.shutdown();

  const manager = newManager(store);
  await manager.loadFromStore();
  const room = manager.get(first.code);
  const net = fakeIo();
  manager.io = net.io;
  // Ein Zuschauer zuerst: bekommt keine Host-Rolle (Übergangsregel gilt nur für Räume ohne Token)
  assert.equal((await net.socket(manager).call('board:watch', { code: room.code })).host, false);
  const host = net.socket(manager);
  const res = await host.call('board:watch', { code: room.code, hostToken: first.token });
  assert.deepEqual(res, { ok: true, code: room.code, host: true, hostCode: first.hostCode });
  assert.ok((await host.call('board:start', { hostToken: first.token })).ok);
  assert.equal(room.started, true);
  // Auch der Host-Code überlebt den Neustart
  const tablet = net.socket(manager);
  await tablet.call('board:watch', { code: room.code });
  assert.ok((await tablet.call('host:claim', { code: first.hostCode })).ok);
  manager.shutdown();
});

test('Alter gespeicherter Raum ohne Token: neues Token, die erste Host-Ansicht übernimmt es', async () => {
  const store = memoryStore();
  const first = await setup(store);
  first.room.broadcast();
  await first.manager.flush();
  first.manager.shutdown();
  // Stand von vor dem Deploy: ohne hostToken und hostCode
  const old = JSON.parse(store.rows.get(first.code));
  delete old.hostToken;
  delete old.hostCode;
  store.rows.set(first.code, JSON.stringify(old));

  const manager = newManager(store);
  await manager.loadFromStore();
  const room = manager.get(first.code);
  assert.match(room.hostToken, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(room.hostToken, first.token);
  assert.equal(room.hostClaimable, true);
  const net = fakeIo();
  manager.io = net.io;
  const tv = net.socket(manager);
  const res = await tv.call('board:watch', { code: room.code });
  assert.equal(res.host, true, 'erste Host-Ansicht übernimmt');
  assert.equal(res.hostToken, room.hostToken);
  assert.equal(res.hostCode, room.hostCode);
  // Die zweite Ansicht ist nur noch Zuschauer
  const second = await net.socket(manager).call('board:watch', { code: room.code });
  assert.deepEqual(second, { ok: true, code: room.code, host: false });
  assert.ok((await tv.call('board:start', { hostToken: res.hostToken })).ok);
  // Gespeichert ohne Übergangsmarke
  room.broadcast();
  await manager.flush();
  const saved = JSON.parse(store.rows.get(room.code));
  assert.equal(saved.hostToken, res.hostToken);
  assert.equal('hostClaimable' in saved, false);
  manager.shutdown();
});

test('HTTP: POST /api/rooms liefert das Token nur dort; Raumabfrage, Beitrittsadresse und QR ohne Token', async () => {
  const logs = captureLogs();
  const srv = createServer({ testMode: true, seed: 'host' });
  try {
    const port = await srv.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const made = await fetch(`${base}/api/rooms`, { method: 'POST' });
    assert.equal(made.status, 201);
    assert.equal(made.headers.get('cache-control'), 'no-store');
    const { code, hostToken } = await made.json();
    assert.equal(srv.rooms.get(code).hostToken, hostToken);
    for (const url of [`/api/rooms/${code}`, `/api/join-url?room=${code}`, `/api/qr.svg?room=${code}`, '/healthz']) {
      const text = await (await fetch(base + url)).text();
      assert.equal(containsPart(text, hostToken), false, url);
      assert.equal(/hostToken|hostCode/.test(text), false, url);
    }
    const joinUrl = (await (await fetch(`${base}/api/join-url?room=${code}`)).json()).url;
    assert.equal(new URL(joinUrl).search, `?room=${code}`, 'QR-Adresse nur mit Raumcode');
    assert.equal(containsPart(logs.lines.join('\n'), hostToken), false);
  } finally {
    logs.restore();
    await srv.close();
  }
});
