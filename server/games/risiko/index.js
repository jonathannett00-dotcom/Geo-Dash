'use strict';

/* =========================================================
 *  Risiko als Spielmodul (Schnittstelle siehe server/games/index.js).
 *
 *  Animationen: Nach jeder Aktion vergleicht die Partie den Zustand der
 *  Engine vorher und nachher und leitet daraus Ereignisse ab (Verstärkung,
 *  Kampf, Eroberung, Verschieben). Jedes Ereignis hat Startzeit und Dauer;
 *  daraus ergibt sich animUntil – wie bei Monopoly warten die Handys, bis
 *  der Fernseher fertig ist. Die Engine (rules.js) bleibt unverändert.
 * ========================================================= */

const { RisikoGame, RuleError, MIN_PLAYERS, MAX_PLAYERS, DEFAULT_SETTINGS, SETTING_OPTIONS } = require('./rules');
const { MAP_VIEW } = require('./map');

const SETTING_ERRORS = {
  cardValues: 'Kartenwerte: bitte „steigend“ oder „fest“ wählen.',
  fortify: 'Verschieben: bitte „benachbart“ oder „verbunden“ wählen.',
  animation: 'Animationen: bitte „normal“, „kurz“ oder „aus“ wählen.',
};
/** Einstellungen der Darstellung (nicht Teil der Regeln). */
const VIEW_OPTIONS = { animation: ['normal', 'kurz', 'aus'] };
const OPTIONS = { ...SETTING_OPTIONS, ...VIEW_OPTIONS };

/** Dauer der Animationen in ms bei „normal“. */
const ANIM_MS = { place: 700, battle: 1900, conquer: 1500, move: 900 };
const ANIM_FACTOR = { normal: 1, kurz: 0.45, aus: 0 };
const ANIM_KEEP = 30;

/** Partie mit Snapshots pro Rolle und Spieler und Ereignissen für die Animationen. */
class RisikoSession extends RisikoGame {
  get animState() {
    if (!this._anim) Object.defineProperty(this, '_anim', { value: { seq: 0, until: 0, events: [] }, writable: true, enumerable: false });
    return this._anim;
  }

  handleAction(pid, action = {}) { return this.track(action.type, () => super.handleAction(pid, action)); }

  removePlayer(pid, reason) { return this.track('remove', () => super.removePlayer(pid, reason)); }

  /** Aktion ausführen und aus dem Unterschied vorher/nachher Ereignisse ableiten. */
  track(type, fn) {
    if (this._tracking) return fn();
    const before = {
      phase: this.phase,
      territories: Object.fromEntries(Object.entries(this.territories).map(([id, t]) => [id, { ...t }])),
      battleSeq: this.lastBattle ? this.lastBattle.seq : 0,
      occupy: this.turn && this.turn.occupy ? { ...this.turn.occupy } : null,
    };
    this._tracking = true;
    try {
      return fn();
    } finally {
      this._tracking = false;
      this.emitEvents(type, before);
    }
  }

  emitEvents(type, before) {
    const now = this.now();
    const after = this.territories;
    const events = [];
    const touched = new Set();
    const b = this.lastBattle;
    if (b && b.seq !== before.battleSeq) {
      events.push({
        type: 'battle', from: b.from, to: b.to, attackerId: b.attackerId, defenderId: b.defenderId,
        attack: b.attack, defend: b.defend, attackerLosses: b.attackerLosses, defenderLosses: b.defenderLosses,
        attackerArmies: before.territories[b.from].armies, defenderArmies: before.territories[b.to].armies, conquered: b.conquered,
      });
      touched.add(b.from).add(b.to);
      if (b.conquered) {
        // Für die Hervorhebung: das Gebiet wechselt in die Farbe des neuen Besitzers
        events.push({ type: 'conquer', territory: b.to, owner: after[b.to].owner, previous: b.defenderId });
        // Ohne Wahlmöglichkeit rückt die Engine sofort nach
        if (after[b.to].armies > 0) events.push({ type: 'move', from: b.from, to: b.to, count: after[b.to].armies });
      }
    }
    if (type === 'occupy' && before.occupy) {
      const { from, to } = before.occupy;
      events.push({ type: 'move', from, to, count: after[to].armies - before.territories[to].armies });
      touched.add(from).add(to);
    }
    if (type === 'fortify') {
      for (const [id, t] of Object.entries(after)) {
        const diff = t.armies - before.territories[id].armies;
        if (diff > 0) {
          const from = Object.keys(after).find((o) => after[o].armies < before.territories[o].armies && after[o].owner === t.owner);
          if (from) { events.push({ type: 'move', from, to: id, count: diff }); touched.add(from).add(id); }
        }
      }
    }
    // Verstärkung (Setzen, Kartenbonus): Armeen wachsen ohne Besitzerwechsel
    for (const [id, t] of Object.entries(after)) {
      const old = before.territories[id];
      if (!touched.has(id) && t.owner === old.owner && t.armies > old.armies) {
        events.push({ type: 'place', territory: id, from: old.armies, to: t.armies, owner: t.owner });
      }
    }
    if (!events.length) return;

    const anim = this.animState;
    const factor = (ANIM_FACTOR[this.settings.animation] ?? 1) * (this.timeScale ?? 1);
    // Im Aufbau setzen alle gleichzeitig: Das läuft parallel und hält niemanden auf
    const blocking = before.phase !== 'setup';
    let cursor = Math.max(now, anim.until);
    for (const e of events) {
      const dur = Math.round(ANIM_MS[e.type] * factor);
      anim.seq += 1;
      const start = blocking ? cursor : now;
      anim.events.push({ ...e, seq: anim.seq, at: start, dur });
      if (blocking) cursor = start + dur;
    }
    if (blocking) anim.until = cursor;
    if (anim.events.length > ANIM_KEEP) anim.events.splice(0, anim.events.length - ANIM_KEEP);
  }

  /** Animations-Ereignisse seit einer Sequenznummer (für Tests und die Host-Ansicht). */
  eventsSince(seq = 0) { return this.animState.events.filter((e) => e.seq > seq); }

  view(role, playerId = null) {
    const anim = this.animState;
    return {
      map: MAP_VIEW,
      game: this.publicState(role === 'player' ? playerId : null),
      animUntil: anim.until,
      anim: { seq: anim.seq, events: anim.events },
    };
  }

  toJSON() {
    const data = super.toJSON();
    delete data.timeScale;
    delete data._tracking;
    return data;
  }
}

module.exports = {
  id: 'risiko',
  name: 'Risiko',
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,

  defaultSettings() { return { ...DEFAULT_SETTINGS, animation: 'normal' }; },

  applySettings(settings, patch = {}) {
    const next = { ...settings };
    for (const [key, options] of Object.entries(OPTIONS)) {
      if (!(key in patch)) continue;
      if (!options.includes(patch[key])) throw new RuleError(SETTING_ERRORS[key]);
      next[key] = patch[key];
    }
    return next;
  },

  createGame({ players, settings, rng, timeScale = 1, forcedDice = [] }) {
    const game = new RisikoSession({ players, settings, rng, forcedDice: forcedDice.flat().map(Number) });
    game.timeScale = timeScale;
    return game;
  },

  restoreGame(data, { rng, timeScale = 1 }) {
    const game = RisikoSession.fromJSON(data, { rng });
    game.timeScale = timeScale;
    return game;
  },

  RisikoSession,
  ANIM_MS,
};
