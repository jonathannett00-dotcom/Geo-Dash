'use strict';

/* =========================================================
 *  Texas Hold'em (Cash-Game) – reine Spiellogik.
 *  Der Server ist die einzige Instanz: gemischt wird über server/rng.js,
 *  jede Aktion prüft Zug, Phase und Betrag und wirft sonst RuleError mit
 *  einer deutschen Meldung. Alle Beträge sind ganze Cent.
 *
 *  Ablauf einer Runde (Hand): Button weiter, Blinds, je zwei Karten,
 *  Setzrunden Pre-Flop, Flop, Turn, River, Showdown (aufdecken oder
 *  verdeckt wegwerfen), Pots verteilen. Zwischen zwei Runden kaufen
 *  Pleite gegangene Spieler nach oder setzen aus.
 *
 *  Für die Anzeige sammelt die Engine Ereignisse (this.pending); das
 *  Spielmodul (index.js) gibt ihnen Startzeit und Dauer.
 * ========================================================= */

const { shuffledDeck, isCard } = require('./cards');
const { bestHand, compareScores } = require('./hands');
const { uncalled, buildPots, splitPot } = require('./pots');
const { formatEuro, parseEuro } = require('./money');
const { createRng } = require('../../rng');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 12;
/** Version des gespeicherten Spielstands. */
const FORMAT_VERSION = 1;
const LOG_LIMIT = 60;

/** Einstellungen in Cent bzw. Sekunden. */
const DEFAULT_SETTINGS = { startMoney: 2000, smallBlind: 10, bigBlind: 20, rebuy: true, turnTime: 0 };
const TURN_TIMES = [0, 30, 60];
const START_MIN = 100;
const START_MAX = 10000000;

const STREETS = ['preflop', 'flop', 'turn', 'river'];
const STREET_NAMES = { preflop: 'Pre-Flop', flop: 'Flop', turn: 'Turn', river: 'River' };

class RuleError extends Error {
  constructor(message) { super(message); this.name = 'RuleError'; }
}
const fail = (message) => { throw new RuleError(message); };
const euro = formatEuro;

/* ---------------- Einstellungen ---------------- */

/** Betrag aus der Lobby (Text oder Zahl in Euro) → Cent, sonst verständliche Meldung. */
function moneySetting(value, label) {
  const cents = parseEuro(value);
  if (cents === null) fail(`${label}: Bitte einen Betrag wie 12,50 € eingeben (Komma oder Punkt, höchstens zwei Nachkommastellen).`);
  return cents;
}

/** Geprüfte neue Einstellungen (Beträge als Euro-Text oder -Zahl, gespeichert in Cent). */
function applySettings(settings, patch = {}) {
  const next = { ...DEFAULT_SETTINGS, ...settings };
  if ('startMoney' in patch) next.startMoney = moneySetting(patch.startMoney, 'Startguthaben');
  if ('smallBlind' in patch) next.smallBlind = moneySetting(patch.smallBlind, 'Small Blind');
  if ('bigBlind' in patch) next.bigBlind = moneySetting(patch.bigBlind, 'Big Blind');
  if ('rebuy' in patch) {
    const v = patch.rebuy;
    if (v === true || v === 'an' || v === 'true') next.rebuy = true;
    else if (v === false || v === 'aus' || v === 'false') next.rebuy = false;
    else fail('Nachkaufen: bitte „an“ oder „aus“ wählen.');
  }
  if ('turnTime' in patch) {
    const v = patch.turnTime === 'aus' ? 0 : Number(patch.turnTime);
    if (!TURN_TIMES.includes(v)) fail('Zugzeit: bitte „aus“, 30 oder 60 Sekunden wählen.');
    next.turnTime = v;
  }
  if (next.startMoney < START_MIN || next.startMoney > START_MAX) fail(`Startguthaben: bitte einen Betrag zwischen ${euro(START_MIN)} und ${euro(START_MAX)} eingeben.`);
  if (next.smallBlind < 1) fail('Der Small Blind muss mindestens 0,01 € sein.');
  if (next.bigBlind < next.smallBlind) fail('Der Big Blind muss mindestens so groß sein wie der Small Blind.');
  if (next.bigBlind > next.startMoney) fail('Der Big Blind darf höchstens so groß sein wie das Startguthaben.');
  return next;
}

/* ---------------- Engine ---------------- */

class PokerGame {
  constructor({ players, settings = {}, rng = createRng(), now = Date.now }) {
    if (!players || players.length < MIN_PLAYERS) fail(`Es werden mindestens ${MIN_PLAYERS} Spieler gebraucht.`);
    if (players.length > MAX_PLAYERS) fail(`Poker ist für höchstens ${MAX_PLAYERS} Spieler – ein ${players.length}. Platz ist am Tisch nicht frei.`);
    this.rng = rng;
    this.now = now;
    this.type = 'poker';
    this.format = FORMAT_VERSION;
    this.settings = applySettings({ ...DEFAULT_SETTINGS, ...settings }, {});
    this.players = players.map((p, i) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      seat: i + 1,
      stack: this.settings.startMoney,
      rebuys: 0,
      status: 'playing',      // 'playing' | 'sitout' (pleite, setzt aus) | 'out' (pleite ohne Nachkaufen) | 'left'
      pendingRebuy: false,    // pleite: Entscheidung Nachkaufen/Aussetzen steht aus
      ...PokerGame.emptyHandState(),
    }));
    this.phase = 'between';   // 'betting' | 'showdown' | 'between' | 'gameover'
    this.street = null;
    this.handNo = 0;
    this.board = [];
    this.deck = [];
    this.buttonIndex = rng.int(this.players.length);
    this.sbIndex = -1;
    this.bbIndex = -1;
    this.actorIndex = -1;
    this.currentBet = 0;
    this.lastRaise = 0;
    this.raiseSeq = 0;
    this.lastAggressor = null;
    this.showdown = null;     // { order: [ids], pos, decider, allIn }
    this.result = null;       // Ergebnis der letzten Runde (für die Anzeige zwischen zwei Runden)
    this.winner = null;
    this.seq = 0;
    this.log = [];
    this.pending = [];        // Ereignisse für die Animationen (nicht gespeichert)
  }

  static emptyHandState() {
    return { inHand: false, cards: [], folded: false, allIn: false, bet: 0, committed: 0, acted: false, actedSeq: 0, lastAction: null, shown: null, mucked: false, hand: null };
  }

  /* ---------------- Hilfen ---------------- */

  event(text, kind = 'info') {
    this.seq += 1;
    this.log.push({ seq: this.seq, text, kind, time: this.now() });
    if (this.log.length > LOG_LIMIT) this.log.shift();
  }

  emit(type, data = {}) { this.pending.push({ type, ...data }); }

  takeEvents() { const out = this.pending; this.pending = []; return out; }

  player(id) {
    const p = this.players.find((x) => x.id === id);
    if (!p) fail('Unbekannter Spieler.');
    return p;
  }

  idx(id) { return this.players.findIndex((p) => p.id === id); }

  actor() { return this.phase === 'betting' && this.actorIndex >= 0 ? this.players[this.actorIndex] : null; }

  /** Spieler in Sitzreihenfolge ab dem Platz nach `from` (ohne `from` selbst, am Ende `from`). */
  around(from) {
    const n = this.players.length;
    return Array.from({ length: n }, (_, i) => this.players[(from + 1 + i) % n]);
  }

  /** Nächster Index nach `from`, der die Bedingung erfüllt (oder -1). */
  nextIndex(from, cond) {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const j = (from + i) % n;
      if (cond(this.players[j])) return j;
    }
    return -1;
  }

  inHandPlayers() { return this.players.filter((p) => p.inHand); }

  livePlayers() { return this.players.filter((p) => p.inHand && !p.folded); }

  /** Noch handlungsfähig: in der Hand, nicht gefoldet, nicht All-in. */
  canAct(p) { return p.inHand && !p.folded && !p.allIn; }

  pot() { return this.players.reduce((s, p) => s + p.committed, 0); }

  /** Kann gerade gespielt werden (am Tisch und mit Geld)? */
  seated(p) { return p.status === 'playing' && p.stack > 0 && !p.pendingRebuy; }

  /** Gesamtes Geld am Tisch (Guthaben + Pot) – bleibt bis auf Nachkäufe konstant. */
  totalMoney() { return this.players.reduce((s, p) => s + p.stack + p.committed, 0); }

  /** Summe aller Einkäufe (Start + Nachkäufe) – muss totalMoney() entsprechen. */
  totalBuyIns() { return this.players.reduce((s, p) => s + this.settings.startMoney * (1 + p.rebuys), 0); }

  /* ---------------- Rundenbeginn ---------------- */

  /** Entscheidungen zum Nachkaufen, auf die noch gewartet wird. */
  pendingRebuys() { return this.players.filter((p) => p.pendingRebuy && p.status !== 'left'); }

  /** Kann die nächste Runde beginnen? */
  canStartHand() {
    return this.phase === 'between' && !this.pendingRebuys().length && this.players.filter((p) => this.seated(p)).length >= MIN_PLAYERS;
  }

  /** Neue Runde: Button weiter, Blinds, Karten. */
  startHand() {
    if (!this.canStartHand()) fail('Die nächste Runde kann noch nicht beginnen.');
    const seated = (p) => this.seated(p);
    for (const p of this.players) Object.assign(p, PokerGame.emptyHandState());
    // Button rückt zum nächsten Spieler mit Guthaben (beim ersten Mal steht er schon)
    this.buttonIndex = this.handNo === 0 && seated(this.players[this.buttonIndex])
      ? this.buttonIndex : this.nextIndex(this.buttonIndex, seated);
    this.handNo += 1;
    this.result = null;
    this.showdown = null;
    this.board = [];
    this.deck = shuffledDeck(this.rng);
    for (const p of this.players) if (seated(p)) p.inHand = true;
    const count = this.inHandPlayers().length;
    // Heads-up: Der Dealer ist Small Blind und handelt vor dem Flop zuerst
    this.sbIndex = count === 2 ? this.buttonIndex : this.nextIndex(this.buttonIndex, (p) => p.inHand);
    this.bbIndex = this.nextIndex(this.sbIndex, (p) => p.inHand);
    this.street = 'preflop';
    this.currentBet = 0;
    this.lastRaise = this.settings.bigBlind;
    this.raiseSeq = 1;
    this.lastAggressor = null;
    this.phase = 'betting';

    const button = this.players[this.buttonIndex];
    this.event(`Runde ${this.handNo}: ${button.name} gibt.`, 'hand');
    this.emit('hand', {
      handNo: this.handNo, buttonId: button.id, sbId: this.players[this.sbIndex].id, bbId: this.players[this.bbIndex].id,
      order: this.around(this.buttonIndex).filter((p) => p.inHand).map((p) => p.id),
    });
    this.postBlind(this.players[this.sbIndex], this.settings.smallBlind, 'sb');
    this.postBlind(this.players[this.bbIndex], this.settings.bigBlind, 'bb');
    this.currentBet = Math.max(...this.players.map((p) => p.bet));

    // Austeilen: je eine Karte reihum ab links vom Dealer, zweimal
    const order = this.around(this.buttonIndex).filter((p) => p.inHand);
    for (let round = 0; round < 2; round++) for (const p of order) p.cards.push(this.deck.shift());
    this.emit('deal', { order: order.map((p) => p.id) });

    // Wer zuerst handelt: Heads-up der Dealer (Small Blind), sonst der Spieler nach dem Big Blind
    const first = count === 2 ? this.sbIndex : this.nextIndex(this.bbIndex, (p) => p.inHand);
    this.actorIndex = this.canAct(this.players[first]) ? first : this.nextIndex(first, (p) => this.canAct(p));
    this.advance(true);
  }

  postBlind(p, amount, kind) {
    const paid = Math.min(amount, p.stack);
    this.move(p, paid);
    p.lastAction = kind === 'sb' ? 'Small Blind' : 'Big Blind';
    this.event(`${p.name} setzt den ${p.lastAction} (${euro(paid)})${p.allIn ? ' und ist All-in' : ''}.`, 'blind');
    this.emit('bet', { playerId: p.id, action: kind, amount: paid, to: p.bet, allIn: p.allIn });
  }

  /** Chips vom Guthaben in den Einsatz dieser Setzrunde. */
  move(p, amount) {
    p.stack -= amount;
    p.bet += amount;
    p.committed += amount;
    if (p.stack === 0 && p.inHand) p.allIn = true;
  }

  /* ---------------- Setzen ---------------- */

  toCall(p) { return Math.max(0, this.currentBet - p.bet); }

  /** Mindestbetrag, auf den erhöht werden muss (gesamter Einsatz dieser Setzrunde). */
  minRaiseTo() {
    return this.currentBet === 0 ? this.settings.bigBlind : this.currentBet + this.lastRaise;
  }

  /** Darf p erhöhen? Nach einem zu kleinen All-in nur, wer seitdem nicht gehandelt hat. */
  raiseBlock(p) {
    if (p.stack <= this.toCall(p)) return 'Dein Guthaben reicht nur zum Mitgehen.';
    if (!this.livePlayers().some((q) => q !== p && !q.allIn)) return 'Alle anderen sind All-in – du kannst nur mitgehen oder aussteigen.';
    if (p.acted && p.actedSeq >= this.raiseSeq) return 'Nach einem zu kleinen All-in darfst du nur mitgehen oder aussteigen.';
    return null;
  }

  /** Was der Spieler am Zug tun darf (für das Handy). */
  options(p) {
    if (this.actor() !== p) return null;
    const toCall = this.toCall(p);
    const block = this.raiseBlock(p);
    const maxTo = p.bet + p.stack;
    return {
      toCall,
      callAmount: Math.min(toCall, p.stack),
      canCheck: toCall === 0,
      canCall: toCall > 0,
      canRaise: !block,
      raiseBlock: block,
      minTo: Math.min(this.minRaiseTo(), maxTo),
      maxTo,
      currentBet: this.currentBet,
      bet: p.bet,
      stack: p.stack,
    };
  }

  assertTurn(pid) {
    const p = this.player(pid);
    if (p.status === 'left') fail('Du hast den Tisch verlassen.');
    if (this.phase === 'gameover') fail('Das Spiel ist vorbei.');
    if (this.phase !== 'betting') fail(this.phase === 'showdown' ? 'Gerade ist Showdown – es wird nicht mehr gesetzt.' : 'Gerade wird nicht gesetzt – warte auf die nächste Runde.');
    if (!p.inHand || p.folded) fail('Du spielst in dieser Runde nicht mehr mit.');
    const cur = this.actor();
    if (cur !== p) fail(`Du bist nicht am Zug – gerade ist ${cur.name} dran.`);
    return p;
  }

  fold(p, auto = false) {
    p.folded = true;
    p.acted = true;
    p.lastAction = 'Fold';
    this.event(`${p.name} steigt aus${auto ? ' (Zeit abgelaufen)' : ''}.`, 'fold');
    this.emit('bet', { playerId: p.id, action: 'fold', amount: 0, to: p.bet });
  }

  check(p, auto = false) {
    if (this.toCall(p) > 0) fail(`Schieben geht nicht – zum Mitgehen fehlen ${euro(this.toCall(p))}. Du kannst mitgehen, erhöhen oder aussteigen.`);
    p.acted = true;
    p.actedSeq = this.raiseSeq;
    p.lastAction = 'Check';
    this.event(`${p.name} checkt${auto ? ' (Zeit abgelaufen)' : ''}.`, 'check');
    this.emit('bet', { playerId: p.id, action: 'check', amount: 0, to: p.bet });
  }

  call(p) {
    const need = this.toCall(p);
    if (need === 0) fail('Es gibt nichts mitzugehen – du kannst checken.');
    const paid = Math.min(need, p.stack);
    this.move(p, paid);
    p.acted = true;
    p.actedSeq = this.raiseSeq;
    p.lastAction = p.allIn ? 'All-in' : 'Call';
    this.event(`${p.name} geht mit (${euro(paid)})${p.allIn ? ' und ist All-in' : ''}.`, 'call');
    this.emit('bet', { playerId: p.id, action: p.allIn ? 'allin' : 'call', amount: paid, to: p.bet, allIn: p.allIn });
  }

  /** Erhöhen auf `to` (gesamter Einsatz dieser Setzrunde, in Cent). */
  raise(p, to) {
    if (!Number.isInteger(to) || to <= 0) fail('Bitte einen gültigen Betrag angeben.');
    const maxTo = p.bet + p.stack;
    if (to > maxTo) fail(`So viel hast du nicht – höchstens ${euro(maxTo)} (All-in).`);
    if (to <= this.currentBet) fail(`Zum Erhöhen musst du mehr als ${euro(this.currentBet)} setzen.`);
    const block = this.raiseBlock(p);
    if (block) fail(block);
    const minTo = this.minRaiseTo();
    if (to < minTo && to < maxTo) fail(`Erhöhe mindestens auf ${euro(minTo)} – oder geh All-in.`);
    const opened = this.currentBet === 0;
    const increase = to - this.currentBet;
    const paid = to - p.bet;
    this.move(p, paid);
    if (increase >= this.lastRaise) {
      // Vollständige Erhöhung: alle anderen dürfen wieder erhöhen
      this.lastRaise = increase;
      this.raiseSeq += 1;
    }
    this.currentBet = to;
    this.lastAggressor = p.id;
    p.acted = true;
    p.actedSeq = this.raiseSeq;
    p.lastAction = p.allIn ? 'All-in' : opened ? 'Bet' : 'Raise';
    this.event(p.allIn
      ? `${p.name} geht All-in (${euro(to)}).`
      : opened ? `${p.name} setzt ${euro(to)}.` : `${p.name} erhöht auf ${euro(to)}.`, 'raise');
    this.emit('bet', { playerId: p.id, action: p.allIn ? 'allin' : opened ? 'bet' : 'raise', amount: paid, to, allIn: p.allIn });
  }

  allIn(p) {
    if (p.stack <= 0) fail('Du hast kein Guthaben mehr.');
    const to = p.bet + p.stack;
    if (to <= this.currentBet) return this.call(p);
    const block = this.raiseBlock(p);
    if (block) {
      if (this.toCall(p) > 0) fail(`${block} Mitgehen kostet ${euro(this.toCall(p))}.`);
      fail(block);
    }
    return this.raise(p, to);
  }

  /** Aktion des Spielers am Zug. */
  bettingAction(pid, action) {
    const p = this.assertTurn(pid);
    switch (action.type) {
      case 'fold': this.fold(p); break;
      case 'check': this.check(p); break;
      case 'call': this.call(p); break;
      case 'raise': this.raise(p, Number(action.to)); break;
      case 'allin': this.allIn(p); break;
      default: fail('Unbekannte Aktion.');
    }
    this.advance();
  }

  /** Zeit abgelaufen: checken, wenn möglich, sonst aussteigen. */
  autoAct() {
    const p = this.actor();
    if (!p) return;
    if (this.toCall(p) === 0) this.check(p, true);
    else this.fold(p, true);
    this.advance();
  }

  /** Ist die Setzrunde abgeschlossen (niemand muss mehr handeln)? */
  streetDone() {
    return this.livePlayers().length < 2 || !this.players.some((p) => this.needsToAct(p));
  }

  /** Nach einer Aktion: nächster Spieler, nächste Straße, Showdown oder Gewinn durch Folds. */
  advance(fresh = false) {
    if (this.streetDone()) { this.endStreet(); return; }
    if (fresh && this.actorIndex >= 0 && this.needsToAct(this.players[this.actorIndex])) return;
    this.actorIndex = this.nextIndex(this.actorIndex, (p) => this.needsToAct(p));
  }

  /** Muss p in dieser Setzrunde noch handeln? */
  needsToAct(p) {
    if (!this.canAct(p)) return false;
    if (!p.acted) {
      // Ist p der Einzige, der noch handeln kann, und hat er schon genug gesetzt, ist nichts mehr zu tun
      const others = this.livePlayers().filter((q) => q !== p && !q.allIn);
      return others.length > 0 || p.bet < this.currentBet;
    }
    return p.bet < this.currentBet;
  }

  /** Einsätze in den Pot; nicht gecallte Einsätze zurück; weiter zur nächsten Straße. */
  endStreet() {
    this.actorIndex = -1;
    const back = uncalled(this.inHandPlayers().map((p) => ({ id: p.id, amount: p.bet })));
    if (back) {
      const p = this.player(back.id);
      p.stack += back.amount;
      p.bet -= back.amount;
      p.committed -= back.amount;
      if (p.stack > 0) p.allIn = false;
      this.event(`${p.name} bekommt ${euro(back.amount)} zurück (nicht mitgegangen).`, 'return');
      this.emit('return', { playerId: p.id, amount: back.amount });
    }
    const collected = this.players.reduce((s, p) => s + p.bet, 0);
    const bets = Object.fromEntries(this.players.filter((p) => p.bet > 0).map((p) => [p.id, p.bet]));
    for (const p of this.players) p.bet = 0;
    if (collected) this.emit('collect', { amount: collected, pot: this.pot(), bets });
    this.currentBet = 0;
    if (this.livePlayers().length === 1) { this.winByFold(); return; }

    const i = STREETS.indexOf(this.street);
    if (i === STREETS.length - 1) { this.startShowdown(); return; }
    this.street = STREETS[i + 1];
    this.deck.shift();   // Brennkarte
    const cards = this.deck.splice(0, this.street === 'flop' ? 3 : 1);
    this.board.push(...cards);
    this.event(`${STREET_NAMES[this.street]}: ${cards.map(cardText).join(' ')}`, 'street');
    this.emit('street', { street: this.street, cards, board: this.board.slice() });
    this.lastRaise = this.settings.bigBlind;
    this.raiseSeq += 1;
    for (const p of this.players) { p.acted = false; if (p.inHand && !p.folded && !p.allIn) p.lastAction = null; }
    this.lastAggressor = null;
    const live = this.livePlayers().filter((p) => !p.allIn);
    if (live.length < 2) { this.endStreet(); return; }   // alle (bis auf einen) All-in: Karten bis zum River
    this.actorIndex = this.nextIndex(this.buttonIndex, (p) => this.canAct(p));
  }

  /* ---------------- Rundenende ---------------- */

  /** Alle anderen sind ausgestiegen: Der letzte Spieler gewinnt, ohne Karten zu zeigen. */
  winByFold() {
    this.actorIndex = -1;
    for (const p of this.players) p.bet = 0;
    this.currentBet = 0;
    const winner = this.livePlayers()[0];
    const amount = this.pot();
    winner.stack += amount;
    for (const p of this.players) p.committed = 0;
    this.event(`${winner.name} gewinnt ${euro(amount)}.`, 'win');
    this.result = { pots: [{ amount, winners: [{ id: winner.id, amount }], label: null, cards: null, side: false }], byFold: true };
    this.emit('win', { pot: 0, amount, winners: [{ id: winner.id, amount }], label: null, cards: null, side: false });
    this.endHand();
  }

  /**
   * Showdown: Reihenfolge ab dem letzten Angreifer auf dem River, sonst ab links vom Dealer.
   * Wer gewinnen kann, muss zeigen; wer nicht gewinnen kann, darf verdeckt wegwerfen.
   * Ist jemand All-in, werden alle Hände gezeigt.
   */
  startShowdown() {
    this.phase = 'showdown';
    this.street = 'showdown';
    this.actorIndex = -1;
    for (const p of this.livePlayers()) p.hand = bestHand([...p.cards, ...this.board]);
    const startIdx = this.lastAggressor && this.player(this.lastAggressor).inHand && !this.player(this.lastAggressor).folded
      ? this.idx(this.lastAggressor) : this.nextIndex(this.buttonIndex, (p) => p.inHand && !p.folded);
    const order = [this.players[startIdx], ...this.around(startIdx)].filter((p, k, arr) => p.inHand && !p.folded && arr.indexOf(p) === k);
    this.showdown = { order: order.map((p) => p.id), pos: 0, decider: null, allIn: this.livePlayers().some((p) => p.allIn) };
    this.pots = this.currentPots();
    this.event('Showdown.', 'showdown');
    this.continueShowdown();
  }

  /** Pots der laufenden Runde (nach Abzug nicht gecallter Einsätze). */
  currentPots() {
    return buildPots(this.players.map((p) => ({ id: p.id, amount: p.committed, folded: !p.inHand || p.folded })));
  }

  /** Kann p (nach den bisher gezeigten Händen) noch mindestens einen Pot gewinnen oder teilen? */
  canStillWin(p) {
    return this.pots.some((pot) => {
      if (!pot.eligible.includes(p.id)) return false;
      const shown = pot.eligible.map((id) => this.player(id)).filter((q) => q.shown);
      return shown.every((q) => compareScores(p.hand.score, q.hand.score) >= 0);
    });
  }

  continueShowdown() {
    const sd = this.showdown;
    while (sd.pos < sd.order.length) {
      const p = this.player(sd.order[sd.pos]);
      if (sd.allIn || this.canStillWin(p)) { this.reveal(p); sd.pos += 1; continue; }
      // Kann nicht gewinnen: darf zeigen oder verdeckt wegwerfen (wer gegangen ist, wirft weg)
      if (p.status === 'left') { this.muck(p, true); sd.pos += 1; continue; }
      sd.decider = p.id;
      return;
    }
    sd.decider = null;
    this.settle();
  }

  reveal(p) {
    p.shown = p.cards.slice();
    p.lastAction = 'Zeigt';
    this.event(`${p.name} zeigt ${p.cards.map(cardText).join(' ')}: ${p.hand.label}.`, 'show');
    this.emit('reveal', { playerId: p.id, cards: p.cards.slice(), label: p.hand.label, best: p.hand.cards.slice() });
  }

  muck(p, auto = false) {
    p.mucked = true;
    p.folded = true;
    p.lastAction = 'Verdeckt';
    this.event(`${p.name} wirft verdeckt weg${auto ? ' (Zeit abgelaufen)' : ''}.`, 'muck');
    this.emit('muck', { playerId: p.id });
  }

  /** Entscheidung am Showdown: zeigen oder verdeckt wegwerfen. */
  showdownChoice(pid, show, auto = false) {
    const p = this.player(pid);
    if (this.phase !== 'showdown' || !this.showdown || this.showdown.decider !== pid) fail('Gerade musst du nichts aufdecken.');
    if (show) this.reveal(p);
    else this.muck(p, auto);
    this.showdown.pos += 1;
    this.showdown.decider = null;
    this.continueShowdown();
  }

  /** Pots an die besten gezeigten Hände; übrige Cent reihum ab links vom Dealer. */
  settle() {
    const fromButton = this.around(this.buttonIndex).map((p) => p.id);
    const result = [];
    this.pots.forEach((pot, k) => {
      const contenders = pot.eligible.map((id) => this.player(id)).filter((p) => p.shown);
      let best = null;
      for (const p of contenders) if (!best || compareScores(p.hand.score, best) > 0) best = p.hand.score;
      const winners = contenders.filter((p) => compareScores(p.hand.score, best) === 0)
        .sort((a, b) => fromButton.indexOf(a.id) - fromButton.indexOf(b.id));
      const shares = splitPot(pot.amount, winners.map((p) => p.id));
      for (const s of shares) this.player(s.id).stack += s.amount;
      const label = winners[0].hand.label;
      const cards = winners.length === 1 ? winners[0].hand.cards.slice() : null;
      const side = k > 0;
      const names = nameList(winners.map((p) => p.name));
      this.event(`${names} ${winners.length > 1 ? 'teilen sich' : 'gewinnt'} ${side ? `den Side-Pot ${k}` : this.pots.length > 1 ? 'den Hauptpot' : 'den Pot'} (${euro(pot.amount)}) mit ${label}.`, 'win');
      const entry = { pot: k, amount: pot.amount, winners: shares, label, cards, side };
      result.push(entry);
      this.emit('win', entry);
    });
    for (const p of this.players) p.committed = 0;
    this.result = { pots: result, byFold: false };
    this.pots = null;
    this.endHand();
  }

  /** Runde vorbei: Pleite gegangene entscheiden über Nachkaufen, ggf. Spielende. */
  endHand() {
    this.phase = 'between';
    this.actorIndex = -1;
    for (const p of this.players) {
      if (p.status === 'playing' && p.stack === 0) {
        if (this.settings.rebuy) {
          p.pendingRebuy = true;
          this.event(`${p.name} ist pleite: nachkaufen oder aussetzen?`, 'broke');
        } else {
          p.status = 'out';
          this.event(`${p.name} ist pleite und scheidet aus.`, 'broke');
        }
      }
    }
    this.emit('handEnd', { handNo: this.handNo });
    this.checkGameOver();
  }

  /** Spielende: Es können keine zwei Spieler mehr am Tisch sitzen. */
  checkGameOver() {
    if (this.phase === 'gameover') return true;
    if (this.phase !== 'between') return false;
    const possible = this.players.filter((p) => p.status !== 'left' && p.status !== 'out'
      && (p.stack > 0 || (this.settings.rebuy && (p.pendingRebuy || p.status === 'sitout'))));
    if (possible.length >= MIN_PLAYERS) return false;
    this.phase = 'gameover';
    this.street = null;
    const ranking = this.players.slice().sort((a, b) => b.stack - a.stack);
    this.winner = ranking[0] && ranking[0].stack > 0 ? ranking[0].id : null;
    this.event(this.winner ? `Spielende: ${ranking[0].name} gewinnt mit ${euro(ranking[0].stack)}.` : 'Spielende.', 'gameover');
    this.emit('gameover', { winner: this.winner });
    return true;
  }

  /* ---------------- Nachkaufen, Aussetzen, Verlassen ---------------- */

  rebuy(pid) {
    const p = this.player(pid);
    if (p.status === 'left') fail('Du hast den Tisch verlassen.');
    if (this.phase === 'gameover') fail('Das Spiel ist vorbei.');
    if (!this.settings.rebuy) fail('Nachkaufen ist in diesem Spiel ausgeschaltet.');
    if (p.stack > 0) fail('Nachkaufen geht erst, wenn dein Guthaben aufgebraucht ist.');
    if (p.inHand && this.phase !== 'between') fail('Nachkaufen geht erst nach dieser Runde.');
    p.stack = this.settings.startMoney;
    p.rebuys += 1;
    p.status = 'playing';
    p.pendingRebuy = false;
    this.event(`${p.name} kauft für ${euro(this.settings.startMoney)} nach (${p.rebuys}. Nachkauf).`, 'rebuy');
    this.emit('rebuy', { playerId: p.id, amount: this.settings.startMoney, rebuys: p.rebuys });
  }

  sitOut(pid, auto = false) {
    const p = this.player(pid);
    if (!p.pendingRebuy) fail('Aussetzen kannst du nur, wenn du pleite bist.');
    p.pendingRebuy = false;
    p.status = 'sitout';
    this.event(`${p.name} setzt aus${auto ? ' (Zeit abgelaufen)' : ''}.`, 'sitout');
    this.checkGameOver();
  }

  /** Spieler verlässt den Tisch (Aufstehen oder zu lange getrennt). Sein Guthaben bleibt in der Abrechnung. */
  leave(pid, reason = 'quit') {
    const p = this.player(pid);
    if (p.status === 'left' || this.phase === 'gameover') return;
    const wasActor = this.actor() === p;
    const decider = this.phase === 'showdown' && this.showdown && this.showdown.decider === pid;
    if (p.inHand && !p.folded && this.phase === 'betting') {
      p.folded = true;
      p.lastAction = 'Fold';
      this.emit('bet', { playerId: p.id, action: 'fold', amount: 0, to: p.bet });
    }
    p.status = 'left';
    p.pendingRebuy = false;
    this.event(reason === 'quit' ? `${p.name} verlässt den Tisch.` : `${p.name} war zu lange getrennt und verlässt den Tisch.`, 'left');
    if (decider) { this.showdownChoice(pid, false, true); return; }
    if (this.phase === 'betting') {
      if (wasActor) this.advance();
      else if (this.streetDone()) this.endStreet();
    } else if (this.phase === 'between') {
      this.checkGameOver();
    }
    // Am Showdown bleibt ein Spieler, der schon gezeigt hat, in der Wertung (seine Karten liegen offen)
  }

  /* ---------------- Aktionen der Clients ---------------- */

  handleAction(pid, action = {}) {
    switch (action.type) {
      case 'fold': case 'check': case 'call': case 'raise': case 'allin': this.bettingAction(pid, action); break;
      case 'show': this.showdownChoice(pid, true); break;
      case 'muck': this.showdownChoice(pid, false); break;
      case 'rebuy': this.rebuy(pid); break;
      case 'sitout': this.sitOut(pid); break;
      case 'leave': this.leave(pid, 'quit'); break;
      default: fail('Unbekannte Aktion.');
    }
  }

  /** Wartet das Spiel gerade auf einen bestimmten Spieler? */
  waitingFor() {
    if (this.phase === 'betting') return this.actor() ? this.actor().id : null;
    if (this.phase === 'showdown') return this.showdown ? this.showdown.decider : null;
    if (this.phase === 'between') { const p = this.pendingRebuys()[0]; return p ? p.id : null; }
    return null;
  }

  isOver() { return this.phase === 'gameover'; }

  /* ---------------- Speichern & Wiederherstellen ---------------- */

  /** Vollständiger Zustand inklusive Kartenstapel und Handkarten – nur für den Server-Speicher. */
  toJSON() {
    const { rng, now, pending, ...data } = this;
    return JSON.parse(JSON.stringify(data));
  }

  static fromJSON(data, { rng = createRng(), now = Date.now } = {}) {
    if (!data || data.type !== 'poker') throw new Error('Kein Poker-Spielstand.');
    if (data.format > FORMAT_VERSION) throw new Error(`Poker-Spielstand Version ${data.format} ist neuer als dieser Server.`);
    const g = Object.create(this.prototype);
    Object.assign(g, JSON.parse(JSON.stringify(data)));
    g.rng = rng;
    g.now = now;
    g.pending = [];
    return g;
  }

  /* ---------------- Zustand für die Clients ---------------- */

  /**
   * Öffentlicher Zustand. Handkarten sieht nur ihr Besitzer (viewerId); alle anderen –
   * auch der Fernseher – sehen nur, ob jemand Karten hat. Gezeigt werden nur Karten,
   * die am Showdown aufgedeckt wurden. Kartenstapel und weggeworfene Karten bleiben hier.
   */
  publicState(viewerId = null) {
    const viewer = this.players.find((p) => p.id === viewerId) || null;
    const actor = this.actor();
    return {
      phase: this.phase,
      street: this.street,
      handNo: this.handNo,
      board: this.board.slice(),
      pot: this.pot(),
      potCollected: this.players.reduce((s, p) => s + p.committed - p.bet, 0),
      currentBet: this.currentBet,
      minRaiseTo: this.phase === 'betting' ? this.minRaiseTo() : null,
      buttonId: this.players[this.buttonIndex] ? this.players[this.buttonIndex].id : null,
      sbId: this.sbIndex >= 0 ? this.players[this.sbIndex].id : null,
      bbId: this.bbIndex >= 0 ? this.players[this.bbIndex].id : null,
      actorId: actor ? actor.id : null,
      decider: this.phase === 'showdown' && this.showdown ? this.showdown.decider : null,
      settings: { ...this.settings },
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        seat: p.seat,
        stack: p.stack,
        bet: p.bet,
        committed: p.committed,
        rebuys: p.rebuys,
        status: p.status,
        pendingRebuy: p.pendingRebuy,
        inHand: p.inHand,
        hasCards: p.inHand && !p.folded && p.cards.length > 0,
        folded: p.folded,
        allIn: p.allIn,
        lastAction: p.lastAction,
        shown: p.shown ? p.shown.slice() : null,
        handLabel: p.shown && p.hand ? p.hand.label : null,
        best: p.shown && p.hand ? p.hand.cards.slice() : null,
        net: p.stack - this.settings.startMoney * (1 + p.rebuys),
      })),
      result: this.result,
      winner: this.winner,
      log: this.log.slice(-30),
      me: viewer ? {
        id: viewer.id,
        cards: viewer.cards.slice(),
        hand: viewer.cards.length && this.board.length >= 3 ? bestHand([...viewer.cards, ...this.board]).label : null,
        options: this.options(viewer),
        canRebuy: this.settings.rebuy && viewer.stack === 0 && viewer.status !== 'left' && viewer.status !== 'out'
          && this.phase !== 'gameover' && !(viewer.inHand && this.phase !== 'between'),
        mustDecide: viewer.pendingRebuy,
        showdownChoice: this.phase === 'showdown' && this.showdown && this.showdown.decider === viewer.id,
      } : null,
    };
  }
}

/** „Anna“, „Anna und Ben“, „Anna, Ben und Cem“ */
function nameList(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`;
}

const SUIT_SYMBOLS = { s: '♠', h: '♥', d: '♦', c: '♣' };
/** 'Td' → '10♦' (Ticker) */
function cardText(card) {
  const rank = { T: '10', J: 'B', Q: 'D' }[card[0]] || card[0];
  return `${rank}${SUIT_SYMBOLS[card[1]]}`;
}

module.exports = {
  PokerGame,
  RuleError,
  FORMAT_VERSION,
  MIN_PLAYERS,
  MAX_PLAYERS,
  DEFAULT_SETTINGS,
  TURN_TIMES,
  STREET_NAMES,
  applySettings,
  cardText,
  nameList,
  isCard,
};
