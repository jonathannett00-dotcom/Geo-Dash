'use strict';

/* =========================================================
 *  Blackjack – 6-Deck-Schuh, Dealer steht auf Soft 17,
 *  Blackjack zahlt 3:2, keine Versicherung.
 * ========================================================= */

const DECKS = 6;
const RESHUFFLE_AT = 0.75;
const MIN_BET = 10;
const BET_WINDOW_MS = 30000;
const DECISION_MS = 20000;
const DEAL_MS = 800;          // Zeit pro ausgeteilter Karte (Animation auf Tablet und Handy)
const DEALER_CARD_MS = 1400;
const RESULTS_MS = 12000;

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];

class GameError extends Error {
  constructor(message) { super(message); this.name = 'RuleError'; }
}
const fail = (msg) => { throw new GameError(msg); };
const money = (n) => `${Number(n).toLocaleString('de-DE')} M`;

/* ---------------- Reine Regeln ---------------- */

function newShoe(rng, decks = DECKS) {
  const cards = [];
  for (let d = 0; d < decks; d++) for (const s of SUITS) for (const r of RANKS) cards.push({ r, s });
  return { cards: rng.shuffle(cards), pos: 0 };
}

const needsShuffle = (shoe) => !shoe.cards || shoe.pos >= shoe.cards.length * RESHUFFLE_AT;

function cardPoints(c) {
  if (c.r === 'A') return 11;
  if (['K', 'Q', 'J', '10'].includes(c.r)) return 10;
  return Number(c.r);
}

/** Handwert; soft = mindestens ein Ass zählt noch 11. */
function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    total += cardPoints(c);
    if (c.r === 'A') aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return { total, soft: aces > 0 };
}

const isBlackjack = (cards) => cards.length === 2 && handValue(cards).total === 21;

/** Der Dealer zieht bis 16 und steht ab 17 – auch auf Soft 17. */
const dealerShouldHit = (cards) => handValue(cards).total < 17;

const canSplit = (hand) => hand.cards.length === 2 && hand.cards[0].r === hand.cards[1].r && !hand.fromSplit;
const canDouble = (hand) => hand.cards.length === 2 && !hand.splitAces;

/** Ergebnis und Auszahlung (inklusive Einsatz) einer Hand gegen den Dealer. */
function settleHand(hand, dealerCards) {
  const pv = handValue(hand.cards).total;
  const dv = handValue(dealerCards).total;
  const dealerBJ = isBlackjack(dealerCards);
  const playerBJ = !hand.fromSplit && isBlackjack(hand.cards);
  if (pv > 21) return { result: 'bust', payout: 0 };
  if (playerBJ && !dealerBJ) return { result: 'blackjack', payout: hand.bet + Math.floor(hand.bet * 1.5) };
  if (dealerBJ) return playerBJ ? { result: 'push', payout: hand.bet } : { result: 'lose', payout: 0 };
  if (dv > 21 || pv > dv) return { result: 'win', payout: hand.bet * 2 };
  if (pv === dv) return { result: 'push', payout: hand.bet };
  return { result: 'lose', payout: 0 };
}

/* ---------------- Spielrunde ---------------- */

class Blackjack {
  constructor({ id, players, wallet, rng, shoe = {}, timeScale = 1, now = Date.now, log = () => {}, onChange = () => {}, onDone = () => {} }) {
    this.type = 'blackjack';
    this.id = id;
    this.players = players;
    this.wallet = wallet;
    this.rng = rng;
    this.shoe = shoe;            // bleibt über mehrere Runden im Raum erhalten
    this.timeScale = timeScale;
    this.now = now;
    this.log = log;
    this.onChange = onChange;
    this.onDone = onDone;
    this.phase = 'betting';
    this.bets = new Map();
    this.ready = new Set();
    this.seats = [];
    this.dealer = [];
    this.holeHidden = true;
    this.turn = null;
    this.cardSeq = 0;
    this.timers = [];
    this.shuffled = false;
  }

  start() {
    this.endsAt = this.now() + BET_WINDOW_MS;
    this.later(BET_WINDOW_MS, () => this.closeBetting());
    this.log('🃏 Blackjack! 30 Sekunden Zeit für Einsätze.');
    this.onChange();
  }

  later(ms, fn) { this.timers.push(setTimeout(fn, ms)); }

  stop() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  /* ----- Wetten ----- */

  assertBetting(pid) {
    if (this.phase !== 'betting') fail('Die Wettzeit ist vorbei.');
    if (!this.players.some((p) => p.id === pid)) fail('Du spielst bei dieser Runde nicht mit.');
    if (this.ready.has(pid)) fail('Du hast schon „Fertig“ gedrückt.');
  }

  /** Setzt den Einsatz (ersetzt einen vorherigen). 0 = aussetzen. */
  placeBet(pid, amount) {
    this.assertBetting(pid);
    const value = Number(amount);
    if (!Number.isInteger(value) || value < 0) fail('Bitte einen gültigen Betrag eingeben.');
    if (value > 0 && value < MIN_BET) fail(`Der Mindesteinsatz ist ${money(MIN_BET)}.`);
    const old = this.bets.get(pid) || 0;
    if (old) this.wallet.credit(pid, old);
    try {
      if (value) this.wallet.debit(pid, value);
    } catch (err) {
      if (old) this.wallet.debit(pid, old);
      throw err;
    }
    if (value) this.bets.set(pid, value);
    else this.bets.delete(pid);
  }

  setReady(pid) {
    this.assertBetting(pid);
    this.ready.add(pid);
    if (this.players.every((p) => this.ready.has(p.id))) this.closeBetting();
  }

  /** Spieler hat aufgegeben: nicht mehr auf ihn warten. */
  leave(pid) {
    if (!this.players.some((p) => p.id === pid)) return;
    if (this.phase === 'betting') {
      this.ready.add(pid);
      if (this.players.every((p) => this.ready.has(p.id))) this.closeBetting();
      return;
    }
    const seat = this.seats.find((s) => s.playerId === pid);
    if (this.phase !== 'playing' || !seat) return;
    seat.hands.forEach((h) => { h.done = true; });
    if (this.turn && this.seats[this.turn.seat].playerId === pid) this.advance();
  }

  handle(pid, action) {
    switch (action.type) {
      case 'bet': this.placeBet(pid, action.amount); break;
      case 'ready': this.setReady(pid); break;
      case 'hit': case 'stand': case 'double': case 'split': this.act(pid, action.type); break;
      default: fail('Unbekannte Aktion.');
    }
  }

  /* ----- Austeilen ----- */

  draw() {
    if (!this.shoe.cards || this.shoe.pos >= this.shoe.cards.length) Object.assign(this.shoe, newShoe(this.rng));
    const c = this.shoe.cards[this.shoe.pos++];
    this.cardSeq += 1;
    return { r: c.r, s: c.s, n: this.cardSeq };
  }

  closeBetting() {
    if (this.phase !== 'betting') return;
    this.stop();
    this.seats = this.players.filter((p) => this.bets.has(p.id)).map((p) => ({
      playerId: p.id,
      hands: [{ cards: [], bet: this.bets.get(p.id), done: false, fromSplit: false, splitAces: false, doubled: false, result: null, payout: 0 }],
    }));
    if (!this.seats.length) {
      this.log('🃏 Niemand setzt – der Dealer räumt den Tisch.');
      this.finish();
      return;
    }
    if (needsShuffle(this.shoe)) {
      Object.assign(this.shoe, newShoe(this.rng));
      this.shuffled = true;
      this.log('🃏 Der Dealer mischt einen neuen 6-Deck-Schuh.');
    }
    // reihum austeilen: jeder eine Karte, Dealer eine, jeder die zweite, Dealer die verdeckte
    for (let round = 0; round < 2; round++) {
      this.seats.forEach((seat) => seat.hands[0].cards.push(this.draw()));
      this.dealer.push(this.draw());
    }
    this.phase = 'playing';
    const dealMs = (this.seats.length + 1) * 2 * DEAL_MS * this.timeScale;
    this.log(`🃏 Der Dealer teilt aus (${this.seats.length} ${this.seats.length === 1 ? 'Spieler' : 'Spieler'}).`);

    if (isBlackjack(this.dealer)) {
      this.holeHidden = false;
      this.log('🃏 Der Dealer hat Blackjack!');
      this.later(dealMs + 800 * this.timeScale, () => this.settle());
      this.onChange();
      return;
    }
    this.seats.forEach((seat) => {
      const h = seat.hands[0];
      if (isBlackjack(h.cards)) h.done = true;
    });
    this.dealtAt = this.now() + dealMs;
    this.later(dealMs, () => this.advance());
    this.onChange();
  }

  /* ----- Spielerentscheidungen ----- */

  currentHand() {
    if (!this.turn) return null;
    return this.seats[this.turn.seat].hands[this.turn.hand];
  }

  /** Nächste offene Hand suchen, sonst spielt der Dealer. */
  advance() {
    for (let s = 0; s < this.seats.length; s++) {
      for (let h = 0; h < this.seats[s].hands.length; h++) {
        if (!this.seats[s].hands[h].done) {
          this.turn = { seat: s, hand: h, seq: (this.turn?.seq || 0) + 1, endsAt: this.now() + DECISION_MS };
          const seq = this.turn.seq;
          this.later(DECISION_MS, () => {
            if (this.phase === 'playing' && this.turn && this.turn.seq === seq) {
              const pid = this.seats[this.turn.seat].playerId;
              this.act(pid, 'stand', true);
            }
          });
          this.onChange();
          return;
        }
      }
    }
    this.turn = null;
    this.dealerPlay();
  }

  act(pid, action, auto = false) {
    if (this.phase !== 'playing' || !this.turn) fail('Gerade ist keine Entscheidung dran.');
    const seat = this.seats[this.turn.seat];
    if (seat.playerId !== pid) {
      const cur = this.players.find((p) => p.id === seat.playerId);
      fail(`Du bist nicht dran – gerade entscheidet ${cur ? cur.name : 'jemand anderes'}.`);
    }
    const hand = this.currentHand();
    switch (action) {
      case 'hit': {
        hand.cards.push(this.draw());
        const v = handValue(hand.cards).total;
        if (v >= 21) hand.done = true;
        break;
      }
      case 'stand':
        hand.done = true;
        if (auto) this.log(`🃏 ${this.players.find((p) => p.id === pid).name} lässt die Zeit ablaufen – automatisch „Stand“.`);
        break;
      case 'double':
        if (!canDouble(hand)) fail('Verdoppeln geht nur mit den ersten 2 Karten.');
        this.wallet.debit(pid, hand.bet);
        hand.bet *= 2;
        hand.doubled = true;
        hand.cards.push(this.draw());
        hand.done = true;
        break;
      case 'split': {
        if (hand.fromSplit) fail('Jede Hand kann nur einmal geteilt werden.');
        if (!canSplit(hand)) fail('Teilen geht nur mit einem Paar aus den ersten 2 Karten.');
        this.wallet.debit(pid, hand.bet);
        const aces = hand.cards[0].r === 'A';
        const make = (card) => ({ cards: [card, this.draw()], bet: hand.bet, done: false, fromSplit: true, splitAces: aces, doubled: false, result: null, payout: 0 });
        const h1 = make(hand.cards[0]);
        const h2 = make(hand.cards[1]);
        // geteilte Asse erhalten je nur eine Karte
        [h1, h2].forEach((h) => { if (aces || handValue(h.cards).total === 21) h.done = true; });
        seat.hands.splice(this.turn.hand, 1, h1, h2);
        break;
      }
      default:
        fail('Unbekannte Aktion.');
    }
    if (hand.done || action === 'split') this.advance();
    else {
      this.turn.endsAt = this.now() + DECISION_MS;
      const seq = ++this.turn.seq;
      this.later(DECISION_MS, () => {
        if (this.phase === 'playing' && this.turn && this.turn.seq === seq) this.act(pid, 'stand', true);
      });
      this.onChange();
    }
  }

  /* ----- Dealer & Abrechnung ----- */

  dealerPlay() {
    this.phase = 'dealer';
    this.holeHidden = false;
    const live = this.seats.some((s) => s.hands.some((h) => handValue(h.cards).total <= 21));
    if (live) while (dealerShouldHit(this.dealer)) this.dealer.push(this.draw());
    const drawn = this.dealer.length - 2;
    this.later((1 + drawn) * DEALER_CARD_MS * this.timeScale + 400, () => this.settle());
    this.onChange();
  }

  settle() {
    if (this.phase === 'results' || this.phase === 'done') return;
    this.holeHidden = false;
    this.turn = null;
    const dv = handValue(this.dealer).total;
    this.log(`🃏 Dealer: ${isBlackjack(this.dealer) ? 'Blackjack' : (dv > 21 ? `${dv} – überkauft` : dv)}.`);
    const LABEL = { blackjack: 'Blackjack', win: 'gewinnt', push: 'unentschieden', lose: 'verliert', bust: 'überkauft' };
    for (const seat of this.seats) {
      const p = this.players.find((x) => x.id === seat.playerId);
      let net = 0;
      for (const hand of seat.hands) {
        const r = settleHand(hand, this.dealer);
        hand.result = r.result;
        hand.payout = r.payout;
        if (r.payout) this.wallet.credit(seat.playerId, r.payout);
        net += r.payout - hand.bet;
      }
      const labels = seat.hands.map((h) => LABEL[h.result]).join(' / ');
      this.log(`🃏 ${p.name}: ${labels} (${net >= 0 ? '+' : '−'}${money(Math.abs(net))}).`);
    }
    this.finish();
  }

  finish() {
    this.phase = 'results';
    this.later(RESULTS_MS * this.timeScale, () => { this.phase = 'done'; this.onDone(); });
    this.onChange();
  }

  view() {
    const hidden = this.holeHidden && this.dealer.length === 2;
    const dealer = this.dealer.map((c, i) => (hidden && i === 1 ? { r: '?', s: '?', n: c.n, hidden: true } : c));
    const visible = dealer.filter((c) => !c.hidden);
    return {
      id: this.id,
      type: this.type,
      phase: this.phase,
      endsAt: this.endsAt,
      players: this.players,
      bets: [...this.bets].map(([playerId, amount]) => ({ playerId, amount })),
      ready: [...this.ready],
      minBet: MIN_BET,
      seats: this.seats.map((s) => ({
        playerId: s.playerId,
        hands: s.hands.map((h) => ({
          cards: h.cards, bet: h.bet, done: h.done, doubled: h.doubled, fromSplit: h.fromSplit,
          value: handValue(h.cards), canDouble: canDouble(h), canSplit: canSplit(h), result: h.result, payout: h.payout,
        })),
      })),
      dealer,
      dealerValue: handValue(visible),
      turn: this.turn ? { seat: this.turn.seat, hand: this.turn.hand, endsAt: this.turn.endsAt, playerId: this.seats[this.turn.seat].playerId } : null,
      decisionMs: DECISION_MS,
      dealMs: DEAL_MS * this.timeScale,
      dealerCardMs: DEALER_CARD_MS * this.timeScale,
      dealtAt: this.dealtAt,
      timeScale: this.timeScale,
      shoeLeft: this.shoe.cards ? this.shoe.cards.length - this.shoe.pos : DECKS * 52,
      shuffled: this.shuffled,
    };
  }
}

module.exports = {
  Blackjack, newShoe, needsShuffle, handValue, isBlackjack, dealerShouldHit, settleHand, canSplit, canDouble,
  MIN_BET, DECISION_MS, RESHUFFLE_AT,
};
