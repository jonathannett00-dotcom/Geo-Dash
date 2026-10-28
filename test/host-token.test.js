'use strict';

/*
 * Host-Token: Nur der Host eines Raums darf Host-Aktionen auslösen. Geprüft werden gültiges,
 * falsches, fehlendes und ersetztes Token für jede Host-Aktion, Zuschauer ohne Token,
 * „Host übernehmen“ (nur ohne verbundenen Host, 15 s Toleranz, Rate-Limit), Neustart mit dem
 * Ersatz-Speicher, alte Räume ohne Token, Handys sowie dass das Token nie in Snapshots, Logs
 * oder an Handys gelangt.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { RoomManager, FIGURES, HOST_GRACE_MS, TAKEOVERS_PER_MINUTE_PER_IP } = require('../server/rooms');
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

const newManager = (store = null, hostGraceMs) => new RoomManager({ testMode: true, seed: 'host', timeScale: 0.01, store, hostGraceMs });
const later = (ms) => Date.now() + ms;

/** Raum mit Host-Ansicht und zwei Handys (Monopoly, Lobby). */
async function setup(store = null, hostGraceMs) {
  const manager = newManager(store, hostGraceMs);
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
  return { manager, net, host, phones, room, code: room.code, token: created.hostToken };
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

test('board:create liefert das Token (24 Byte, Base64url) nur in der Antwort', async () => {
  const { manager, net, token, room } = await setup();
  assert.match(token, /^[A-Za-z0-9_-]{32}$/, '24 Bytes Base64url = 32 Zeichen ohne Auffüllung');
  assert.equal(Buffer.from(token, 'base64url').length, 24);
  assert.equal(room.hostToken, token);
  // Snapshots für Host-Ansicht und Handys enthalten kein Token
  for (const snap of [room.snapshot('board'), room.snapshot('player', room.players[0].id)]) {
    const json = JSON.stringify(snap);
    assert.equal(containsPart(json, token), false);
    assert.equal(/hostToken/.test(json), false);
  }
  // Nichts, was gesendet wurde (Broadcasts), enthält das Token
  assert.equal(containsPart(JSON.stringify(net.sent), token), false);
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

test('Host übernehmen: ohne verbundenen Host klappt es, das alte Token ist danach ungültig', async () => {
  const { manager, net, host, room, token } = await setup(null, 0);
  const tablet = net.socket(manager, '10.0.5.5');
  assert.equal((await tablet.call('board:watch', { code: room.code })).host, false);
  // Der Host trennt sich (ohne Toleranz in diesem Test)
  host.disconnect();
  const res = await tablet.call('host:takeover');
  assert.ok(res.ok, res.error);
  assert.equal(res.host, true);
  assert.match(res.hostToken, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(res.hostToken, token);
  assert.equal(room.hostToken, res.hostToken);
  // Das alte Token gilt nicht mehr: keine Aktion, keine Änderung
  const before = stateOf(room);
  const old = await host.call('board:settings', { startMoney: 3000, hostToken: token });
  assert.equal(old.ok, false);
  assert.match(old.error, /Nur der Host kann das Spiel einstellen/);
  assert.equal(stateOf(room), before);
  // Neu laden mit dem alten Token: Zuschauer mit Hinweis, kein Token in der Antwort
  const reload = await net.socket(manager).call('board:watch', { code: room.code, hostToken: token });
  assert.deepEqual(reload, { ok: true, code: room.code, host: false, tokenInvalid: true });
  // Der neue Host steuert
  assert.ok((await tablet.call('board:settings', { startMoney: 3000, hostToken: res.hostToken })).ok);
  assert.equal(room.settings.startMoney, 3000);
  manager.shutdown();
});

test('Host übernehmen: mit verbundenem Host abgelehnt („Der Host ist verbunden.“), ohne Änderung', async () => {
  const { manager, net, host, room, token } = await setup();
  const tablet = net.socket(manager, '10.0.5.6');
  await tablet.call('board:watch', { code: room.code });
  const before = stateOf(room);
  const res = await tablet.call('host:takeover');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Der Host ist verbunden.');
  assert.equal(room.hostToken, token);
  assert.equal(stateOf(room), before);
  assert.equal(net.sent.some((m) => m.event === 'host:revoked'), false);
  // Der Host selbst kann nicht „übernehmen“
  assert.match((await host.call('host:takeover')).error, /schon der Host/);
  // Auch ein zweites Host-Gerät mit gültigem Token zählt als verbunden
  const second = net.socket(manager, '10.0.5.7');
  assert.equal((await second.call('board:watch', { code: room.code, hostToken: token })).host, true);
  host.disconnect();
  assert.equal((await tablet.call('host:takeover')).error, 'Der Host ist verbunden.');
  manager.shutdown();
});

test('Host übernehmen: 15 Sekunden Toleranz nach einem Verbindungsabbruch, Neuladen verdrängt den Host nicht', async () => {
  assert.equal(HOST_GRACE_MS, 15000);
  const { manager, net, host, room, token } = await setup();
  const tablet = net.socket(manager, '10.0.6.1');
  await tablet.call('board:watch', { code: room.code });
  host.disconnect();
  const left = room.hostLeftAt;
  // Innerhalb der 15 s: abgelehnt
  assert.equal((await tablet.call('host:takeover')).error, 'Der Host ist verbunden.');
  assert.throws(() => manager.takeOverHost(room, { ip: '10.0.6.2', now: left + 14999 }), /Der Host ist verbunden\./);
  // Kurzes Neuladen: der Host meldet sich mit seinem Token wieder an und bleibt Host
  const reloaded = net.socket(manager);
  assert.equal((await reloaded.call('board:watch', { code: room.code, hostToken: token })).host, true);
  assert.throws(() => manager.takeOverHost(room, { ip: '10.0.6.3', now: later(HOST_GRACE_MS + 1000) }), /Der Host ist verbunden\./, 'verbunden ist verbunden, egal wie lange');
  // Erneut getrennt: nach Ablauf der 15 s geht die Übernahme
  reloaded.disconnect();
  const res = manager.takeOverHost(room, { ip: '10.0.6.4', now: room.hostLeftAt + HOST_GRACE_MS });
  assert.notEqual(res.hostToken, token);
  assert.equal(room.isHostToken(token), false);
  manager.shutdown();
});

test('Host übernehmen: höchstens 5 Versuche pro Minute und IP', async () => {
  const { manager, net, room } = await setup();
  const tablet = net.socket(manager, '10.0.7.7');
  await tablet.call('board:watch', { code: room.code });
  for (let i = 0; i < TAKEOVERS_PER_MINUTE_PER_IP; i++) assert.equal((await tablet.call('host:takeover')).error, 'Der Host ist verbunden.');
  const locked = await tablet.call('host:takeover');
  assert.equal(locked.ok, false);
  assert.match(locked.error, /Zu viele Versuche, die Host-Rolle zu übernehmen\. Bitte warte eine Minute/);
  // Auch ohne verbundenen Host bleibt die Sperre bis zum Ablauf der Minute
  assert.throws(() => manager.takeOverHost(room, { ip: '10.0.7.7', now: later(HOST_GRACE_MS + 1000) }), /Zu viele Versuche/);
  // Eine andere IP ist nicht betroffen; nach einer Minute geht es wieder
  assert.equal((await net.socket(manager, '10.0.7.8').call('board:watch', { code: room.code })).ok, true);
  for (const s of [...room.hostSockets]) room.leaveHost(s, Date.now() - HOST_GRACE_MS);
  assert.ok(manager.takeOverHost(room, { ip: '10.0.7.7', now: later(61 * 1000) }).hostToken);
  manager.shutdown();
});

test('Zuschauer ohne Token: Spielansicht ohne Host-Rechte, kein Token in der Antwort', async () => {
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

test('Handys: keine Host-Aktionen, auch nicht mit Token im richtigen Format oder dem echten Token', async () => {
  const { manager, net, host, phones, room, token } = await setup(null, 0);
  const guessed = crypto.randomBytes(24).toString('base64url');
  for (const hostToken of [undefined, guessed, token]) {
    for (const event of ['board:settings', 'board:game', 'board:start', 'board:end', 'board:lobby', 'board:close', 'board:foto', 'debug:dice']) {
      const before = stateOf(room);
      const res = await phones[0].call(event, { hostToken, gameType: 'poker', startMoney: 999, playerId: room.players[1].id });
      assert.equal(res.ok, false, `${event} vom Handy`);
      assert.equal(stateOf(room), before);
    }
  }
  // Host übernehmen geht am Handy nicht – auch dann nicht, wenn kein Host verbunden ist
  host.disconnect();
  assert.equal(room.hostConnected(), false);
  const takeover = await phones[0].call('host:takeover', { hostToken: token });
  assert.equal(takeover.ok, false);
  assert.match(takeover.error, /Nur eine Host-Ansicht kann die Host-Rolle übernehmen/);
  assert.equal(room.hostToken, token, 'Token unverändert');
  assert.equal(net.sent.some((m) => m.event === 'host:revoked'), false);
  // Spielabsicht „Spiel beenden“ geht nicht
  assert.equal((await phones[0].call('act', { type: 'end', hostToken: token })).ok, false);
  assert.ok(manager.get(room.code));
  manager.shutdown();
});

test('Das Token erreicht nie ein Handy und steht nie in Logs', async () => {
  const logs = captureLogs();
  let ctx;
  try {
    ctx = await setup();
    const { manager, net, host, room, token } = ctx;
    await host.call('board:settings', { startMoney: 1800, hostToken: token });
    await host.call('board:settings', { startMoney: -5, hostToken: token });     // Ablehnung mit Meldung
    await host.call('board:start', { hostToken: token });
    await ctx.phones[0].call('act', { type: 'roll' });
    await ctx.phones[1].call('board:end', { hostToken: token });
    const viewer = net.socket(manager);
    await viewer.call('board:watch', { code: room.code, hostToken: `${token}x` });
    await viewer.call('host:takeover');
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
    assert.equal(/hostToken/.test(phoneText), false);
    assert.equal(containsPart(JSON.stringify(net.sent), token), false, 'auch kein Broadcast an die Host-Ansicht');
    assert.equal(containsPart(logs.lines.join('\n'), token), false, 'Logs ohne Token');
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
  first.manager.shutdown();

  const manager = newManager(store);
  await manager.loadFromStore();
  const room = manager.get(first.code);
  const net = fakeIo();
  manager.io = net.io;
  // Ein Zuschauer zuerst: bekommt keine Host-Rolle (Übergangsregel gilt nur für Räume ohne Token)
  // und kann sie auch nicht übernehmen – nach dem Neustart hat der Host 15 s, sich wieder zu melden
  const viewer = net.socket(manager);
  assert.equal((await viewer.call('board:watch', { code: room.code })).host, false);
  assert.equal((await viewer.call('host:takeover')).error, 'Der Host ist verbunden.');
  const host = net.socket(manager);
  const res = await host.call('board:watch', { code: room.code, hostToken: first.token });
  assert.deepEqual(res, { ok: true, code: room.code, host: true });
  assert.ok((await host.call('board:start', { hostToken: first.token })).ok);
  assert.equal(room.started, true);
  manager.shutdown();
});

test('Alter gespeicherter Raum ohne Token: neues Token, die erste Host-Ansicht übernimmt es', async () => {
  const store = memoryStore();
  const first = await setup(store);
  first.room.broadcast();
  await first.manager.flush();
  first.manager.shutdown();
  // Stand von vor dem Deploy: ohne hostToken
  const old = JSON.parse(store.rows.get(first.code));
  delete old.hostToken;
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
      assert.equal(/hostToken/.test(text), false, url);
    }
    const joinUrl = (await (await fetch(`${base}/api/join-url?room=${code}`)).json()).url;
    assert.equal(new URL(joinUrl).search, `?room=${code}`, 'QR-Adresse nur mit Raumcode');
    assert.equal(containsPart(logs.lines.join('\n'), hostToken), false);
  } finally {
    logs.restore();
    await srv.close();
  }
});
