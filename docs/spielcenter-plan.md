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
- **Risiko** (Branch `feature/risiko`): in der Lobby wählbar; Host-Ansicht mit realistischer Weltkarte (siehe unten), Handy-Controller zum Setzen, Kartentausch, Angreifen, Verteidigen, Nachrücken und Verschieben. Regel-Engine nach den klassischen Standardregeln unter `server/games/risiko/`, 2–6 Spieler.
  - Karte als Daten mit eigener schematischer Grafik: 42 Gebiete, 6 Kontinente, 83 Grenzen, Kontinentboni 5/2/5/3/7/2.
  - Aufbau: Gebiete werden zufällig verteilt (je 1 Armee), danach setzen alle gleichzeitig ihre restlichen Startarmeen (35/30/25/20; bei 2 Spielern je 40 plus neutrale Armee mit 40).
  - Verstärkung: Gebiete / 3 (mindestens 3) plus Kontinentboni.
  - Kartentausch: Infanterie, Kavallerie, Artillerie, 2 Joker; steigende Werte 4, 6, 8, 10, 12, 15, dann +5 (Einstellung `fest`: 4/6/8/10). +2 auf ein eigenes abgebildetes Gebiet. Pflicht ab 5 Karten, nach dem Ausschalten eines Gegners ab 6 sofort.
  - Angriff mit bis zu 3 Würfeln. Der Verteidiger wählt auf seinem Handy 1 oder 2 Würfel (höchstens so viele wie Armeen im Gebiet), vorausgewählt ist die Höchstzahl; der Server würfelt erst danach. Gleichstand gewinnt der Verteidiger. Nachrücken mindestens mit so vielen Armeen wie Würfeln.
  - Einmal Verschieben pro Zug ins Nachbargebiet (Einstellung `verbunden`: über eigene Gebiete). Eine Karte pro Zug mit Eroberung.
  - Keine Missionen; 2010er-Variante und Hauptstadt-Modus folgen später.
  - Weltkarte der Host-Ansicht: aus Natural Earth 1:50m (gemeinfrei) mit `scripts/build-map.js` erzeugt, Miller-Projektion, Naht im Pazifik bei 169,5° W.
    - Länder werden zu den 42 Gebieten zusammengefasst; Kanada, USA, Russland und Australien sind entlang fester Längen- und Breitengrade geteilt. Die Schnitte sind so gewählt, dass nur Gebiete aneinandergrenzen, die laut `map.js` Nachbarn sind (59 Landgrenzen); die übrigen 24 Nachbarschaften sind gestrichelte Seewege.
    - Dafür gehört der Süden Russlands am Amur (bis Wladiwostok) zum Gebiet Mongolei und die Zentralafrikanische Republik zu Nordafrika; Neuseeland, Pazifikinseln und andere kleine Gebiete außerhalb der 42 sind graues, unbespieltes Land.
    - Gestaltung: flache Flächen, gleichmäßige dunkle Konturen (Kontinente und Küsten etwas stärker), runde Zahlen-Marker, ruhiges dunkles Blau als Ozean, Spielerliste unten. Feste, gedämpfte Kartenfarbe je Spielerfarbe aus der Lobby. Bildschirmfotos: `docs/screenshots/`.
    - `x`/`y`/`label` in `map.js` gehören zur alten schematischen Karte und werden von der Host-Ansicht nicht mehr benutzt.
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
- **Tests:** `npm test` führt nur die Unit-Tests aus (108: Regeln von Monopoly, Risiko und Minispielen, Spiel-Schnittstelle, Spielauswahl, Neustart-Tests mit gespeicherten Räumen in Version 1 und 2, Prüfung der erzeugten Weltkarte, Wächter für die Testskripte). Lokal kommen dazu `npm run test:browser` (4 Playwright-Durchläufe: Monopoly mit 1 Host-Ansicht und 3 Handys, Lobby, alte Einzelversion, Risiko mit 2 Handys; braucht `CHROMIUM_PATH`) und `npm run test:db` (2 Datenbank-Tests, braucht `DATABASE_URL`). Fehlt die Umgebung, werden diese Tests mit Grund übersprungen. Zeitlimit 60 s pro Testdatei.
- **Aufräumarbeiten:** `package-lock.json` liegt im Repo. Die alte Pferderennen-Einzelversion liegt in `legacy/`.

## Entscheidungen

1. **Eigenes Guthaben pro Spiel.** Jedes Spiel verwaltet sein eigenes Geld bzw. seine eigenen Chips. Es gibt kein gemeinsames Konto über mehrere Spiele.
2. **Reihenfolge:** zuerst Monopoly (fertig), dann Risiko, dann Poker.
3. **Server ist die einzige Instanz** für Spielzustand und Zufall. Clients zeigen nur Snapshots, versteckte Information wird pro Spieler gefiltert (siehe `CLAUDE.md`).
4. **Gleiche Grundlage für alle Spiele:** Räume, Beitritt, QR-Code und Wiederverbindung werden geteilt; Hosting auf Render bleibt.

## Offene Punkte

> Hinweis: Die Projektwissensdatei lag beim Anlegen dieses Dokuments nicht vor. Die Punkte stammen aus der Projektanalyse vom Oktober 2026 – bitte mit der Projektwissensdatei abgleichen.

### Architektur
- Erledigt: Gemeinsame Spiel-Schnittstelle in `server/games/index.js` (`createGame`, `handleAction`, `view(role, playerId)`, `tick`, `isOver`, dazu `waitingFor`, `removePlayer`, `toJSON`). Monopoly ist die erste Implementierung (`server/monopoly/index.js`); Animations-Timing, Auto-Würfeln, Auktions-Timer und Minispiele liegen dort, `server/rooms.js` ist spielunabhängig.
- Erledigt: Jedes Handy bekommt einen eigenen Snapshot (`view('player', playerId)`). Spielstände werden als Version 2 mit `gameType` gespeichert; Version 1 lässt sich weiter laden.
- Die Frontends `public/board/board.js` und `public/play/play.js` sind große Einzeldateien mit Monopoly- und Minispiel-Ansichten. Für mehrere Spiele sollten sie pro Spiel aufgeteilt werden; dazu kommt eine gemeinsame Hülle für Lobby, Kopfzeile und Verbindung.
- Animationszeiten sind zwischen Server (`TIMING`, Konstanten der Minispiele) und Clients verteilt.
- Erledigt: Spielauswahl in der Lobby der Host-Ansicht (`board:game`); Risiko-Ansichten liegen in eigenen Dateien (`public/board/risiko.js`, `public/play/risiko.js`).

### Betrieb
- Persistenz (Branch `feature/persistenz`) ist implementiert: Mit `DATABASE_URL` werden Räume in Postgres (Neon) gespeichert und beim Start geladen.
  - Neon ist angebunden: `neon deploy` legt `DATABASE_URL` in `.env.local` ab.
  - Die Datenbank-Tests (`test/db.test.js`) sind lokal gegen den Neon-Branch `test` grün: 2 bestanden, 0 fehlgeschlagen, 0 übersprungen.
  - Die Browser-Tests (`e2e`, `lobby.e2e`, `legacy.e2e`) wurden dabei nicht ausgeführt.
  - Offen: Ein unterbrochenes Minispiel startet nach einem Neustart neu.
- Nur eine Server-Instanz möglich, weil Socket.IO keinen gemeinsamen Adapter (z. B. Redis) nutzt.
- Keine Authentifizierung: Wer den Raumcode kennt, kann die Host-Ansicht öffnen und starten. Getrennte Plätze lassen sich übernehmen.

### Noch zu klären
- Render: Welcher Branch ist verbunden, ist `PUBLIC_URL` gesetzt, welche Node-Version läuft, bleibt es beim Free-Plan?
- Wird `main` künftig der Branch, den Render beobachtet?
- Verhalten auf echten Handys (iOS Safari, Android) über längere Zeit, z. B. Displaysperre und Netzwechsel. Getestet ist nur headless Chromium.
- Last mit 10 Spielern auf dem Free-Plan.
- Regeln und Umfang für Poker: Varianten, Spielerzahl, Spieldauer, Minispiele ja oder nein.

### Offene Entscheidungen Risiko
Beide Regeln sind umgesetzt und im Code mit „OFFENE ENTSCHEIDUNG“ markiert (`server/games/risiko/rules.js`); geändert wird erst nach einer Vorgabe.
- **Neutrale Armee bei 2 Spielern:** Heute spielt eine neutrale Armee mit 40 Armeen mit (klassische Zwei-Personen-Regel). Sie hat kein Handy und verteidigt deshalb immer mit der Höchstzahl an Würfeln. Diese Datei enthielt dazu keine Vorgabe. Offen: beibehalten oder entfernen (dann z. B. 2 Spieler ohne Neutral, Startarmeen festlegen).
- **Ausscheiden (aufgegeben oder zu lange getrennt):** Die Gebiete werden neutral, die Armeen bleiben stehen, die Karten kommen auf den Ablagestapel. Offen: so lassen oder z. B. Gebiete an andere Spieler verteilen.

### Bekannte Regelvereinfachungen in Monopoly
- Keine 10 % Zinsen auf übernommene Hypotheken.
- Automatische Pleite, wenn auch der Verkauf aller Häuser und Hypotheken nicht reicht.
- Die Zugreihenfolge entspricht der Beitrittsreihenfolge.
- Minispiele starten bei jeder passenden Würfelsumme, auch im Gefängnis.
