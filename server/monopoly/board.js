'use strict';

/* Spielbrett der deutschen Standardausgabe (Beträge in M). */

const street = (name, group, price, house, rent) => ({ name, type: 'street', group, price, house, rent });
const railroad = (name) => ({ name, type: 'railroad', price: 200 });
const utility = (name) => ({ name, type: 'utility', price: 150 });

const SQUARES = [
  { name: 'Los', type: 'go' },
  street('Badstraße', 'brown', 60, 50, [2, 10, 30, 90, 160, 250]),
  { name: 'Gemeinschaftsfeld', type: 'community' },
  street('Turmstraße', 'brown', 60, 50, [4, 20, 60, 180, 320, 450]),
  { name: 'Einkommensteuer', type: 'tax', amount: 200 },
  railroad('Südbahnhof'),
  street('Chausseestraße', 'lightblue', 100, 50, [6, 30, 90, 270, 400, 550]),
  { name: 'Ereignisfeld', type: 'chance' },
  street('Elisenstraße', 'lightblue', 100, 50, [6, 30, 90, 270, 400, 550]),
  street('Poststraße', 'lightblue', 120, 50, [8, 40, 100, 300, 450, 600]),
  { name: 'Gefängnis', type: 'jail' },
  street('Seestraße', 'pink', 140, 100, [10, 50, 150, 450, 625, 750]),
  utility('Elektrizitätswerk'),
  street('Hafenstraße', 'pink', 140, 100, [10, 50, 150, 450, 625, 750]),
  street('Neue Straße', 'pink', 160, 100, [12, 60, 180, 500, 700, 900]),
  railroad('Westbahnhof'),
  street('Münchner Straße', 'orange', 180, 100, [14, 70, 200, 550, 750, 950]),
  { name: 'Gemeinschaftsfeld', type: 'community' },
  street('Wiener Straße', 'orange', 180, 100, [14, 70, 200, 550, 750, 950]),
  street('Berliner Straße', 'orange', 200, 100, [16, 80, 220, 600, 800, 1000]),
  { name: 'Frei Parken', type: 'parking' },
  street('Theaterstraße', 'red', 220, 150, [18, 90, 250, 700, 875, 1050]),
  { name: 'Ereignisfeld', type: 'chance' },
  street('Museumstraße', 'red', 220, 150, [18, 90, 250, 700, 875, 1050]),
  street('Opernplatz', 'red', 240, 150, [20, 100, 300, 750, 925, 1100]),
  railroad('Nordbahnhof'),
  street('Lessingstraße', 'yellow', 260, 150, [22, 110, 330, 800, 975, 1150]),
  street('Schillerstraße', 'yellow', 260, 150, [22, 110, 330, 800, 975, 1150]),
  utility('Wasserwerk'),
  street('Goethestraße', 'yellow', 280, 150, [24, 120, 360, 850, 1025, 1200]),
  { name: 'Gehe ins Gefängnis', type: 'gotojail' },
  street('Rathausplatz', 'green', 300, 200, [26, 130, 390, 900, 1100, 1275]),
  street('Hauptstraße', 'green', 300, 200, [26, 130, 390, 900, 1100, 1275]),
  { name: 'Gemeinschaftsfeld', type: 'community' },
  street('Bahnhofstraße', 'green', 320, 200, [28, 150, 450, 1000, 1200, 1400]),
  railroad('Hauptbahnhof'),
  { name: 'Ereignisfeld', type: 'chance' },
  street('Parkstraße', 'darkblue', 350, 200, [35, 175, 500, 1100, 1300, 1500]),
  { name: 'Zusatzsteuer', type: 'tax', amount: 100 },
  street('Schlossallee', 'darkblue', 400, 200, [50, 200, 600, 1400, 1700, 2000]),
];

const GROUP_COLORS = {
  brown: '#8d5a3b',
  lightblue: '#9fd6f2',
  pink: '#d6338f',
  orange: '#f58f1f',
  red: '#e2262c',
  yellow: '#f4dc19',
  green: '#17a656',
  darkblue: '#1b5fae',
  railroad: '#2b2b2b',
  utility: '#8a96a3',
};

/** Gruppen-Schlüssel eines Feldes (Farbe, „railroad“ oder „utility“), sonst null. */
function groupKey(s) {
  if (s.type === 'street') return s.group;
  if (s.type === 'railroad' || s.type === 'utility') return s.type;
  return null;
}

const GROUPS = {};
SQUARES.forEach((s, i) => {
  s.index = i;
  const key = groupKey(s);
  if (key) (GROUPS[key] = GROUPS[key] || []).push(i);
});

const isOwnable = (i) => groupKey(SQUARES[i]) !== null;

module.exports = { SQUARES, GROUPS, GROUP_COLORS, groupKey, isOwnable };
