'use strict';

/* =========================================================
 *  Risiko: sparsame Töne für die Host-Ansicht. Alles wird zur Laufzeit
 *  mit der Web Audio API erzeugt (keine Audiodateien, keine Lizenzen):
 *  kurz, leise, keine Schleifen und keine Musik. Der Ton ist immer an,
 *  mit fester Lautstärke. Browser erlauben Ton erst nach einer Bedienung:
 *  freigeschaltet wird beim Klick auf „Spiel starten“ bzw. nach einem
 *  Neuladen beim ersten Klick irgendwo auf der Seite – ohne Hinweis.
 * ========================================================= */

const RkAudio = (() => {
  const VOLUME = 0.3;
  let ctx = null;
  let master = null;
  const lastPlayed = {};

  /** Audio-Kontext anlegen und fortsetzen; still, wenn der Browser es (noch) nicht erlaubt. */
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

  /** Weicher Ton mit kurzer Hüllkurve. */
  function tone(freq, { at = 0, dur = 0.12, type = 'sine', gain = 0.14, glide = null } = {}) {
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

  /** Kurzes, gefiltertes Rauschen (Würfel auf dem Tisch). */
  function click(at, gain = 0.22) {
    const t0 = ctx.currentTime + at;
    const len = Math.floor(ctx.sampleRate * 0.03);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2200;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(bp).connect(g).connect(master);
    src.start(t0);
  }

  const SOUNDS = {
    // Würfel: Klicks, die immer langsamer werden – wie Würfel, die ausrollen (über die Rolldauer verteilt)
    dice(ms = 600) {
      const n = 7;
      const total = Math.max(0.4, Math.min(2.2, ms / 1000));
      for (let i = 0; i < n; i++) click(total * (i / (n - 1)) ** 1.8, 0.22 - i * 0.022);
    },
    place() { tone(520, { dur: 0.09, glide: 660, gain: 0.1 }); },
    conquer() { tone(523, { dur: 0.16, type: 'triangle', gain: 0.12 }); tone(784, { at: 0.12, dur: 0.26, type: 'triangle', gain: 0.11 }); },
    round() { tone(220, { dur: 0.32, glide: 330, gain: 0.12 }); },
    turn() { tone(392, { dur: 0.14, gain: 0.07 }); },
    trade() { tone(880, { dur: 0.07, type: 'triangle', gain: 0.09 }); tone(1175, { at: 0.08, dur: 0.09, type: 'triangle', gain: 0.08 }); },
  };

  /** Ton abspielen (gleiche Töne höchstens alle 90 ms, z. B. beim gleichzeitigen Setzen). */
  function play(name, arg) {
    if (!ready() || !SOUNDS[name]) return;
    const now = performance.now();
    if (now - (lastPlayed[name] || 0) < 90) return;
    lastPlayed[name] = now;
    try { SOUNDS[name](arg); } catch (_) { /* Audio nicht verfügbar */ }
  }

  // Erste Bedienung irgendwo auf der Seite schaltet frei (auch der Klick auf „Spiel starten“)
  ['pointerdown', 'keydown', 'touchend'].forEach((ev) => window.addEventListener(ev, unlock, { capture: true, passive: true }));

  return { unlock, play, get state() { return ctx ? ctx.state : 'none'; } };
})();
