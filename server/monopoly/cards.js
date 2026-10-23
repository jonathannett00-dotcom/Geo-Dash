'use strict';

/* Je 16 Ereignis- und Gemeinschaftskarten mit den Standardtexten (M-Ausgabe). */

const CHANCE_CARDS = [
  { text: 'Rücke vor bis auf Los. (Ziehe 200 M ein.)', action: { type: 'advance', to: 0 } },
  { text: 'Rücke vor bis zur Schlossallee.', action: { type: 'advance', to: 39 } },
  { text: 'Rücke vor bis zum Opernplatz. Wenn du über Los kommst, ziehe 200 M ein.', action: { type: 'advance', to: 24 } },
  { text: 'Rücke vor bis zur Seestraße. Wenn du über Los kommst, ziehe 200 M ein.', action: { type: 'advance', to: 11 } },
  { text: 'Rücke vor bis zum nächsten Bahnhof. Der Eigentümer erhält das Doppelte der normalen Miete. Gehört er noch niemandem, darfst du ihn kaufen.', action: { type: 'nearest', kind: 'railroad' } },
  { text: 'Rücke vor bis zum nächsten Bahnhof. Der Eigentümer erhält das Doppelte der normalen Miete. Gehört er noch niemandem, darfst du ihn kaufen.', action: { type: 'nearest', kind: 'railroad' } },
  { text: 'Rücke vor bis zum nächsten Werk. Gehört es einem Mitspieler, würfle und zahle ihm das Zehnfache der Augenzahl. Gehört es noch niemandem, darfst du es kaufen.', action: { type: 'nearest', kind: 'utility' } },
  { text: 'Mache einen Ausflug zum Südbahnhof. Wenn du über Los kommst, ziehe 200 M ein.', action: { type: 'advance', to: 5 } },
  { text: 'Gehe 3 Felder zurück.', action: { type: 'back', steps: 3 } },
  { text: 'Gehe in das Gefängnis. Begib dich direkt dorthin. Gehe nicht über Los. Ziehe nicht 200 M ein.', action: { type: 'jail' } },
  { text: 'Du kommst aus dem Gefängnis frei. Behalte diese Karte, bis du sie benötigst oder verkaufst.', action: { type: 'jailCard' } },
  { text: 'Die Bank zahlt dir eine Dividende von 50 M.', action: { type: 'money', amount: 50 } },
  { text: 'Dein Bausparvertrag wird fällig. Ziehe 150 M ein.', action: { type: 'money', amount: 150 } },
  { text: 'Lass alle deine Häuser renovieren! Zahle an die Bank für jedes Haus 25 M und für jedes Hotel 100 M.', action: { type: 'repairs', house: 25, hotel: 100 } },
  { text: 'Strafe für zu schnelles Fahren: Zahle 15 M.', action: { type: 'money', amount: -15 } },
  { text: 'Du wirst zum Vorstand gewählt. Zahle jedem Spieler 50 M.', action: { type: 'payEach', amount: 50 } },
];

const COMMUNITY_CARDS = [
  { text: 'Rücke vor bis auf Los. (Ziehe 200 M ein.)', action: { type: 'advance', to: 0 } },
  { text: 'Bankirrtum zu deinen Gunsten. Ziehe 200 M ein.', action: { type: 'money', amount: 200 } },
  { text: 'Arztkosten. Zahle 50 M.', action: { type: 'money', amount: -50 } },
  { text: 'Aus Lagerverkäufen erhältst du 50 M.', action: { type: 'money', amount: 50 } },
  { text: 'Du kommst aus dem Gefängnis frei. Behalte diese Karte, bis du sie benötigst oder verkaufst.', action: { type: 'jailCard' } },
  { text: 'Gehe in das Gefängnis. Begib dich direkt dorthin. Gehe nicht über Los. Ziehe nicht 200 M ein.', action: { type: 'jail' } },
  { text: 'Einkommensteuer-Rückerstattung. Ziehe 20 M ein.', action: { type: 'money', amount: 20 } },
  { text: 'Du hast Geburtstag. Jeder Spieler schenkt dir 10 M.', action: { type: 'collectEach', amount: 10 } },
  { text: 'Deine Lebensversicherung wird fällig. Ziehe 100 M ein.', action: { type: 'money', amount: 100 } },
  { text: 'Krankenhausgebühren. Zahle 100 M.', action: { type: 'money', amount: -100 } },
  { text: 'Schulgeld. Zahle 50 M.', action: { type: 'money', amount: -50 } },
  { text: 'Du erhältst auf Vorzugsaktien 7 % Dividende: 25 M.', action: { type: 'money', amount: 25 } },
  { text: 'Du wirst zu Straßenausbesserungsarbeiten herangezogen. Zahle für jedes Haus 40 M und für jedes Hotel 115 M an die Bank.', action: { type: 'repairs', house: 40, hotel: 115 } },
  { text: 'Du hast den zweiten Preis in einer Schönheitskonkurrenz gewonnen. Ziehe 10 M ein.', action: { type: 'money', amount: 10 } },
  { text: 'Du erbst 100 M.', action: { type: 'money', amount: 100 } },
  { text: 'Deine Urlaubskasse ist fällig. Ziehe 100 M ein.', action: { type: 'money', amount: 100 } },
];

module.exports = { CHANCE_CARDS, COMMUNITY_CARDS };
