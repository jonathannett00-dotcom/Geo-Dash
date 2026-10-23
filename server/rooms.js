'use strict';

const crypto = require('crypto');

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_PLAYERS = 10;
const MIN_PLAYERS = 2;
const RECONNECT_GRACE_MS = 5 * 60 * 1000;
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

const COLORS = ['#e63946', '#1d72d8', '#2a9d8f', '#f4a261', '#8e44ad', '#e9c46a', '#ff6fb5', '#264653', '#8ac926', '#795548'];
const FIGURES = ['🎩', '🚗', '🐕', '🚢', '👢', '🐈', '🦆', '🦖', '✈️', '🎸'];

/** Fehler, deren Text dem Spieler angezeigt wird. */
class UserError extends Error {
  constructor(message) { super(message); this.name = 'UserError'; }
}
const fail = (msg) => { throw new UserError(msg); };

class Room {
  constructor(code, manager) {
    this.code = code;
    this.manager = manager;
    this.config = manager.config;
    this.players = [];
    this.settings = { startMoney: 1500 };
    this.started = false;
    this.lastActivity = Date.now();
  }

  get io() { return this.manager.io; }

  touch() { this.lastActivity = Date.now(); }

  playerById(id) { return this.players.find((p) => p.id === id); }

  /* ---------- Lobby ---------- */

  join({ name, color, figure }) {
    if (this.started) fail('Das Spiel läuft bereits – neue Spieler können nicht mehr beitreten.');
    if (this.players.length >= MAX_PLAYERS) fail(`Der Raum ist voll (maximal ${MAX_PLAYERS} Spieler).`);
    name = String(name || '').trim().replace(/\s+/g, ' ');
    if (!name) fail('Bitte gib einen Namen ein.');
    if (name.length > 16) fail('Der Name darf höchstens 16 Zeichen lang sein.');
    if (this.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) fail(`Der Name „${name}“ ist schon vergeben.`);
    if (!COLORS.includes(color)) fail('Bitte wähle eine Farbe.');
    if (!FIGURES.includes(figure)) fail('Bitte wähle eine Spielfigur.');
    if (this.players.some((p) => p.color === color)) fail('Diese Farbe ist schon vergeben.');
    if (this.players.some((p) => p.figure === figure)) fail('Diese Spielfigur ist schon vergeben.');

    const player = {
      id: `p${crypto.randomBytes(4).toString('hex')}`,
      token: crypto.randomBytes(16).toString('hex'),
      name,
      color,
      figure,
      connected: false,
      sockets: new Set(),
      leaveTimer: null,
    };
    this.players.push(player);
    return player;
  }

  resume(token) {
    const player = this.players.find((p) => p.token === token);
    if (!player) fail('Deine Sitzung ist abgelaufen. Bitte tritt neu bei.');
    return player;
  }

  setStartMoney(value) {
    if (this.started) fail('Das Spiel läuft bereits.');
    const v = Math.floor(Number(value));
    if (!Number.isFinite(v) || v < 100 || v > 100000) fail('Der Startbetrag muss zwischen 100 und 100.000 M liegen.');
    this.settings.startMoney = v;
  }

  start() {
    if (this.started) fail('Das Spiel läuft bereits.');
    if (this.players.length < MIN_PLAYERS) fail(`Es werden mindestens ${MIN_PLAYERS} Spieler gebraucht.`);
    this.started = true;
  }

  /* ---------- Verbindungen ---------- */

  attach(socket, player) {
    socket.join(`${this.code}:players`);
    socket.data.code = this.code;
    socket.data.role = 'player';
    socket.data.playerId = player.id;
    player.sockets.add(socket.id);
    player.connected = true;
    clearTimeout(player.leaveTimer);
    player.leaveTimer = null;
  }

  detach(socket) {
    const player = this.playerById(socket.data.playerId);
    if (!player) return;
    player.sockets.delete(socket.id);
    if (player.sockets.size) return;
    player.connected = false;
    clearTimeout(player.leaveTimer);
    player.leaveTimer = setTimeout(() => this.dropPlayer(player.id), RECONNECT_GRACE_MS);
    player.leaveTimer.unref?.();
  }

  /** Spieler war zu lange getrennt. */
  dropPlayer(id) {
    const player = this.playerById(id);
    if (!player || player.connected) return;
    player.leaveTimer = null;
    if (!this.started) this.players = this.players.filter((p) => p.id !== id);
    this.broadcast();
  }

  /* ---------- Zustand an Clients ---------- */

  snapshot() {
    return {
      code: this.code,
      now: Date.now(),
      started: this.started,
      settings: this.settings,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      colors: COLORS,
      figures: FIGURES,
      lobby: this.players.map((p) => ({ id: p.id, name: p.name, color: p.color, figure: p.figure, connected: p.connected })),
    };
  }

  broadcast() {
    if (!this.io) return;
    const snap = this.snapshot();
    this.io.to(`${this.code}:board`).emit('state', { ...snap, role: 'board' });
    this.io.to(`${this.code}:players`).emit('state', { ...snap, role: 'player' });
  }

  dispose() {
    this.players.forEach((p) => clearTimeout(p.leaveTimer));
  }
}

class RoomManager {
  constructor(config = {}) {
    this.config = config;
    this.io = null;
    this.rooms = new Map();
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  get size() { return this.rooms.size; }

  get(code) { return this.rooms.get(String(code || '').toUpperCase()); }

  create() {
    let code;
    do {
      code = Array.from({ length: 4 }, () => CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)]).join('');
    } while (this.rooms.has(code));
    const room = new Room(code, this);
    this.rooms.set(code, room);
    return room;
  }

  /** Löscht Räume nach 6 h ohne Aktivität. */
  sweep(now = Date.now()) {
    for (const [code, room] of this.rooms) {
      if (now - room.lastActivity > ROOM_IDLE_MS) {
        room.dispose();
        this.rooms.delete(code);
      }
    }
  }

  shutdown() {
    clearInterval(this.sweeper);
    for (const room of this.rooms.values()) room.dispose();
    this.rooms.clear();
  }

  requireRoom(code) {
    const room = this.get(code);
    if (!room) fail('Diesen Raum gibt es nicht (mehr). Bitte prüfe den Code.');
    return room;
  }

  /** Verbindet einen Socket mit allen Ereignissen. */
  bindSocket(socket) {
    if (!this.io) this.io = socket.nsp.server;

    const handle = (event, fn) => {
      socket.on(event, (payload, ack) => {
        if (typeof payload === 'function') { ack = payload; payload = {}; }
        const reply = typeof ack === 'function' ? ack : () => {};
        let room = null;
        try {
          const res = fn(payload || {}, (r) => { room = r; });
          reply({ ok: true, ...(res || {}) });
        } catch (err) {
          if (err.name === 'UserError' || err.name === 'RuleError') {
            reply({ ok: false, error: err.message });
          } else {
            console.error(err);
            reply({ ok: false, error: 'Interner Fehler – bitte nochmal versuchen.' });
          }
        }
        if (room) {
          room.touch();
          room.broadcast();
        }
      });
    };

    const ownRoom = () => {
      const room = this.get(socket.data.code);
      if (!room) fail('Du bist mit keinem Raum verbunden.');
      return room;
    };

    handle('board:create', (_, use) => {
      const room = this.create();
      socket.join(`${room.code}:board`);
      socket.data.code = room.code;
      socket.data.role = 'board';
      use(room);
      return { code: room.code };
    });

    handle('board:watch', ({ code }, use) => {
      const room = this.requireRoom(code);
      socket.join(`${room.code}:board`);
      socket.data.code = room.code;
      socket.data.role = 'board';
      use(room);
      return { code: room.code };
    });

    handle('board:settings', ({ startMoney }, use) => {
      const room = ownRoom();
      if (socket.data.role !== 'board') fail('Nur das Tablet kann das Spiel einstellen.');
      room.setStartMoney(startMoney);
      use(room);
    });

    handle('board:start', (_, use) => {
      const room = ownRoom();
      if (socket.data.role !== 'board') fail('Nur das Tablet kann das Spiel starten.');
      room.start();
      use(room);
    });

    handle('room:info', ({ code }) => {
      const room = this.requireRoom(code);
      const snap = room.snapshot();
      return { started: snap.started, lobby: snap.lobby, colors: COLORS, figures: FIGURES, full: snap.lobby.length >= MAX_PLAYERS };
    });

    handle('player:join', ({ code, name, color, figure }, use) => {
      const room = this.requireRoom(code);
      const player = room.join({ name, color, figure });
      room.attach(socket, player);
      use(room);
      return { token: player.token, playerId: player.id, code: room.code };
    });

    handle('player:resume', ({ code, token }, use) => {
      const room = this.requireRoom(code);
      const player = room.resume(String(token || ''));
      room.attach(socket, player);
      use(room);
      return { playerId: player.id, code: room.code };
    });

    socket.on('disconnect', () => {
      const room = this.get(socket.data.code);
      if (!room || socket.data.role !== 'player') return;
      room.detach(socket);
      room.broadcast();
    });
  }
}

module.exports = { RoomManager, Room, UserError, COLORS, FIGURES, MAX_PLAYERS, MIN_PLAYERS, RECONNECT_GRACE_MS, ROOM_IDLE_MS };
