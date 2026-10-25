'use strict';

/* =========================================================
 *  Risiko-Weltkarte als Daten: 42 Gebiete, 6 Kontinente, Grenzen
 *  und Kontinentboni. x/y sind Mittelpunkte auf einer eigenen,
 *  schematischen Karte (Zeichenfläche 1000 × 560).
 * ========================================================= */

const CONTINENTS = [
  { id: 'nordamerika', name: 'Nordamerika', bonus: 5, color: '#e9b949' },
  { id: 'suedamerika', name: 'Südamerika', bonus: 2, color: '#e07a5f' },
  { id: 'europa', name: 'Europa', bonus: 5, color: '#5b8bd9' },
  { id: 'afrika', name: 'Afrika', bonus: 3, color: '#c98b4f' },
  { id: 'asien', name: 'Asien', bonus: 7, color: '#6fb26f' },
  { id: 'australien', name: 'Australien', bonus: 2, color: '#a57fc9' },
];

const TERRITORIES = [
  // Nordamerika
  { id: 'alaska', name: 'Alaska', continent: 'nordamerika', x: 60, y: 90 },
  { id: 'nordwest-territorium', name: 'Nordwest-Territorium', continent: 'nordamerika', x: 170, y: 85 },
  { id: 'groenland', name: 'Grönland', continent: 'nordamerika', x: 330, y: 50 },
  { id: 'alberta', name: 'Alberta', continent: 'nordamerika', x: 150, y: 150 },
  { id: 'ontario', name: 'Ontario', continent: 'nordamerika', x: 230, y: 155 },
  { id: 'quebec', name: 'Quebec', continent: 'nordamerika', x: 310, y: 150 },
  { id: 'weststaaten', name: 'Weststaaten', continent: 'nordamerika', x: 160, y: 220 },
  { id: 'oststaaten', name: 'Oststaaten', continent: 'nordamerika', x: 250, y: 230 },
  { id: 'mittelamerika', name: 'Mittelamerika', continent: 'nordamerika', x: 180, y: 300 },
  // Südamerika
  { id: 'venezuela', name: 'Venezuela', continent: 'suedamerika', x: 260, y: 360 },
  { id: 'peru', name: 'Peru', continent: 'suedamerika', x: 260, y: 440 },
  { id: 'brasilien', name: 'Brasilien', continent: 'suedamerika', x: 330, y: 420 },
  { id: 'argentinien', name: 'Argentinien', continent: 'suedamerika', x: 280, y: 510 },
  // Europa
  { id: 'island', name: 'Island', continent: 'europa', x: 420, y: 100 },
  { id: 'skandinavien', name: 'Skandinavien', continent: 'europa', x: 510, y: 90 },
  { id: 'grossbritannien', name: 'Großbritannien', continent: 'europa', x: 420, y: 170 },
  { id: 'nordeuropa', name: 'Nordeuropa', continent: 'europa', x: 505, y: 170 },
  { id: 'westeuropa', name: 'Westeuropa', continent: 'europa', x: 430, y: 250 },
  { id: 'suedeuropa', name: 'Südeuropa', continent: 'europa', x: 520, y: 240 },
  { id: 'osteuropa', name: 'Osteuropa', continent: 'europa', x: 600, y: 140 },
  // Afrika
  { id: 'nordafrika', name: 'Nordafrika', continent: 'afrika', x: 470, y: 340 },
  { id: 'aegypten', name: 'Ägypten', continent: 'afrika', x: 560, y: 320 },
  { id: 'ostafrika', name: 'Ostafrika', continent: 'afrika', x: 610, y: 400 },
  { id: 'zentralafrika', name: 'Zentralafrika', continent: 'afrika', x: 540, y: 430 },
  { id: 'suedafrika', name: 'Südafrika', continent: 'afrika', x: 560, y: 510 },
  { id: 'madagaskar', name: 'Madagaskar', continent: 'afrika', x: 650, y: 500 },
  // Asien
  { id: 'ural', name: 'Ural', continent: 'asien', x: 700, y: 120 },
  { id: 'sibirien', name: 'Sibirien', continent: 'asien', x: 770, y: 90 },
  { id: 'jakutien', name: 'Jakutien', continent: 'asien', x: 860, y: 70 },
  { id: 'irkutsk', name: 'Irkutsk', continent: 'asien', x: 840, y: 140 },
  { id: 'kamtschatka', name: 'Kamtschatka', continent: 'asien', x: 940, y: 90 },
  { id: 'mongolei', name: 'Mongolei', continent: 'asien', x: 860, y: 200 },
  { id: 'japan', name: 'Japan', continent: 'asien', x: 950, y: 220 },
  { id: 'afghanistan', name: 'Afghanistan', continent: 'asien', x: 680, y: 210 },
  { id: 'china', name: 'China', continent: 'asien', x: 800, y: 260 },
  { id: 'naher-osten', name: 'Naher Osten', continent: 'asien', x: 640, y: 290 },
  { id: 'indien', name: 'Indien', continent: 'asien', x: 730, y: 320 },
  { id: 'suedostasien', name: 'Südostasien', continent: 'asien', x: 820, y: 340 },
  // Australien
  { id: 'indonesien', name: 'Indonesien', continent: 'australien', x: 820, y: 430 },
  { id: 'neuguinea', name: 'Neuguinea', continent: 'australien', x: 920, y: 410 },
  { id: 'westaustralien', name: 'Westaustralien', continent: 'australien', x: 850, y: 510 },
  { id: 'ostaustralien', name: 'Ostaustralien', continent: 'australien', x: 940, y: 500 },
];

/** Jede Grenze genau einmal; die Nachbarlisten werden daraus symmetrisch erzeugt. */
const BORDERS = [
  // Nordamerika
  ['alaska', 'nordwest-territorium'], ['alaska', 'alberta'],
  ['nordwest-territorium', 'alberta'], ['nordwest-territorium', 'ontario'], ['nordwest-territorium', 'groenland'],
  ['groenland', 'ontario'], ['groenland', 'quebec'],
  ['alberta', 'ontario'], ['alberta', 'weststaaten'],
  ['ontario', 'quebec'], ['ontario', 'weststaaten'], ['ontario', 'oststaaten'],
  ['quebec', 'oststaaten'],
  ['weststaaten', 'oststaaten'], ['weststaaten', 'mittelamerika'],
  ['oststaaten', 'mittelamerika'],
  // Südamerika
  ['venezuela', 'peru'], ['venezuela', 'brasilien'],
  ['peru', 'brasilien'], ['peru', 'argentinien'],
  ['brasilien', 'argentinien'],
  // Europa
  ['island', 'grossbritannien'], ['island', 'skandinavien'],
  ['skandinavien', 'grossbritannien'], ['skandinavien', 'nordeuropa'], ['skandinavien', 'osteuropa'],
  ['grossbritannien', 'nordeuropa'], ['grossbritannien', 'westeuropa'],
  ['nordeuropa', 'westeuropa'], ['nordeuropa', 'suedeuropa'], ['nordeuropa', 'osteuropa'],
  ['westeuropa', 'suedeuropa'],
  ['suedeuropa', 'osteuropa'],
  // Afrika
  ['nordafrika', 'aegypten'], ['nordafrika', 'ostafrika'], ['nordafrika', 'zentralafrika'],
  ['aegypten', 'ostafrika'],
  ['ostafrika', 'zentralafrika'], ['ostafrika', 'suedafrika'], ['ostafrika', 'madagaskar'],
  ['zentralafrika', 'suedafrika'],
  ['suedafrika', 'madagaskar'],
  // Asien
  ['ural', 'sibirien'], ['ural', 'china'], ['ural', 'afghanistan'],
  ['sibirien', 'jakutien'], ['sibirien', 'irkutsk'], ['sibirien', 'mongolei'], ['sibirien', 'china'],
  ['jakutien', 'irkutsk'], ['jakutien', 'kamtschatka'],
  ['irkutsk', 'kamtschatka'], ['irkutsk', 'mongolei'],
  ['kamtschatka', 'mongolei'], ['kamtschatka', 'japan'],
  ['mongolei', 'japan'], ['mongolei', 'china'],
  ['afghanistan', 'china'], ['afghanistan', 'indien'], ['afghanistan', 'naher-osten'],
  ['china', 'suedostasien'], ['china', 'indien'],
  ['naher-osten', 'indien'],
  ['indien', 'suedostasien'],
  // Australien
  ['indonesien', 'neuguinea'], ['indonesien', 'westaustralien'],
  ['neuguinea', 'westaustralien'], ['neuguinea', 'ostaustralien'],
  ['westaustralien', 'ostaustralien'],
  // Zwischen Kontinenten
  ['alaska', 'kamtschatka'],
  ['groenland', 'island'],
  ['mittelamerika', 'venezuela'],
  ['brasilien', 'nordafrika'],
  ['westeuropa', 'nordafrika'],
  ['suedeuropa', 'nordafrika'], ['suedeuropa', 'aegypten'], ['suedeuropa', 'naher-osten'],
  ['osteuropa', 'ural'], ['osteuropa', 'afghanistan'], ['osteuropa', 'naher-osten'],
  ['aegypten', 'naher-osten'], ['ostafrika', 'naher-osten'],
  ['suedostasien', 'indonesien'],
];

const TERRITORY_IDS = TERRITORIES.map((t) => t.id);
const TERRITORY = Object.fromEntries(TERRITORIES.map((t) => [t.id, t]));
const CONTINENT = Object.fromEntries(CONTINENTS.map((c) => [c.id, c]));

/** Nachbarn je Gebiet. */
const NEIGHBORS = Object.fromEntries(TERRITORY_IDS.map((id) => [id, []]));
for (const [a, b] of BORDERS) {
  NEIGHBORS[a].push(b);
  NEIGHBORS[b].push(a);
}

/** Gebiete je Kontinent. */
const CONTINENT_TERRITORIES = Object.fromEntries(CONTINENTS.map((c) => [c.id, TERRITORY_IDS.filter((id) => TERRITORY[id].continent === c.id)]));

const isNeighbor = (a, b) => Boolean(NEIGHBORS[a] && NEIGHBORS[a].includes(b));

/** Statische Kartendaten für die Clients. */
const MAP_VIEW = {
  width: 1000,
  height: 560,
  continents: CONTINENTS.map((c) => ({ ...c, territories: CONTINENT_TERRITORIES[c.id] })),
  territories: TERRITORIES.map((t) => ({ ...t, neighbors: NEIGHBORS[t.id].slice() })),
};

module.exports = {
  CONTINENTS,
  TERRITORIES,
  BORDERS,
  TERRITORY_IDS,
  TERRITORY,
  CONTINENT,
  NEIGHBORS,
  CONTINENT_TERRITORIES,
  MAP_VIEW,
  isNeighbor,
};
