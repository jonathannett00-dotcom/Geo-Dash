'use strict';

/*
 * Geometrie des Poker-Tisches (public/board/poker-layout.js), ohne Browser:
 * Für viele Tischgrößen und 2 bis 12 Spieler berühren Plätze, Einsätze und
 * Dealer-Button weder die Sperrzonen (Kartenring, Blinds, Pot, Handname) noch
 * einander; der Button liegt nie zur Tischmitte hin; Chip-Flugbahnen gehen um
 * Kartenring und Blinds-Feld herum. Die Messung im Browser: poker-layout.e2e.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PK_CHIP, pkComputeLayout, pkFlightPath, pkHits, pkGrow, pkSegmentHits } = require('../public/board/poker-layout.js');

/** Tischflächen der drei Zielauflösungen (1920x1080, 1366x768, 1024x768) und weitere Größen. */
const SIZES = [[1484, 980], [1054, 697], [774, 699], [700, 600], [1200, 800], [1600, 900], [900, 760]];

test('Poker-Tisch: Plätze, Einsätze und Dealer-Button berühren keine Sperrzone und einander nicht', () => {
  for (const [W, H] of SIZES) {
    for (let n = 2; n <= 12; n++) {
      const L = pkComputeLayout(W, H, n);
      const where = `${W}x${H}, ${n} Spieler`;
      assert.ok(L.ok, `${where}: ${L.why}`);
      const zones = Object.values(L.zones);
      const items = [...L.seats.map((r) => ['Platz', r]), ...L.bets.map((r) => ['Einsatz', r])];
      for (const [kind, r] of [...items, ...L.dealers.map((r) => ['Button', r])]) {
        assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H, `${where}: ${kind} ragt aus dem Tisch`);
        for (const z of zones) assert.ok(!pkHits(r, z), `${where}: ${kind} in einer Sperrzone`);
      }
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) assert.ok(!pkHits(items[i][1], items[j][1]), `${where}: ${items[i][0]} × ${items[j][0]}`);
      L.dealers.forEach((d, i) => {
        for (const [kind, r] of items) assert.ok(!pkHits(d, r), `${where}: Button ${i + 1} × ${kind}`);
        // Nie zur Mitte hin: nicht näher an der Tischmitte als die Mitte des eigenen Platzes minus ein Stück
        const s = L.seats[i];
        const dist = (x, y) => Math.hypot((x - L.cx) / L.rx, (y - L.cy) / L.ry);
        assert.ok(dist(d.cx, d.cy) >= dist(s.cx, s.cy) - 0.12, `${where}: Button ${i + 1} liegt zur Mitte hin`);
      });
    }
  }
});

test('Poker-Tisch: Chips fliegen um Kartenring und Blinds-Feld herum', () => {
  for (const [W, H] of SIZES) {
    for (const n of [2, 3, 6, 9, 12]) {
      const L = pkComputeLayout(W, H, n);
      const m = (PK_CHIP / 2) * L.u;
      const avoid = [pkGrow(L.zones.ring, m), pkGrow(L.zones.blinds, m)];
      const pot = { x: L.zones.pot.x + L.zones.pot.w * 0.28, y: L.zones.pot.y + L.zones.pot.h / 2 };
      for (const r of [...L.bets, ...L.seats]) {
        for (const pts of [pkFlightPath({ x: r.cx, y: r.cy }, pot, L), pkFlightPath(pot, { x: r.cx, y: r.cy }, L)]) {
          pts.forEach((p, i) => { if (i) for (const z of avoid) assert.ok(!pkSegmentHits(pts[i - 1], p, z), `${W}x${H}, ${n} Spieler: Flugbahn durch eine Sperrzone`); });
        }
      }
    }
  }
});
