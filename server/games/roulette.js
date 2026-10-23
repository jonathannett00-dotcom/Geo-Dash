'use strict';

/* =========================================================
 *  Roulette – europäisch mit einer Null (0–36).
 *  Der Server dreht das Rad; Tablet und Handy zeigen nur an.
 * ========================================================= */

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const WHEEL_ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const CHIPS = [5, 10, 25, 100];
const MIN_BET = 10;
const BET_WINDOW_MS = 30000;
const SPIN_MS = 10000;
const RESULTS_MS = 12000;

/** Auszahlungsquoten (x:1). */
const PAYOUT = { straight: 35, red: 1, black: 1, even: 1, odd: 1, low: 1, high: 1, dozen: 2, column: 2 };

class GameError extends Error {
  constructor(message) { super(message); this.name = 'RuleError'; }
}
const fail = (msg) => { throw new GameError(msg); };
const money = (n) => `${Number(n).toLocaleString('de-DE')} M`;

const colorOf = (n) => (n === 0 ? 'green' : (RED.has(n) ? 'red' : 'black'));

function betLabel(kind, value) {
  switch (kind) {
    case 'straight': return `Plein ${value}`;
    case 'red': return 'Rot';
    case 'black': return 'Schwarz';
    case 'even': return 'Gerade';
    case 'odd': return 'Ungerade';
    case 'low': return '1–18';
    case 'high': return '19–36';
    case 'dozen': return `${value}. Dutzend`;
    case 'column': return `${value}. Kolonne`;
    default: return kind;
  }
}

/** Prüft ein Wettfeld und gibt den normierten Wert zurück. */
function validateSpot(kind, value) {
  if (!(kind in PAYOUT)) fail('Unbekanntes Wettfeld.');
  if (kind === 'straight') {
    const v = Number(value);
    if (!Number.isInteger(v) || v < 0 || v > 36) fail('Bitte eine Zahl von 0 bis 36 wählen.');
    return v;
  }
  if (kind === 'dozen' || kind === 'column') {
    const v = Number(value);
    if (![1, 2, 3].includes(v)) fail('Unbekanntes Wettfeld.');
    return v;
  }
  return null;
}

function isWinning(kind, value, n) {
  if (kind === 'straight') return n === value;
  if (n === 0) return false;
  switch (kind) {
    case 'red': return RED.has(n);
    case 'black': return !RED.has(n);
    case 'even': return n % 2 === 0;
    case 'odd': return n % 2 === 1;
    case 'low': return n <= 18;
    case 'high': return n >= 19;
    case 'dozen': return Math.ceil(n / 12) === value;
    case 'column': return ((n - 1) % 3) + 1 === value;
    default: return false;
  }
}

/** Auszahlung inklusive Einsatz (0 bei Verlust). */
function payoutFor(bet, n) {
  return isWinning(bet.kind, bet.value, n) ? bet.amount * (PAYOUT[bet.kind] + 1) : 0;
}

class Roulette {
  constructor({ id, players, wallet, rng, timeScale = 1, now = Date.now, log = () => {}, onChange = () => {}, onDone = () => {} }) {
    this.type = 'roulette';
    this.id = id;
    this.players = players;
    this.wallet = wallet;
    this.rng = rng;
    this.timeScale = timeScale;
    this.now = now;
    this.log = log;
    this.onChange = onChange;
    this.onDone = onDone;
    this.phase = 'betting';
    this.bets = [];
    this.ready = new Set();
    this.result = null;
    this.results = null;
    this.timers = [];
  }

  start() {
    this.endsAt = this.now() + BET_WINDOW_MS;
    this.later(BET_WINDOW_MS, () => this.closeBetting());
    this.log('🎡 Roulette! 30 Sekunden Zeit für Einsätze.');
    this.onChange();
  }

  later(ms, fn) { this.timers.push(setTimeout(fn, ms)); }

  stop() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  assertBetting(pid) {
    if (this.phase !== 'betting') fail('Nichts geht mehr – die Wettzeit ist vorbei.');
    if (!this.players.some((p) => p.id === pid)) fail('Du spielst bei dieser Runde nicht mit.');
    if (this.ready.has(pid)) fail('Du hast schon „Fertig“ gedrückt.');
  }

  totalOf(pid) { return this.bets.filter((b) => b.playerId === pid).reduce((s, b) => s + b.amount, 0); }

  /** Setzt einen Chip auf ein Feld (gleiche Felder werden zusammengefasst). */
  placeChip(pid, { kind, value, amount }) {
    this.assertBetting(pid);
    const v = validateSpot(kind, value);
    const chip = Number(amount);
    if (!CHIPS.includes(chip)) fail('Bitte einen Chip zu 5, 10, 25 oder 100 M wählen.');
    this.wallet.debit(pid, chip);
    const same = this.bets.find((b) => b.playerId === pid && b.kind === kind && b.value === v);
    if (same) same.amount += chip;
    else this.bets.push({ playerId: pid, kind, value: v, amount: chip });
  }

  clearBets(pid) {
    this.assertBetting(pid);
    const total = this.totalOf(pid);
    if (total) this.wallet.credit(pid, total);
    this.bets = this.bets.filter((b) => b.playerId !== pid);
  }

  setReady(pid) {
    this.assertBetting(pid);
    const total = this.totalOf(pid);
    if (total > 0 && total < MIN_BET) fail(`Der Mindesteinsatz ist ${money(MIN_BET)} – oder nimm deine Chips zurück, um auszusetzen.`);
    this.ready.add(pid);
    if (this.players.every((p) => this.ready.has(p.id))) this.closeBetting();
  }

  handle(pid, action) {
    switch (action.type) {
      case 'chip': this.placeChip(pid, action); break;
      case 'clear': this.clearBets(pid); break;
      case 'ready': this.setReady(pid); break;
      default: fail('Unbekannte Aktion.');
    }
  }

  closeBetting() {
    if (this.phase !== 'betting') return;
    this.stop();
    // Einsätze unter dem Minimum werden zurückgegeben
    for (const p of this.players) {
      const total = this.totalOf(p.id);
      if (total > 0 && total < MIN_BET) {
        this.wallet.credit(p.id, total);
        this.bets = this.bets.filter((b) => b.playerId !== p.id);
        this.log(`🎡 ${p.name}: ${money(total)} liegen unter dem Mindesteinsatz und gehen zurück.`);
      }
    }
    this.result = this.rng.int(37);
    this.phase = 'spinning';
    this.spinMs = SPIN_MS * this.timeScale;
    this.spinEndsAt = this.now() + this.spinMs;
    this.log('🎡 Nichts geht mehr – das Rad dreht sich!');
    this.later(this.spinMs + 200, () => this.settle());
    this.onChange();
  }

  settle() {
    if (this.phase !== 'spinning') return;
    const n = this.result;
    this.results = this.bets.map((b) => ({ ...b, label: betLabel(b.kind, b.value), payout: payoutFor(b, n) }));
    this.results.forEach((r) => { if (r.payout) this.wallet.credit(r.playerId, r.payout); });
    const colorName = { red: 'Rot', black: 'Schwarz', green: 'Grün' }[colorOf(n)];
    this.log(`🎡 Die Kugel fällt auf ${n} (${colorName}).`);
    const net = new Map();
    this.results.forEach((r) => net.set(r.playerId, (net.get(r.playerId) || 0) + r.payout - r.amount));
    net.forEach((v, pid) => {
      const p = this.players.find((x) => x.id === pid);
      this.log(`🎡 ${p.name} ${v >= 0 ? 'gewinnt' : 'verliert'} ${money(Math.abs(v))} beim Roulette.`);
    });
    this.phase = 'results';
    this.later(RESULTS_MS * this.timeScale, () => { this.phase = 'done'; this.onDone(); });
    this.onChange();
  }

  view() {
    return {
      id: this.id,
      type: this.type,
      phase: this.phase,
      endsAt: this.endsAt,
      players: this.players,
      bets: this.bets,
      ready: [...this.ready],
      minBet: MIN_BET,
      chips: CHIPS,
      wheel: WHEEL_ORDER,
      red: [...RED],
      result: this.phase === 'betting' ? null : this.result,
      spinMs: this.spinMs,
      spinEndsAt: this.spinEndsAt,
      results: this.results,
    };
  }
}

module.exports = { Roulette, payoutFor, isWinning, betLabel, validateSpot, colorOf, PAYOUT, WHEEL_ORDER, CHIPS, MIN_BET };
