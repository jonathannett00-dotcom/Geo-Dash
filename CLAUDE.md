# CLAUDE.md

Spielcenter für den Spieleabend: Ein großer Bildschirm (Tablet oder TV) zeigt das Spiel, jeder Spieler steuert per Handy. Heute laufen Monopoly (mit den Minispielen Pferderennen, Roulette und Blackjack), Risiko und Poker (Texas Hold'em, Cash-Game); das Spiel wird in der Lobby der Host-Ansicht gewählt (siehe `docs/spielcenter-plan.md`).

## Architektur

- **Der Server ist die einzige Instanz für Spielzustand und Zufall.** Würfel, Karten, Mischen, Rennsimulation, Roulette-Zahl: alles entsteht auf dem Server (`server/rng.js`). Clients senden nur Absichten (`act` mit `{ type, … }`). Der Server prüft jede Aktion (Zug, Phase, Geld) und lehnt mit einer verständlichen deutschen Meldung ab.
- **Clients zeigen nur Snapshots.** Der Server schickt nach jeder Änderung den vollständigen Zustand (`state`-Event). Host-Ansicht (`public/board/`) und Handy (`public/play/`) berechnen keine Ergebnisse, sie stellen nur dar und animieren.
- **Versteckte Information wird pro Spieler gefiltert.** Was ein Spieler nicht sehen darf (z. B. die verdeckte Dealerkarte, Risiko-Handkarten, Pokerhände), verlässt den Server nicht. Die Filterung passiert beim Erzeugen des Snapshots, nicht im Client.
  - Poker: Das Handy bekommt nur die eigenen zwei Karten, der Fernseher nur Gemeinschaftskarten und am Showdown aufgedeckte Hände. Kartenstapel, gefoldete und verdeckt weggeworfene Karten bleiben auf dem Server (der Stapel wird mit gespeichert).
  - Jede Partie liefert `view(role, playerId)`; der Raum schickt jedem Handy einen eigenen Snapshot.
- **Aufbau:**
  - `server/index.js`: HTTP und Socket.IO
  - `server/rooms.js`: Räume, Beitritt, Wiederverbindung, Timer; spielunabhängig
  - `server/games/index.js`: gemeinsame Spiel-Schnittstelle (`createGame`, `handleAction`, `view`, `tick`, `isOver` …) und Liste der Spielmodule
  - `server/monopoly/`: Regel-Engine, Spieldaten und Spielmodul (`index.js`)
  - `server/games/risiko/`: Risiko-Regel-Engine, Karte als Daten (`map.js`: Gebiete, Nachbarschaften) und Spielmodul
  - `server/games/poker/`: Texas Hold'em – `cards.js` (Karten, Mischen über `server/rng.js`), `hands.js` (Handbewertung, eigene Umsetzung), `pots.js` (Pot, Side-Pots, Split), `money.js` (Euro als ganze Cent), `rules.js` (Rundenablauf, Aktionsprüfung, Einstellungen), `index.js` (Spielmodul mit Ereignissen, Zugzeit, Snapshots, eigener Farbpalette mit 12 Farben)
  - `server/games/risiko/map-paths.js`: realistische Weltkarte (SVG-Pfade, Seen, Marker, Namen, Seewege), **erzeugt** von `scripts/build-map.js` aus Natural Earth; nicht von Hand ändern, sondern neu bauen. Die Host-Ansicht lädt sie als `/risiko/map-paths.js`.
  - Avatare: `public/shared/avatare.js` / `.css` (24 geometrische SVG-Motive plus Monogramm, eine Anzeige `avatarHtml(spieler, 'S'|'M'|'L')` für alle Ansichten; Avatar und Foto kommen aus `lobby` im Snapshot). Eigene Fotos: Zuschnitt am Handy `public/play/foto.js`, Prüfung am Dateikopf `server/foto.js` (nur WebP/JPEG, 128 × 128, höchstens 24 KB), Absicht `avatar:foto`, Auslieferung `/api/avatar/:raum/:spieler`. Fotos liegen im Raumzustand und verschwinden mit dem Raum; der Snapshot enthält nur den Verweis, nie das Bild. Das Spielerfeld `figure` (alte Emoji-Figuren) wird nur noch aus alten Spielständen gelesen.
  - Startseite `public/start/` (unter `/`), Lobby- und Beitritts-Gestaltung gemeinsam in `public/shared/lobby.css` / `lobby.js`, animierte Spiel-Hintergründe für Startseite und Lobby in `public/shared/hintergrund.js`; Raumgrenzen (20 gleichzeitig, 5 pro Minute und IP, leere Räume nach 30 Minuten weg) in `server/rooms.js`
  - Clients: Monopoly in `board.js` / `play.js`, Risiko in `public/board/risiko.js` (dazu `risiko-audio.js` für Töne) und `public/play/risiko.js`; gemeinsame Kartenfarben und -größen in `public/shared/risiko-farben.js`
  - Poker-Clients: `public/board/poker.js` (Tisch, Animationen aus den Server-Ereignissen; `poker-audio.js` für Töne), `public/play/poker.js`; Spielkarten, Chipstapel, Sitzmarken und Euro-Anzeige gemeinsam in `public/shared/poker-karten.js` / `.css`
  - `public/board/poker-layout.js`: Tischgeometrie (reine Rechnung, auch in den Unit-Tests). Kartenring, Blinds-Feld, Pot-Feld und Handname sind Sperrzonen; Plätze, Einsätze, Dealer-Button und fliegende Chips dürfen sie nie berühren. Wer am Tisch etwas ändert, lässt `test:browser` laufen (Überlappungsprüfung `poker-layout*.e2e`).
  - Spiel beenden: Jedes Spielmodul bietet `endByHost()` und `summary()` (Endstand für `final` im Snapshot, nur Anzeige). `board:end`, `board:lobby` und `board:close` nimmt der Server nur von der Host-Ansicht an; Endstand-Darstellung gemeinsam in `public/shared/endstand.js` / `.css`.
  - Host-Rechte: Beim Anlegen eines Raums (`POST /api/rooms`, `board:create`) erzeugt der Server ein Host-Token (`crypto.randomBytes(24)`, Base64url). Es liegt im Raumzustand (also auch in Postgres) und geht **nur** in der Antwort an das anlegende bzw. übernehmende Gerät (`board:create`, `POST /api/rooms`, `host:takeover`, Übergangsregel in `board:watch`); nie in Snapshots, Logs, Fehlermeldungen, Adressen oder an Handys. Jede Host-Aktion (`board:settings`, `board:game`, `board:start`, `board:end`, `board:lobby`, `board:close`, `board:foto`, im Testmodus `debug:dice`) braucht `hostToken` im Payload; geprüft zeitkonstant (`crypto.timingSafeEqual`) in `hostRoom()` in `server/rooms.js`. Neue Host-Aktionen immer über `hostRoom()` und im Client über `hostEmit()` (`public/board/board.js`).
  - Ohne gültiges Token ist die Host-Ansicht Zuschauer (`body.zuschauer`, keine Host-Knöpfe, dafür „Host übernehmen“). Das Token liegt im Browser in `localStorage` unter `spieleabend-host:<RAUMCODE>`; die Startseite legt es dort ab, bevor sie zu `/board?room=…` weiterleitet. „Host übernehmen“ (`host:takeover`, nur Host-Ansichten in Zuschauer-Rolle) klappt nur, wenn kein Host-Gerät mit gültigem Token verbunden ist, mit 15 s Toleranz nach einem Verbindungsabbruch (`HOST_GRACE_MS`, auch nach einem Neustart); sonst „Der Host ist verbunden.“ Dann gibt es ein neues Token, das alte wird ungültig (`host:revoked`). Höchstens 5 Versuche pro Minute und IP.
  - Räume nehmen bis zu 12 Spieler auf (das Spielmodul begrenzt weiter: Monopoly 10, Risiko 6, Poker 12). Ein Modul kann eigene Lobby-Farben haben (`colors`); beim Spielwechsel werden die Farben übertragen.
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
