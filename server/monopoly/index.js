'use strict';

/* =========================================================
 *  Monopoly als Spielmodul (Schnittstelle siehe server/games/index.js):
 *  Regel-Engine, Animationszeiten, automatisches Würfeln, Auktions-Timer
 *  und die Minispiele, die durch die Würfelsumme ausgelöst werden.
 * ========================================================= */

const { MonopolyGame, RuleError } = require('./rules');
const { SQUARES, GROUP_COLORS } = require('./board');
const { HorseRace } = require('../games/horserace');
const { Roulette } = require('../games/roulette');
const { Blackjack } = require('../games/blackjack');

const fail = (message) => { throw new RuleError(message); };

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

/** Phasen, in denen das Spiel auf einen bestimmten Spieler wartet. */
const WAITING_PHASES = ['roll', 'jail', 'buy', 'debt', 'end'];

class MonopolySession {
  constructor(engine, { rng, timeScale = 1, onChange = () => {}, shoe = {} }) {
    this.engine = engine;
    this.rng = rng;
    this.timeScale = timeScale;
    this.onChange = onChange;
    this.shoe = shoe;
    this.mini = null;
    this.animUntil = 0;
    this.seenRollSeq = 0;
    this.seenMoveSeq = 0;
    this.rollAt = null;
    this.rollFor = null;
    this.miniAt = null;
  }

  /* ---------- Spielzüge ---------- */

  handleAction(pid, action = {}) {
    const g = this.engine;
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
      case 'quit':
        g.quit(pid);
        if (this.mini && this.mini.leave) this.mini.leave(pid);
        break;
      case 'trade:propose': g.proposeTrade(pid, action.trade || {}); break;
      case 'trade:respond': g.respondTrade(pid, action.id, Boolean(action.accept)); break;
      case 'trade:cancel': g.cancelTrade(pid, action.id); break;
      case 'mini':
        if (!this.mini) fail('Gerade läuft kein Minispiel.');
        this.mini.handle(pid, action.action || {});
        break;
      default: fail('Unbekannte Aktion.');
    }
    this.afterChange();
  }

  /** Merkt sich, wie lange das Tablet für Würfel und Figuren braucht. */
  afterChange() {
    const g = this.engine;
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
  }

  /* ---------- Zeitsteuerung ---------- */

  /** Automatisches Würfeln, Auktionsende und Start der Minispiele. */
  tick(now = Date.now(), { isConnected = () => true } = {}) {
    // Jeder ausgeführte Schritt kann den nächsten fällig machen – begrenzt wiederholen
    for (let i = 0; i < 10; i++) {
      const result = this.step(now, isConnected);
      if (result !== 'acted') return result;
    }
    return 0;
  }

  step(now, isConnected) {
    const g = this.engine;
    if (g.phase === 'gameover') {
      this.stopMini();
      return null;
    }
    const due = [];
    const run = (fn) => {
      try { fn(); } catch (err) { console.error(err); }
      this.afterChange();
      return 'acted';
    };

    const cur = g.currentPlayer();
    if (g.phase === 'roll' && isConnected(cur.id)) {
      if (this.rollAt === null || this.rollFor !== cur.id) {
        this.rollFor = cur.id;
        this.rollAt = Math.max(this.animUntil, now) + TIMING.rollDelay * this.timeScale;
      }
      if (now >= this.rollAt) {
        this.rollAt = null;
        return run(() => g.roll(cur.id));
      }
      due.push(this.rollAt);
    } else {
      this.rollAt = null;
    }

    if (g.phase === 'auction' && g.auction) {
      const end = g.auction.endsAt + 50;
      if (now >= end && g.now() >= g.auction.endsAt) return run(() => g.auctionTimeout());
      due.push(Math.max(end, now + 1));
    }

    if (g.phase === 'minigame' && !this.mini) {
      if (this.miniAt === null) this.miniAt = Math.max(this.animUntil, now) + TIMING.miniDelay * this.timeScale;
      if (now >= this.miniAt) {
        this.miniAt = null;
        return run(() => this.startMini());
      }
      due.push(this.miniAt);
    } else {
      this.miniAt = null;
    }

    return due.length ? Math.max(0, Math.min(...due) - now) : null;
  }

  /* ---------- Minispiele ---------- */

  startMini() {
    const g = this.engine;
    if (g.phase !== 'minigame' || this.mini) return;
    const { type, seq } = g.minigame;
    const Game = MINIGAMES[type];
    if (!Game) {
      g.finishMinigame();
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
      onChange: () => this.onChange(),
      onDone: () => this.finishMini(),
    });
    this.mini.start();
  }

  finishMini() {
    this.stopMini();
    this.engine.finishMinigame();
    this.afterChange();
    this.onChange();
  }

  stopMini() {
    if (this.mini) this.mini.stop();
    this.mini = null;
  }

  /* ---------- Raum-Schnittstelle ---------- */

  isOver() { return this.engine.phase === 'gameover'; }

  /** Spieler am Zug oder mit Schulden, auf den das Spiel gerade wartet – sonst null. */
  waitingFor() {
    const g = this.engine;
    if (!WAITING_PHASES.includes(g.phase)) return null;
    if (g.phase === 'debt' && g.debts[0]) return g.debts[0].debtorId;
    return g.currentPlayer().id;
  }

  removePlayer(pid) {
    this.engine.removePlayer(pid);
    this.afterChange();
  }

  /** Während eines Minispiels wird nicht gespeichert – der letzte Stand ist dann dessen Beginn. */
  canSave() { return !this.mini; }

  /** Nur im Testmodus: Würfel vorgeben. */
  debugDice(list) { this.engine.forcedDice.push(...list); }

  view(role) {
    return {
      board: BOARD,
      groupColors: GROUP_COLORS,
      timing: { ...TIMING, timeScale: this.timeScale },
      game: this.engine.publicState(),
      animUntil: this.animUntil,
      mini: this.mini ? this.mini.view(role) : null,
    };
  }

  toJSON() {
    return { engine: this.engine.toJSON(), shoe: this.shoe };
  }

  dispose() { this.stopMini(); }
}

module.exports = {
  id: 'monopoly',
  name: 'Monopoly',
  minPlayers: 2,
  maxPlayers: 10,

  defaultSettings() { return { startMoney: 1500 }; },

  applySettings(settings, patch = {}) {
    const next = { ...settings };
    if ('startMoney' in patch) {
      const v = Math.floor(Number(patch.startMoney));
      if (!Number.isFinite(v) || v < 100 || v > 100000) fail('Der Startbetrag muss zwischen 100 und 100.000 M liegen.');
      next.startMoney = v;
    }
    return next;
  },

  createGame({ players, settings = {}, rng, timeScale, onChange, forcedDice = [] }) {
    const engine = new MonopolyGame({ players, startMoney: settings.startMoney, rng });
    engine.forcedDice.push(...forcedDice);
    const session = new MonopolySession(engine, { rng, timeScale, onChange });
    session.afterChange();
    return session;
  },

  /** Stellt eine gespeicherte Partie wieder her; ein unterbrochenes Minispiel startet neu. */
  restoreGame(data, { rng, timeScale, onChange }) {
    const engine = MonopolyGame.fromJSON(data.engine, { rng });
    const session = new MonopolySession(engine, { rng, timeScale, onChange, shoe: data.shoe || {} });
    // Bereits gezeigte Würfe und Züge nicht noch einmal abwarten
    session.seenRollSeq = engine.lastRoll ? engine.lastRoll.seq : 0;
    session.seenMoveSeq = engine.moves.reduce((m, x) => Math.max(m, x.seq), 0);
    return session;
  },

  MonopolySession,
  TIMING,
  MINIGAMES,
};
