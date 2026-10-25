# CLAUDE.md

Spielcenter für den Spieleabend: Ein großer Bildschirm (Tablet oder TV) zeigt das Spiel, jeder Spieler steuert per Handy. Heute laufen Monopoly (mit den Minispielen Pferderennen, Roulette und Blackjack) und Risiko; das Spiel wird in der Lobby der Host-Ansicht gewählt. Poker folgt (siehe `docs/spielcenter-plan.md`).

## Architektur

- **Der Server ist die einzige Instanz für Spielzustand und Zufall.** Würfel, Karten, Mischen, Rennsimulation, Roulette-Zahl: alles entsteht auf dem Server (`server/rng.js`). Clients senden nur Absichten (`act` mit `{ type, … }`). Der Server prüft jede Aktion (Zug, Phase, Geld) und lehnt mit einer verständlichen deutschen Meldung ab.
- **Clients zeigen nur Snapshots.** Der Server schickt nach jeder Änderung den vollständigen Zustand (`state`-Event). Host-Ansicht (`public/board/`) und Handy (`public/play/`) berechnen keine Ergebnisse, sie stellen nur dar und animieren.
- **Versteckte Information wird pro Spieler gefiltert.** Was ein Spieler nicht sehen darf (z. B. die verdeckte Dealerkarte, später Pokerhände oder Risiko-Handkarten), verlässt den Server nicht. Die Filterung passiert beim Erzeugen des Snapshots, nicht im Client.
  - Jede Partie liefert `view(role, playerId)`; der Raum schickt jedem Handy einen eigenen Snapshot.
- **Aufbau:**
  - `server/index.js`: HTTP und Socket.IO
  - `server/rooms.js`: Räume, Beitritt, Wiederverbindung, Timer; spielunabhängig
  - `server/games/index.js`: gemeinsame Spiel-Schnittstelle (`createGame`, `handleAction`, `view`, `tick`, `isOver` …) und Liste der Spielmodule
  - `server/monopoly/`: Regel-Engine, Spieldaten und Spielmodul (`index.js`)
  - `server/games/risiko/`: Risiko-Regel-Engine, Karte als Daten (`map.js`: Gebiete, Nachbarschaften) und Spielmodul
  - `server/games/risiko/map-paths.js`: realistische Weltkarte (SVG-Pfade, Seen, Marker, Namen, Seewege), **erzeugt** von `scripts/build-map.js` aus Natural Earth; nicht von Hand ändern, sondern neu bauen. Die Host-Ansicht lädt sie als `/risiko/map-paths.js`.
  - Startseite `public/start/` (unter `/`), Lobby- und Beitritts-Gestaltung gemeinsam in `public/shared/lobby.css` / `lobby.js`; Raumgrenzen (20 gleichzeitig, 5 pro Minute und IP, leere Räume nach 30 Minuten weg) in `server/rooms.js`
  - Clients: Monopoly in `board.js` / `play.js`, Risiko in `public/board/risiko.js` (dazu `risiko-audio.js` für Töne) und `public/play/risiko.js`; gemeinsame Kartenfarben und -größen in `public/shared/risiko-farben.js`
  - Risiko-Anzeigedaten (Vorauswahl, Phasentexte, Animations-Ereignisse) entstehen im Spielmodul `server/games/risiko/index.js`; die Vorauswahl geht nur an die Host-Ansicht. Die Statistik fürs Abschlussbild zählt die Engine nur zur Anzeige mit.
  - `server/games/*.js`: Minispiele mit `wallet`-Interface
  - `server/db.js`: Postgres-Speicher (Neon). Mit `DATABASE_URL` wird jeder Raum nach Änderungen als JSONB gespeichert und beim Start wieder geladen; ohne `DATABASE_URL` liegt alles nur im Arbeitsspeicher. Während eines Minispiels wird nicht gespeichert.

## Regeln für Änderungen

- Alle Texte für Spieler sind **auf Deutsch**: UI, Fehlermeldungen, Ticker, README.
- **`npm test` muss vor jedem Commit grün sein.** Wer Oberfläche oder Speicher ändert, lässt lokal zusätzlich `test:browser` bzw. `test:db` laufen.
- **Ein Feature pro Branch.**
- **Keine neuen Abhängigkeiten ohne Rückfrage.**
  - Laufzeit: nur `express`, `socket.io`, `qrcode`, `pg`.
  - Entwicklung: nur `playwright` sowie `@neon/config` und `@neon/env` (für die Neon-CLI und `neon.ts`).
  - Ausnahme nur für das Build-Skript der Risiko-Karte: `sane-topojson` (Natural Earth 1:50m mit Provinzen/Staaten), `topojson-client`, `polygon-clipping` (devDependencies; Render installiert sie nicht, die Laufzeit braucht nur die erzeugte Datei).
  - `package-lock.json` liegt im Repo und wird mit `npm install` aktualisiert.
- `legacy/` enthält die alte Pferderennen-Einzelversion. Sie bleibt unverändert; neuer Code verweist nicht darauf.

## Befehle

- `npm start`: startet den Server auf `PORT` (Standard 3000). Host-Ansicht unter `/board`, Handy unter `/play`.
- `npm run build:map`: baut `server/games/risiko/map-paths.js` neu (braucht die devDependencies). Das Skript prüft, dass jede Landgrenze eine Nachbarschaft aus `map.js` ist und dass alle Namen überlappungsfrei Platz finden; die erzeugte Datei wird committed.
- `npm test`: nur Unit-Tests (`node:test`), ohne Browser und ohne Datenbank. Läuft überall, auch ohne Zugangsdaten.
  - Jede Testdatei steht in genau einem Skript; neue Dateien in `package.json` eintragen (`test/testskripte.test.js` prüft das).
  - Zeitlimit 60 s pro Testdatei (`--test-timeout=60000`), auch in den beiden lokalen Skripten.
- `npm run test:browser` (nur lokal): Playwright-Browser-Tests. Ohne `CHROMIUM_PATH` oder wenn die Datei fehlt, werden sie mit „CHROMIUM_PATH fehlt (nur lokal)“ übersprungen.
  - Beispiel: `CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:browser`
  - `E2E_SCREEN=1920x1080` prüft den Durchlauf in TV-Auflösung.
  - `E2E_SHOTS=<ordner>` speichert Bildschirmfotos.
- `npm run test:db` (nur lokal): Datenbank-Tests (`test/db.test.js`, eigene Wegwerf-Tabelle) mit `DATABASE_URL` aus `.env.local`. Ohne `DATABASE_URL` werden sie mit „DATABASE_URL fehlt (nur lokal)“ übersprungen, ohne zu verbinden.
- Zugangsdaten stehen nur in `.env` / `.env.local` (in `.gitignore`). Die Verbindungs-URL nie ausgeben, loggen oder committen.
