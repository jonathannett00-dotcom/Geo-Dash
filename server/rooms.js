'use strict';

const crypto = require('crypto');
const { createRng } = require('./rng');
const { GAMES, DEFAULT_GAME } = require('./games');
const { TIMING, MINIGAMES } = require('./monopoly');

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
  constructor(code, manager, gameType = DEFAULT_GAME) {
    if (!GAMES[gameType]) fail('Dieses Spiel gibt es nicht.');
    this.code = code;
    this.manager = manager;
    this.config = manager.config;
    this.gameType = gameType;
    this.module = GAMES[gameType];
    this.players = [];
    this.settings = this.module.defaultSettings();
    this.started = false;
    this.lastActivity = Date.now();
    this.rng = createRng(this.config.seed);
    this.game = null;
    this.timers = {};
    this.pendingDice = [];
  }

  get timeScale() { return this.config.timeScale ?? 1; }

  get io() { return this.manager.io; }

  get maxPlayers() { return Math.min(this.module.maxPlayers, MAX_PLAYERS); }

  get minPlayers() { return this.module.minPlayers; }

  touch() { this.lastActivity = Date.now(); }

  playerById(id) { return this.players.find((p) => p.id === id); }

  /* ---------- Lobby ---------- */

  join({ name, color, figure }) {
    if (this.started) fail('Das Spiel läuft bereits – neue Spieler können nicht mehr beitreten.');
    if (this.players.length >= this.maxPlayers) fail(`Der Raum ist voll (maximal ${this.maxPlayers} Spieler).`);
    name = String(name || '').trim().replace(/\s+/g, ' ');
    if (!name) fail('Bitte gib einen Namen ein.');
    if (name.length > 16) fail('Der Name darf höchstens 16 Zeichen lang sein.');
    if (this.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) fail(`Der Name „${name}“ ist schon vergeben.`);
    if (!COLORS.includes(color)) fail('Bitte wähle eine Farbe.');
    // Die Spielfigur wählt man nur bei Monopoly; sonst bekommt man die erste freie (falls später Monopoly gewählt wird)
    if (!figure && this.gameType !== 'monopoly') figure = FIGURES.find((f) => !this.players.some((p) => p.figure === f));
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

  /** Spielauswahl in der Lobby; die Einstellungen beginnen beim Standard des Spiels. */
  setGameType(gameType) {
    if (this.started) fail('Das Spiel läuft bereits.');
    const mod = GAMES[gameType];
    if (!mod) fail('Dieses Spiel gibt es nicht.');
    if (this.players.length > mod.maxPlayers) fail(`${mod.name} ist für höchstens ${mod.maxPlayers} Spieler – im Raum sind schon ${this.players.length}.`);
    if (gameType === this.gameType) return;
    this.gameType = gameType;
    this.module = mod;
    this.settings = mod.defaultSettings();
  }

  updateSettings(patch) {
    if (this.started) fail('Das Spiel läuft bereits.');
    this.settings = this.module.applySettings(this.settings, patch);
  }

  setStartMoney(value) { this.updateSettings({ startMoney: value }); }

  /** Callbacks, mit denen eine Partie Änderungen außerhalb von Aktionen meldet. */
  gameHooks() {
    return {
      rng: this.rng,
      timeScale: this.timeScale,
      onChange: () => { this.touch(); this.schedule(); this.broadcast(); },
    };
  }

  start() {
    if (this.started) fail('Das Spiel läuft bereits.');
    if (this.players.length < this.minPlayers) fail(`Es werden mindestens ${this.minPlayers} Spieler gebraucht.`);
    this.game = this.module.createGame({
      ...this.gameHooks(),
      players: this.players.map(({ id, name, color, figure }) => ({ id, name, color, figure })),
      settings: this.settings,
      forcedDice: this.pendingDice,
    });
    this.pendingDice = [];
    this.started = true;
    this.schedule();
  }

  /* ---------- Spielzüge ---------- */

  /** Absicht eines Spielers ausführen – das Spielmodul prüft alles selbst. */
  act(pid, action = {}) {
    if (!this.game) fail('Das Spiel hat noch nicht begonnen.');
    this.game.handleAction(pid, action || {});
    this.schedule();
  }

  /** Getrennter Spieler, auf den das Spiel gerade wartet – sonst null. */
  blockingPlayer() {
    if (!this.game || this.game.isOver()) return null;
    const waitingFor = this.playerById(this.game.waitingFor());
    return waitingFor && !waitingFor.connected ? waitingFor : null;
  }

  /** Ist der Zug pausiert, weil der Spieler am Zug getrennt ist? */
  isPaused() { return Boolean(this.blockingPlayer()); }

  setTimer(key, ms, fn) {
    clearTimeout(this.timers[key]);
    this.timers[key] = setTimeout(() => {
      delete this.timers[key];
      try { fn(); } catch (err) { console.error(err); }
      this.touch();
      this.broadcast();
    }, Math.max(0, ms));
  }

  clearTimer(key) {
    clearTimeout(this.timers[key]);
    delete this.timers[key];
  }

  /** Ausscheiden getrennter Spieler und zeitgesteuerte Schritte des Spiels. */
  schedule() {
    const g = this.game;
    if (!g) return;
    if (g.isOver()) {
      g.dispose();
      Object.keys(this.timers).forEach((k) => this.clearTimer(k));
      return;
    }

    // Getrennte Spieler bleiben im Spiel. Erst wenn das Spiel 5 Minuten lang
    // auf sie warten muss (ihr Zug ist pausiert), scheiden sie aus.
    const blocker = this.blockingPlayer();
    if (blocker) {
      if (!this.timers.drop || this.dropFor !== blocker.id) {
        this.dropFor = blocker.id;
        this.setTimer('drop', RECONNECT_GRACE_MS, () => {
          const still = this.blockingPlayer();
          if (still && still.id === this.dropFor) {
            this.game.removePlayer(still.id);
            this.schedule();
          }
        });
      }
    } else {
      this.clearTimer('drop');
      this.dropFor = null;
    }

    const wait = g.tick(Date.now(), { isConnected: (id) => Boolean(this.playerById(id)?.connected) });
    if (g.isOver()) {
      this.schedule();
    } else if (wait === null || wait === undefined) {
      this.clearTimer('tick');
    } else {
      this.setTimer('tick', wait, () => this.schedule());
    }
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
    this.schedule();
  }

  detach(socket) {
    const player = this.playerById(socket.data.playerId);
    if (!player) return;
    player.sockets.delete(socket.id);
    if (player.sockets.size) return;
    player.connected = false;
    if (this.game && this.game.onDisconnect) this.game.onDisconnect(player.id);
    clearTimeout(player.leaveTimer);
    if (!this.started) {
      // In der Lobby wird ein getrennter Platz nach 5 Minuten wieder frei
      player.leaveTimer = setTimeout(() => this.dropPlayer(player.id), RECONNECT_GRACE_MS);
      player.leaveTimer.unref?.();
    }
    this.schedule();
  }

  /** Spieler war in der Lobby zu lange getrennt. */
  dropPlayer(id) {
    const player = this.playerById(id);
    if (!player || player.connected || this.started) return;
    player.leaveTimer = null;
    this.players = this.players.filter((p) => p.id !== id);
    this.broadcast();
  }

  /** Wiedereinstieg ohne Token (z. B. anderer Browser): nur für getrennte Spieler. */
  reclaim(playerId) {
    if (!this.started) fail('Das Spiel hat noch nicht begonnen – tritt einfach neu bei.');
    const player = this.playerById(playerId);
    if (!player) fail('Diesen Spieler gibt es nicht.');
    if (player.connected) fail(`${player.name} ist noch verbunden. Nur getrennte Spieler können übernommen werden.`);
    return player;
  }

  /* ---------- Zustand an Clients ---------- */

  /** Snapshot für das Tablet ('board') oder das Handy eines Spielers. */
  snapshot(role = 'board', playerId = null) {
    return {
      code: this.code,
      now: Date.now(),
      gameType: this.gameType,
      games: Object.values(GAMES).map(({ id, name, minPlayers, maxPlayers }) => ({ id, name, minPlayers, maxPlayers })),
      started: this.started,
      settings: this.settings,
      minPlayers: this.minPlayers,
      maxPlayers: this.maxPlayers,
      colors: COLORS,
      figures: FIGURES,
      lobby: this.players.map((p) => ({ id: p.id, name: p.name, color: p.color, figure: p.figure, connected: p.connected })),
      paused: this.isPaused(),
      role,
      board: null,
      game: null,
      mini: null,
      ...(this.game ? this.game.view(role, playerId) : {}),
    };
  }

  broadcast() {
    this.manager.persist(this);
    if (!this.io) return;
    this.io.to(`${this.code}:board`).emit('state', this.snapshot('board'));
    // Jedes Handy bekommt seinen eigenen Snapshot – versteckte Information bleibt auf dem Server
    for (const p of this.players) {
      if (p.sockets.size) this.io.to([...p.sockets]).emit('state', this.snapshot('player', p.id));
    }
  }

  dispose() {
    this.players.forEach((p) => clearTimeout(p.leaveTimer));
    Object.keys(this.timers).forEach((k) => this.clearTimer(k));
    if (this.game) this.game.dispose();
  }

  /* ---------- Speichern & Wiederherstellen ---------- */

  /** Zustand des Raums als reine Daten für die Datenbank (ohne Sockets und Timer). */
  serialize() {
    return {
      version: 2,
      code: this.code,
      gameType: this.gameType,
      settings: this.settings,
      started: this.started,
      lastActivity: this.lastActivity,
      players: this.players.map(({ id, token, name, color, figure }) => ({ id, token, name, color, figure })),
      game: this.game ? this.game.toJSON() : null,
    };
  }

  /**
   * Stellt einen gespeicherten Raum wieder her. Alle Spieler gelten als getrennt
   * und kommen per Token zurück; ein unterbrochenes Minispiel startet neu.
   */
  static restore(data, manager) {
    const room = new Room(data.code, manager, data.gameType || DEFAULT_GAME);
    room.settings = { ...room.settings, ...data.settings };
    room.started = Boolean(data.started);
    room.lastActivity = data.lastActivity || Date.now();
    room.players = (data.players || []).map((p) => ({ ...p, connected: false, sockets: new Set(), leaveTimer: null }));
    if (data.game) {
      // Version 1 (nur Monopoly): Engine-Zustand und Blackjack-Schuh lagen getrennt
      const gameData = (data.version || 1) < 2 ? { engine: data.game, shoe: data.shoe } : data.game;
      room.game = room.module.restoreGame(gameData, room.gameHooks());
    }
    if (!room.started) {
      room.players.forEach((p) => {
        p.leaveTimer = setTimeout(() => room.dropPlayer(p.id), RECONNECT_GRACE_MS);
        p.leaveTimer.unref?.();
      });
    }
    return room;
  }
}

class RoomManager {
  constructor(config = {}) {
    this.config = config;
    this.store = config.store || null;   // Postgres-Speicher oder null (nur Arbeitsspeicher)
    this.saveTimers = new Map();
    this.saving = new Map();
    this.io = null;
    this.rooms = new Map();
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  get size() { return this.rooms.size; }

  get(code) { return this.rooms.get(String(code || '').toUpperCase()); }

  create(gameType = DEFAULT_GAME) {
    let code;
    do {
      code = Array.from({ length: 4 }, () => CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)]).join('');
    } while (this.rooms.has(code));
    const room = new Room(code, this, gameType);
    this.rooms.set(code, room);
    return room;
  }

  /** Löscht Räume nach 6 h ohne Aktivität. */
  sweep(now = Date.now()) {
    for (const [code, room] of this.rooms) {
      if (now - room.lastActivity > ROOM_IDLE_MS) {
        room.dispose();
        this.rooms.delete(code);
        clearTimeout(this.saveTimers.get(code));
        this.saveTimers.delete(code);
        if (this.store) this.store.remove(code).catch((err) => console.error(`Raum ${code} konnte nicht gelöscht werden:`, err.message));
      }
    }
  }

  /* ---------- Speichern in der Datenbank ---------- */

  /**
   * Merkt einen Raum zum Speichern vor (gebündelt). Während eines Minispiels wird
   * nicht gespeichert – der letzte Stand ist dann der Beginn des Minispiels.
   */
  persist(room) {
    if (!this.store || (room.game && !room.game.canSave())) return;
    clearTimeout(this.saveTimers.get(room.code));
    const t = setTimeout(() => { this.saveTimers.delete(room.code); this.saveNow(room); }, 250);
    t.unref?.();
    this.saveTimers.set(room.code, t);
  }

  /** Speichert sofort; Fehler werden geloggt, das Spiel läuft im Arbeitsspeicher weiter. */
  saveNow(room) {
    if (!this.store) return Promise.resolve();
    const previous = this.saving.get(room.code) || Promise.resolve();
    const next = previous
      .then(() => this.store.save(room.code, room.serialize()))
      .catch((err) => console.error(`Raum ${room.code} konnte nicht gespeichert werden:`, err.message));
    this.saving.set(room.code, next);
    return next;
  }

  /** Alle vorgemerkten Speicherungen sofort ausführen (z. B. vor dem Beenden). */
  async flush() {
    if (!this.store) return;
    for (const [code, t] of this.saveTimers) {
      clearTimeout(t);
      const room = this.rooms.get(code);
      if (room && (!room.game || room.game.canSave())) this.saveNow(room);
    }
    this.saveTimers.clear();
    await Promise.all(this.saving.values());
  }

  /** Lädt beim Start alle gespeicherten Räume der letzten 6 h. */
  async loadFromStore() {
    if (!this.store) return 0;
    const states = await this.store.loadAll(ROOM_IDLE_MS);
    let count = 0;
    for (const data of states) {
      if (!data || !data.code || this.rooms.has(data.code)) continue;
      try {
        const room = Room.restore(data, this);
        this.rooms.set(room.code, room);
        room.schedule();
        count++;
      } catch (err) {
        console.error(`Raum ${data.code} konnte nicht wiederhergestellt werden:`, err.message);
      }
    }
    return count;
  }

  shutdown() {
    clearInterval(this.sweeper);
    this.saveTimers.forEach(clearTimeout);
    this.saveTimers.clear();
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

    handle('board:settings', (patch, use) => {
      const room = ownRoom();
      if (socket.data.role !== 'board') fail('Nur das Tablet kann das Spiel einstellen.');
      room.updateSettings(patch);
      use(room);
    });

    handle('board:game', ({ gameType }, use) => {
      const room = ownRoom();
      if (socket.data.role !== 'board') fail('Nur das Tablet kann das Spiel auswählen.');
      room.setGameType(String(gameType || ''));
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
      return { started: snap.started, gameType: room.gameType, lobby: snap.lobby, colors: COLORS, figures: FIGURES, max: room.maxPlayers, full: snap.lobby.length >= room.maxPlayers };
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

    handle('player:reclaim', ({ code, playerId }, use) => {
      const room = this.requireRoom(code);
      const player = room.reclaim(String(playerId || ''));
      room.attach(socket, player);
      use(room);
      return { token: player.token, playerId: player.id, code: room.code };
    });

    handle('act', (action, use) => {
      const room = ownRoom();
      if (socket.data.role !== 'player') fail('Nur Spieler können Aktionen ausführen.');
      use(room);
      room.act(socket.data.playerId, action);
    });

    if (this.config.testMode) {
      // Nur im Testmodus: Würfel vorgeben, damit Browser-Tests reproduzierbar sind.
      handle('debug:dice', ({ dice }, use) => {
        const room = ownRoom();
        const list = (Array.isArray(dice) ? dice : []).map((d) => [Number(d[0]), Number(d[1])]);
        if (!room.game) room.pendingDice.push(...list);
        else if (room.game.debugDice) room.game.debugDice(list);
        else fail('Dieses Spiel unterstützt keine vorgegebenen Würfel.');
        use(room);
      });
    }

    socket.on('disconnect', () => {
      const room = this.get(socket.data.code);
      if (!room || socket.data.role !== 'player') return;
      room.detach(socket);
      room.broadcast();
    });
  }
}

module.exports = { RoomManager, Room, UserError, MINIGAMES, TIMING, COLORS, FIGURES, MAX_PLAYERS, MIN_PLAYERS, RECONNECT_GRACE_MS, ROOM_IDLE_MS };
