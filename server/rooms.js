'use strict';

const crypto = require('crypto');
const { MonopolyGame } = require('./monopoly/rules');
const { SQUARES, GROUP_COLORS } = require('./monopoly/board');
const { createRng } = require('./rng');
const { HorseRace } = require('./games/horserace');
const { Roulette } = require('./games/roulette');
const { Blackjack } = require('./games/blackjack');

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_PLAYERS = 10;
const MIN_PLAYERS = 2;
const RECONNECT_GRACE_MS = 5 * 60 * 1000;
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

const COLORS = ['#e63946', '#1d72d8', '#2a9d8f', '#f4a261', '#8e44ad', '#e9c46a', '#ff6fb5', '#264653', '#8ac926', '#795548'];
const FIGURES = ['🎩', '🚗', '🐕', '🚢', '👢', '🐈', '🦆', '🦖', '✈️', '🎸'];

/* Animationszeiten (ms) – Tablet und Server rechnen mit denselben Werten. */
const TIMING = { dice: 1800, step: 380, jump: 1100, land: 900, rollDelay: 3000, miniDelay: 2500 };

/** Minispiele nach Typ. */
const MINIGAMES = {
  horserace: HorseRace,
  roulette: Roulette,
  blackjack: Blackjack,
};

/** Statische Brettdaten für die Clients. */
const BOARD = SQUARES.map((s) => ({
  name: s.name, type: s.type, group: s.group || s.type, price: s.price, house: s.house, rent: s.rent, amount: s.amount,
}));

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
    this.rng = createRng(this.config.seed);
    this.game = null;
    this.mini = null;
    this.timers = {};
    this.animUntil = 0;
    this.seenRollSeq = 0;
    this.seenMoveSeq = 0;
    this.pendingDice = [];
    this.shoe = {};
  }

  get timeScale() { return this.config.timeScale ?? 1; }

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
    this.game = new MonopolyGame({
      players: this.players.map(({ id, name, color, figure }) => ({ id, name, color, figure })),
      startMoney: this.settings.startMoney,
      rng: this.rng,
    });
    this.game.forcedDice.push(...this.pendingDice);
    this.pendingDice = [];
    this.started = true;
    this.afterGameChange();
  }

  /* ---------- Spielzüge ---------- */

  /** Absicht eines Spielers ausführen – der Server prüft alles selbst. */
  act(pid, action = {}) {
    const g = this.game;
    if (!g) fail('Das Spiel hat noch nicht begonnen.');
    switch (action.type) {
      case 'buy': g.buy(pid); break;
      case 'decline': g.declineBuy(pid); break;
      case 'jail:pay': g.payJail(pid); break;
      case 'jail:card': g.useJailCard(pid); break;
      case 'jail:roll': g.rollInJail(pid); break;
      case 'bid': g.bid(pid, action.amount); break;
      case 'pass': g.passAuction(pid); break;
      case 'build': g.buildHouse(pid, action.square); break;
      case 'sell': g.sellHouse(pid, action.square); break;
      case 'mortgage': g.mortgage(pid, action.square); break;
      case 'unmortgage': g.unmortgage(pid, action.square); break;
      case 'bankrupt': g.declareBankruptcy(pid); break;
      case 'endTurn': g.endTurn(pid); break;
      case 'trade:propose': g.proposeTrade(pid, action.trade || {}); break;
      case 'trade:respond': g.respondTrade(pid, action.id, Boolean(action.accept)); break;
      case 'trade:cancel': g.cancelTrade(pid, action.id); break;
      case 'mini':
        if (!this.mini) fail('Gerade läuft kein Minispiel.');
        this.mini.handle(pid, action.action || {});
        break;
      default: fail('Unbekannte Aktion.');
    }
    this.afterGameChange();
  }

  currentRoomPlayer() { return this.game ? this.playerById(this.game.currentPlayer().id) : null; }

  /** Getrennter Spieler, auf den das Spiel gerade wartet (am Zug oder mit Schulden) – sonst null. */
  blockingPlayer() {
    const g = this.game;
    if (!g || !['roll', 'jail', 'buy', 'debt', 'end'].includes(g.phase)) return null;
    const cur = this.currentRoomPlayer();
    const waitingFor = g.phase === 'debt' && g.debts[0] ? this.playerById(g.debts[0].debtorId) : cur;
    return waitingFor && !waitingFor.connected ? waitingFor : null;
  }

  /** Ist der Zug pausiert, weil der Spieler am Zug getrennt ist? */
  isPaused() { return Boolean(this.blockingPlayer()); }

  /** Merkt sich, wie lange das Tablet für Würfel und Figuren braucht. */
  afterGameChange() {
    const g = this.game;
    if (!g) return;
    let anim = 0;
    if (g.lastRoll && g.lastRoll.seq > this.seenRollSeq) {
      this.seenRollSeq = g.lastRoll.seq;
      anim += TIMING.dice;
    }
    for (const m of g.moves) {
      if (m.seq <= this.seenMoveSeq) continue;
      this.seenMoveSeq = m.seq;
      anim += m.mode === 'jump' ? TIMING.jump : m.steps * TIMING.step + TIMING.land;
    }
    if (anim) this.animUntil = Math.max(this.animUntil, Date.now()) + anim * this.timeScale;
    this.schedule();
  }

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

  /** Automatisches Würfeln, Auktions-Timer und Start der Minispiele. */
  schedule() {
    const g = this.game;
    if (!g) return;
    const ts = this.timeScale;
    const waitAnim = () => Math.max(0, this.animUntil - Date.now());
    if (g.phase === 'gameover') {
      this.stopMini();
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
            this.afterGameChange();
          }
        });
      }
    } else {
      this.clearTimer('drop');
      this.dropFor = null;
    }

    const cur = this.currentRoomPlayer();
    if (g.phase === 'roll' && cur && cur.connected) {
      if (!this.timers.roll) {
        this.setTimer('roll', waitAnim() + TIMING.rollDelay * ts, () => {
          const p = this.currentRoomPlayer();
          if (this.game.phase === 'roll' && p && p.connected) this.game.roll(p.id);
          this.afterGameChange();
        });
      }
    } else {
      this.clearTimer('roll');
    }

    if (g.phase === 'auction' && g.auction) {
      this.setTimer('auction', g.auction.endsAt - Date.now() + 50, () => {
        this.game.auctionTimeout();
        this.afterGameChange();
      });
    } else {
      this.clearTimer('auction');
    }

    if (g.phase === 'minigame' && !this.mini && !this.timers.mini) {
      this.setTimer('mini', waitAnim() + TIMING.miniDelay * ts, () => this.startMini());
    }
  }

  /* ---------- Minispiele ---------- */

  startMini() {
    const g = this.game;
    if (!g || g.phase !== 'minigame' || this.mini) return;
    const { type, seq } = g.minigame;
    const Game = MINIGAMES[type];
    if (!Game) {
      g.finishMinigame();
      this.afterGameChange();
      return;
    }
    this.mini = new Game({
      id: seq,
      players: g.activePlayers().map(({ id, name, color, figure }) => ({ id, name, color, figure })),
      wallet: {
        balance: (id) => g.player(id).money,
        debit: (id, amount) => g.debitBet(id, amount),
        credit: (id, amount) => g.creditWin(id, amount),
      },
      rng: this.rng,
      timeScale: this.timeScale,
      shoe: this.shoe,
      log: (text) => g.event(text, 'minigame'),
      onChange: () => { this.touch(); this.broadcast(); },
      onDone: () => this.finishMini(),
    });
    this.mini.start();
  }

  finishMini() {
    this.stopMini();
    if (this.game) this.game.finishMinigame();
    this.afterGameChange();
    this.touch();
    this.broadcast();
  }

  stopMini() {
    if (this.mini) this.mini.stop();
    this.mini = null;
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
      board: this.game ? BOARD : null,
      groupColors: GROUP_COLORS,
      timing: { ...TIMING, timeScale: this.timeScale },
      game: this.game ? this.game.publicState() : null,
      paused: this.isPaused(),
      animUntil: this.animUntil,
    };
  }

  broadcast() {
    if (!this.io) return;
    const snap = this.snapshot();
    const mini = (role) => (this.mini ? this.mini.view(role) : null);
    this.io.to(`${this.code}:board`).emit('state', { ...snap, role: 'board', mini: mini('board') });
    this.io.to(`${this.code}:players`).emit('state', { ...snap, role: 'player', mini: mini('player') });
  }

  dispose() {
    this.players.forEach((p) => clearTimeout(p.leaveTimer));
    Object.keys(this.timers).forEach((k) => this.clearTimer(k));
    this.stopMini();
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
        if (room.game) room.game.forcedDice.push(...list);
        else room.pendingDice.push(...list);
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
