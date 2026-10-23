'use strict';

/* =========================================================
 *  Monopoly-Regeln (deutsche Standardausgabe) – reine Spiellogik.
 *  Der Server ist die einzige Instanz: Clients schicken nur Absichten,
 *  jede Methode prüft Zug, Phase und Geld und wirft sonst RuleError.
 * ========================================================= */

const { SQUARES, GROUPS, isOwnable } = require('./board');
const { CHANCE_CARDS, COMMUNITY_CARDS } = require('./cards');
const { createRng } = require('../rng');

const GO_SALARY = 200;
const JAIL_POSITION = 10;
const JAIL_FINE = 50;
const MAX_JAIL_ROLLS = 3;
const BANK_HOUSES = 32;
const BANK_HOTELS = 12;
const HOTEL = 5;
const AUCTION_STEP = 10;
const AUCTION_MS = 25000;
const AUCTION_EXTEND_MS = 12000;
const LOG_LIMIT = 80;
const MOVES_LIMIT = 40;

const DECKS = { chance: CHANCE_CARDS, community: COMMUNITY_CARDS };
const DECK_NAMES = { chance: 'Ereigniskarte', community: 'Gemeinschaftskarte' };

class RuleError extends Error {
  constructor(message) { super(message); this.name = 'RuleError'; }
}
const fail = (message) => { throw new RuleError(message); };
const money = (n) => `${Number(n).toLocaleString('de-DE')} M`;

/** Würfelsumme → Minispiel (oder null). */
function minigameForSum(sum) {
  if (sum === 2 || sum === 6) return 'blackjack';
  if (sum === 8 || sum === 12) return 'roulette';
  if (sum === 7) return 'horserace';
  return null;
}

/** Ablösesumme einer Hypothek: Hypothekenwert + 10 % (aufgerundet). */
const mortgageValue = (i) => SQUARES[i].price / 2;
const unmortgageCost = (i) => mortgageValue(i) + Math.ceil(mortgageValue(i) / 10);

class MonopolyGame {
  constructor({ players, startMoney = 1500, rng = createRng(), now = Date.now }) {
    if (!players || players.length < 2) fail('Es werden mindestens 2 Spieler gebraucht.');
    if (players.length > 10) fail('Maximal 10 Spieler.');
    this.rng = rng;
    this.now = now;
    this.startMoney = startMoney;
    this.players = players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      figure: p.figure,
      money: startMoney,
      position: 0,
      inJail: false,
      jailRolls: 0,
      jailCards: [],
      bankrupt: false,
    }));
    this.props = SQUARES.map((_, i) => (isOwnable(i) ? { owner: null, houses: 0, mortgaged: false } : null));
    this.bank = { houses: BANK_HOUSES, hotels: BANK_HOTELS };
    this.decks = {
      chance: rng.shuffle(CHANCE_CARDS.map((_, i) => i)),
      community: rng.shuffle(COMMUNITY_CARDS.map((_, i) => i)),
    };
    this.seq = 0;
    this.log = [];
    this.moves = [];
    this.lastRoll = null;
    this.lastCard = null;
    this.auction = null;
    this.auctionQueue = [];
    this.debts = [];
    this.trades = [];
    this.minigame = null;
    this.winner = null;
    this.forcedDice = [];
    this.currentIndex = 0;
    this.phase = 'roll';
    this.event(`Das Spiel beginnt! Alle starten mit ${money(startMoney)}.`, 'info');
    this.startTurn();
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

  currentPlayer() { return this.players[this.currentIndex]; }
  activePlayers() { return this.players.filter((p) => !p.bankrupt); }
  nameOf(id) { return id ? this.player(id).name : 'die Bank'; }

  assertActive(p) { if (p.bankrupt) fail('Du bist pleite und spielst nicht mehr mit.'); }

  assertTurn(pid) {
    const p = this.player(pid);
    this.assertActive(p);
    if (this.phase === 'gameover') fail('Das Spiel ist vorbei.');
    if (this.currentPlayer().id !== pid) fail(`Du bist nicht am Zug – gerade ist ${this.currentPlayer().name} dran.`);
    return p;
  }

  /** Bauen, Hypotheken und Handel: jederzeit außer während Minispielen. */
  assertCanManage(pid) {
    const p = this.player(pid);
    this.assertActive(p);
    if (this.phase === 'minigame') fail('Während eines Minispiels geht das nicht.');
    if (this.phase === 'gameover') fail('Das Spiel ist vorbei.');
    return p;
  }

  assertOwnStreet(p, i) {
    const s = SQUARES[i];
    if (!s || !this.props[i]) fail('Unbekanntes Grundstück.');
    if (this.props[i].owner !== p.id) fail(`${s.name} gehört dir nicht.`);
    return s;
  }

  ownsGroup(pid, group) { return GROUPS[group].every((i) => this.props[i].owner === pid); }
  groupHasBuildings(group) { return GROUPS[group].some((i) => this.props[i].houses > 0); }
  ownedBy(pid) { return this.props.map((st, i) => (st && st.owner === pid ? i : -1)).filter((i) => i >= 0); }

  /** Was ein Spieler durch Verkauf aller Häuser und Hypotheken noch auftreiben könnte. */
  liquidationValue(p) {
    return this.ownedBy(p.id).reduce((sum, i) => {
      const s = SQUARES[i];
      const st = this.props[i];
      return sum + (st.houses ? (st.houses * s.house) / 2 : 0) + (st.mortgaged ? 0 : mortgageValue(i));
    }, 0);
  }

  /* ---------------- Würfel & Bewegung ---------------- */

  rollDice() {
    const forced = this.forcedDice.shift();
    const dice = forced ? [forced[0], forced[1]] : [this.rng.int(6) + 1, this.rng.int(6) + 1];
    return { dice, sum: dice[0] + dice[1], doubles: dice[0] === dice[1] };
  }

  recordMove(p, from, mode, steps) {
    this.moves.push({ seq: this.nextSeq(), playerId: p.id, from, to: p.position, steps, mode });
    if (this.moves.length > MOVES_LIMIT) this.moves.shift();
  }

  moveBy(p, steps) {
    const from = p.position;
    p.position = (from + steps) % 40;
    this.recordMove(p, from, 'walk', steps);
    if (from + steps >= 40) {
      p.money += GO_SALARY;
      this.event(`${p.name} ${p.position === 0 ? 'landet auf' : 'kommt über'} Los und erhält ${money(GO_SALARY)}.`, 'money');
    }
  }

  moveTo(p, target) { this.moveBy(p, (target - p.position + 40) % 40); }

  moveBack(p, steps) {
    const from = p.position;
    p.position = (from - steps + 40) % 40;
    this.recordMove(p, from, 'back', steps);
  }

  sendToJail(p) {
    const from = p.position;
    p.position = JAIL_POSITION;
    p.inJail = true;
    p.jailRolls = 0;
    this.recordMove(p, from, 'jump', 0);
    if (this.turn && this.turn.playerId === p.id) this.turn.rollAgain = false;
  }

  releaseFromJail(p) {
    p.inJail = false;
    p.jailRolls = 0;
  }

  /* ---------------- Geld ---------------- */

  /**
   * Zahlung an Spieler (creditorId) oder Bank (null). Reicht das Bargeld nicht,
   * entsteht eine Schuld, die der Spieler über Verkauf/Hypotheken begleichen muss.
   */
  pay(p, amount, creditorId, reason) {
    if (amount <= 0) return true;
    const queued = this.debts.some((d) => d.debtorId === p.id);
    if (!queued && p.money >= amount) {
      p.money -= amount;
      if (creditorId) this.player(creditorId).money += amount;
      return true;
    }
    this.debts.push({ debtorId: p.id, creditorId: creditorId || null, amount, reason });
    return false;
  }

  /** Arbeitet offene Schulden ab. true = Spiel wartet auf den Schuldner. */
  processDebts() {
    while (this.debts.length) {
      const d = this.debts[0];
      const debtor = this.player(d.debtorId);
      if (debtor.bankrupt) { this.debts.shift(); continue; }
      if (d.creditorId && this.player(d.creditorId).bankrupt) d.creditorId = null;
      if (debtor.money >= d.amount) {
        debtor.money -= d.amount;
        if (d.creditorId) this.player(d.creditorId).money += d.amount;
        this.event(`${debtor.name} zahlt ${money(d.amount)} (${d.reason}) an ${this.nameOf(d.creditorId)}.`, 'money');
        this.debts.shift();
        continue;
      }
      if (debtor.money + this.liquidationValue(debtor) < d.amount) {
        this.debts.shift();
        this.event(`${debtor.name} kann ${money(d.amount)} (${d.reason}) nicht aufbringen.`, 'debt');
        this.goBankrupt(debtor, d.creditorId);
        continue;
      }
      if (this.phase !== 'debt' || !d.announced) {
        d.announced = true;
        this.event(`${debtor.name} muss ${money(d.amount)} (${d.reason}) an ${this.nameOf(d.creditorId)} zahlen – erst Häuser verkaufen oder Hypotheken aufnehmen.`, 'debt');
      }
      this.phase = 'debt';
      return true;
    }
    return false;
  }

  /** Pleite: Besitz geht an den Gläubiger – bei Schulden an die Bank wird er versteigert. */
  goBankrupt(p, creditorId, { auction = true, announce = true } = {}) {
    const creditor = creditorId ? this.player(creditorId) : null;
    for (const i of this.ownedBy(p.id)) {
      const st = this.props[i];
      if (st.houses) {
        if (st.houses === HOTEL) this.bank.hotels += 1;
        else this.bank.houses += st.houses;
        p.money += (st.houses * SQUARES[i].house) / 2;
        st.houses = 0;
      }
      if (creditor) {
        st.owner = creditor.id;
      } else {
        st.owner = null;
        st.mortgaged = false;
        if (auction) this.auctionQueue.push(i);
      }
    }
    if (creditor) {
      creditor.money += p.money;
      creditor.jailCards.push(...p.jailCards);
      this.event(`💥 ${p.name} ist pleite! Geld und Besitz gehen an ${creditor.name}.`, 'bankrupt');
    } else {
      p.jailCards.forEach((deck) => this.returnJailCard(deck));
      if (announce) this.event(`💥 ${p.name} ist pleite! Der Besitz geht an die Bank${auction && this.auctionQueue.length ? ' und wird versteigert' : ''}.`, 'bankrupt');
    }
    p.money = 0;
    p.jailCards = [];
    p.inJail = false;
    p.bankrupt = true;
    this.debts = this.debts.filter((d) => d.debtorId !== p.id);
    this.trades = this.trades.filter((t) => t.fromId !== p.id && t.toId !== p.id);
  }

  declareBankruptcy(pid) {
    const p = this.player(pid);
    this.assertActive(p);
    const d = this.debts[0];
    if (this.phase !== 'debt' || !d || d.debtorId !== pid) fail('Du hast gerade keine offenen Schulden.');
    this.debts.shift();
    this.goBankrupt(p, d.creditorId);
    this.continueTurn();
  }

  /* ---------------- Zugablauf ---------------- */

  startTurn() {
    const p = this.currentPlayer();
    this.turn = {
      playerId: p.id,
      doubles: 0,
      rolled: false,
      rollAgain: false,
      buyOffer: null,
      pendingMove: null,
      minigame: null,
      minigameDone: false,
      dice: null,
    };
    this.phase = p.inJail ? 'jail' : 'roll';
    this.event(`${p.name} ist am Zug${p.inJail ? ' (im Gefängnis)' : ''}.`, 'turn');
  }

  nextPlayer() {
    if (this.checkGameOver()) return;
    let i = this.currentIndex;
    do { i = (i + 1) % this.players.length; } while (this.players[i].bankrupt);
    this.currentIndex = i;
    this.startTurn();
  }

  checkGameOver() {
    if (this.phase === 'gameover') return true;
    const alive = this.activePlayers();
    if (alive.length > 1) return false;
    this.phase = 'gameover';
    this.winner = alive[0] ? alive[0].id : null;
    this.minigame = null;
    this.auction = null;
    this.auctionQueue = [];
    this.debts = [];
    if (alive[0]) this.event(`🏆 ${alive[0].name} gewinnt das Spiel!`, 'win');
    return true;
  }

  /**
   * Führt den Zug nach jeder abgeschlossenen Interaktion fort:
   * Schulden → Versteigerung → Kaufentscheidung → Bewegung → Minispiel → Pasch → nächster Spieler.
   */
  continueTurn() {
    if (this.phase === 'gameover') return;
    if (this.processDebts()) return;
    if (this.checkGameOver()) return;
    if (this.auction) { this.phase = 'auction'; return; }
    if (this.auctionQueue.length) { this.startAuction(this.auctionQueue.shift()); return; }

    const p = this.currentPlayer();
    const t = this.turn;
    if (p.bankrupt) {
      t.buyOffer = null;
      t.pendingMove = null;
      t.rollAgain = false;
      if (!t.rolled) { this.nextPlayer(); return; }
    }
    if (t.buyOffer !== null) { this.phase = 'buy'; return; }
    if (t.pendingMove) {
      const steps = t.pendingMove;
      t.pendingMove = null;
      this.moveBy(p, steps);
      this.resolveSquare(p, steps);
      this.continueTurn();
      return;
    }
    if (!t.rolled) { this.phase = p.inJail ? 'jail' : 'roll'; return; }
    if (t.minigame && !t.minigameDone) {
      this.phase = 'minigame';
      this.minigame = { type: t.minigame, seq: this.nextSeq() };
      return;
    }
    if (t.rollAgain && !p.inJail && !p.bankrupt) {
      Object.assign(t, { rolled: false, rollAgain: false, minigame: null, minigameDone: false });
      this.phase = 'roll';
      this.event(`${p.name} hatte einen Pasch und würfelt nochmal.`, 'turn');
      return;
    }
    if (p.bankrupt) { this.nextPlayer(); return; }
    // Alles erledigt – der Spieler beendet seinen Zug selbst (vorher noch bauen/handeln möglich)
    this.phase = 'end';
  }

  endTurn(pid) {
    const p = this.assertTurn(pid);
    if (this.phase !== 'end') fail('Du kannst deinen Zug erst beenden, wenn alles erledigt ist.');
    this.event(`${p.name} beendet den Zug.`, 'turn');
    this.nextPlayer();
  }

  beginRoll(p) {
    const r = this.rollDice();
    Object.assign(this.turn, {
      rolled: true, rollAgain: false, buyOffer: null, pendingMove: null,
      minigame: minigameForSum(r.sum), minigameDone: false, dice: r.dice,
    });
    this.lastRoll = { seq: this.nextSeq(), playerId: p.id, dice: r.dice, sum: r.sum, doubles: r.doubles };
    this.event(`${p.name} würfelt ${r.dice[0]} + ${r.dice[1]} = ${r.sum}${r.doubles ? ' – Pasch!' : ''}`, 'dice');
    return r;
  }

  roll(pid) {
    const p = this.assertTurn(pid);
    if (this.phase === 'jail') fail('Du sitzt im Gefängnis – wähle zuerst, wie du rauskommen willst.');
    if (this.phase !== 'roll') fail('Jetzt wird nicht gewürfelt.');
    const r = this.beginRoll(p);
    if (r.doubles) {
      this.turn.doubles += 1;
      if (this.turn.doubles >= 3) {
        this.event(`Dritter Pasch in Folge – ${p.name} muss ins Gefängnis!`, 'jail');
        this.sendToJail(p);
        this.continueTurn();
        return;
      }
      this.turn.rollAgain = true;
    }
    this.moveBy(p, r.sum);
    this.resolveSquare(p, r.sum);
    this.continueTurn();
  }

  /* ---------------- Gefängnis ---------------- */

  assertJailChoice(pid) {
    const p = this.assertTurn(pid);
    if (this.phase !== 'jail') fail('Du sitzt gerade nicht im Gefängnis.');
    return p;
  }

  payJail(pid) {
    const p = this.assertJailChoice(pid);
    if (p.money < JAIL_FINE) fail(`Nicht genug Geld: Du brauchst ${money(JAIL_FINE)}, hast aber nur ${money(p.money)}.`);
    p.money -= JAIL_FINE;
    this.releaseFromJail(p);
    this.event(`${p.name} zahlt ${money(JAIL_FINE)} und verlässt das Gefängnis.`, 'jail');
    this.phase = 'roll';
  }

  useJailCard(pid) {
    const p = this.assertJailChoice(pid);
    if (!p.jailCards.length) fail('Du hast keine Gefängnis-Freikarte.');
    this.returnJailCard(p.jailCards.shift());
    this.releaseFromJail(p);
    this.event(`${p.name} setzt eine Freikarte ein und verlässt das Gefängnis.`, 'jail');
    this.phase = 'roll';
  }

  returnJailCard(deck) {
    this.decks[deck].push(DECKS[deck].findIndex((c) => c.action.type === 'jailCard'));
  }

  rollInJail(pid) {
    const p = this.assertJailChoice(pid);
    const r = this.beginRoll(p);
    if (r.doubles) {
      this.releaseFromJail(p);
      this.event(`Pasch! ${p.name} kommt aus dem Gefängnis frei.`, 'jail');
      this.moveBy(p, r.sum);
      this.resolveSquare(p, r.sum);
    } else {
      p.jailRolls += 1;
      if (p.jailRolls >= MAX_JAIL_ROLLS) {
        this.event(`${p.name} hat dreimal keinen Pasch – zahlt ${money(JAIL_FINE)} und zieht.`, 'jail');
        this.releaseFromJail(p);
        this.pay(p, JAIL_FINE, null, 'Gefängnis');
        this.turn.pendingMove = r.sum;
      } else {
        this.event(`Kein Pasch – ${p.name} bleibt im Gefängnis (Versuch ${p.jailRolls} von ${MAX_JAIL_ROLLS}).`, 'jail');
      }
    }
    this.continueTurn();
  }

  /* ---------------- Felder ---------------- */

  rentFor(i, diceSum, opts = {}) {
    const s = SQUARES[i];
    const st = this.props[i];
    if (!st || !st.owner || st.mortgaged) return 0;
    if (s.type === 'street') {
      if (st.houses > 0) return s.rent[st.houses];
      return this.ownsGroup(st.owner, s.group) ? s.rent[0] * 2 : s.rent[0];
    }
    if (s.type === 'railroad') {
      const n = GROUPS.railroad.filter((j) => this.props[j].owner === st.owner).length;
      return 25 * 2 ** (n - 1) * (opts.railroadMultiplier || 1);
    }
    if (s.type === 'utility') {
      const n = GROUPS.utility.filter((j) => this.props[j].owner === st.owner).length;
      return (opts.utilityFactor || (n === 2 ? 10 : 4)) * diceSum;
    }
    return 0;
  }

  resolveSquare(p, diceSum, opts = {}) {
    const i = p.position;
    const s = SQUARES[i];
    switch (s.type) {
      case 'street':
      case 'railroad':
      case 'utility': {
        const st = this.props[i];
        if (!st.owner) {
          this.turn.buyOffer = i;
          this.event(`${p.name} landet auf ${s.name} – zu kaufen für ${money(s.price)}.`, 'land');
        } else if (st.owner === p.id) {
          this.event(`${p.name} landet auf dem eigenen Grundstück ${s.name}.`, 'land');
        } else if (st.mortgaged) {
          this.event(`${p.name} landet auf ${s.name} – mit Hypothek belastet, keine Miete.`, 'rent');
        } else {
          let rentDice = diceSum;
          if (s.type === 'utility' && opts.utilityFactor) {
            const r = this.rollDice();
            rentDice = r.sum;
            this.event(`${p.name} würfelt für die Miete: ${r.dice[0]} + ${r.dice[1]} = ${r.sum}.`, 'dice');
          }
          const rent = this.rentFor(i, rentDice, opts);
          const owner = this.player(st.owner);
          if (this.pay(p, rent, owner.id, `Miete für ${s.name}`)) {
            this.event(`${p.name} zahlt ${money(rent)} Miete an ${owner.name} für ${s.name}.`, 'rent');
          }
        }
        break;
      }
      case 'tax':
        if (this.pay(p, s.amount, null, s.name)) this.event(`${p.name} zahlt ${money(s.amount)} ${s.name}.`, 'tax');
        break;
      case 'chance':
      case 'community':
        this.drawCard(p, s.type, diceSum);
        break;
      case 'gotojail':
        this.event(`${p.name} muss ins Gefängnis!`, 'jail');
        this.sendToJail(p);
        break;
      case 'parking':
        this.event(`${p.name} macht Pause auf Frei Parken.`, 'land');
        break;
      default:
        break;
    }
  }

  drawCard(p, deck, diceSum) {
    const index = this.decks[deck].shift();
    const card = DECKS[deck][index];
    const a = card.action;
    if (a.type !== 'jailCard') this.decks[deck].push(index);
    this.lastCard = { seq: this.nextSeq(), deck, title: DECK_NAMES[deck], text: card.text, playerId: p.id };
    this.event(`${p.name} zieht eine ${DECK_NAMES[deck]}: „${card.text}“`, 'card');

    switch (a.type) {
      case 'advance':
        this.moveTo(p, a.to);
        this.resolveSquare(p, diceSum);
        break;
      case 'nearest': {
        const targets = GROUPS[a.kind];
        const target = targets.find((t) => t > p.position) ?? targets[0];
        this.moveTo(p, target);
        this.resolveSquare(p, diceSum, a.kind === 'railroad' ? { railroadMultiplier: 2 } : { utilityFactor: 10 });
        break;
      }
      case 'back':
        this.moveBack(p, a.steps);
        this.resolveSquare(p, diceSum);
        break;
      case 'jail':
        this.sendToJail(p);
        break;
      case 'jailCard':
        p.jailCards.push(deck);
        break;
      case 'money':
        if (a.amount > 0) p.money += a.amount;
        else this.pay(p, -a.amount, null, 'Karte');
        break;
      case 'repairs': {
        let houses = 0;
        let hotels = 0;
        for (const i of this.ownedBy(p.id)) {
          if (this.props[i].houses === HOTEL) hotels += 1;
          else houses += this.props[i].houses;
        }
        const cost = houses * a.house + hotels * a.hotel;
        if (cost) {
          this.event(`${p.name} zahlt ${money(cost)} für ${houses} Häuser und ${hotels} Hotels.`, 'money');
          this.pay(p, cost, null, 'Renovierung');
        }
        break;
      }
      case 'payEach':
        for (const o of this.activePlayers()) if (o.id !== p.id) this.pay(p, a.amount, o.id, 'Ereigniskarte');
        break;
      case 'collectEach':
        for (const o of this.activePlayers()) if (o.id !== p.id) this.pay(o, a.amount, p.id, 'Geburtstag');
        break;
      default:
        break;
    }
  }

  /* ---------------- Kaufen & Versteigern ---------------- */

  buy(pid) {
    const p = this.assertTurn(pid);
    if (this.phase !== 'buy' || this.turn.buyOffer === null) fail('Gerade gibt es nichts zu kaufen.');
    const i = this.turn.buyOffer;
    const s = SQUARES[i];
    if (p.money < s.price) fail(`Nicht genug Geld: ${s.name} kostet ${money(s.price)}, du hast nur ${money(p.money)}.`);
    p.money -= s.price;
    this.props[i].owner = p.id;
    this.turn.buyOffer = null;
    this.event(`${p.name} kauft ${s.name} für ${money(s.price)}.`, 'buy');
    this.continueTurn();
  }

  declineBuy(pid) {
    const p = this.assertTurn(pid);
    if (this.phase !== 'buy' || this.turn.buyOffer === null) fail('Gerade gibt es nichts zu kaufen.');
    const i = this.turn.buyOffer;
    this.turn.buyOffer = null;
    this.event(`${p.name} kauft ${SQUARES[i].name} nicht.`, 'buy');
    this.startAuction(i);
  }

  startAuction(i) {
    this.auction = { square: i, bid: 0, bidderId: null, passed: [], endsAt: this.now() + AUCTION_MS, seq: this.nextSeq() };
    this.phase = 'auction';
    this.event(`🔨 Versteigerung: ${SQUARES[i].name} (Wert ${money(SQUARES[i].price)}) – Mindestgebot ${money(AUCTION_STEP)}.`, 'auction');
  }

  assertAuction(p) {
    this.assertActive(p);
    if (this.phase !== 'auction' || !this.auction) fail('Gerade läuft keine Versteigerung.');
    if (this.auction.passed.includes(p.id)) fail('Du bist bei dieser Versteigerung schon ausgestiegen.');
    return this.auction;
  }

  bid(pid, amount) {
    const p = this.player(pid);
    const a = this.assertAuction(p);
    const value = Number(amount);
    if (!Number.isInteger(value)) fail('Bitte einen ganzen Betrag bieten.');
    if (a.bidderId === pid) fail('Du hast bereits das höchste Gebot.');
    const min = a.bidderId ? a.bid + AUCTION_STEP : AUCTION_STEP;
    if (value < min) fail(`Das Gebot muss mindestens ${money(min)} betragen.`);
    if (value > p.money) fail(`Nicht genug Geld: Du hast nur ${money(p.money)}.`);
    a.bid = value;
    a.bidderId = pid;
    a.endsAt = Math.max(a.endsAt, this.now() + AUCTION_EXTEND_MS);
    this.event(`${p.name} bietet ${money(value)} für ${SQUARES[a.square].name}.`, 'auction');
    this.checkAuctionEnd();
  }

  passAuction(pid) {
    const p = this.player(pid);
    const a = this.assertAuction(p);
    if (a.bidderId === pid) fail('Du hast das höchste Gebot und kannst nicht aussteigen.');
    a.passed.push(pid);
    this.event(`${p.name} steigt aus der Versteigerung aus.`, 'auction');
    this.checkAuctionEnd();
  }

  /** Endet vorzeitig, wenn außer dem Höchstbietenden niemand mehr bieten kann. */
  checkAuctionEnd() {
    const a = this.auction;
    if (!a) return;
    const others = this.activePlayers().filter((p) => !a.passed.includes(p.id) && p.id !== a.bidderId);
    if (others.length === 0) this.endAuction();
  }

  /** Vom Server-Timer aufgerufen. */
  auctionTimeout() {
    if (this.auction && this.now() >= this.auction.endsAt) this.endAuction();
  }

  endAuction() {
    const a = this.auction;
    if (!a) return;
    this.auction = null;
    const s = SQUARES[a.square];
    const winner = a.bidderId ? this.player(a.bidderId) : null;
    if (winner && !winner.bankrupt) {
      this.props[a.square].owner = winner.id;
      this.pay(winner, a.bid, null, `Versteigerung ${s.name}`);
      this.event(`🔨 ${winner.name} ersteigert ${s.name} für ${money(a.bid)}.`, 'auction');
    } else {
      this.event(`🔨 Niemand bietet für ${s.name} – es bleibt bei der Bank.`, 'auction');
    }
    this.continueTurn();
  }

  /* ---------------- Bauen & Hypotheken ---------------- */

  afterManage() { if (this.phase === 'debt') this.continueTurn(); }

  buildHouse(pid, square) {
    const p = this.assertCanManage(pid);
    const i = Number(square);
    const s = this.assertOwnStreet(p, i);
    const st = this.props[i];
    if (s.type !== 'street') fail('Auf Bahnhöfen und Werken kann man nicht bauen.');
    if (!this.ownsGroup(p.id, s.group)) fail('Bauen geht nur mit der kompletten Farbgruppe.');
    if (GROUPS[s.group].some((j) => this.props[j].mortgaged)) fail('In dieser Farbgruppe ist ein Grundstück mit Hypothek belastet.');
    if (st.houses >= HOTEL) fail(`Auf ${s.name} steht schon ein Hotel.`);
    const min = Math.min(...GROUPS[s.group].map((j) => this.props[j].houses));
    if (st.houses > min) fail('Gleichmäßig bauen: Erst die anderen Straßen der Farbgruppe bebauen.');
    if (p.money < s.house) fail(`Nicht genug Geld: Ein ${st.houses === 4 ? 'Hotel' : 'Haus'} kostet ${money(s.house)}, du hast ${money(p.money)}.`);
    if (st.houses === 4) {
      if (this.bank.hotels < 1) fail('Die Bank hat keine Hotels mehr.');
      this.bank.hotels -= 1;
      this.bank.houses += 4;
    } else {
      if (this.bank.houses < 1) fail('Die Bank hat keine Häuser mehr.');
      this.bank.houses -= 1;
    }
    st.houses += 1;
    p.money -= s.house;
    this.event(`${p.name} baut ${st.houses === HOTEL ? 'ein Hotel' : `ein Haus (${st.houses})`} auf ${s.name}.`, 'build');
  }

  sellHouse(pid, square) {
    const p = this.assertCanManage(pid);
    const i = Number(square);
    const s = this.assertOwnStreet(p, i);
    const st = this.props[i];
    if (s.type !== 'street' || !st.houses) fail(`Auf ${s.name} steht nichts zum Verkaufen.`);
    const max = Math.max(...GROUPS[s.group].map((j) => this.props[j].houses));
    if (st.houses < max) fail('Gleichmäßig verkaufen: Erst die Häuser der anderen Straßen dieser Farbe verkaufen.');
    if (st.houses === HOTEL) {
      if (this.bank.houses < 4) fail('Die Bank hat nicht genug Häuser, um das Hotel in 4 Häuser zu tauschen.');
      this.bank.houses -= 4;
      this.bank.hotels += 1;
    } else {
      this.bank.houses += 1;
    }
    st.houses -= 1;
    p.money += s.house / 2;
    this.event(`${p.name} verkauft ${st.houses === 4 ? 'das Hotel' : 'ein Haus'} auf ${s.name} für ${money(s.house / 2)}.`, 'build');
    this.afterManage();
  }

  mortgage(pid, square) {
    const p = this.assertCanManage(pid);
    const i = Number(square);
    const s = this.assertOwnStreet(p, i);
    const st = this.props[i];
    if (st.mortgaged) fail(`${s.name} hat schon eine Hypothek.`);
    if (s.type === 'street' && this.groupHasBuildings(s.group)) fail('Erst alle Häuser dieser Farbgruppe verkaufen.');
    st.mortgaged = true;
    p.money += mortgageValue(i);
    this.event(`${p.name} nimmt eine Hypothek auf ${s.name} auf (${money(mortgageValue(i))}).`, 'mortgage');
    this.afterManage();
  }

  unmortgage(pid, square) {
    const p = this.assertCanManage(pid);
    const i = Number(square);
    const s = this.assertOwnStreet(p, i);
    const st = this.props[i];
    if (!st.mortgaged) fail(`${s.name} hat keine Hypothek.`);
    const cost = unmortgageCost(i);
    if (p.money < cost) fail(`Nicht genug Geld: Die Ablösung kostet ${money(cost)}, du hast ${money(p.money)}.`);
    p.money -= cost;
    st.mortgaged = false;
    this.event(`${p.name} löst die Hypothek auf ${s.name} ab (${money(cost)}).`, 'mortgage');
  }

  /* ---------------- Handel ---------------- */

  normalizeSide(side) {
    const props = [...new Set((Array.isArray(side?.props) ? side.props : []).map(Number))];
    const m = Number(side?.money) || 0;
    const cards = Number(side?.jailCards) || 0;
    if (!Number.isInteger(m) || m < 0 || !Number.isInteger(cards) || cards < 0) fail('Ungültiger Betrag im Angebot.');
    return { props, money: m, jailCards: cards };
  }

  validateSide(p, side, who) {
    if (side.money > p.money) fail(`${who} hat nicht genug Geld (${money(p.money)}).`);
    if (side.jailCards > p.jailCards.length) fail(`${who} hat nicht so viele Freikarten.`);
    for (const i of side.props) {
      const s = SQUARES[i];
      if (!s || !this.props[i] || this.props[i].owner !== p.id) fail(`${s ? s.name : 'Das Grundstück'} gehört nicht ${who === 'Du' ? 'dir' : who}.`);
      if (s.type === 'street' && this.groupHasBuildings(s.group)) fail(`In der Farbgruppe von ${s.name} stehen Häuser – die müssen erst verkauft werden.`);
    }
  }

  describeSide(side) {
    const parts = side.props.map((i) => SQUARES[i].name);
    if (side.money) parts.push(money(side.money));
    if (side.jailCards) parts.push(`${side.jailCards} Freikarte${side.jailCards > 1 ? 'n' : ''}`);
    return parts.join(', ') || 'nichts';
  }

  proposeTrade(fromId, { toId, give, want } = {}) {
    const from = this.assertCanManage(fromId);
    if (this.phase === 'minigame') fail('Während eines Minispiels ist kein Handel möglich.');
    const to = this.players.find((x) => x.id === toId);
    if (!to || to.bankrupt || to.id === from.id) fail('Bitte wähle einen Handelspartner.');
    const g = this.normalizeSide(give);
    const w = this.normalizeSide(want);
    if (!g.props.length && !g.money && !g.jailCards && !w.props.length && !w.money && !w.jailCards) fail('Das Angebot ist leer.');
    this.validateSide(from, g, 'Du');
    this.validateSide(to, w, to.name);
    const trade = { id: this.nextSeq(), fromId: from.id, toId: to.id, give: g, want: w };
    this.trades.push(trade);
    this.event(`🤝 ${from.name} bietet ${to.name} an: ${this.describeSide(g)} gegen ${this.describeSide(w)}.`, 'trade');
    return trade;
  }

  respondTrade(pid, tradeId, accept) {
    const trade = this.trades.find((t) => t.id === Number(tradeId));
    if (!trade) fail('Dieses Angebot gibt es nicht mehr.');
    if (trade.toId !== pid) fail('Dieses Angebot ist nicht an dich gerichtet.');
    const to = this.player(pid);
    this.assertActive(to);
    if (this.phase === 'minigame') fail('Während eines Minispiels ist kein Handel möglich.');
    const from = this.player(trade.fromId);
    this.trades = this.trades.filter((t) => t !== trade);
    if (!accept) {
      this.event(`🤝 ${to.name} lehnt das Angebot von ${from.name} ab.`, 'trade');
      return;
    }
    try {
      this.validateSide(from, trade.give, from.name);
      this.validateSide(to, trade.want, 'Du');
    } catch (err) {
      fail(`Das Angebot ist nicht mehr gültig: ${err.message}`);
    }
    const move = (a, b, side) => {
      side.props.forEach((i) => { this.props[i].owner = b.id; });
      a.money -= side.money;
      b.money += side.money;
      b.jailCards.push(...a.jailCards.splice(0, side.jailCards));
    };
    move(from, to, trade.give);
    move(to, from, trade.want);
    this.event(`🤝 Handel: ${from.name} gibt ${this.describeSide(trade.give)} und bekommt von ${to.name} ${this.describeSide(trade.want)}.`, 'trade');
    this.afterManage();
  }

  cancelTrade(pid, tradeId) {
    const trade = this.trades.find((t) => t.id === Number(tradeId));
    if (!trade) fail('Dieses Angebot gibt es nicht mehr.');
    if (trade.fromId !== pid) fail('Nur wer das Angebot gemacht hat, kann es zurückziehen.');
    this.trades = this.trades.filter((t) => t !== trade);
    this.event(`🤝 ${this.player(pid).name} zieht das Angebot an ${this.nameOf(trade.toId)} zurück.`, 'trade');
  }

  /* ---------------- Minispiele ---------------- */

  /** Einsatz vom Monopoly-Konto abbuchen. */
  debitBet(pid, amount) {
    const p = this.player(pid);
    this.assertActive(p);
    if (amount > p.money) fail(`Nicht genug Geld: Du hast nur ${money(p.money)}.`);
    p.money -= amount;
  }

  creditWin(pid, amount) {
    const p = this.player(pid);
    if (!p.bankrupt) p.money += amount;
  }

  finishMinigame() {
    if (this.phase !== 'minigame') return;
    this.turn.minigameDone = true;
    this.minigame = null;
    this.continueTurn();
  }

  /* ---------------- Spieler verlässt das Spiel ---------------- */

  /** Spieler gibt freiwillig auf: Geld verfällt, alle Grundstücke werden wieder frei. */
  quit(pid) {
    const p = this.player(pid);
    this.assertActive(p);
    if (this.phase === 'gameover') fail('Das Spiel ist schon vorbei.');
    this.removePlayer(pid, 'quit');
  }

  /**
   * Spieler scheidet aus (aufgegeben oder zu lange getrennt): Geld verfällt,
   * Häuser gehen an die Bank, Grundstücke werden ohne Versteigerung wieder frei.
   */
  removePlayer(pid, reason = 'timeout') {
    const p = this.player(pid);
    if (p.bankrupt || this.phase === 'gameover') return;
    const wasCurrent = this.currentPlayer().id === pid;
    this.debts.forEach((d) => { if (d.creditorId === pid) d.creditorId = null; });
    if (this.auction && this.auction.bidderId === pid) { this.auction.bidderId = null; this.auction.bid = 0; }
    const owned = this.ownedBy(pid).length;
    this.event(reason === 'quit'
      ? `🏳️ ${p.name} gibt auf – ${money(p.money)} verfallen${owned ? `, ${owned} Grundstück${owned > 1 ? 'e sind' : ' ist'} wieder frei` : ''}.`
      : `${p.name} war zu lange getrennt und scheidet aus – der Besitz ist wieder frei.`, 'bankrupt');
    p.quit = reason === 'quit';
    this.goBankrupt(p, null, { auction: false, announce: false });
    if (this.checkGameOver()) return;
    if (this.phase === 'minigame') return;
    if (this.auction) { this.checkAuctionEnd(); return; }
    if (wasCurrent) {
      this.debts = this.debts.filter((d) => d.debtorId !== pid);
      if (this.processDebts()) return;
      this.nextPlayer();
    } else if (this.phase === 'debt') {
      this.continueTurn();
    }
  }

  /* ---------------- Zustand für die Clients ---------------- */

  publicState() {
    return {
      phase: this.phase,
      currentId: this.currentPlayer().id,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        figure: p.figure,
        money: p.money,
        position: p.position,
        inJail: p.inJail,
        jailRolls: p.jailRolls,
        jailCards: p.jailCards.length,
        bankrupt: p.bankrupt,
        quit: Boolean(p.quit),
        assets: this.liquidationValue(p),
      })),
      props: this.props.map((st) => (st ? { ...st } : null)),
      bank: { ...this.bank },
      turn: {
        playerId: this.turn.playerId,
        doubles: this.turn.doubles,
        rolled: this.turn.rolled,
        buyOffer: this.turn.buyOffer,
        dice: this.turn.dice,
        minigame: this.turn.minigame,
      },
      auction: this.auction ? { ...this.auction, passed: [...this.auction.passed] } : null,
      debts: this.debts.map((d) => ({ debtorId: d.debtorId, creditorId: d.creditorId, amount: d.amount, reason: d.reason })),
      trades: this.trades.map((t) => ({ ...t })),
      log: this.log.slice(-40),
      moves: this.moves.slice(),
      lastRoll: this.lastRoll,
      lastCard: this.lastCard,
      minigame: this.minigame,
      winner: this.winner,
    };
  }
}

module.exports = {
  MonopolyGame,
  RuleError,
  minigameForSum,
  mortgageValue,
  unmortgageCost,
  GO_SALARY,
  JAIL_FINE,
  JAIL_POSITION,
  BANK_HOUSES,
  BANK_HOTELS,
  AUCTION_STEP,
  AUCTION_MS,
  AUCTION_EXTEND_MS,
};
