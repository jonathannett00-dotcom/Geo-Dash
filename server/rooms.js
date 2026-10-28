'use strict';

const crypto = require('crypto');
const { createRng } = require('./rng');
const { GAMES, DEFAULT_GAME } = require('./games');
const { TIMING, MINIGAMES } = require('./monopoly');
const { AV_IDS, AV_MOTIVE } = require('../public/shared/avatare');
const { checkFoto } = require('./foto');

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_PLAYERS = 12;
const MIN_PLAYERS = 2;
const RECONNECT_GRACE_MS = 5 * 60 * 1000;
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
/** Schutz vor Missbrauch (Seite und Repo sind öffentlich). */
const MAX_ACTIVE_ROOMS = 20;
const ROOMS_PER_MINUTE_PER_IP = 5;
const RATE_WINDOW_MS = 60 * 1000;
/** Räume ohne Host-Ansicht und ohne Spieler verschwinden nach 30 Minuten. */
const EMPTY_ROOM_MS = 30 * 60 * 1000;
/** Ist das Raumlimit erreicht, dürfen leere Räume schon nach 2 Minuten Platz machen. */
const EMPTY_EVICT_MS = 2 * 60 * 1000;

const COLORS = ['#e63946', '#1d72d8', '#2a9d8f', '#f4a261', '#8e44ad', '#e9c46a', '#ff6fb5', '#264653', '#8ac926', '#795548'];
/** Alte Emoji-Spielfiguren: nur noch, um gespeicherte Räume zu lesen (werden zu Avataren). */
const FIGURES = ['🎩', '🚗', '🐕', '🚢', '👢', '🐈', '🦆', '🦖', '✈️', '🎸'];
const DEFAULT_AVATAR = 'monogramm';
/** Fotos: höchstens 3 Wechsel pro Spieler und Minute, höchstens 12 je Raum. */
const FOTO_CHANGES_PER_MINUTE = 3;
const MAX_FOTOS_PER_ROOM = 12;
/** Host-Code (Notausgang auf einem neuen Gerät): höchstens 5 Fehlversuche pro Minute und IP, 10 pro Raum und Stunde. */
const HOST_FAILS_PER_MINUTE_PER_IP = 5;
const HOST_FAILS_PER_HOUR_PER_ROOM = 10;
const HOUR_MS = 60 * 60 * 1000;

/** Neues Host-Token (24 Zufallsbytes, Base64url) – verlässt den Server nur in der Antwort an den Host. */
const newHostToken = () => crypto.randomBytes(24).toString('base64url');
/** Sechsstelliger Host-Code aus Ziffern. */
const newHostCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();
/** Zeitkonstanter Vergleich; gleiche Länge über den Hash, falsche Typen zählen als falsch. */
function sameSecret(given, expected) {
  if (typeof given !== 'string' || !given || given.length > 200 || typeof expected !== 'string' || !expected) return false;
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

/** Avatar für einen alten Spieler mit Emoji-Figur (gleiche Stelle im Avatar-Set). */
function legacyAvatar(figure) {
  const i = FIGURES.indexOf(figure);
  return i >= 0 ? AV_MOTIVE[i].id : DEFAULT_AVATAR;
}

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
    // Host: Token (im Raumzustand, nie im Snapshot) und sechsstelliger Code zum Übernehmen
    this.hostToken = newHostToken();
    this.hostCode = newHostCode();
    this.hostClaimable = false;   // Übergangsregel für alte Räume ohne Token
    this.hostFails = [];          // Fehlversuche mit dem Host-Code (Zeitpunkte, letzte Stunde)
    this.hostSockets = new Set(); // Sockets, die gerade als Host verbunden sind
  }

  get timeScale() { return this.config.timeScale ?? 1; }

  get io() { return this.manager.io; }

  get maxPlayers() { return Math.min(this.module.maxPlayers, MAX_PLAYERS); }

  get minPlayers() { return this.module.minPlayers; }

  /** Spielerfarben der Lobby: eigene Palette des Spiels (Poker: 12) oder die gemeinsame. */
  get colors() { return this.module.colors || COLORS; }

  touch() { this.lastActivity = Date.now(); }

  /** Ist gerade eine Host-Ansicht verbunden? */
  hasHost() {
    const sockets = this.io && this.io.sockets && this.io.sockets.adapter.rooms.get(`${this.code}:board`);
    return Boolean(sockets && sockets.size);
  }

  /** Leer: keine Host-Ansicht verbunden und kein Spieler im Raum. */
  isEmpty() { return !this.players.length && !this.hasHost(); }

  playerById(id) { return this.players.find((p) => p.id === id); }

  /* ---------- Host ---------- */

  /** Ist das das gültige Host-Token dieses Raums? (zeitkonstant verglichen) */
  isHostToken(token) { return sameSecret(token, this.hostToken); }

  /**
   * Host-Rolle per Host-Code übernehmen: neues Token (das alte wird ungültig) und neuer Code.
   * Fehlversuche zählen pro Raum (10 pro Stunde); die Grenze pro IP prüft der RoomManager.
   */
  claimHost(code, now = Date.now()) {
    this.hostFails = this.hostFails.filter((t) => now - t < HOUR_MS);
    if (this.hostFails.length >= HOST_FAILS_PER_HOUR_PER_ROOM) {
      fail('Für diesen Raum gab es zu viele falsche Host-Codes. Die Übernahme ist für eine Stunde gesperrt.');
    }
    const clean = String(code ?? '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(clean) || !sameSecret(clean, this.hostCode)) {
      this.hostFails.push(now);
      return false;
    }
    this.renewHost();
    return true;
  }

  /** Neues Token und neuer Code; Geräte mit dem alten Token sind ab sofort nur noch Zuschauer. */
  renewHost() {
    this.hostToken = newHostToken();
    this.hostCode = newHostCode();
    this.hostClaimable = false;
    this.hostFails = [];
    if (this.io && this.hostSockets.size) {
      this.io.to([...this.hostSockets]).emit('host:revoked', { message: 'Ein anderes Gerät hat die Host-Rolle übernommen. Dieses Gerät sieht jetzt nur noch zu.' });
    }
    this.hostSockets.clear();
  }

  /* ---------- Lobby ---------- */

  join({ name, color, avatar }) {
    if (this.started) fail('Das Spiel läuft bereits – neue Spieler können nicht mehr beitreten.');
    if (this.players.length >= this.maxPlayers) fail(`Der Raum ist voll (maximal ${this.maxPlayers} Spieler).`);
    name = String(name || '').trim().replace(/\s+/g, ' ');
    if (!name) fail('Bitte gib einen Namen ein.');
    if (name.length > 16) fail('Der Name darf höchstens 16 Zeichen lang sein.');
    if (this.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) fail(`Der Name „${name}“ ist schon vergeben.`);
    if (!this.colors.includes(color)) fail('Bitte wähle eine Farbe.');
    // Farbe und Avatar sind getrennt wählbar; ohne Wahl gilt das Monogramm
    avatar = avatar === undefined || avatar === null || avatar === '' ? DEFAULT_AVATAR : String(avatar);
    if (!AV_IDS.includes(avatar)) fail('Bitte wähle einen Avatar.');
    if (this.players.some((p) => p.color === color)) fail('Diese Farbe ist schon vergeben.');
    // Gleicher Avatar ist erlaubt, aber nicht in gleicher Farbe
    if (this.players.some((p) => p.color === color && p.avatar === avatar)) fail('Diesen Avatar gibt es in dieser Farbe schon.');

    const player = {
      id: `p${crypto.randomBytes(4).toString('hex')}`,
      token: crypto.randomBytes(16).toString('hex'),
      name,
      color,
      avatar,
      photo: null,          // { type, data: Buffer, v } – nur im Raumzustand, nie im Snapshot
      photoHidden: false,   // vom Host ausgeblendet
      photoTimes: [],
      connected: false,
      sockets: new Set(),
      leaveTimer: null,
    };
    this.players.push(player);
    return player;
  }

  /**
   * Nach einem Spielwechsel: Farben in die Palette des neuen Spiels übertragen (gleiche Stelle,
   * sonst die erste freie).
   */
  adoptPalette(oldColors) {
    const palette = this.colors;
    const taken = new Set();
    for (const p of this.players) {
      if (palette.includes(p.color) && !taken.has(p.color)) { taken.add(p.color); continue; }
      const same = palette[oldColors.indexOf(p.color)];
      p.color = same && !taken.has(same) && !this.players.some((q) => q !== p && q.color === same) ? same : palette.find((c) => !taken.has(c) && !this.players.some((q) => q !== p && q.color === c));
      taken.add(p.color);
    }
  }

  /* ---------- Fotos ---------- */

  /** Eigenes Foto setzen (geprüft: Format, Maße, Größe) oder mit null entfernen. */
  setFoto(playerId, foto, now = Date.now()) {
    const player = this.playerById(playerId);
    if (!player) fail('Diesen Spieler gibt es nicht.');
    player.photoTimes = (player.photoTimes || []).filter((t) => now - t < 60 * 1000);
    if (player.photoTimes.length >= FOTO_CHANGES_PER_MINUTE) fail('Du hast dein Foto gerade oft gewechselt. Bitte warte eine Minute.');
    if (foto === null || foto === undefined) {
      player.photoTimes.push(now);
      player.photo = null;
      return;
    }
    const others = this.players.filter((p) => p !== player && p.photo).length;
    if (others >= MAX_FOTOS_PER_ROOM) fail(`In diesem Raum gibt es schon ${MAX_FOTOS_PER_ROOM} Fotos.`);
    const { type, data } = checkFoto(foto, fail);
    player.photoTimes.push(now);
    // Höchstens ein Foto pro Spieler: das neue ersetzt das alte
    player.photo = { type, data, v: ((player.photo && player.photo.v) || 0) + 1 };
    player.photoHidden = false;
  }

  /** Host blendet das Foto eines Spielers aus (Rückfall auf Avatar bzw. Monogramm) oder wieder ein. */
  hideFoto(playerId, hidden = true) {
    const player = this.playerById(playerId);
    if (!player) fail('Diesen Spieler gibt es nicht.');
    player.photoHidden = Boolean(hidden);
  }

  /** Sichtbares Foto eines Spielers (für /api/avatar) – sonst null. */
  fotoOf(playerId) {
    const player = this.playerById(playerId);
    return player && player.photo && !player.photoHidden ? player.photo : null;
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
    const oldColors = this.colors;
    this.gameType = gameType;
    this.module = mod;
    this.settings = mod.defaultSettings();
    this.adoptPalette(oldColors);
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
      players: this.players.map(({ id, name, color }) => ({ id, name, color })),
      settings: this.settings,
      forcedDice: this.pendingDice,
    });
    this.pendingDice = [];
    this.started = true;
    this.schedule();
  }

  /* ---------- Spiel beenden (nur Host) ---------- */

  /** Der Host beendet das laufende Spiel; der Spielstand bleibt mit Endstand erhalten. */
  endGame() {
    if (!this.started || !this.game) fail('Es läuft gerade kein Spiel.');
    if (this.game.isOver()) fail('Das Spiel ist schon vorbei.');
    this.game.endByHost();
    this.schedule();
  }

  /** Nach dem Spielende zurück in die Lobby: gleicher Raum, gleiche Spieler, neues Spiel wählbar. */
  backToLobby() {
    if (!this.game || !this.game.isOver()) fail('Zurück zur Lobby geht erst, wenn das Spiel beendet ist.');
    this.game.dispose();
    Object.keys(this.timers).forEach((k) => this.clearTimer(k));
    this.game = null;
    this.started = false;
    this.settings = this.module.defaultSettings();
    // In der Lobby wird ein getrennter Platz wie üblich nach 5 Minuten frei
    for (const p of this.players) {
      clearTimeout(p.leaveTimer);
      p.leaveTimer = null;
      if (!p.connected) {
        p.leaveTimer = setTimeout(() => this.dropPlayer(p.id), RECONNECT_GRACE_MS);
        p.leaveTimer.unref?.();
      }
    }
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
    this.hostSockets.delete(socket.id);
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
      colors: this.colors,
      lobby: this.lobbyList(),
      paused: this.isPaused(),
      role,
      board: null,
      game: null,
      mini: null,
      ...(this.game ? this.game.view(role, playerId) : {}),
      // Endstand nach Spielende (vom Host beendet oder regulär) – nur Anzeige
      final: this.game && this.game.isOver() && this.game.summary ? this.game.summary() : null,
    };
  }

  /** Spieler für Lobby und Anzeigen: Avatar und nur ein Verweis aufs Foto (nie das Bild selbst). */
  lobbyList() {
    return this.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      avatar: p.avatar,
      photo: p.photo && !p.photoHidden ? `/api/avatar/${this.code}/${p.id}?v=${p.photo.v}` : null,
      hasPhoto: Boolean(p.photo),
      photoHidden: Boolean(p.photo && p.photoHidden),
      connected: p.connected,
    }));
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
      hostToken: this.hostToken,
      hostCode: this.hostCode,
      ...(this.hostClaimable ? { hostClaimable: true } : {}),
      players: this.players.map(({ id, token, name, color, figure, avatar, photo, photoHidden }) => ({
        id, token, name, color, avatar, ...(figure ? { figure } : {}),
        photo: photo ? { type: photo.type, data: photo.data.toString('base64'), v: photo.v } : null,
        photoHidden: Boolean(photoHidden),
      })),
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
    if (typeof data.hostToken === 'string' && data.hostToken && /^\d{6}$/.test(String(data.hostCode))) {
      room.hostToken = data.hostToken;
      room.hostCode = String(data.hostCode);
      room.hostClaimable = Boolean(data.hostClaimable);
    } else {
      // Alter Raum ohne Token: frisches Token (im Konstruktor erzeugt); die erste Host-Ansicht übernimmt es
      room.hostClaimable = true;
    }
    room.players = (data.players || []).map((p) => ({
      ...p,
      // Alte Räume: Emoji-Figur statt Avatar (Feld bleibt lesbar)
      avatar: AV_IDS.includes(p.avatar) ? p.avatar : legacyAvatar(p.figure),
      photo: restoreFoto(p.photo),
      photoHidden: Boolean(p.photoHidden),
      photoTimes: [],
      connected: false, sockets: new Set(), leaveTimer: null,
    }));
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

/** Gespeichertes Foto wieder einlesen; beschädigte Daten fallen weg (Rückfall auf den Avatar). */
function restoreFoto(photo) {
  if (!photo || typeof photo.data !== 'string') return null;
  try {
    const { type, data } = checkFoto(photo.data, (msg) => { throw new Error(msg); });
    return { type, data, v: Number(photo.v) || 1 };
  } catch (_) {
    return null;
  }
}

/** Adresse des Aufrufers (hinter dem Proxy von Render steht sie in X-Forwarded-For). */
function socketIp(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0].trim() : '') || socket.handshake.address || 'unbekannt';
}

class RoomManager {
  constructor(config = {}) {
    this.config = config;
    this.store = config.store || null;   // Postgres-Speicher oder null (nur Arbeitsspeicher)
    this.saveTimers = new Map();
    this.saving = new Map();
    this.io = null;
    this.rooms = new Map();
    this.recentCreates = new Map();      // IP → Zeitpunkte der letzten Raum-Erstellungen
    this.hostFailsByIp = new Map();      // IP → Zeitpunkte falscher Host-Codes (letzte Minute)
    this.maxRooms = config.maxRooms ?? MAX_ACTIVE_ROOMS;
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

  /**
   * Neuer Raum über die Startseite oder die Host-Ansicht – mit Grenzen: höchstens
   * 20 Räume gleichzeitig und 5 neue pro Minute und IP.
   */
  open({ ip = 'unbekannt', now = Date.now() } = {}) {
    const recent = (this.recentCreates.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= ROOMS_PER_MINUTE_PER_IP) {
      this.recentCreates.set(ip, recent);
      throw Object.assign(new UserError('Von hier wurden gerade viele Räume angelegt. Bitte warte eine Minute und versuche es dann noch einmal.'), { status: 429 });
    }
    if (this.rooms.size >= this.maxRooms) {
      // Erst verlassene, leere Räume aufräumen, dann erst ablehnen
      const empty = [...this.rooms.values()].filter((r) => r.isEmpty() && now - r.lastActivity > EMPTY_EVICT_MS)
        .sort((a, b) => a.lastActivity - b.lastActivity);
      if (empty.length) this.remove(empty[0].code);
      else throw Object.assign(new UserError(`Gerade laufen schon ${this.maxRooms} Spiele – mehr gehen nicht gleichzeitig. Bitte versuche es später noch einmal.`), { status: 503 });
    }
    recent.push(now);
    this.recentCreates.set(ip, recent);
    return this.create();
  }

  /** Host schließt den Raum: alle Geräte bekommen Bescheid, der Raum wird gelöscht (auch aus der Datenbank). */
  close(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    if (this.io) {
      const msg = { message: 'Der Raum wurde geschlossen.' };
      this.io.to(`${code}:board`).emit('room:closed', msg);
      this.io.to(`${code}:players`).emit('room:closed', msg);
    }
    this.remove(code);
  }

  /** Raum entfernen (auch aus der Datenbank). */
  remove(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    room.dispose();
    this.rooms.delete(code);
    clearTimeout(this.saveTimers.get(code));
    this.saveTimers.delete(code);
    if (this.store) this.store.remove(code).catch((err) => console.error(`Raum ${code} konnte nicht gelöscht werden:`, err.message));
  }

  /** Löscht Räume nach 6 h ohne Aktivität und leere Räume (ohne Host und Spieler) nach 30 Minuten. */
  sweep(now = Date.now()) {
    for (const [code, room] of this.rooms) {
      const idle = now - room.lastActivity;
      if (idle > ROOM_IDLE_MS || (idle > EMPTY_ROOM_MS && room.isEmpty())) this.remove(code);
    }
    for (const map of [this.recentCreates, this.hostFailsByIp]) {
      for (const [ip, list] of map) {
        if (!list.some((t) => now - t < RATE_WINDOW_MS)) map.delete(ip);
      }
    }
  }

  /**
   * Host-Code auf einem neuen Gerät eingeben. Liefert bei Erfolg das neue Token und den neuen
   * Code (nur für dieses Gerät). Sperre nach 5 Fehlversuchen pro Minute und IP bzw. 10 pro Raum und Stunde.
   */
  claimHost(room, code, { ip = 'unbekannt', now = Date.now() } = {}) {
    const recent = (this.hostFailsByIp.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
    this.hostFailsByIp.set(ip, recent);
    if (recent.length >= HOST_FAILS_PER_MINUTE_PER_IP) fail('Zu viele falsche Host-Codes. Bitte warte eine Minute und versuche es dann noch einmal.');
    if (!room.claimHost(code, now)) {
      recent.push(now);
      const left = Math.min(HOST_FAILS_PER_MINUTE_PER_IP - recent.length, HOST_FAILS_PER_HOUR_PER_ROOM - room.hostFails.length);
      fail(left > 0 ? 'Der Host-Code stimmt nicht. Bitte prüfe die sechs Ziffern.' : 'Der Host-Code stimmt nicht. Weitere Versuche sind vorerst gesperrt.');
    }
    return { hostToken: room.hostToken, hostCode: room.hostCode };
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

  /**
   * Lädt beim Start alle gespeicherten Räume der letzten 6 h – höchstens so viele, wie
   * gleichzeitig erlaubt sind (die neuesten); ältere werden aus der Datenbank gelöscht.
   */
  async loadFromStore() {
    if (!this.store) return 0;
    const all = await this.store.loadAll(ROOM_IDLE_MS);   // älteste zuerst
    const states = all.slice(-this.maxRooms);
    for (const data of all.slice(0, all.length - states.length)) {
      if (data && data.code) this.store.remove(data.code).catch((err) => console.error(`Raum ${data.code} konnte nicht gelöscht werden:`, err.message));
    }
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

    /** Host-Ansicht des Raums betreten; `host` sagt, ob dieses Gerät steuern darf. */
    const joinBoard = (room, host) => {
      if (socket.data.code && socket.data.code !== room.code) this.get(socket.data.code)?.hostSockets.delete(socket.id);
      socket.join(`${room.code}:board`);
      socket.data.code = room.code;
      socket.data.role = 'board';
      if (host) room.hostSockets.add(socket.id);
      else room.hostSockets.delete(socket.id);
    };

    // Neuer Raum aus der Host-Ansicht: Token und Host-Code gehen nur in dieser Antwort an das anlegende Gerät
    handle('board:create', (_, use) => {
      const room = this.open({ ip: socketIp(socket) });
      joinBoard(room, true);
      use(room);
      return { code: room.code, host: true, hostToken: room.hostToken, hostCode: room.hostCode };
    });

    // Host-Ansicht öffnen: mit gültigem Token als Host, sonst als Zuschauer (nur ansehen)
    handle('board:watch', ({ code, hostToken }, use) => {
      const room = this.requireRoom(code);
      if (room.isHostToken(hostToken) && !room.hostClaimable) {
        joinBoard(room, true);
        use(room);
        return { code: room.code, host: true, hostCode: room.hostCode };
      }
      if (room.hostClaimable) {
        // Übergangsregel: alter Raum ohne Token – die erste Host-Ansicht nach dem Neustart übernimmt
        room.hostClaimable = false;
        joinBoard(room, true);
        use(room);
        return { code: room.code, host: true, hostToken: room.hostToken, hostCode: room.hostCode };
      }
      joinBoard(room, false);
      use(room);
      return { code: room.code, host: false, ...(hostToken ? { tokenInvalid: true } : {}) };
    });

    // Host-Rolle auf einem neuen Gerät per Host-Code übernehmen (nur aus der Host-Ansicht des Raums)
    handle('host:claim', ({ code }, use) => {
      const room = ownRoom();
      if (socket.data.role !== 'board') fail('Den Host-Code kann man nur in der Host-Ansicht eingeben.');
      const res = this.claimHost(room, code, { ip: socketIp(socket) });
      joinBoard(room, true);
      use(room);
      return { host: true, ...res };
    });

    /**
     * Raum für eine Host-Aktion: nur aus der Host-Ansicht und nur mit dem gültigen Host-Token
     * (Handys und Zuschauer werden abgelehnt, ohne dass sich etwas ändert).
     */
    const hostRoom = (what, payload) => {
      const room = ownRoom();
      if (socket.data.role !== 'board') fail(`Nur die Host-Ansicht kann ${what}.`);
      if (!room.isHostToken(payload && payload.hostToken)) {
        fail(`Nur der Host kann ${what}. Dieses Gerät sieht nur zu – mit dem Host-Code lässt sich die Host-Rolle übernehmen.`);
      }
      return room;
    };

    handle('board:settings', ({ hostToken, ...patch }, use) => {
      const room = hostRoom('das Spiel einstellen', { hostToken });
      room.updateSettings(patch);
      use(room);
    });

    handle('board:game', (payload, use) => {
      const room = hostRoom('das Spiel auswählen', payload);
      room.setGameType(String(payload.gameType || ''));
      use(room);
    });

    handle('board:end', (payload, use) => {
      const room = hostRoom('das Spiel beenden', payload);
      room.endGame();
      use(room);
    });

    handle('board:lobby', (payload, use) => {
      const room = hostRoom('zur Lobby zurückkehren', payload);
      room.backToLobby();
      use(room);
    });

    handle('board:close', (payload) => {
      const room = hostRoom('den Raum schließen', payload);
      this.close(room.code);
      return { closed: true };
    });

    handle('board:start', (payload, use) => {
      const room = hostRoom('das Spiel starten', payload);
      room.start();
      use(room);
    });

    handle('room:info', ({ code }) => {
      const room = this.requireRoom(code);
      const snap = room.snapshot();
      return { started: snap.started, gameType: room.gameType, lobby: snap.lobby, colors: room.colors, max: room.maxPlayers, full: snap.lobby.length >= room.maxPlayers };
    });

    handle('player:join', ({ code, name, color, avatar }, use) => {
      const room = this.requireRoom(code);
      const player = room.join({ name, color, avatar });
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

    // Eigenes Foto (128 × 128, WebP oder JPEG, höchstens 24 KB) oder null zum Entfernen
    handle('avatar:foto', ({ foto } = {}, use) => {
      const room = ownRoom();
      if (socket.data.role !== 'player') fail('Nur Spieler können ein Foto hochladen.');
      room.setFoto(socket.data.playerId, foto);
      use(room);
    });

    handle('board:foto', ({ playerId, hidden, hostToken }, use) => {
      const room = hostRoom('Fotos ausblenden', { hostToken });
      room.hideFoto(String(playerId || ''), hidden !== false);
      use(room);
    });

    handle('act', (action, use) => {
      const room = ownRoom();
      if (socket.data.role !== 'player') fail('Nur Spieler können Aktionen ausführen.');
      use(room);
      room.act(socket.data.playerId, action);
    });

    if (this.config.testMode) {
      // Nur im Testmodus: Würfel vorgeben, damit Browser-Tests reproduzierbar sind.
      handle('debug:dice', ({ dice, hostToken }, use) => {
        const room = hostRoom('Würfel vorgeben', { hostToken });
        const list = (Array.isArray(dice) ? dice : []).map((d) => [Number(d[0]), Number(d[1])]);
        if (!room.game) room.pendingDice.push(...list);
        else if (room.game.debugDice) room.game.debugDice(list);
        else fail('Dieses Spiel unterstützt keine vorgegebenen Würfel.');
        use(room);
      });
    }

    socket.on('disconnect', () => {
      const room = this.get(socket.data.code);
      if (!room) return;
      // Ab jetzt zählt die Zeit, nach der ein leerer Raum verschwindet
      if (socket.data.role === 'board') { room.hostSockets.delete(socket.id); room.touch(); return; }
      if (socket.data.role !== 'player') return;
      room.detach(socket);
      room.broadcast();
    });
  }
}

module.exports = {
  RoomManager, Room, UserError, MINIGAMES, TIMING, COLORS, FIGURES, DEFAULT_AVATAR, FOTO_CHANGES_PER_MINUTE, MAX_FOTOS_PER_ROOM, MAX_PLAYERS, MIN_PLAYERS, RECONNECT_GRACE_MS, ROOM_IDLE_MS,
  MAX_ACTIVE_ROOMS, ROOMS_PER_MINUTE_PER_IP, EMPTY_ROOM_MS,
};
