'use strict';

/* Risiko: feste, ruhige Kartenfarbe je Spielerfarbe aus der Lobby (Fernseher und Handy). */

const RK_TONES = {
  '#e63946': '#c4605a',
  '#1d72d8': '#5582b8',
  '#2a9d8f': '#4f9a8d',
  '#f4a261': '#d39a66',
  '#8e44ad': '#8a6aa6',
  '#e9c46a': '#cdb567',
  '#ff6fb5': '#c9809f',
  '#264653': '#58747c',
  '#8ac926': '#8aad5b',
  '#795548': '#977661',
};
const RK_NEUTRAL = '#b5b0a4';
const LABEL_DIRS = { s: [0, 1], n: [0, -1], e: [1, 0], w: [-1, 0], se: [0.72, 0.72], sw: [-0.72, 0.72], ne: [0.72, -0.72], nw: [-0.72, -0.72] };

/** Größen bei Maßstab k (Pixel je Karteneinheit) – dieselben Formeln wie scripts/build-map.js. */
function rkSizes(k) {
  const st = window.RISIKO_MAP_PATHS.style;
  const markerScale = Math.max(1, Math.min(st.markerMaxScale, st.markerMinPx / (st.markerR * k)));
  const font = Math.max(st.labelMinPx, Math.min(st.labelMaxPx, st.labelUnits * k)) / k;
  return { markerScale, r: st.markerR * markerScale, font };
}

/** Position eines Namens neben seinem Marker (wie im Build-Skript geprüft). */
function rkLabelPos(t, k) {
  const { r, font } = rkSizes(k);
  const [mx, my] = t.marker;
  const l = t.label;
  if (l.x !== undefined) return { x: l.x, y: l.y, anchor: 'middle', font };
  const [dx, dy] = LABEL_DIRS[l.dir];
  const d = (r + window.RISIKO_MAP_PATHS.style.labelGap * font) * l.m;
  let y = my + dy * d;
  if (dy > 0.1) y += font / 2; else if (dy < -0.1) y -= font / 2;
  return { x: mx + dx * d, y, anchor: dx > 0.1 ? 'start' : dx < -0.1 ? 'end' : 'middle', font };
}
