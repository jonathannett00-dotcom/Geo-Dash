'use strict';

/* =========================================================
 *  Poker: Geometrie des Tisches (reine Rechnung, ohne DOM). Läuft im
 *  Browser und in den Unit-Tests (Node).
 *
 *  Sperrzonen in der Mitte: Blinds-Feld, Kartenring (Gemeinschaftskarten),
 *  Pot-Feld und Zeile für den Handnamen. Plätze sitzen auf einer Ellipse
 *  am Tischrand. Einsätze liegen zwischen Platz und Mitte; ein Löser prüft
 *  Kandidaten (Abstand, seitlich verschoben, kleiner) und nimmt den ersten,
 *  der nichts berührt. Der Dealer-Button sitzt neben seinem Platz am Rand,
 *  nie zur Mitte hin. Reicht der Platz nicht, wird alles etwas kleiner.
 *  Alle Größen in u (Pixel je Einheit).
 * ========================================================= */

const PK_SIZES = {
  normal: { seatW: 10.4, seatH: 7.8, betW: 6.8, betH: 3.6, dealer: 2, card: 4.3, cardGap: 0.45, ringPad: 0.6, blindsW: 9.4, potW: 14, rowH: 3.4, nameW: 28, nameH: 2.9, gap: 0.55 },
  many: { seatW: 8.8, seatH: 6.8, betW: 6, betH: 3.2, dealer: 1.8, card: 3.6, cardGap: 0.4, ringPad: 0.5, blindsW: 8.4, potW: 12, rowH: 3, nameW: 24, nameH: 2.7, gap: 0.5 },
};
/** Größe eines fliegenden Chips (u). */
const PK_CHIP = 1.3;

const pkRect = (x, y, w, h) => ({ x, y, w, h });
const pkCentered = (cx, cy, w, h) => pkRect(cx - w / 2, cy - h / 2, w, h);
const pkGrow = (r, m) => pkRect(r.x - m, r.y - m, r.w + 2 * m, r.h + 2 * m);
const pkHits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const pkInside = (r, W, H, m = 0) => r.x >= m && r.y >= m && r.x + r.w <= W - m && r.y + r.h <= H - m;
/** Halbe Ausdehnung eines Rechtecks in Richtung (dx, dy). */
const pkHalfExt = (w, h, dx, dy) => (Math.abs(dx) * w) / 2 + (Math.abs(dy) * h) / 2;

function pkTryLayout(W, H, n, u, sz) {
  const cx = W / 2;
  const cy = H / 2;
  // Mitte: Kartenring, darunter Blinds- und Pot-Feld nebeneinander, darunter der Handname
  const ringW = (5 * sz.card + 4 * sz.cardGap + 2 * sz.ringPad) * u;
  const ringH = (sz.card * 1.4 + 2 * sz.ringPad) * u;
  const heights = [ringH, sz.gap * u, sz.rowH * u, sz.gap * 0.6 * u, sz.nameH * u];
  let y = cy - heights.reduce((a, b) => a + b, 0) / 2;
  const zones = {};
  zones.ring = pkRect(cx - ringW / 2, y, ringW, ringH); y += heights[0] + heights[1];
  const rowW = (sz.blindsW + sz.gap + sz.potW) * u;
  zones.blinds = pkRect(cx - rowW / 2, y, sz.blindsW * u, sz.rowH * u);
  zones.pot = pkRect(cx - rowW / 2 + (sz.blindsW + sz.gap) * u, y, sz.potW * u, sz.rowH * u); y += heights[2] + heights[3];
  zones.name = pkRect(cx - (sz.nameW * u) / 2, y, sz.nameW * u, sz.nameH * u);
  const zoneList = Object.values(zones);

  // Plätze auf der Ellipse: Platz 1 unten in der Mitte, dann im Uhrzeigersinn
  const seatW = sz.seatW * u;
  const seatH = sz.seatH * u;
  const rx = W / 2 - seatW / 2 - 0.2 * u;
  const ry = H / 2 - seatH / 2 - 0.2 * u;
  const seats = [];
  for (let i = 0; i < n; i++) {
    const t = Math.PI / 2 + (i * 2 * Math.PI) / n;
    const sx = cx + rx * Math.cos(t);
    const sy = cy + ry * Math.sin(t);
    seats.push({ ...pkCentered(sx, sy, seatW, seatH), t, cx: sx, cy: sy });
  }
  const fail = (why) => ({ ok: false, why, u });
  for (let i = 0; i < n; i++) {
    if (zoneList.some((z) => pkHits(pkGrow(seats[i], 0.3 * u), z))) return fail('Platz berührt die Mitte');
    for (let j = i + 1; j < n; j++) if (pkHits(pkGrow(seats[i], 0.15 * u), seats[j])) return fail('Plätze berühren sich');
  }

  const blocked = [...zoneList.map((z) => pkGrow(z, 0.4 * u)), ...seats.map((s) => pkGrow(s, 0.25 * u))];
  const free = (r, extra = []) => pkInside(r, W, H, 0.1 * u) && ![...blocked, ...extra].some((b) => pkHits(r, b));

  // Einsätze: zwischen Platz und Mitte, notfalls seitlich verschoben oder kleiner
  const bets = [];
  for (const s of seats) {
    const len = Math.hypot(cx - s.cx, cy - s.cy) || 1;
    const ux = (cx - s.cx) / len;
    const uy = (cy - s.cy) / len;
    let found = null;
    for (const scale of [1, 0.85, 0.7]) {
      const bw = sz.betW * u * scale;
      const bh = sz.betH * u * scale;
      const d0 = pkHalfExt(seatW, seatH, ux, uy) + pkHalfExt(bw, bh, ux, uy) + 0.35 * u;
      for (const k of [1, 0, 2, 3, 4, 5, 6, 7, 8]) {
        for (const lat of [0, 0.8, -0.8, 1.6, -1.6, 2.6, -2.6, 3.6, -3.6]) {
          const d = d0 + k * 0.5 * u;
          const bx = s.cx + ux * d - uy * lat * u;
          const by = s.cy + uy * d + ux * lat * u;
          const r = pkCentered(bx, by, bw, bh);
          if (free(r, bets.map((b) => pkGrow(b, 0.25 * u)))) { found = { ...r, scale, cx: bx, cy: by }; break; }
        }
        if (found) break;
      }
      if (found) break;
    }
    if (!found) return fail('kein Platz für einen Einsatz');
    bets.push(found);
  }

  // Dealer-Button: neben dem eigenen Platz am Rand (im Uhrzeigersinn, sonst gegen), nie zur Mitte hin
  const D = sz.dealer * u;
  const dealers = [];
  for (const s of seats) {
    const tx0 = -rx * Math.sin(s.t);
    const ty0 = ry * Math.cos(s.t);
    const tl = Math.hypot(tx0, ty0) || 1;
    const tx = tx0 / tl;
    const ty = ty0 / tl;
    const len = Math.hypot(cx - s.cx, cy - s.cy) || 1;
    const ox = -(cx - s.cx) / len;    // nach außen
    const oy = -(cy - s.cy) / len;
    const cands = [];
    for (const side of [1, -1]) {
      const off = pkHalfExt(seatW, seatH, tx, ty) + D / 2 + 0.3 * u;
      for (const radial of [0, 0.6, -0.6, 1.2, -1.2, 1.8]) cands.push([s.cx + side * off * tx + radial * u * ox, s.cy + side * off * ty + radial * u * oy]);
    }
    const behind = pkHalfExt(seatW, seatH, ox, oy) + D / 2 + 0.3 * u;
    cands.push([s.cx + ox * behind, s.cy + oy * behind]);
    let found = null;
    for (const [dx, dy] of cands) {
      const r = pkCentered(dx, dy, D, D);
      if (free(r, bets.map((b) => pkGrow(b, 0.2 * u)))) { found = { ...r, cx: dx, cy: dy }; break; }
    }
    if (!found) return fail('kein Platz für den Dealer-Button');
    dealers.push(found);
  }
  return { ok: true, u, W, H, cx, cy, rx, ry, zones, seats, bets, dealers, sizes: sz };
}

/** Layout für eine Tischfläche W × H mit n Spielern (n ≥ 9: kleinere Plätze und Karten). */
function pkComputeLayout(W, H, n) {
  const sz = n >= 9 ? PK_SIZES.many : PK_SIZES.normal;
  let u = Math.min(W / (n >= 9 ? 64 : 56), H / (n >= 9 ? 46 : 41));
  let res = null;
  for (let attempt = 0; attempt < 14; attempt++, u *= 0.95) {
    res = pkTryLayout(W, H, n, u, sz);
    if (res.ok) return res;
  }
  return res;
}

/** Schneidet die Strecke a→b das Rechteck r? */
function pkSegmentHits(a, b, r) {
  const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
  for (let i = 0; i <= steps; i++) {
    const x = a.x + ((b.x - a.x) * i) / steps;
    const y = a.y + ((b.y - a.y) * i) / steps;
    if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) return true;
  }
  return false;
}

/**
 * Flugbahn eines Chips (Liste von Punkten) um Kartenring und Blinds-Feld herum:
 * direkt, sonst seitlich am Ring vorbei (auf der näheren Seite zuerst).
 */
function pkFlightPath(from, to, layout) {
  const m = (PK_CHIP / 2 + 0.3) * layout.u;
  const avoid = [pkGrow(layout.zones.ring, m), pkGrow(layout.zones.blinds, m)];
  const ok = (pts) => pts.every((p, i) => i === 0 || !avoid.some((r) => pkSegmentHits(pts[i - 1], p, r)));
  const left = avoid[0].x - 0.2 * layout.u;
  const right = avoid[0].x + avoid[0].w + 0.2 * layout.u;
  const below = Math.max(...avoid.map((r) => r.y + r.h)) + 0.2 * layout.u;
  const above = Math.min(...avoid.map((r) => r.y)) - 0.2 * layout.u;
  const sides = Math.abs(from.x - left) <= Math.abs(from.x - right) ? [left, right] : [right, left];
  const routes = [[from, to]];
  for (const sx of sides) {
    routes.push([from, { x: sx, y: from.y }, { x: sx, y: to.y }, to]);
    routes.push([from, { x: sx, y: from.y }, { x: sx, y: below }, { x: to.x, y: below }, to]);
  }
  routes.push([from, { x: from.x, y: below }, { x: to.x, y: below }, to]);
  for (const sx of sides) routes.push([from, { x: from.x, y: above }, { x: sx, y: above }, { x: sx, y: below }, { x: to.x, y: below }, to]);
  return routes.find(ok) || routes[0];
}

if (typeof module !== 'undefined') module.exports = { PK_SIZES, PK_CHIP, pkComputeLayout, pkFlightPath, pkHits, pkGrow, pkSegmentHits };
