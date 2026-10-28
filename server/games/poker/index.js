'use strict';

/* =========================================================
 *  Poker (Texas Hold'em) als Spielmodul (Schnittstelle siehe server/games/index.js).
 *
 *  Animationen: Die Engine (rules.js) sammelt nach jeder Aktion Ereignisse
 *  (Austeilen, Setzen, Pot, Flop/Turn/River, Aufdecken, Gewinn). Hier bekommt
 *  jedes Ereignis Startzeit und Dauer; strikt nacheinander. Daraus ergibt sich
 *  animUntil – die Handys warten, bis der Fernseher fertig ist. Zugzeit und
 *  die nächste Runde beginnen erst danach.
 *
 *  Versteckte Information: view('player', id) enthält nur die eigenen Karten,
 *  view('board') keine Handkarten außer den am Showdown aufgedeckten.
 * ========================================================= */

const { PokerGame, RuleError, MIN_PLAYERS, MAX_PLAYERS, DEFAULT_SETTINGS, STREET_NAMES, applySettings } = require('./rules');
const { formatEuro } = require('./money');

/** 12 gut unterscheidbare Spielerfarben (nur Poker); dazu zeigt der Tisch immer die Sitznummer. */
const POKER_COLORS = ['#d1495b', '#2e86de', '#f0a202', '#7e57c2', '#26a69a', '#ef6c9a', '#8d6e63', '#9ccc65', '#00acc1', '#f57c00', '#5c6bc0', '#e0e0e0'];

const ANIMATIONS = ['normal', 'kurz', 'aus'];

/** Dauer der Animationen in ms je Einstellung; „aus“ zeigt nur das Ergebnis. */
const ANIM_MS = {
  normal: { hand: 700, card: 140, bet: 650, fold: 500, check: 450, collect: 700, return: 650, flop: 2100, turn: 1200, river: 1200, reveal: 1500, muck: 600, win: 2300, rebuy: 600, handEnd: 0, gameover: 0 },
  kurz: { hand: 400, card: 70, bet: 380, fold: 300, check: 260, collect: 400, return: 380, flop: 1200, turn: 700, river: 700, reveal: 900, muck: 350, win: 1300, rebuy: 350, handEnd: 0, gameover: 0 },
};
/** Pause zwischen zwei Runden (nach der letzten Animation). */
const BETWEEN_MS = { normal: 2600, kurz: 1600, aus: 1200 };
/** Wer am Showdown nicht gewinnen kann, hat so lange Zeit zum Zeigen; danach wird verdeckt weggeworfen. */
const MUCK_MS = 15000;
const ANIM_KEEP = 80;

const SETTING_KEYS = ['startMoney', 'smallBlind', 'bigBlind', 'rebuy', 'turnTime'];

class PokerSession extends PokerGame {
  constructor({ timeScale = 1, ...opts }) {
    super(opts);
    this.timeScale = timeScale;
    this.anim = { seq: 0, until: 0, events: [] };
    this.deadline = null;      // Zugzeit bzw. Showdown-Entscheidung (Server-Zeit) oder null
    this.deadlineKind = null;
    this.startHand();
    this.flush();
  }

  get animMode() { return ANIM_MS[this.settings.animation] ? this.settings.animation : null; }

  /** Dauer eines Ereignisses in ms. */
  duration(e) {
    const m = ANIM_MS[this.animMode];
    if (!m) return 0;
    let ms;
    if (e.type === 'deal') ms = m.card * e.order.length * 2;
    else if (e.type === 'bet') ms = e.action === 'fold' ? m.fold : e.action === 'check' ? m.check : m.bet;
    else if (e.type === 'street') ms = m[e.street];
    else ms = m[e.type] ?? 0;
    return Math.round(ms * (this.timeScale ?? 1));
  }

  /** Gesammelte Ereignisse der Engine einplanen: strikt nacheinander nach dem letzten. */
  flush() {
    const events = this.takeEvents();
    if (!events.length) return;
    const now = this.now();
    const anim = this.anim;
    if (events.some((e) => e.type === 'hand')) anim.events = [];   // neue Runde: alte Ereignisse (und Karten) verfallen
    let cursor = Math.max(now, anim.until);
    for (const e of events) {
      anim.seq += 1;
      const dur = this.duration(e);
      anim.events.push({ ...e, seq: anim.seq, at: cursor, dur });
      cursor += dur;
    }
    anim.until = cursor;
    if (anim.events.length > ANIM_KEEP) anim.events.splice(0, anim.events.length - ANIM_KEEP);
    this.deadline = null;
    this.deadlineKind = null;
  }

  handleAction(pid, action = {}) {
    try {
      super.handleAction(pid, action);
    } finally {
      this.flush();
    }
  }

  removePlayer(pid) {
    this.leave(pid, 'timeout');
    this.flush();
  }

  endByHost() {
    super.endByHost();
    this.flush();
  }

  /**
   * Zeitgesteuerte Schritte: nächste Runde nach den Animationen, abgelaufene Zugzeit
   * (Check, sonst Fold), Showdown-Entscheidung (verdeckt wegwerfen), Nachkauf-Entscheidung
   * (aussetzen). Ist der Spieler, auf den gewartet wird, getrennt, ruht seine Zugzeit (Pause).
   */
  tick(now = this.now(), { isConnected = () => true } = {}) {
    for (let guard = 0; guard < 50; guard++) {
      if (this.phase === 'gameover') return null;
      const step = this.nextStep(now, isConnected);
      if (step === 'again') continue;
      return step;
    }
    return 1000;
  }

  /** Ein Schritt von tick: 'again', Wartezeit in ms oder null. */
  nextStep(now, isConnected) {
    const until = this.anim.until;
    if (this.phase === 'between') {
      const pending = this.pendingRebuys()[0];
      if (pending) return this.timed(now, isConnected, pending.id, 'rebuy', this.settings.turnTime * 1000, () => this.sitOut(pending.id, true));
      if (!this.canStartHand()) return null;
      const at = until + Math.round(BETWEEN_MS[this.settings.animation in BETWEEN_MS ? this.settings.animation : 'normal'] * (this.timeScale ?? 1));
      if (now < at) return at - now;
      this.startHand();
      this.flush();
      return 'again';
    }
    if (this.phase === 'betting') {
      const p = this.actor();
      if (!p) return null;
      return this.timed(now, isConnected, p.id, 'turn', this.settings.turnTime * 1000, () => this.autoAct());
    }
    if (this.phase === 'showdown') {
      const id = this.showdown && this.showdown.decider;
      if (!id) return null;
      // Getrennt am Showdown: sofort verdeckt wegwerfen (verrät nichts)
      if (!isConnected(id)) { this.showdownChoice(id, false, true); this.flush(); return 'again'; }
      return this.timed(now, isConnected, id, 'muck', Math.round(MUCK_MS * (this.timeScale ?? 1)), () => this.showdownChoice(id, false, true));
    }
    return null;
  }

  /** Frist für eine Entscheidung; beginnt erst nach den Animationen und ruht, solange der Spieler getrennt ist. */
  timed(now, isConnected, pid, kind, ms, onExpire) {
    if (!ms) return null;
    const key = `${kind}:${pid}:${this.handNo}:${this.anim.seq}`;
    if (!isConnected(pid)) { this.deadline = null; this.deadlineKind = null; return null; }
    if (!this.deadline || this.deadlineKind !== key) {
      this.deadline = Math.max(now, this.anim.until) + ms;
      this.deadlineKind = key;
    }
    if (now < this.deadline) return this.deadline - now;
    onExpire();
    this.flush();
    return 'again';
  }

  /* ---------------- Anzeige ---------------- */

  /** Kurze Texte für Kopfzeile (Fernseher) und Handy. */
  statusInfo() {
    const name = (id) => this.player(id).name;
    const base = { phase: this.phase, street: this.street, playerId: null, handNo: this.handNo };
    if (this.phase === 'betting') {
      const p = this.actor();
      const toCall = p ? this.toCall(p) : 0;
      return { ...base, playerId: p ? p.id : null, title: STREET_NAMES[this.street], text: p ? `${p.name} ist am Zug` : '', detail: toCall ? `Zum Mitgehen ${formatEuro(Math.min(toCall, p.stack))}` : 'Checken möglich' };
    }
    if (this.phase === 'showdown') {
      const d = this.showdown && this.showdown.decider;
      return { ...base, playerId: d, title: 'Showdown', text: d ? `${name(d)} zeigt oder wirft weg` : 'Showdown', detail: '' };
    }
    if (this.phase === 'between') {
      const pending = this.pendingRebuys();
      if (pending.length) return { ...base, playerId: pending[0].id, title: 'Pause', text: `${pending.map((p) => p.name).join(', ')}: nachkaufen oder aussetzen`, detail: '' };
      if (!this.canStartHand()) return { ...base, title: 'Pause', text: 'Warte auf Spieler', detail: 'Es braucht mindestens zwei Spieler mit Guthaben' };
      return { ...base, title: 'Pause', text: 'Gleich beginnt die nächste Runde', detail: '' };
    }
    if (this.phase === 'gameover') {
      if (this.endedBy === 'host') return { ...base, title: 'Spielende', text: 'Spiel vom Host beendet', detail: '' };
      return { ...base, playerId: this.winner, title: 'Spielende', text: this.winner ? `${name(this.winner)} gewinnt` : 'Das Spiel ist vorbei', detail: '' };
    }
    return { ...base, title: '', text: '', detail: '' };
  }

  view(role, playerId = null) {
    const game = this.publicState(role === 'player' ? playerId : null);
    return {
      game,
      status: this.statusInfo(),
      deadline: this.deadline,
      deadlineFor: this.deadline ? this.waitingFor() : null,
      animUntil: this.anim.until,
      anim: { seq: this.anim.seq, events: this.anim.events },
    };
  }

  toJSON() {
    const data = super.toJSON();
    delete data.timeScale;
    return data;
  }

  canSave() { return true; }

  dispose() {}
}

module.exports = {
  id: 'poker',
  name: 'Poker',
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  colors: POKER_COLORS,

  defaultSettings() { return { ...DEFAULT_SETTINGS, animation: 'normal' }; },

  applySettings(settings, patch = {}) {
    const rules = {};
    for (const k of SETTING_KEYS) if (k in patch) rules[k] = patch[k];
    const next = { ...settings, ...applySettings(settings, rules) };
    if ('animation' in patch) {
      if (!ANIMATIONS.includes(patch.animation)) throw new RuleError('Animationen: bitte „normal“, „kurz“ oder „aus“ wählen.');
      next.animation = patch.animation;
    }
    return next;
  },

  createGame({ players, settings, rng, timeScale = 1, now }) {
    // Farben stammen aus der Poker-Palette der Lobby; fehlt eine, gibt es die nächste freie
    const used = new Set(players.map((p) => p.color).filter((c) => POKER_COLORS.includes(c)));
    const free = POKER_COLORS.filter((c) => !used.has(c));
    const seated = players.map((p) => ({ ...p, color: POKER_COLORS.includes(p.color) ? p.color : free.shift() }));
    return new PokerSession({ players: seated, settings, rng, timeScale, ...(now ? { now } : {}) });
  },

  restoreGame(data, { rng, timeScale = 1, now }) {
    const game = PokerSession.fromJSON(data, { rng, ...(now ? { now } : {}) });
    game.timeScale = timeScale;
    if (!game.anim) game.anim = { seq: 0, until: 0, events: [] };
    return game;
  },

  PokerSession,
  POKER_COLORS,
  ANIM_MS,
  BETWEEN_MS,
  MUCK_MS,
};
