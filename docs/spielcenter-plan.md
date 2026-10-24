# Spielcenter – Plan

Ziel: Aus dem Monopoly-Abend wird ein Spielcenter mit mehreren Spielen.
- Ein großer Bildschirm (Laptop am TV oder Tablet) ist die Host-Ansicht, Handys sind die Controller.
- Gehostet wird auf Render.

## Aktueller Stand

- **Monopoly** nach den Regeln der deutschen Standardausgabe, 2–10 Spieler, vollständig auf dem Server (`server/monopoly/rules.js`):
  - Kaufen und Versteigern, Miete, Bauen mit dem Häuserlimit der Bank, Hypothek
  - Gefängnis, Pasch, je 16 Ereignis- und Gemeinschaftskarten
  - Handel, Schulden und Pleite, Aufgeben, „Zug beenden“ durch den Spieler
- **Minispiele** in Monopoly, ausgelöst durch die Würfelsumme: Pferderennen (7), Roulette (8, 12), Blackjack (2, 6). Gesetzt wird mit dem Monopoly-Konto.
- **Räume:**
  - 4-Buchstaben-Code mit QR-Beitritt
  - Wiederverbindung per Token; getrennte Spieler können ihren Platz zurückholen
  - Pause, solange der Spieler am Zug getrennt ist; Ausscheiden erst nach 5 Minuten Blockade
- **Host-Ansicht:** für Tablet (1024×768) und 16:9-TV. Minispiele laufen im Vollbild.
- **Technik:**
  - Node.js ≥ 20, Express 5, Socket.IO 4, qrcode
  - Vanilla-JS-Clients ohne Build-Schritt
  - Zustand im Arbeitsspeicher; mit `DATABASE_URL` zusätzlich in Postgres (Neon), siehe Betrieb
- **Deployment:** `render.yaml` als Web Service im Free-Plan; Build mit `npm install --omit=dev`, Start mit `npm start`, Healthcheck `/healthz`.
- **Tests:** 63 Tests (`npm test`): Regel- und Minispiel-Tests, Playwright-Durchläufe mit 1 Host-Ansicht und 3 Handys sowie 2 Datenbank-Tests, die nur mit `DATABASE_URL` laufen.
- **Aufräumarbeiten:** `package-lock.json` liegt im Repo. Die alte Pferderennen-Einzelversion liegt in `legacy/`.

## Entscheidungen

1. **Eigenes Guthaben pro Spiel.** Jedes Spiel verwaltet sein eigenes Geld bzw. seine eigenen Chips. Es gibt kein gemeinsames Konto über mehrere Spiele.
2. **Reihenfolge:** zuerst Monopoly (fertig), dann Risiko, dann Poker.
3. **Server ist die einzige Instanz** für Spielzustand und Zufall. Clients zeigen nur Snapshots, versteckte Information wird pro Spieler gefiltert (siehe `CLAUDE.md`).
4. **Gleiche Grundlage für alle Spiele:** Räume, Beitritt, QR-Code und Wiederverbindung werden geteilt; Hosting auf Render bleibt.

## Offene Punkte

> Hinweis: Die Projektwissensdatei lag beim Anlegen dieses Dokuments nicht vor. Die Punkte stammen aus der Projektanalyse vom Oktober 2026 – bitte mit der Projektwissensdatei abgleichen.

### Architektur
- `server/rooms.js` ist fest an Monopoly gekoppelt: `Room.game` ist ein `MonopolyGame`, `act()` ist ein Monopoly-`switch`, und Animations-Timing, Auto-Würfeln und Pause hängen an Monopoly-Phasen. Für weitere Spiele braucht es eine gemeinsame Schnittstelle für Spielmodule, zum Beispiel `create`, `handleAction`, `view(spieler)`, Timer und Ende.
- Snapshots gehen heute an alle Handys gleich, gefiltert wird nur nach Rolle. Für Poker (Handkarten) und Risiko (verdeckte Karten) muss es einen eigenen Snapshot pro Spieler bzw. Socket geben.
- Die Frontends `public/board/board.js` und `public/play/play.js` sind große Einzeldateien mit Monopoly- und Minispiel-Ansichten. Für mehrere Spiele sollten sie pro Spiel aufgeteilt werden; dazu kommt eine gemeinsame Hülle für Lobby, Kopfzeile und Verbindung.
- Animationszeiten sind zwischen Server (`TIMING`, Konstanten der Minispiele) und Clients verteilt.
- Es braucht eine Spielauswahl in der Lobby der Host-Ansicht.

### Betrieb
- Persistenz (Branch `feature/persistenz`): Mit `DATABASE_URL` werden Räume in Postgres (Neon) gespeichert und beim Start geladen.
  - Neon ist angebunden: `neon deploy` legt `DATABASE_URL` in `.env.local` ab.
  - Die Datenbank-Tests (`test/db.test.js`) sind gegen den Neon-Test-Branch grün (lokaler Lauf).
  - Die Browser-Tests (Playwright) wurden dabei nicht lokal ausgeführt. Grün sind sie bisher nur im Cloud-Container, dort ohne Datenbank, weil der Container Neon nicht direkt erreicht.
  - Offen: Ein unterbrochenes Minispiel startet nach einem Neustart neu.
- Nur eine Server-Instanz möglich, weil Socket.IO keinen gemeinsamen Adapter (z. B. Redis) nutzt.
- Keine Authentifizierung: Wer den Raumcode kennt, kann die Host-Ansicht öffnen und starten. Getrennte Plätze lassen sich übernehmen.

### Noch zu klären
- Render: Welcher Branch ist verbunden, ist `PUBLIC_URL` gesetzt, welche Node-Version läuft, bleibt es beim Free-Plan?
- Wird `main` künftig der Branch, den Render beobachtet?
- Verhalten auf echten Handys (iOS Safari, Android) über längere Zeit, z. B. Displaysperre und Netzwechsel. Getestet ist nur headless Chromium.
- Last mit 10 Spielern auf dem Free-Plan.
- Regeln und Umfang für Risiko und Poker: Varianten, Spielerzahl, Spieldauer, Minispiele ja oder nein.

### Bekannte Regelvereinfachungen in Monopoly
- Keine 10 % Zinsen auf übernommene Hypotheken.
- Automatische Pleite, wenn auch der Verkauf aller Häuser und Hypotheken nicht reicht.
- Die Zugreihenfolge entspricht der Beitrittsreihenfolge.
- Minispiele starten bei jeder passenden Würfelsumme, auch im Gefängnis.
