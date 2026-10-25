'use strict';

/* =========================================================
 *  Spielmodule des Spielcenters.
 *
 *  Ein Modul beschreibt ein Spiel und erzeugt Partien:
 *    id, name, minPlayers, maxPlayers
 *    defaultSettings()                  → Einstellungen der Lobby
 *    applySettings(settings, patch)     → geprüfte neue Einstellungen (wirft RuleError)
 *    createGame({ players, settings, rng, timeScale, onChange })
 *    restoreGame(data, { rng, timeScale, onChange })
 *
 *  Eine Partie (Rückgabe von createGame) bietet:
 *    handleAction(playerId, action)     Absicht eines Spielers prüfen und ausführen
 *    view(role, playerId)               Snapshot für 'board' oder 'player'; versteckte
 *                                       Information wird hier pro Spieler gefiltert
 *    tick(now, { isConnected })         zeitgesteuerte Schritte ausführen; liefert die
 *                                       Wartezeit in ms bis zum nächsten Aufruf oder null
 *    isOver()                           Partie beendet?
 *    waitingFor()                       Spieler-ID, auf die das Spiel gerade wartet, sonst null
 *    removePlayer(playerId)             Spieler scheidet aus (zu lange getrennt)
 *    canSave()                          darf der Raum jetzt gespeichert werden?
 *    toJSON()                           Zustand als reine Daten
 *    dispose()                          Timer und laufende Unterspiele beenden
 *    onDisconnect(playerId)             optional: Verbindung eines Spielers abgebrochen
 *
 *  onChange() meldet Änderungen, die nicht durch handleAction oder tick
 *  entstehen (z. B. Minispiel-Timer); der Raum plant dann neu und sendet Snapshots.
 * ========================================================= */

const monopoly = require('../monopoly');
const risiko = require('./risiko');

/* Ausgewählt wird in der Lobby der Host-Ansicht (board:game). */
const GAMES = {
  [monopoly.id]: monopoly,
  [risiko.id]: risiko,
};

const DEFAULT_GAME = monopoly.id;

module.exports = { GAMES, DEFAULT_GAME };
