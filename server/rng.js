'use strict';

const crypto = require('crypto');

/** Macht aus beliebigem Text einen 32-Bit-Startwert. */
function hashSeed(seed) {
  const str = String(seed);
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

/**
 * Zufallsgenerator des Servers (mulberry32). Ohne Seed wird er kryptografisch
 * zufällig initialisiert; mit Seed (nur Tests) ist jeder Ablauf reproduzierbar.
 */
function createRng(seed) {
  let a = seed === undefined || seed === null || seed === ''
    ? crypto.randomInt(0, 2 ** 32 - 1)
    : hashSeed(seed);

  function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next,
    int: (n) => Math.floor(next() * n),
    range: (lo, hi) => lo + next() * (hi - lo),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    shuffle(arr) {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

module.exports = { createRng };
