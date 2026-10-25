'use strict';

/* =========================================================
 *  Risiko als Spielmodul (Schnittstelle siehe server/games/index.js).
 *  Noch ohne Oberfläche: Engine, Karte und Tests.
 * ========================================================= */

const { RisikoGame, RuleError, MIN_PLAYERS, MAX_PLAYERS, DEFAULT_SETTINGS, SETTING_OPTIONS } = require('./rules');
const { MAP_VIEW } = require('./map');

const SETTING_ERRORS = {
  cardValues: 'Kartenwerte: bitte „steigend“ oder „fest“ wählen.',
  fortify: 'Verschieben: bitte „benachbart“ oder „verbunden“ wählen.',
};

/** Partie mit Snapshots pro Rolle und Spieler. */
class RisikoSession extends RisikoGame {
  view(role, playerId = null) {
    return {
      map: MAP_VIEW,
      game: this.publicState(role === 'player' ? playerId : null),
    };
  }
}

module.exports = {
  id: 'risiko',
  name: 'Risiko',
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,

  defaultSettings() { return { ...DEFAULT_SETTINGS }; },

  applySettings(settings, patch = {}) {
    const next = { ...settings };
    for (const [key, options] of Object.entries(SETTING_OPTIONS)) {
      if (!(key in patch)) continue;
      if (!options.includes(patch[key])) throw new RuleError(SETTING_ERRORS[key]);
      next[key] = patch[key];
    }
    return next;
  },

  createGame({ players, settings, rng, forcedDice = [] }) {
    return new RisikoSession({ players, settings, rng, forcedDice: forcedDice.flat().map(Number) });
  },

  restoreGame(data, { rng }) {
    return RisikoSession.fromJSON(data, { rng });
  },

  RisikoSession,
};
