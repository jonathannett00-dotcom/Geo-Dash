'use strict';

/* =========================================================
 *  Pferderennen – Simulation und Quoten aus dem Original-Spiel
 *  (game.js), jetzt auf dem Server mit dessen Zufallsgenerator.
 * ========================================================= */

const HORSES_PER_RACE = 6;
const TRACK_LENGTH = 1000;
const TICKS_PER_SECOND = 60;
const HOUSE_MARGIN = 0.9;       // 10 % Buchmacher-Marge
const ODDS_SIMULATIONS = 1500;  // Monte-Carlo-Läufe zur Quotenberechnung
const FRAME_STEP = 2;           // jeder 2. Tick wird an das Tablet geschickt

const MIN_BET = 10;
const BET_WINDOW_MS = 30000;
const COUNTDOWN_MS = 3000;
const RESULTS_MS = 9000;

const SILK_COLORS = ['#e63946', '#1d72d8', '#f1c40f', '#2ecc71', '#9b59b6', '#ff7f11', '#00b8d4', '#ec407a'];
const COAT_COLORS = ['#6b3e1f', '#3b2416', '#8a5a2b', '#1f1a17', '#a0703f', '#c9b8a3', '#5b4636'];
const NAME_PARTS_A = ['Blitz', 'Donner', 'Silber', 'Gold', 'Sturm', 'Schatten', 'Feuer', 'Wüsten', 'Nacht', 'Morgen', 'Eis', 'Sonnen', 'Wind', 'Stern', 'Glücks', 'Turbo'];
const NAME_PARTS_B = ['pfeil', 'hufe', 'mähne', 'läufer', 'falke', 'prinz', 'königin', 'rakete', 'traum', 'wolke', 'kobold', 'baron', 'blitz', 'tänzer', 'komet', 'jäger'];

class GameError extends Error {
  constructor(message) { super(message); this.name = 'RuleError'; }
}
const fail = (msg) => { throw new GameError(msg); };
const money = (n) => `${Number(n).toLocaleString('de-DE')} M`;

/**
 * Simuliert ein komplettes Rennen. Gibt die Zielreihenfolge zurück und
 * (optional) jede Position pro Tick zum Abspielen der Animation.
 */
function simulateRace(horses, rng, recordFrames = false) {
  const n = horses.length;
  const pos = new Array(n).fill(0);
  const vel = horses.map((h) => h.speed * 0.6);
  const target = horses.map((h) => h.speed);
  const finishTime = new Array(n).fill(Infinity);
  const frames = recordFrames ? [] : null;
  let tick = 0;
  let finished = 0;

  while (finished < n && tick < 5000) {
    for (let i = 0; i < n; i++) {
      if (finishTime[i] !== Infinity) {
        // Pferd trabt nach dem Ziel aus
        pos[i] += vel[i] * 0.4;
        continue;
      }
      const h = horses[i];
      if (rng.next() < 0.02) {
        target[i] = h.speed * rng.range(0.8, 1.2);
      }
      // Endspurt: Ausdauer entscheidet im letzten Viertel
      let t = target[i];
      if (pos[i] > TRACK_LENGTH * 0.72) t *= 1 + (h.stamina - 0.5) * 0.14;
      vel[i] += (t - vel[i]) * 0.05;
      const prev = pos[i];
      pos[i] += vel[i];
      if (pos[i] >= TRACK_LENGTH) {
        finishTime[i] = tick + (TRACK_LENGTH - prev) / (pos[i] - prev);
        finished++;
      }
    }
    if (frames) frames.push(pos.slice());
    tick++;
  }

  const order = [...Array(n).keys()].sort((a, b) => finishTime[a] - finishTime[b]);
  return { order, frames, finishTime };
}

function computeOdds(horses, rng) {
  const wins = new Array(horses.length).fill(0);
  const places = new Array(horses.length).fill(0);
  for (let s = 0; s < ODDS_SIMULATIONS; s++) {
    const { order } = simulateRace(horses, rng);
    wins[order[0]]++;
    for (let k = 0; k < 3; k++) places[order[k]]++;
  }
  horses.forEach((h, i) => {
    const pWin = Math.max(wins[i], 1) / ODDS_SIMULATIONS;
    const pPlace = Math.max(places[i], 1) / ODDS_SIMULATIONS;
    h.winOdds = Math.max(1.1, Math.round((HOUSE_MARGIN / pWin) * 10) / 10);
    h.placeOdds = Math.max(1.05, Math.round((HOUSE_MARGIN / pPlace) * 20) / 20);
  });
}

function generateHorses(rng) {
  const names = new Set();
  const silks = rng.shuffle(SILK_COLORS);
  const horses = [];
  for (let i = 0; i < HORSES_PER_RACE; i++) {
    let name;
    do { name = rng.pick(NAME_PARTS_A) + rng.pick(NAME_PARTS_B); } while (names.has(name));
    names.add(name);
    const base = 1000 / (TICKS_PER_SECOND * 18);   // ~18 Sekunden Renndauer
    horses.push({
      name: name.charAt(0).toUpperCase() + name.slice(1),
      speed: base * rng.range(0.985, 1.015),
      stamina: rng.next(),
      silk: silks[i],
      coat: rng.pick(COAT_COLORS),
    });
  }
  computeOdds(horses, rng);
  // Formwert 1–5 für die Anzeige (abgeleitet aus der Siegchance)
  const maxP = Math.max(...horses.map((h) => 1 / h.winOdds));
  horses.forEach((h) => { h.form = Math.max(1, Math.round(((1 / h.winOdds) / maxP) * 5)); });
  return horses;
}

/** Auszahlung einer Wette (inklusive Einsatz) bei gegebener Zielreihenfolge. */
function settleBet(bet, horses, order) {
  const h = horses[bet.horse];
  const won = bet.type === 'win' ? order[0] === bet.horse : order.slice(0, 3).includes(bet.horse);
  const odds = bet.type === 'win' ? h.winOdds : h.placeOdds;
  return { ...bet, won, odds, payout: won ? Math.round(bet.amount * odds) : 0 };
}

class HorseRace {
  constructor({ id, players, wallet, rng, timeScale = 1, now = Date.now, log = () => {}, onChange = () => {}, onDone = () => {} }) {
    this.type = 'horserace';
    this.id = id;
    this.players = players;
    this.wallet = wallet;
    this.rng = rng;
    this.timeScale = timeScale;
    this.now = now;
    this.log = log;
    this.onChange = onChange;
    this.onDone = onDone;
    this.horses = generateHorses(rng);
    this.phase = 'betting';
    this.bets = [];
    this.ready = new Set();
    this.results = null;
    this.timers = [];
  }

  start() {
    this.endsAt = this.now() + BET_WINDOW_MS;
    this.later(BET_WINDOW_MS, () => this.closeBetting());
    this.log('🏇 Pferderennen! 30 Sekunden Zeit für Wetten.');
    this.onChange();
  }

  later(ms, fn) { this.timers.push(setTimeout(fn, ms)); }

  stop() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  assertBetting(pid) {
    if (this.phase !== 'betting') fail('Die Wettzeit ist vorbei.');
    if (!this.players.some((p) => p.id === pid)) fail('Du spielst bei diesem Rennen nicht mit.');
    if (this.ready.has(pid)) fail('Du hast schon „Fertig“ gedrückt.');
  }

  placeBet(pid, { horse, kind, amount }) {
    this.assertBetting(pid);
    const h = Number(horse);
    const value = Number(amount);
    if (!Number.isInteger(h) || h < 0 || h >= this.horses.length) fail('Bitte wähle ein Pferd.');
    if (kind !== 'win' && kind !== 'place') fail('Bitte wähle Sieg oder Platz.');
    if (!Number.isInteger(value) || value < MIN_BET) fail(`Der Mindesteinsatz ist ${money(MIN_BET)}.`);
    this.wallet.debit(pid, value);
    this.bets.push({ playerId: pid, horse: h, type: kind, amount: value });
  }

  clearBets(pid) {
    this.assertBetting(pid);
    const mine = this.bets.filter((b) => b.playerId === pid);
    mine.forEach((b) => this.wallet.credit(pid, b.amount));
    this.bets = this.bets.filter((b) => b.playerId !== pid);
  }

  setReady(pid) {
    this.assertBetting(pid);
    this.ready.add(pid);
    if (this.players.every((p) => this.ready.has(p.id))) this.closeBetting();
  }

  /** Aktion vom Handy. */
  handle(pid, action) {
    switch (action.type) {
      case 'bet': this.placeBet(pid, action); break;
      case 'clear': this.clearBets(pid); break;
      case 'ready': this.setReady(pid); break;
      default: fail('Unbekannte Aktion.');
    }
  }

  closeBetting() {
    if (this.phase !== 'betting') return;
    this.stop();
    const sim = simulateRace(this.horses, this.rng, true);
    this.order = sim.order;
    this.finishTime = sim.finishTime;
    this.frames = sim.frames
      .filter((_, i) => i % FRAME_STEP === 0)
      .map((f) => f.map((v) => Math.round(v * 10) / 10));
    this.totalTicks = this.frames.length * FRAME_STEP;
    this.phase = 'running';
    this.startAt = this.now() + COUNTDOWN_MS * this.timeScale;
    const raceMs = (this.totalTicks / TICKS_PER_SECOND) * 1000 * this.timeScale;
    this.finishAt = this.startAt + raceMs;
    const stake = this.bets.reduce((s, b) => s + b.amount, 0);
    this.log(`🏇 Die Wetten sind geschlossen (${this.bets.length} Wetten, ${money(stake)} Einsatz) – das Rennen läuft!`);
    this.later(this.finishAt - this.now() + 300, () => this.settle());
    this.onChange();
  }

  settle() {
    if (this.phase !== 'running') return;
    this.results = this.bets.map((b) => settleBet(b, this.horses, this.order));
    this.results.forEach((r) => { if (r.payout) this.wallet.credit(r.playerId, r.payout); });
    const [a, b, c] = this.order.map((i) => `#${i + 1} ${this.horses[i].name}`);
    this.log(`🏆 Zieleinlauf: 1. ${a}, 2. ${b}, 3. ${c}.`);
    const byPlayer = new Map();
    this.results.forEach((r) => byPlayer.set(r.playerId, (byPlayer.get(r.playerId) || 0) + r.payout - r.amount));
    byPlayer.forEach((net, pid) => {
      const p = this.players.find((x) => x.id === pid);
      this.log(`🏇 ${p.name} ${net >= 0 ? 'gewinnt' : 'verliert'} ${money(Math.abs(net))} beim Rennen.`);
    });
    this.phase = 'results';
    this.doneAt = this.now() + RESULTS_MS * this.timeScale;
    this.later(RESULTS_MS * this.timeScale, () => { this.phase = 'done'; this.onDone(); });
    this.onChange();
  }

  view(role) {
    const v = {
      id: this.id,
      type: this.type,
      phase: this.phase,
      endsAt: this.endsAt,
      horses: this.horses.map(({ name, silk, coat, winOdds, placeOdds, form }) => ({ name, silk, coat, winOdds, placeOdds, form })),
      bets: this.bets,
      ready: [...this.ready],
      players: this.players,
      minBet: MIN_BET,
      startAt: this.startAt,
      finishAt: this.finishAt,
      doneAt: this.doneAt,
      order: this.phase === 'results' ? this.order : null,
      results: this.results,
    };
    if (role === 'board' && this.phase !== 'betting') {
      v.frames = this.frames;
      v.frameStep = FRAME_STEP;
      v.ticksPerSecond = TICKS_PER_SECOND;
      v.trackLength = TRACK_LENGTH;
      v.finishTime = this.finishTime;
      v.finishOrder = this.order;
      v.timeScale = this.timeScale;
    }
    return v;
  }
}

module.exports = { HorseRace, simulateRace, computeOdds, generateHorses, settleBet, MIN_BET, BET_WINDOW_MS, TRACK_LENGTH };
