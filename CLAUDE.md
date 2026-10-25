# CLAUDE.md

Spielcenter für den Spieleabend: Ein großer Bildschirm (Tablet oder TV) zeigt das Spiel, jeder Spieler steuert per Handy. Heute läuft Monopoly mit den Minispielen Pferderennen, Roulette und Blackjack. Risiko und Poker folgen (siehe `docs/spielcenter-plan.md`).

## Architektur

- **Der Server ist die einzige Instanz für Spielzustand und Zufall.** Würfel, Karten, Mischen, Rennsimulation, Roulette-Zahl: alles entsteht auf dem Server (`server/rng.js`). Clients senden nur Absichten (`act` mit `{ type, … }`). Der Server prüft jede Aktion (Zug, Phase, Geld) und lehnt mit einer verständlichen deutschen Meldung ab.
- **Clients zeigen nur Snapshots.** Der Server schickt nach jeder Änderung den vollständigen Zustand (`state`-Event). Host-Ansicht (`public/board/`) und Handy (`public/play/`) berechnen keine Ergebnisse, sie stellen nur dar und animieren.
- **Versteckte Information wird pro Spieler gefiltert.** Was ein Spieler nicht sehen darf (z. B. die verdeckte Dealerkarte, später Pokerhände oder verdeckte Risiko-Karten), verlässt den Server nicht. Die Filterung passiert beim Erzeugen des Snapshots, nicht im Client.
  - Heute filtert `view(role)` nur nach Rolle: Host-Ansicht oder Handy.
  - Für Poker und Risiko braucht es einen Snapshot pro Spieler.
- **Aufbau:**
  - `server/index.js`: HTTP und Socket.IO
  - `server/rooms.js`: Räume, Beitritt, Wiederverbindung, Timer, Ablauf
  - `server/monopoly/`: Regel-Engine und Spieldaten
  - `server/games/`: Minispiele mit `wallet`-Interface
  - `server/db.js`: Postgres-Speicher (Neon). Mit `DATABASE_URL` wird jeder Raum nach Änderungen als JSONB gespeichert und beim Start wieder geladen; ohne `DATABASE_URL` liegt alles nur im Arbeitsspeicher. Während eines Minispiels wird nicht gespeichert.

## Regeln für Änderungen

- Alle Texte für Spieler sind **auf Deutsch**: UI, Fehlermeldungen, Ticker, README.
- **`npm test` muss vor jedem Commit grün sein.**
- **Ein Feature pro Branch.**
- **Keine neuen Abhängigkeiten ohne Rückfrage.**
  - Laufzeit: nur `express`, `socket.io`, `qrcode`, `pg`.
  - Entwicklung: nur `playwright` sowie `@neon/config` und `@neon/env` (für die Neon-CLI und `neon.ts`).
  - `package-lock.json` liegt im Repo und wird mit `npm install` aktualisiert.
- `legacy/` enthält die alte Pferderennen-Einzelversion. Sie bleibt unverändert; neuer Code verweist nicht darauf.

## Befehle

- `npm start`: startet den Server auf `PORT` (Standard 3000). Host-Ansicht unter `/board`, Handy unter `/play`.
- `npm test`: Unit-Tests (`node:test`) und Playwright-Browser-Tests.
  - Chromium kommt aus `CHROMIUM_PATH`, Standard `/opt/pw-browsers/chromium`.
  - `E2E_SCREEN=1920x1080` prüft den Durchlauf in TV-Auflösung.
  - `E2E_SHOTS=<ordner>` speichert Bildschirmfotos.
  - Mit `DATABASE_URL` laufen zusätzlich die Datenbank-Tests (`test/db.test.js`, eigene Wegwerf-Tabelle), ohne werden sie übersprungen: `node --env-file=.env.local --test --test-concurrency=1 test/*.test.js`.
- Zugangsdaten stehen nur in `.env` / `.env.local` (in `.gitignore`). Die Verbindungs-URL nie ausgeben, loggen oder committen.
