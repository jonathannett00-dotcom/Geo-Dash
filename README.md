# 🎲 Monopoly-Abend

Ein Multiplayer-Brettspiel nach den klassischen Monopoly-Regeln (deutsche Standardausgabe) für 2–10 Spieler:

- Ein **Tablet** zeigt das Spielfeld.
- Jeder Spieler steuert alles über sein **Handy**.
- In der Brettmitte laufen die Minispiele **Pferderennen**, **Roulette** und **Blackjack**, damit alle am Tablet zuschauen können.
- Der Server verwaltet den Spielstand, würfelt, mischt und rechnet ab. Handys senden nur ihre Absichten, der Server prüft jede Aktion.

## Lokal starten

Voraussetzung: Node.js 20 oder neuer.

```bash
npm install
npm start
```

Danach:

1. Das Tablet öffnet `http://localhost:3000`. Es erstellt automatisch einen Raum und zeigt einen QR-Code.
2. Die Handys scannen den QR-Code. Sie müssen im selben WLAN sein: Der QR-Code enthält automatisch die LAN-Adresse des Rechners.
3. Ohne QR-Code öffnet man `http://<IP-des-Rechners>:3000/play` und gibt den 4-stelligen Raum-Code ein.

Den Port ändert man mit `PORT=8080 npm start`. Mit `PUBLIC_URL=https://mein-spiel.example` legt man die Adresse im QR-Code fest.

**Auf dem Fernseher spielen:** Das Spielfeld funktioniert auf einem Tablet genauso wie auf einem 16:9-Fernseher. Öffne es dafür am Laptop und übertrage den Bildschirm (HDMI oder Bildschirmübertragung). Mit F11 kommt der Browser in den Vollbildmodus. Das Brett nutzt die Breite, die Spielerleiste passt sich der Bildschirmgröße an, und Minispiele füllen automatisch den ganzen Bildschirm.

## Auf Render deployen (kostenlos)

Das Repository enthält eine `render.yaml` (Blueprint):

1. Auf [render.com](https://render.com) anmelden und GitHub verbinden.
2. **New → Blueprint** wählen, dieses Repository und den gewünschten Branch auswählen.
3. Render übernimmt `render.yaml` und legt einen Web-Service an:
   - kostenloser Plan
   - Build: `npm install --omit=dev`
   - Start: `npm start`
   - Healthcheck: `/healthz`
4. Nach dem Deploy die Render-Adresse auf dem Tablet öffnen, zum Beispiel `https://monopoly-abend.onrender.com`. Handys können dann aus jedem Netz beitreten.

Hinweise zum kostenlosen Plan:

- Der Spielstand liegt nur im Arbeitsspeicher.
- Render legt kostenlose Dienste nach etwa 15 Minuten ohne eingehende Anfragen schlafen. Dabei geht der Spielstand verloren, und der erste Aufruf danach dauert einen Moment.
- Unabhängig davon wird ein Raum nach 6 Stunden ohne Aktivität gelöscht.

## Spielanleitung

### Lobby

- Das Tablet zeigt Raum-Code und QR-Code. Jeder Spieler tritt am Handy mit **Name, Spielfigur und Farbe** bei (2–10 Spieler).
- Am Tablet stellt man den **Startbetrag** ein (Standard 1500 M, für alle gleich) und tippt auf **„Spiel starten“**. Das Tablet braucht sonst keine Bedienung.
- Wer das Handy neu lädt oder das gesperrte Display wieder entsperrt, ist sofort wieder im Spiel.
- Getrennte Spieler bleiben im Spiel. Ist ein getrennter Spieler gerade dran, wird sein Zug pausiert. Wartet das Spiel 5 Minuten lang auf ihn, scheidet er aus.
- Landet jemand in einem anderen Browser (zum Beispiel nach dem Scannen mit einer QR-App), zeigt die Beitrittsseite die getrennten Spieler. Ein Tipp auf den eigenen Namen führt zurück ins Spiel.

### Das Handy

Oben stehen immer dein Kontostand und wer gerade dran ist. Unten gibt es vier Tabs:

| Tab | Wofür |
| --- | --- |
| 🎲 **Zug** | Zug beenden, Kaufen oder Ablehnen, Versteigerung (Gebote, Aussteigen), Gefängnis (50 M zahlen, Freikarte, Pasch würfeln), Schulden begleichen |
| 🏠 **Besitz** | Häuser/Hotels bauen und verkaufen, Hypothek aufnehmen und ablösen |
| 🤝 **Handel** | Angebote aus Straßen, Geld und Freikarten an Mitspieler senden, annehmen oder ablehnen |
| 🎰 **Minispiel** | Nur aktiv, wenn ein Minispiel läuft |

Geht eine Aktion nicht, zum Beispiel weil du nicht dran bist oder zu wenig Geld hast, zeigt das Handy den Grund an.

### Ablauf eines Zuges

1. Ist ein Spieler dran, **würfelt das Tablet automatisch**. Die Figur zieht Feld für Feld.
2. Das Feld wird abgewickelt: kaufen oder versteigern, Miete zahlen, Karte ziehen, Steuer zahlen.
3. Passt die Würfelsumme, folgt ein **Minispiel für alle** Spieler, die noch nicht pleite sind.
4. Nach einem **Pasch** würfelt das Tablet für denselben Spieler nochmal.
5. Ist alles erledigt, tippt der Spieler am Handy auf **„Zug beenden“**. Bis dahin kann er noch bauen, Hypotheken ändern oder handeln. Erst dann ist der Nächste dran.

### Regeln (deutsche Standardausgabe)

- **Los:** 200 M beim Überqueren oder Betreten.
- **Kaufen:** Ein freies Grundstück darfst du kaufen. Lehnst du ab, wird es an alle versteigert (Timer, Mindestschritt 10 M).
- **Miete** wird automatisch abgebucht:
  - doppelte Grundmiete bei kompletter Farbgruppe ohne Häuser
  - Bahnhöfe 25/50/100/200 M
  - Werke 4× Augenzahl, mit beiden Werken 10× Augenzahl
  - keine Miete bei Hypothek
- **Bauen:**
  - nur mit kompletter Farbgruppe ohne Hypothek
  - gleichmäßig verteilt, höchstens 4 Häuser, dann ein Hotel
  - Die Bank hat nur 32 Häuser und 12 Hotels.
  - Verkauf zum halben Preis
- **Hypothek:** Du bekommst 50 % des Kaufpreises, die Ablösung kostet 110 %.
- **Steuern:** Einkommensteuer 200 M, Zusatzsteuer 100 M. Frei Parken bringt kein Geld.
- **Pasch:** Du würfelst nochmal. Beim 3. Pasch in Folge geht es ins Gefängnis.
- **Gefängnis:**
  - Hinein kommst du über das Feld „Gehe ins Gefängnis“, über eine Karte oder durch den 3. Pasch.
  - Hinaus kommst du mit 50 M, der Freikarte oder einem Pasch innerhalb von 3 Versuchen.
  - Nach dem 3. Fehlversuch zahlst du 50 M und ziehst.
- **Karten:** je 16 Ereignis- und Gemeinschaftskarten mit den Standardtexten.
- **Handel:** jederzeit möglich, außer während eines Minispiels.
- **Schulden und Pleite:**
  - Reicht dein Geld nicht, verkaufst du zuerst Häuser oder nimmst Hypotheken auf. Sobald das Geld reicht, wird automatisch bezahlt.
  - Reicht auch das nicht, bist du pleite. Dein Besitz geht an den Gläubiger, bei Schulden an die Bank wird er versteigert.
- **Sieg:** Wer als Letzter übrig bleibt, gewinnt.

### Minispiele

| Würfelsumme | Minispiel |
| --- | --- |
| 2 oder 6 | 🃏 Blackjack |
| 7 | 🏇 Pferderennen |
| 8 oder 12 | 🎡 Roulette |

Für alle Minispiele gilt:

- Gesetzt wird mit dem **Monopoly-Kontostand**, Gewinne fließen dorthin zurück.
- Der Mindesteinsatz ist **10 M**. Wer nichts setzt, setzt aus.
- Das Wettfenster dauert **30 Sekunden**, mit Countdown auf Tablet und Handy. Haben alle **„Fertig“** gedrückt, geht es sofort los.
- Das Tablet zeigt live, wer wie viel worauf setzt.

**🏇 Pferderennen**

- 6 Pferde mit Quoten, die per Simulation berechnet werden.
- Sieg- oder Platzwette (Top 3) auf dem Handy.
- Das Rennen läuft auf der ovalen Bahn in der Brettmitte. Pferde mit Wetten leuchten, die Namen der Wettenden stehen wie Bahnbeschriftung hinter dem Pferd.

**🎡 Roulette**

- Europäisch mit einer Null (0–36). Chips zu 5/10/25/100 M.
- Auszahlungen:
  - Plein 35:1
  - Rot/Schwarz, Gerade/Ungerade, 1–18/19–36 jeweils 1:1
  - Dutzende und Kolonnen 2:1
- Die Chips erscheinen mit Name und Betrag auf dem Tableau. Danach dreht sich das große Rad.

**🃏 Blackjack**

- 6-Deck-Schuh, der bei 75 % Verbrauch neu gemischt wird. Die Sitze stehen im Halbkreis um den Dealer.
- Hit, Stand, Double (nur auf den ersten 2 Karten) und Split (Paar, einmal pro Hand; geteilte Asse erhalten je nur eine Karte).
- 20 Sekunden pro Entscheidung, danach automatisch Stand.
- Der Dealer steht auf Soft 17. Blackjack zahlt 3:2, eine Versicherung gibt es nicht.

## Tests

```bash
npm test
```

- Die Regeltests (`node:test`) decken ab:
  - Miete, Bauen, Hypothek, Gefängnis, Pleite, Versteigerung und Handel
  - die Zuordnung Würfelsumme → Minispiel
  - Pferderennen, Roulette-Quoten und Blackjack-Regeln
- Die Browser-Tests (Playwright) spielen mit 1 Tablet und 3 Handys mehrere Runden: Lobby, Kauf, Miete, Versteigerung, Handel, Neuladen, abgelehnte Aktionen und je ein erzwungenes Pferderennen, Roulette und Blackjack.
  - Die Würfel werden dabei nur im Testmodus (`MONOPOLY_TEST=1`) vorgegeben.
  - Chromium muss installiert sein. Der Pfad lässt sich mit `CHROMIUM_PATH` setzen, Standard ist `/opt/pw-browsers/chromium`.

## Projektstruktur

```
server/
  index.js            Express + Socket.IO, QR-Code, Seiten
  rooms.js            Räume, Beitritt, Wiederverbindung, Timer, Minispiel-Steuerung
  rng.js              Zufallsgenerator des Servers
  monopoly/           board.js (Felder), cards.js (Karten), rules.js (Regel-Engine)
  games/              horserace.js, blackjack.js, roulette.js
public/
  board/              Tablet (Spielfeld)
  play/               Handy (Controller)
  shared/             gemeinsame Helfer und die Rennbahn aus dem Pferderennen-Spiel
test/                 node:test- und Playwright-Tests
```

## Grand Prix Galopp (Einzelversion)

Das ursprüngliche Pferderennen-Wettspiel liegt weiterhin unverändert im Hauptverzeichnis (`index.html`, `style.css`, `game.js`). Es läuft komplett im Browser ohne Server: einfach `index.html` öffnen.
