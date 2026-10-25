'use strict';

/*
 * Animations-Ereignisse der Risiko-Partie (server/games/risiko/index.js):
 * abgeleitet aus dem Zustand der Engine, mit Startzeit und Dauer; daraus
 * ergibt sich animUntil, auf das die Handys warten.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRng } = require('../server/rng');
const risiko = require('../server/games/risiko');
const { NEIGHBORS } = require('../server/games/risiko/map');
const { isValidSet } = require('../server/games/risiko/rules');

const PLAYERS = ['a', 'b', 'c'].map((id) => ({ id, name: id.toUpperCase() }));

function session(settings = {}, seed = 'anim') {
  return risiko.createGame({ players: PLAYERS, settings: { ...risiko.defaultSettings(), ...settings }, rng: createRng(seed), timeScale: 1 });
}

/** Aufbau abschließen: Jeder setzt seine Startarmeen auf ein eigenes Gebiet. */
function finishSetup(g) {
  for (const p of g.players) g.handleAction(p.id, { type: 'place', territory: g.territoriesOf(p.id)[0], count: p.remaining });
}

/** Eine zufällige, aber gültige Aktion für den Spieler, auf den das Spiel wartet. */
function step(g, rng) {
  const pid = g.waitingFor();
  const own = g.territoriesOf(pid);
  switch (g.phase) {
    case 'reinforce': {
      const p = g.player(pid);
      if (p.cards.length >= 5) {
        for (let i = 0; i < p.cards.length; i++) for (let j = i + 1; j < p.cards.length; j++) for (let k = j + 1; k < p.cards.length; k++) {
          const set = [p.cards[i], p.cards[j], p.cards[k]];
          if (isValidSet(set)) return g.handleAction(pid, { type: 'trade', cards: set });
        }
      }
      const front = own.filter((id) => NEIGHBORS[id].some((n) => g.territories[n].owner !== pid));
      return g.handleAction(pid, { type: 'place', territory: rng.pick(front.length ? front : own), count: g.turn.reinforcements });
    }
    case 'attack': {
      const from = own.filter((id) => g.territories[id].armies >= 2 && NEIGHBORS[id].some((n) => g.territories[n].owner !== pid));
      if (!from.length || rng.next() < 0.12) return g.handleAction(pid, { type: 'endTurn' });
      const src = rng.pick(from);
      return g.handleAction(pid, { type: 'attack', from: src, to: rng.pick(NEIGHBORS[src].filter((n) => g.territories[n].owner !== pid)) });
    }
    case 'defend': return g.handleAction(pid, { type: 'defend' });
    case 'occupy': {
      const { min, max } = g.turn.occupy;
      return g.handleAction(pid, { type: 'occupy', count: min + rng.int(max - min + 1) });
    }
    case 'fortify': return g.handleAction(pid, { type: 'endTurn' });
    default: throw new Error(`unerwartete Phase ${g.phase}`);
  }
}

test('Animation: Jede Eroberung liefert ein Ereignis für die Hervorhebung', () => {
  const g = session();
  finishSetup(g);
  const rng = createRng('zug');
  let conquests = 0;
  for (let i = 0; i < 1500 && g.phase !== 'gameover'; i++) {
    const owners = Object.fromEntries(Object.entries(g.territories).map(([id, t]) => [id, t.owner]));
    const seq = g.animState.seq;
    step(g, rng);
    const events = g.eventsSince(seq);
    for (const [id, t] of Object.entries(g.territories)) {
      if (t.owner === owners[id]) continue;
      conquests++;
      const e = events.find((x) => x.type === 'conquer' && x.territory === id);
      assert.ok(e, `Eroberung von ${id} ohne Ereignis`);
      assert.equal(e.owner, t.owner, 'neue Farbe = neuer Besitzer');
      assert.equal(e.previous, owners[id]);
      assert.equal(e.dur, risiko.ANIM_MS.normal.conquer, 'Hervorhebung etwas über 2 Sekunden');
      assert.ok(e.at + e.dur <= g.view('board').animUntil, 'animUntil wartet auf die Hervorhebung');
      const battle = events.find((x) => x.type === 'battle' && x.to === id);
      assert.ok(battle && battle.conquered && battle.at + battle.dur <= e.at, 'erst der Kampf, dann die Hervorhebung');
    }
  }
  assert.ok(conquests >= 20, `genug Eroberungen im Testlauf (${conquests})`);
});

test('Animation: Kampf, Verluste und Nachrücken als Ereignisse mit Zahlen vom Server', () => {
  const g = session();
  finishSetup(g);
  const a = g.currentPlayer().id;
  const from = g.territoriesOf(a).find((id) => NEIGHBORS[id].some((n) => g.territories[n].owner !== a));
  g.handleAction(a, { type: 'place', territory: from, count: g.turn.reinforcements });
  const place = g.eventsSince(0).filter((e) => e.type === 'place').pop();
  assert.equal(place.territory, from);
  assert.equal(place.to - place.from, g.territories[from].armies - place.from, 'Verstärkung zählt hoch');
  const to = NEIGHBORS[from].find((n) => g.territories[n].owner !== a);
  const before = [g.territories[from].armies, g.territories[to].armies];
  g.forcedDice.push(6, 6, 6, 1, 1);
  const seq = g.animState.seq;
  g.handleAction(a, { type: 'attack', from, to });
  if (g.phase === 'defend') g.handleAction(g.waitingFor(), { type: 'defend' });
  const battle = g.eventsSince(seq).find((e) => e.type === 'battle');
  assert.deepEqual([battle.attackerArmies, battle.defenderArmies], before);
  assert.deepEqual([battle.attack, battle.defend], [g.lastBattle.attack, g.lastBattle.defend], 'Würfel vom Server');
  assert.equal(battle.defenderLosses, g.lastBattle.defenderLosses);
  if (g.phase === 'occupy') {
    const s2 = g.animState.seq;
    g.handleAction(a, { type: 'occupy', count: g.turn.occupy.max });
    const move = g.eventsSince(s2).find((e) => e.type === 'move');
    assert.equal(move.from, from);
    assert.equal(move.to, to);
    assert.equal(move.count, g.territories[to].armies);
  }
  // Verschieben
  g.handleAction(a, { type: 'endAttack' });
  const src = g.territoriesOf(a).find((id) => g.territories[id].armies >= 2 && NEIGHBORS[id].some((n) => g.territories[n].owner === a));
  if (src) {
    const dst = NEIGHBORS[src].find((n) => g.territories[n].owner === a);
    const s3 = g.animState.seq;
    g.handleAction(a, { type: 'fortify', from: src, to: dst, count: 1 });
    assert.deepEqual(g.eventsSince(s3).filter((e) => e.type === 'move').map((e) => [e.from, e.to, e.count]), [[src, dst, 1]]);
  }
  // Alle Ereignisse laufen strikt nacheinander, nie gleichzeitig (auch Zugwechsel und Aufbau)
  const evs = g.eventsSince(0);
  for (let i = 1; i < evs.length; i++) assert.ok(evs[i].at >= evs[i - 1].at + evs[i - 1].dur, `${evs[i - 1].type} vor ${evs[i].type}`);
});

test('Animation: kürzen und abschalten über die Einstellungen; Aufbau hält niemanden auf', () => {
  const normal = session({}, 's');
  finishSetup(normal);
  assert.equal(normal.view('board').animUntil, 0, 'Startarmeen setzen blockiert die Handys nicht');
  assert.ok(normal.eventsSince(0).length >= 3, 'trotzdem Ereignisse für den Fernseher');

  const kurz = session({ animation: 'kurz' }, 's');
  const aus = session({ animation: 'aus' }, 's');
  for (const g of [kurz, aus]) {
    finishSetup(g);
    const a = g.currentPlayer().id;
    g.handleAction(a, { type: 'place', territory: g.territoriesOf(a)[0], count: g.turn.reinforcements });
  }
  const dur = (g) => g.eventsSince(0).filter((e) => e.type === 'place').pop().dur;
  assert.equal(dur(kurz), 700, 'kurz = die früheren Zeiten');
  assert.equal(dur(aus), 0);
  assert.ok(aus.view('board').animUntil <= Date.now(), 'ohne Animation wartet niemand');
});

test('Animation: Ereignisse gehören nicht zum gespeicherten Spielstand', () => {
  const g = session();
  finishSetup(g);
  const data = JSON.parse(JSON.stringify(g.toJSON()));
  assert.ok(!('_anim' in data) && !('timeScale' in data) && !('_tracking' in data));
  const copy = risiko.restoreGame(data, { rng: createRng('weiter'), timeScale: 1 });
  assert.deepEqual(copy.view('board').anim.events, []);
  assert.deepEqual(copy.view('board').game, g.view('board').game);
});

test('Animation: Dauern je Einstellung – normal ruhiger, kurz wie früher, animUntil wartet auf alles', () => {
  const run = (animation) => {
    const g = session({ animation }, 'dauer');
    finishSetup(g);
    const a = g.currentPlayer().id;
    const from = g.territoriesOf(a).find((id) => NEIGHBORS[id].some((n) => g.territories[n].owner !== a));
    const to = NEIGHBORS[from].find((n) => g.territories[n].owner !== a);
    g.handleAction(a, { type: 'place', territory: from, count: g.turn.reinforcements });
    g.territories[from].armies = 10;
    g.territories[to].armies = 1;
    // 6-6-6 gegen 1: ein Vergleichspaar, Eroberung, Nachrücken
    g.forcedDice.push(6, 6, 6, 1);
    const seq = g.animState.seq;
    g.handleAction(a, { type: 'attack', from, to });
    if (g.phase === 'defend') g.handleAction(g.waitingFor(), { type: 'defend' });
    g.handleAction(a, { type: 'occupy', count: g.turn.occupy.max });
    const evs = g.eventsSince(seq);
    return { g, evs, byType: (t) => evs.find((e) => e.type === t) };
  };

  const kurz = run('kurz');
  assert.equal(kurz.byType('battle').dur, 2600, 'kurz: Kampf wie früher 2,6 s');
  assert.equal(kurz.byType('conquer').dur, 1500);
  assert.equal(kurz.byType('move').dur, 900);

  const normal = run('normal');
  const battle = normal.byType('battle');
  assert.deepEqual(battle.steps, risiko.BATTLE_STEPS.normal);
  assert.equal(battle.steps.roll, 2500, 'Würfel rollen rund 2,5 s');
  assert.equal(battle.steps.pair, 1200, 'jedes Vergleichspaar steht rund 1,2 s');
  const st = battle.steps;
  assert.equal(battle.dur, st.wait + st.arrow + st.roll + st.pair + st.settle + st.fade);
  for (const t of ['conquer', 'move']) {
    const ratio = normal.byType(t).dur / kurz.byType(t).dur;
    assert.ok(ratio >= 1.4 && ratio <= 1.6, `${t} etwa anderthalbmal so lang (${ratio})`);
  }
  assert.ok(battle.dur / kurz.byType('battle').dur > 1.6, 'beim Kampf deutlich mehr');
  // Zwei Paare: jedes weitere Paar verlängert den Kampf um seine Standzeit
  const g2 = session({ animation: 'normal' }, 'dauer2');
  finishSetup(g2);
  const a2 = g2.currentPlayer().id;
  const f2 = g2.territoriesOf(a2).find((id) => NEIGHBORS[id].some((n) => g2.territories[n].owner !== a2));
  const t2 = NEIGHBORS[f2].find((n) => g2.territories[n].owner !== a2);
  g2.handleAction(a2, { type: 'place', territory: f2, count: g2.turn.reinforcements });
  g2.territories[f2].armies = 10;
  g2.territories[t2].armies = 5;
  g2.forcedDice.push(6, 5, 4, 3, 2);
  const s2 = g2.animState.seq;
  g2.handleAction(a2, { type: 'attack', from: f2, to: t2 });
  g2.handleAction(g2.waitingFor(), { type: 'defend', dice: 2 });
  assert.equal(g2.eventsSince(s2).find((e) => e.type === 'battle').dur, battle.dur + 1200);

  // Die Handys warten, bis die letzte Animation des Fernsehers vorbei ist
  const last = normal.evs[normal.evs.length - 1];
  assert.equal(normal.g.view('player', normal.g.currentPlayer().id).animUntil, last.at + last.dur);
  assert.ok(normal.g.view('board').animUntil - kurz.g.view('board').animUntil > 2000, 'normal hält die Handys länger auf');
});

test('Animation: Standard ist „normal“', () => {
  assert.equal(risiko.defaultSettings().animation, 'normal');
  const g = risiko.createGame({ players: PLAYERS, settings: risiko.defaultSettings(), rng: createRng('std') });
  assert.equal(g.settings.animation, 'normal');
});
