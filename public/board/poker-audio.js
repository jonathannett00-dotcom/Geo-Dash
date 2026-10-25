'use strict';

/* =========================================================
 *  Poker: sparsame Töne für die Host-Ansicht, zur Laufzeit mit der
 *  Web Audio API erzeugt (keine Dateien): Austeilen, Chips, Aufdecken,
 *  Gewinn. Kurz und leise, keine Musik, keine Schleifen. Immer an mit
 *  fester Lautstärke; freigeschaltet bei der ersten Bedienung der Seite
 *  (z. B. „Spiel starten“) – wie bei Risiko.
 * ========================================================= */

const PkAudio = (() => {
  const VOLUME = 0.28;
  let ctx = null;
  let master = null;
  const lastPlayed = {};

  function unlock() {
    try {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = VOLUME;
        master.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch (_) { /* kein Ton möglich */ }
  }

  const ready = () => ctx && ctx.state === 'running';

  function tone(freq, { at = 0, dur = 0.12, type = 'sine', gain = 0.12, glide = null } = {}) {
    const t0 = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glide) osc.frequency.exponentialRampToValueAtTime(glide, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.02, dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** Kurzes, gefiltertes Rauschen (Karte gleitet, Chips klicken). */
  function noise(at, { dur = 0.03, freq = 2400, q = 1.2, gain = 0.18 } = {}) {
    const t0 = ctx.currentTime + at;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(bp).connect(g).connect(master);
    src.start(t0);
  }

  const SOUNDS = {
    // Austeilen: ein weiches Wischen pro Karte (Anzahl und Abstand vom Fernseher)
    deal({ cards = 4, gap = 0.14 } = {}) {
      for (let i = 0; i < Math.min(cards, 24); i++) noise(i * gap, { dur: 0.05, freq: 1500, q: 0.8, gain: 0.08 });
    },
    chips() { noise(0, { freq: 3200, q: 3, gain: 0.12 }); noise(0.05, { freq: 3600, q: 3, gain: 0.1 }); },
    flip() { noise(0, { dur: 0.04, freq: 1900, q: 1, gain: 0.12 }); tone(660, { at: 0.01, dur: 0.06, gain: 0.03 }); },
    win() { tone(523, { dur: 0.16, type: 'triangle', gain: 0.1 }); tone(659, { at: 0.12, dur: 0.16, type: 'triangle', gain: 0.09 }); tone(784, { at: 0.24, dur: 0.3, type: 'triangle', gain: 0.09 }); },
  };

  function play(name, arg) {
    if (!ready() || !SOUNDS[name]) return;
    const now = performance.now();
    if (now - (lastPlayed[name] || 0) < 60) return;
    lastPlayed[name] = now;
    try { SOUNDS[name](arg); } catch (_) { /* Audio nicht verfügbar */ }
  }

  ['pointerdown', 'keydown', 'touchend'].forEach((ev) => window.addEventListener(ev, unlock, { capture: true, passive: true }));

  return { unlock, play, get state() { return ctx ? ctx.state : 'none'; } };
})();
