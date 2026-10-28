'use strict';

/* Poker-Tisch ohne Überlappung (Browser): 2, 3, 4 und 6 Spieler. Ablauf und Messung: poker-layout-messung.js */

const { layoutTest } = require('./poker-layout-messung');

for (const n of [2, 3, 4, 6]) layoutTest(n);
