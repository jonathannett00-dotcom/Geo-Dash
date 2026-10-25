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
- **Tests:** 68 Tests (`npm test`): Regel- und Minispiel-Tests, Playwright-Durchläufe mit 1 Host-Ansicht und 3 Handys, Tests der Weckseite sowie 2 Datenbank-Tests, die nur mit `DATABASE_URL` laufen.
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
- Persistenz (Branch `feature/persistenz`) ist implementiert: Mit `DATABASE_URL` werden Räume in Postgres (Neon) gespeichert und beim Start geladen.
  - Neon ist angebunden: `neon deploy` legt `DATABASE_URL` in `.env.local` ab.
  - Die Datenbank-Tests (`test/db.test.js`) sind lokal gegen den Neon-Branch `test` grün: 2 bestanden, 0 fehlgeschlagen, 0 übersprungen.
  - Die Browser-Tests (`e2e`, `lobby.e2e`, `legacy.e2e`) wurden dabei nicht ausgeführt.
  - Offen: Ein unterbrochenes Minispiel startet nach einem Neustart neu.
- Weckseite (`wake/`) für den Link an Freunde, siehe unten.
- Nur eine Server-Instanz möglich, weil Socket.IO keinen gemeinsamen Adapter (z. B. Redis) nutzt.
- Keine Authentifizierung: Wer den Raumcode kennt, kann die Host-Ansicht öffnen und starten. Getrennte Plätze lassen sich übernehmen.

### Weckseite auf Netlify veröffentlichen
Render legt den kostenlosen Dienst nach etwa 15 Minuten schlafen. Die statische Weckseite in `wake/` weckt ihn auf und leitet weiter, sobald `/healthz` mit `ok: true` antwortet. Sie ist der Link, den man an Freunde schickt.
1. Auf [app.netlify.com/drop](https://app.netlify.com/drop) den Ordner `wake/` hineinziehen. Das legt eine **neue Seite** an. Nicht in das bestehende Projekt `poolgames69` hochladen.
2. Die Adresse der neuen Seite notieren, z. B. `https://name.netlify.app`. Unter *Site configuration* lässt sich der Name ändern.
3. Bei Render im Dienst `monopoly-abend` unter *Environment* die Variable `WAKE_ORIGIN` auf genau diese Adresse setzen: mit `https://`, ohne Pfad und ohne Schrägstrich am Ende. Danach neu deployen.
   - Erst damit darf die Weckseite den Status von `/healthz` lesen. Der Server erlaubt nur genau diese Origin, ohne Stern.
   - Ohne `WAKE_ORIGIN` funktioniert die Seite trotzdem über einen ungenauen Rückfall (Anfrage im no-cors-Modus). Sie leitet dann schon weiter, sobald Render irgendetwas antwortet, notfalls auf Renders eigene Warteseite.
4. Ändert sich die Render-Adresse, nur die Konstante `SERVER` oben in `wake/wake.js` anpassen und den Ordner erneut hochladen (bei Netlify unter *Deploys* per Drag-and-drop).

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
