'use strict';

/* =========================================================
 *  Risiko nach den klassischen Standardregeln – reine Spiellogik.
 *  Der Server ist die einzige Instanz: Würfel und Karten kommen aus
 *  server/rng.js, jede Aktion prüft Zug, Phase und Armeen und wirft
 *  sonst RuleError mit einer deutschen Meldung.
 *
 *  Ablauf eines Zuges: Verstärken (Karten tauschen, Armeen setzen) →
 *  Angreifen (beliebig oft; der Verteidiger wählt seine Würfel, nach einer
 *  Eroberung wird nachgerückt) → einmal Verschieben.
 * ========================================================= */

const { TERRITORY_IDS, TERRITORY, CONTINENTS, CONTINENT_TERRITORIES, NEIGHBORS, isNeighbor } = require('./map');
const { createRng } = require('../../rng');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
/** Startarmeen je Spielerzahl (bei 2 Spielern kommt eine neutrale Armee dazu). */
const START_ARMIES = { 2: 40, 3: 35, 4: 30, 5: 25, 6: 20 };
const NEUTRAL = 'neutral';
const NEUTRAL_COLOR = '#9e9e9e';
const MIN_REINFORCEMENTS = 3;
const MAX_ATTACK_DICE = 3;
const MAX_DEFEND_DICE = 2;
const TRADE_TERRITORY_BONUS = 2;
const MUST_TRADE_AT = 5;          // ab 5 Karten muss zu Zugbeginn getauscht werden
const MUST_TRADE_AFTER_KILL = 6;  // ab 6 Karten nach dem Ausschalten eines Gegners sofort
const LOG_LIMIT = 80;

const SYMBOLS = ['infanterie', 'kavallerie', 'artillerie'];
const SYMBOL_NAMES = { infanterie: 'Infanterie', kavallerie: 'Kavallerie', artillerie: 'Artillerie', joker: 'Joker' };

/** Steigende Tauschwerte: 4, 6, 8, 10, 12, 15, danach je +5. */
const RISING_VALUES = [4, 6, 8, 10, 12, 15];
/** Feste Tauschwerte (ältere deutsche Ausgabe). */
const FIXED_VALUES = { infanterie: 4, kavallerie: 6, artillerie: 8, gemischt: 10 };

const DEFAULT_SETTINGS = { cardValues: 'steigend', fortify: 'benachbart' };
const SETTING_OPTIONS = { cardValues: ['steigend', 'fest'], fortify: ['benachbart', 'verbunden'] };

/** 42 Gebietskarten (je 14 pro Symbol) und 2 Joker. */
const CARDS = [
  ...TERRITORY_IDS.map((id, i) => ({ id, territory: id, symbol: SYMBOLS[i % 3] })),
  { id: 'joker-1', territory: null, symbol: 'joker' },
  { id: 'joker-2', territory: null, symbol: 'joker' },
];
const CARD = Object.fromEntries(CARDS.map((c) => [c.id, c]));

class RuleError extends Error {
  constructor(message) { super(message); this.name = 'RuleError'; }
}
const fail = (message) => { throw new RuleError(message); };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const armies = (n) => plural(n, 'Armee', 'Armeen');
const tname = (id) => TERRITORY[id].name;

/** Wert des k-ten Tauschs (k ab 0) bei steigenden Werten. */
function risingTradeValue(k) {
  return k < RISING_VALUES.length ? RISING_VALUES[k] : RISING_VALUES[RISING_VALUES.length - 1] + 5 * (k - RISING_VALUES.length + 1);
}

/** Gültiges Set: drei gleiche, drei verschiedene; Joker ersetzen jedes Symbol. */
function isValidSet(cardIds) {
  const symbols = cardIds.map((id) => CARD[id].symbol).filter((s) => s !== 'joker');
  const distinct = new Set(symbols).size;
  return distinct === 1 || distinct === symbols.length;
}

/** Fester Tauschwert eines gültigen Sets (Joker werden zum besten Wert gezählt). */
function fixedTradeValue(cardIds) {
  const symbols = cardIds.map((id) => CARD[id].symbol).filter((s) => s !== 'joker');
  if (new Set(symbols).size === symbols.length) return FIXED_VALUES.gemischt;
  return FIXED_VALUES[symbols[0]];
}

class RisikoGame {
  constructor({ players, settings = {}, rng = createRng(), now = Date.now, forcedDice = [] }) {
    if (!players || players.length < MIN_PLAYERS) fail(`Es werden mindestens ${MIN_PLAYERS} Spieler gebraucht.`);
    if (players.length > MAX_PLAYERS) fail(`Risiko ist für höchstens ${MAX_PLAYERS} Spieler.`);
    this.rng = rng;
    this.now = now;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.players = players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      figure: p.figure,
      cards: [],
      remaining: 0,
      eliminated: false,
      quit: false,
    }));
    // OFFENE ENTSCHEIDUNG (siehe docs/spielcenter-plan.md): Bei 2 Spielern spielt eine
    // neutrale Armee mit (Regel der klassischen Ausgabe). Eine Vorgabe dazu fehlt noch.
    this.neutral = players.length === 2 ? { id: NEUTRAL, name: 'Neutral', color: NEUTRAL_COLOR } : null;
    this.territories = Object.fromEntries(TERRITORY_IDS.map((id) => [id, { owner: null, armies: 0 }]));
    this.deck = rng.shuffle(CARDS.map((c) => c.id));
    this.discard = [];
    this.tradeCount = 0;
    this.seq = 0;
    this.log = [];
    this.forcedDice = forcedDice.slice();
    this.lastBattle = null;
    this.lastTrade = null;
    this.winner = null;
    this.turn = null;
    this.round = 0;
    this.currentIndex = rng.int(this.players.length);
    this.phase = 'setup';
    this.deal();
  }

  /* ---------------- Hilfen ---------------- */

  nextSeq() { this.seq += 1; return this.seq; }

  event(text, kind = 'info') {
    this.log.push({ seq: this.nextSeq(), text, kind, time: this.now() });
    if (this.log.length > LOG_LIMIT) this.log.shift();
  }

  player(id) {
    const p = this.players.find((x) => x.id === id);
    if (!p) fail('Unbekannter Spieler.');
    return p;
  }

  nameOf(id) { return id === NEUTRAL ? 'Neutral' : this.player(id).name; }

  currentPlayer() { return this.players[this.currentIndex]; }

  activePlayers() { return this.players.filter((p) => !p.eliminated); }

  territory(id) {
    const t = this.territories[id];
    if (!t) fail('Unbekanntes Gebiet.');
    return t;
  }

  territoriesOf(pid) { return TERRITORY_IDS.filter((id) => this.territories[id].owner === pid); }

  armiesOf(pid) { return this.territoriesOf(pid).reduce((sum, id) => sum + this.territories[id].armies, 0); }

  continentsOf(pid) { return CONTINENTS.filter((c) => CONTINENT_TERRITORIES[c.id].every((id) => this.territories[id].owner === pid)); }

  /** Verstärkung zu Zugbeginn: Gebiete / 3 (mindestens 3) plus Kontinentboni. */
  reinforcementsFor(pid) {
    const base = Math.max(MIN_REINFORCEMENTS, Math.floor(this.territoriesOf(pid).length / 3));
    return base + this.continentsOf(pid).reduce((sum, c) => sum + c.bonus, 0);
  }

  /** Wert des nächsten Kartentauschs (bei festen Werten abhängig vom Set, daher null). */
  nextTradeValue() { return this.settings.cardValues === 'fest' ? null : risingTradeValue(this.tradeCount); }

  assertActive(p) { if (p.eliminated) fail('Du bist ausgeschieden und spielst nicht mehr mit.'); }

  assertTurn(pid, ...phases) {
    const p = this.player(pid);
    this.assertActive(p);
    if (this.phase === 'gameover') fail('Das Spiel ist vorbei.');
    if (this.phase === 'setup') fail('Erst müssen alle ihre Startarmeen setzen.');
    if (this.currentPlayer().id !== pid) fail(`Du bist nicht am Zug – gerade ist ${this.currentPlayer().name} dran.`);
    if (phases.length && !phases.includes(this.phase)) fail(PHASE_HINTS[this.phase] || 'Das geht gerade nicht.');
    return p;
  }

  assertOwn(pid, id, what = 'Dieses Gebiet') {
    const t = this.territory(id);
    if (t.owner !== pid) fail(`${what} gehört dir nicht.`);
    return t;
  }

  /** Ganzzahl im erlaubten Bereich, sonst verständliche Meldung. */
  count(value, min, max, label) {
    const n = Number(value);
    if (!Number.isInteger(n)) fail(`Bitte eine ganze Zahl an ${label} angeben.`);
    if (n < min) fail(`Mindestens ${armies(min)}.`);
    if (n > max) fail(max < min ? `Keine ${label} verfügbar.` : `Höchstens ${armies(max)}.`);
    return n;
  }

  rollDie() {
    if (this.forcedDice.length) return this.forcedDice.shift();
    return this.rng.int(6) + 1;
  }

  rollDice(n) { return Array.from({ length: n }, () => this.rollDie()).sort((a, b) => b - a); }

  /* ---------------- Aufbau ---------------- */

  /** Gebiete zufällig verteilen (je 1 Armee), Rest der Startarmeen merken. */
  deal() {
    const n = this.players.length;
    const owners = [];
    for (let i = 0; i < n; i++) owners.push(this.players[(this.currentIndex + i) % n].id);
    if (this.neutral) owners.push(NEUTRAL);
    this.rng.shuffle(TERRITORY_IDS).forEach((id, i) => {
      this.territories[id] = { owner: owners[i % owners.length], armies: 1 };
    });
    const start = START_ARMIES[n];
    for (const p of this.players) p.remaining = start - this.territoriesOf(p.id).length;
    if (this.neutral) {
      // Die neutrale Armee verteilt der Server zufällig
      const own = this.territoriesOf(NEUTRAL);
      for (let left = start - own.length; left > 0; left--) this.territories[this.rng.pick(own)].armies += 1;
    }
    this.event(`Die Gebiete sind verteilt. Alle setzen ihre restlichen Startarmeen (${armies(start)} insgesamt).`, 'setup');
  }

  setupPlace(p, id, value) {
    if (p.remaining <= 0) fail('Du hast schon alle Startarmeen gesetzt.');
    const t = this.assertOwn(p.id, id);
    const n = this.count(value ?? 1, 1, p.remaining, 'Armeen');
    t.armies += n;
    p.remaining -= n;
    if (p.remaining === 0) this.event(`${p.name} hat alle Startarmeen gesetzt.`, 'setup');
    this.checkSetupDone();
  }

  checkSetupDone() {
    if (this.phase !== 'setup' || this.activePlayers().some((p) => p.remaining > 0)) return;
    this.event('Alle Armeen stehen – der Kampf beginnt!', 'setup');
    if (!this.currentPlayer().eliminated) this.startTurn();
    else this.nextPlayer();
  }

  /* ---------------- Zugablauf ---------------- */

  startTurn() {
    const p = this.currentPlayer();
    if (this.currentIndex === this.firstActiveIndex()) this.round += 1;
    const reinforcements = this.reinforcementsFor(p.id);
    this.turn = { playerId: p.id, reinforcements, conquered: false, fortified: false, occupy: null, returnTo: null, pendingAttack: null };
    this.phase = 'reinforce';
    const bonus = this.continentsOf(p.id).map((c) => `${c.name} +${c.bonus}`);
    this.event(`${p.name} ist am Zug und erhält ${armies(reinforcements)}${bonus.length ? ` (${bonus.join(', ')})` : ''}.`, 'turn');
    if (p.cards.length >= MUST_TRADE_AT) this.event(`${p.name} hat ${p.cards.length} Karten und muss tauschen.`, 'cards');
  }

  firstActiveIndex() { return this.players.findIndex((p) => !p.eliminated); }

  nextPlayer() {
    if (this.checkGameOver()) return;
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const idx = (this.currentIndex + i) % n;
      if (!this.players[idx].eliminated) {
        this.currentIndex = idx;
        this.startTurn();
        return;
      }
    }
  }

  checkGameOver() {
    if (this.phase === 'gameover') return true;
    const alive = this.activePlayers();
    if (alive.length > 1) return false;
    this.phase = 'gameover';
    this.turn = null;
    this.winner = alive[0] ? alive[0].id : null;
    this.event(alive[0] ? `🏆 ${alive[0].name} erobert die Welt und gewinnt!` : 'Das Spiel ist vorbei.', 'gameover');
    return true;
  }

  /* ---------------- Verstärken ---------------- */

  place(pid, territory, count) {
    const p = this.player(pid);
    this.assertActive(p);
    if (this.phase === 'setup') return this.setupPlace(p, territory, count);
    this.assertTurn(pid, 'reinforce');
    if (p.cards.length >= MUST_TRADE_AT) fail(`Du hast ${p.cards.length} Karten und musst zuerst tauschen.`);
    if (this.turn.reinforcements <= 0) fail('Du hast keine Armeen mehr zu setzen.');
    const t = this.assertOwn(pid, territory);
    const n = this.count(count ?? this.turn.reinforcements, 1, this.turn.reinforcements, 'Armeen');
    t.armies += n;
    this.turn.reinforcements -= n;
    this.event(`${p.name} setzt ${armies(n)} nach ${tname(territory)}.`, 'place');
    if (this.turn.reinforcements === 0) {
      this.phase = this.turn.returnTo || 'attack';
      this.turn.returnTo = null;
    }
  }

  /** Drei Karten gegen Armeen tauschen. */
  trade(pid, cardIds) {
    const p = this.assertTurn(pid, 'reinforce');
    if (!Array.isArray(cardIds) || cardIds.length !== 3) fail('Bitte genau drei Karten zum Tauschen wählen.');
    const ids = cardIds.map(String);
    if (new Set(ids).size !== 3) fail('Jede Karte kann nur einmal getauscht werden.');
    if (!ids.every((id) => p.cards.includes(id))) fail('Diese Karten hast du nicht.');
    if (!isValidSet(ids)) fail('Kein gültiges Set: Tausche drei gleiche oder drei verschiedene Symbole (Joker zählen für jedes).');

    const value = this.settings.cardValues === 'fest' ? fixedTradeValue(ids) : risingTradeValue(this.tradeCount);
    p.cards = p.cards.filter((id) => !ids.includes(id));
    this.discard.push(...ids);
    this.tradeCount += 1;
    this.turn.reinforcements += value;
    // +2 auf ein eigenes Gebiet, das auf einer der Karten abgebildet ist (einmal pro Tausch)
    const bonusCard = ids.map((id) => CARD[id]).find((c) => c.territory && this.territories[c.territory].owner === pid);
    if (bonusCard) this.territories[bonusCard.territory].armies += TRADE_TERRITORY_BONUS;
    this.lastTrade = { seq: this.nextSeq(), playerId: pid, cards: ids, value, bonusTerritory: bonusCard ? bonusCard.territory : null };
    const symbols = ids.map((id) => SYMBOL_NAMES[CARD[id].symbol]).join(', ');
    this.event(`🃏 ${p.name} tauscht Karten (${symbols}) gegen ${armies(value)}${bonusCard ? ` und erhält +${TRADE_TERRITORY_BONUS} in ${tname(bonusCard.territory)}` : ''}.`, 'cards');
  }

  /* ---------------- Angreifen ---------------- */

  /**
   * Angriff ansagen. Der Verteidiger wählt danach auf seinem Handy, mit wie vielen
   * Würfeln er verteidigt (defend); erst dann würfelt der Server beide Seiten.
   */
  attack(pid, from, to, dice) {
    const p = this.assertTurn(pid, 'attack');
    const src = this.assertOwn(pid, from, 'Das angreifende Gebiet');
    const dst = this.territory(to);
    if (dst.owner === pid) fail('Du kannst dein eigenes Gebiet nicht angreifen.');
    if (!isNeighbor(from, to)) fail(`${tname(from)} grenzt nicht an ${tname(to)}.`);
    if (src.armies < 2) fail('Zum Angreifen brauchst du mindestens 2 Armeen im Gebiet – eine bleibt immer zurück.');
    const maxDice = Math.min(MAX_ATTACK_DICE, src.armies - 1);
    const nAtt = dice === undefined || dice === null ? maxDice : Number(dice);
    if (!Number.isInteger(nAtt) || nAtt < 1) fail('Bitte mit 1 bis 3 Würfeln angreifen.');
    if (nAtt > maxDice) fail(`Mit ${armies(src.armies)} kannst du höchstens mit ${plural(maxDice, 'Würfel', 'Würfeln')} angreifen.`);

    const defenderId = dst.owner;
    this.turn.pendingAttack = { from, to, dice: nAtt, defenderId, maxDefend: Math.min(MAX_DEFEND_DICE, dst.armies) };
    this.phase = 'defend';
    this.event(`⚔️ ${p.name} greift mit ${plural(nAtt, 'Würfel', 'Würfeln')} von ${tname(from)} ${tname(to)} an – ${this.nameOf(defenderId)} verteidigt.`, 'battle');
    // OFFENE ENTSCHEIDUNG (siehe docs/spielcenter-plan.md): Die neutrale Armee hat kein Handy
    // und verteidigt deshalb immer mit der höchstmöglichen Würfelzahl.
    if (defenderId === NEUTRAL) this.resolveBattle(this.turn.pendingAttack.maxDefend);
  }

  /** Der Verteidiger wählt 1 bis 2 Würfel (höchstens so viele wie Armeen im Gebiet). */
  defend(pid, dice) {
    const p = this.player(pid);
    this.assertActive(p);
    if (this.phase !== 'defend' || !this.turn || !this.turn.pendingAttack) fail('Gerade wirst du nicht angegriffen.');
    const pending = this.turn.pendingAttack;
    if (pending.defenderId !== pid) fail(`Gerade verteidigt ${this.nameOf(pending.defenderId)}, nicht du.`);
    const n = dice === undefined || dice === null ? pending.maxDefend : Number(dice);
    if (!Number.isInteger(n) || n < 1 || n > pending.maxDefend) {
      fail(pending.maxDefend === 1 ? 'Mit 1 Armee verteidigst du mit genau 1 Würfel.' : 'Bitte mit 1 oder 2 Würfeln verteidigen.');
    }
    this.resolveBattle(n);
  }

  /** Beide Seiten würfeln; die höchsten Würfel werden paarweise verglichen. */
  resolveBattle(nDef) {
    const { from, to, dice: nAtt, defenderId } = this.turn.pendingAttack;
    const p = this.currentPlayer();
    const src = this.territories[from];
    const dst = this.territories[to];
    this.turn.pendingAttack = null;
    this.phase = 'attack';

    const att = this.rollDice(nAtt);
    const def = this.rollDice(nDef);
    let attackerLosses = 0;
    let defenderLosses = 0;
    for (let i = 0; i < Math.min(nAtt, nDef); i++) {
      // Gleichstand gewinnt der Verteidiger
      if (att[i] > def[i]) defenderLosses += 1;
      else attackerLosses += 1;
    }
    src.armies -= attackerLosses;
    dst.armies -= defenderLosses;
    const conquered = dst.armies === 0;
    this.lastBattle = {
      seq: this.nextSeq(), attackerId: p.id, defenderId, from, to,
      attack: att, defend: def, attackerLosses, defenderLosses, conquered,
    };
    this.event(`🎲 ${tname(from)} gegen ${tname(to)}: ${att.join('-')} gegen ${def.join('-')} – Verluste ${attackerLosses}:${defenderLosses}.`, 'battle');
    if (conquered) this.conquer(p, from, to, defenderId, nAtt);
  }

  conquer(p, from, to, defenderId, diceUsed) {
    const src = this.territories[from];
    const dst = this.territories[to];
    dst.owner = p.id;
    this.turn.conquered = true;
    this.event(`🚩 ${p.name} erobert ${tname(to)}!`, 'conquer');

    if (defenderId !== NEUTRAL && this.territoriesOf(defenderId).length === 0) {
      const loser = this.player(defenderId);
      loser.eliminated = true;
      const taken = loser.cards.length;
      p.cards.push(...loser.cards);
      loser.cards = [];
      this.event(`💀 ${loser.name} ist ausgeschaltet${taken ? ` – ${p.name} übernimmt ${plural(taken, 'Karte', 'Karten')}` : ''}.`, 'eliminated');
    }

    const max = src.armies - 1;
    const min = Math.min(diceUsed, max);
    this.turn.occupy = { from, to, min, max };
    this.phase = 'occupy';
    if (this.activePlayers().length === 1 || min === max) this.occupy(p.id, min);
  }

  /** Nach einer Eroberung Armeen ins neue Gebiet nachziehen (mindestens so viele wie Würfel). */
  occupy(pid, count) {
    const p = this.assertTurn(pid, 'occupy');
    const { from, to, min, max } = this.turn.occupy;
    const n = this.count(count ?? min, min, max, 'Armeen');
    this.territories[from].armies -= n;
    this.territories[to].armies += n;
    this.turn.occupy = null;
    this.phase = 'attack';
    if (this.checkGameOver()) return;
    if (p.cards.length >= MUST_TRADE_AFTER_KILL) {
      // Nach dem Ausschalten eines Gegners: sofort tauschen, bis höchstens 4 Karten bleiben
      this.phase = 'reinforce';
      this.turn.returnTo = 'attack';
      this.event(`${p.name} hat ${p.cards.length} Karten und muss sofort tauschen.`, 'cards');
    }
  }

  endAttack(pid) {
    this.assertTurn(pid, 'attack');
    this.phase = 'fortify';
  }

  /* ---------------- Verschieben & Zugende ---------------- */

  /** Gibt es einen Weg von a nach b nur über eigene Gebiete? */
  connected(pid, a, b) {
    const seen = new Set([a]);
    const queue = [a];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === b) return true;
      for (const n of NEIGHBORS[cur]) {
        if (!seen.has(n) && this.territories[n].owner === pid) { seen.add(n); queue.push(n); }
      }
    }
    return false;
  }

  /** Einmal pro Zug Armeen verschieben; danach endet der Zug. */
  fortify(pid, from, to, count) {
    const p = this.assertTurn(pid, 'attack', 'fortify');
    const src = this.assertOwn(pid, from, 'Das Ausgangsgebiet');
    this.assertOwn(pid, to, 'Das Zielgebiet');
    if (from === to) fail('Bitte zwei verschiedene Gebiete wählen.');
    if (this.settings.fortify === 'verbunden') {
      if (!this.connected(pid, from, to)) fail(`${tname(from)} und ${tname(to)} sind nicht über eigene Gebiete verbunden.`);
    } else if (!isNeighbor(from, to)) {
      fail(`${tname(from)} grenzt nicht an ${tname(to)} – verschoben wird nur ins Nachbargebiet.`);
    }
    if (src.armies < 2) fail('Eine Armee muss immer im Gebiet bleiben.');
    const n = this.count(count, 1, src.armies - 1, 'Armeen');
    src.armies -= n;
    this.territories[to].armies += n;
    this.turn.fortified = true;
    this.event(`${p.name} verschiebt ${armies(n)} von ${tname(from)} nach ${tname(to)}.`, 'fortify');
    this.finishTurn();
  }

  endTurn(pid) {
    this.assertTurn(pid, 'attack', 'fortify');
    this.finishTurn();
  }

  /** Wer in diesem Zug erobert hat, zieht eine Karte. */
  finishTurn() {
    const p = this.currentPlayer();
    if (this.turn && this.turn.conquered) {
      const card = this.drawCard();
      if (card) {
        p.cards.push(card);
        this.event(`${p.name} erhält eine Risikokarte.`, 'cards');
      }
    }
    this.nextPlayer();
  }

  drawCard() {
    if (!this.deck.length && this.discard.length) {
      this.deck = this.rng.shuffle(this.discard);
      this.discard = [];
    }
    return this.deck.shift() || null;
  }

  /* ---------------- Spieler verlässt das Spiel ---------------- */

  quit(pid) {
    const p = this.player(pid);
    this.assertActive(p);
    if (this.phase === 'gameover') fail('Das Spiel ist schon vorbei.');
    this.removePlayer(pid, 'quit');
  }

  /**
   * Spieler scheidet aus (aufgegeben oder zu lange getrennt): Gebiete werden neutral,
   * Karten kommen auf den Ablagestapel.
   * OFFENE ENTSCHEIDUNG (siehe docs/spielcenter-plan.md): Verbleib der Gebiete beim Ausscheiden.
   */
  removePlayer(pid, reason = 'timeout') {
    const p = this.player(pid);
    if (p.eliminated || this.phase === 'gameover') return;
    const wasCurrent = this.phase !== 'setup' && this.currentPlayer().id === pid;
    p.eliminated = true;
    p.quit = reason === 'quit';
    p.remaining = 0;
    this.discard.push(...p.cards);
    p.cards = [];
    if (!this.neutral) this.neutral = { id: NEUTRAL, name: 'Neutral', color: NEUTRAL_COLOR };
    for (const id of this.territoriesOf(pid)) this.territories[id].owner = NEUTRAL;
    this.event(reason === 'quit'
      ? `🏳️ ${p.name} gibt auf – die Gebiete werden neutral.`
      : `${p.name} war zu lange getrennt und scheidet aus – die Gebiete werden neutral.`, 'eliminated');
    if (this.checkGameOver()) return;
    if (this.phase === 'setup') this.checkSetupDone();
    else if (wasCurrent) this.nextPlayer();
    else if (this.phase === 'defend' && this.turn.pendingAttack.defenderId === pid) {
      // Das Gebiet ist jetzt neutral und verteidigt wie die neutrale Armee
      this.turn.pendingAttack.defenderId = NEUTRAL;
      this.resolveBattle(this.turn.pendingAttack.maxDefend);
    }
  }

  /* ---------------- Aktionen der Clients ---------------- */

  handleAction(pid, action = {}) {
    switch (action.type) {
      case 'place': this.place(pid, action.territory, action.count); break;
      case 'trade': this.trade(pid, action.cards); break;
      case 'attack': this.attack(pid, action.from, action.to, action.dice); break;
      case 'defend': this.defend(pid, action.dice); break;
      case 'occupy': this.occupy(pid, action.count); break;
      case 'endAttack': this.endAttack(pid); break;
      case 'fortify': this.fortify(pid, action.from, action.to, action.count); break;
      case 'endTurn': this.endTurn(pid); break;
      case 'quit': this.quit(pid); break;
      default: fail('Unbekannte Aktion.');
    }
  }

  /* ---------------- Raum-Schnittstelle ---------------- */

  /** Risiko braucht keine Timer. */
  tick() { return null; }

  isOver() { return this.phase === 'gameover'; }

  /** Im Aufbau: wer noch Startarmeen setzen muss; sonst der Spieler am Zug. */
  waitingFor() {
    if (this.phase === 'gameover') return null;
    if (this.phase === 'setup') {
      const n = this.players.length;
      for (let i = 0; i < n; i++) {
        const p = this.players[(this.currentIndex + i) % n];
        if (!p.eliminated && p.remaining > 0) return p.id;
      }
      return null;
    }
    if (this.phase === 'defend') return this.turn.pendingAttack.defenderId;
    return this.currentPlayer().id;
  }

  canSave() { return true; }

  dispose() {}

  /** Nur im Testmodus: Würfel vorgeben (Paare oder einzelne Augenzahlen). */
  debugDice(list) { this.forcedDice.push(...list.flat().map(Number)); }

  /* ---------------- Speichern & Wiederherstellen ---------------- */

  toJSON() {
    const { rng, now, ...data } = this;
    return JSON.parse(JSON.stringify(data));
  }

  static fromJSON(data, { rng = createRng(), now = Date.now } = {}) {
    const g = Object.create(this.prototype);
    Object.assign(g, JSON.parse(JSON.stringify(data)));
    g.rng = rng;
    g.now = now;
    return g;
  }

  /* ---------------- Zustand für die Clients ---------------- */

  /**
   * Öffentlicher Zustand. Handkarten sieht nur ihr Besitzer (viewerId);
   * alle anderen – auch das Tablet – sehen nur die Anzahl. Die Reihenfolge
   * des Kartenstapels verlässt den Server nie.
   */
  publicState(viewerId = null) {
    const viewer = this.players.find((p) => p.id === viewerId);
    return {
      phase: this.phase,
      currentId: this.phase === 'setup' || this.phase === 'gameover' ? null : this.currentPlayer().id,
      round: this.round,
      settings: { ...this.settings },
      neutral: this.neutral ? { ...this.neutral } : null,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        figure: p.figure,
        cards: p.cards.length,
        remaining: p.remaining,
        territories: this.territoriesOf(p.id).length,
        armies: this.armiesOf(p.id),
        continents: this.continentsOf(p.id).map((c) => c.id),
        eliminated: p.eliminated,
        quit: p.quit,
      })),
      territories: Object.fromEntries(TERRITORY_IDS.map((id) => [id, { ...this.territories[id] }])),
      turn: this.turn ? {
        ...this.turn,
        occupy: this.turn.occupy ? { ...this.turn.occupy } : null,
        pendingAttack: this.turn.pendingAttack ? { ...this.turn.pendingAttack } : null,
      } : null,
      lastBattle: this.lastBattle,
      lastTrade: this.lastTrade,
      deckCount: this.deck.length,
      tradeCount: this.tradeCount,
      nextTradeValue: this.nextTradeValue(),
      log: this.log.slice(-40),
      winner: this.winner,
      myCards: viewer ? viewer.cards.map((id) => ({ ...CARD[id] })) : null,
    };
  }
}

const PHASE_HINTS = {
  setup: 'Erst müssen alle ihre Startarmeen setzen.',
  reinforce: 'Setze zuerst alle Verstärkungen.',
  attack: 'Gerade ist die Angriffsphase.',
  defend: 'Warte, bis der Verteidiger seine Würfel gewählt hat.',
  occupy: 'Ziehe zuerst Armeen in das eroberte Gebiet nach.',
  fortify: 'Die Angriffe sind vorbei – du kannst nur noch verschieben oder den Zug beenden.',
  gameover: 'Das Spiel ist vorbei.',
};

module.exports = {
  RisikoGame,
  RuleError,
  CARDS,
  CARD,
  SYMBOLS,
  NEUTRAL,
  START_ARMIES,
  MIN_PLAYERS,
  MAX_PLAYERS,
  DEFAULT_SETTINGS,
  SETTING_OPTIONS,
  RISING_VALUES,
  FIXED_VALUES,
  risingTradeValue,
  fixedTradeValue,
  isValidSet,
};
