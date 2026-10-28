'use strict';

/* Poker-Tisch ohne Überlappung (Browser): 8, 9 und 12 Spieler. Ablauf und Messung: poker-layout-messung.js */

const { layoutTest } = require('./poker-layout-messung');

for (const n of [8, 9, 12]) layoutTest(n);
