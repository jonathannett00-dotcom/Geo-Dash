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
const { MAP_VIEW, NEIGHBORS, isNeighbor } = require('./map');

const SETTING_ERRORS = {
  cardValues: 'Kartenwerte: bitte „steigend“ oder „fest“ wählen.',
  fortify: 'Verschieben: bitte „benachbart“ oder „verbunden“ wählen.',
  animation: 'Animationen: bitte „normal“, „kurz“ oder „aus“ wählen.',
};
/** Einstellungen der Darstellung (nicht Teil der Regeln). */
const VIEW_OPTIONS = { animation: ['normal', 'kurz', 'aus'] };
const OPTIONS = { ...SETTING_OPTIONS, ...VIEW_OPTIONS };

/** Dauer der Animationen in ms bei „normal“. */
const ANIM_MS = { place: 700, battle: 2600, conquer: 1500, move: 900, trade: 600, turn: 1600 };
/** Nur Anzeige (Ton, Banner): laufen nach den übrigen Animationen, ohne die Handys aufzuhalten. */
const AFTER = new Set(['trade', 'turn']);
const ANIM_FACTOR = { normal: 1, kurz: 0.45, aus: 0 };
const ANIM_KEEP = 30;

/** Partie mit Snapshots pro Rolle und Spieler und Ereignissen für die Animationen. */
class RisikoSession extends RisikoGame {
  get animState() {
    if (!this._anim) Object.defineProperty(this, '_anim', { value: { seq: 0, until: 0, events: [] }, writable: true, enumerable: false });
    return this._anim;
  }

  handleAction(pid, action = {}) {
    // Vorauswahl am Handy: nur Anzeige auf dem Fernseher, ändert nichts am Spiel
    if (action.type === 'preview') return this.setPreview(pid, action);
    return this.track(action.type, () => super.handleAction(pid, action));
  }

  removePlayer(pid, reason) {
    this.onDisconnect(pid);
    return this.track('remove', () => super.removePlayer(pid, reason));
  }

  /* ---------- Vorauswahl (Von/Nach am Handy → Fernseher) ---------- */

  /** Merkt die Vorauswahl des Spielers am Zug; ungültige werden verworfen (ohne Fehlermeldung). */
  setPreview(pid, { mode, from, to } = {}) {
    const preview = from ? { playerId: pid, mode, from: String(from), to: to ? String(to) : null, turn: this.turn } : null;
    const ok = preview && this.previewTargets(preview) !== null;
    Object.defineProperty(this, '_preview', { value: ok ? preview : null, writable: true, configurable: true, enumerable: false });
    return { preview: Boolean(ok) };
  }

  /** Ziele zur Vorauswahl (angreifbare bzw. erreichbare Gebiete) oder null, wenn sie nicht (mehr) gilt. */
  previewTargets({ playerId, mode, from, to, turn }) {
    const p = this.players.find((x) => x.id === playerId);
    const src = this.territories[from];
    if (!p || p.eliminated || this.phase === 'setup' || this.phase === 'gameover') return null;
    if (turn !== this.turn || this.currentPlayer().id !== playerId || !src || src.owner !== playerId) return null;
    if (mode === 'place') return this.phase === 'reinforce' && !to ? [] : null;
    if (src.armies < 2) return null;
    if (mode === 'attack') {
      if (this.phase !== 'attack') return null;
      const targets = NEIGHBORS[from].filter((n) => this.territories[n].owner !== playerId);
      return !to || targets.includes(to) ? targets : null;
    }
    if (mode === 'fortify') {
      if (this.phase !== 'attack' && this.phase !== 'fortify') return null;
      const targets = this.settings.fortify === 'verbunden'
        ? this.territoriesOf(playerId).filter((id) => id !== from && this.connected(playerId, from, id))
        : NEIGHBORS[from].filter((n) => this.territories[n].owner === playerId);
      return !to || (targets.includes(to) && (this.settings.fortify === 'verbunden' || isNeighbor(from, to))) ? targets : null;
    }
    return null;
  }

  /** Gültige Vorauswahl für die Host-Ansicht – verfällt mit dem Zug, einer Eroberung oder ungültigen Gebieten. */
  currentPreview() {
    const p = this._preview;
    if (!p) return null;
    const targets = this.previewTargets(p);
    if (targets === null) { this._preview = null; return null; }
    return { playerId: p.playerId, mode: p.mode, from: p.from, to: p.to, targets };
  }

  /** Verbindung des Spielers abgebrochen: seine Vorauswahl verfällt. */
  onDisconnect(pid) {
    if (this._preview && this._preview.playerId === pid) this._preview = null;
  }

  /* ---------- Phasenanzeige ---------- */

  /** Kurze Texte zur Phase für Banner (Fernseher) und Kopfzeile (Handy). */
  statusInfo() {
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const cur = this.phase === 'setup' || this.phase === 'gameover' ? null : this.currentPlayer();
    const name = cur ? cur.name : '';
    const base = { phase: this.phase, playerId: cur ? cur.id : null, round: this.round };
    switch (this.phase) {
      case 'setup': {
        const open = this.players.filter((p) => !p.eliminated && p.remaining > 0);
        return { ...base, title: 'Aufbau', text: 'Aufbau', detail: open.length ? `Startarmeen setzen: noch ${open.map((p) => `${p.name} (${p.remaining})`).join(', ')}` : '' };
      }
      case 'reinforce': {
        const n = this.turn.reinforcements;
        return { ...base, title: 'Verstärken', text: `${name} verstärkt`, remaining: n, detail: n ? `Noch ${plural(n, 'Armee', 'Armeen')} zu setzen` : 'Karten tauschen' };
      }
      case 'attack': return { ...base, title: 'Angreifen', text: `${name} greift an`, detail: '' };
      case 'defend': {
        const def = this.turn.pendingAttack.defenderId;
        const defName = def === 'neutral' ? 'Neutral' : this.player(def).name;
        return { ...base, title: 'Angreifen', text: `${name} greift an`, detail: `${defName} verteidigt`, defenderId: def };
      }
      case 'occupy': return { ...base, title: 'Nachrücken', text: `${name} rückt nach`, detail: '' };
      case 'fortify': return { ...base, title: 'Verschieben', text: `${name} verschiebt`, detail: 'einmal, danach endet der Zug' };
      case 'gameover': {
        const w = this.winner ? this.players.find((p) => p.id === this.winner) : null;
        return { ...base, title: 'Spielende', text: w ? `${w.name} erobert die Welt` : 'Das Spiel ist vorbei', detail: '' };
      }
      default: return { ...base, title: '', text: '', detail: '' };
    }
  }

  /** Aktion ausführen und aus dem Unterschied vorher/nachher Ereignisse ableiten. */
  track(type, fn) {
    if (this._tracking) return fn();
    const before = {
      phase: this.phase,
      territories: Object.fromEntries(Object.entries(this.territories).map(([id, t]) => [id, { ...t }])),
      battleSeq: this.lastBattle ? this.lastBattle.seq : 0,
      tradeSeq: this.lastTrade ? this.lastTrade.seq : 0,
      turn: this.turn,
      round: this.round,
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
    const tr = this.lastTrade;
    if (tr && tr.seq !== before.tradeSeq) events.push({ type: 'trade', playerId: tr.playerId, value: tr.value, bonusTerritory: tr.bonusTerritory });
    // Verstärkung (Setzen, Kartenbonus): Armeen wachsen ohne Besitzerwechsel
    for (const [id, t] of Object.entries(after)) {
      const old = before.territories[id];
      if (!touched.has(id) && t.owner === old.owner && t.armies > old.armies) {
        events.push({ type: 'place', territory: id, from: old.armies, to: t.armies, owner: t.owner });
      }
    }
    // Neuer Zug (und ggf. neue Runde) – für Banner und Ton
    if (this.turn && this.turn !== before.turn && this.phase !== 'gameover') {
      events.push({ type: 'turn', playerId: this.turn.playerId, round: this.round, newRound: this.round > before.round });
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
      const after = AFTER.has(e.type);
      const start = after ? Math.max(now, cursor) : blocking ? cursor : now;
      anim.events.push({ ...e, seq: anim.seq, at: start, dur });
      if (blocking && !after) cursor = start + dur;
    }
    if (blocking) anim.until = cursor;
    if (anim.events.length > ANIM_KEEP) anim.events.splice(0, anim.events.length - ANIM_KEEP);
  }

  /** Animations-Ereignisse seit einer Sequenznummer (für Tests und die Host-Ansicht). */
  eventsSince(seq = 0) { return this.animState.events.filter((e) => e.seq > seq); }

  view(role, playerId = null) {
    const anim = this.animState;
    const out = {
      map: MAP_VIEW,
      game: this.publicState(role === 'player' ? playerId : null),
      status: this.statusInfo(),
      animUntil: anim.until,
      anim: { seq: anim.seq, events: anim.events },
    };
    // Die Vorauswahl sieht nur der Fernseher, nicht die anderen Handys
    if (role === 'board') out.preview = this.currentPreview();
    return out;
  }

  toJSON() {
    const data = super.toJSON();
    delete data.timeScale;
    delete data._tracking;
    delete data._preview;
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
