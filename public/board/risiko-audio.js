'use strict';

/* =========================================================
 *  Risiko: sparsame Töne für die Host-Ansicht. Alles wird zur Laufzeit
 *  mit der Web Audio API erzeugt (keine Audiodateien, keine Lizenzen):
 *  kurz, leise, keine Schleifen und keine Musik. Ton erst nach der
 *  ersten Interaktion mit der Seite (Regel der Browser).
 * ========================================================= */

const RkAudio = (() => {
  const KEY = 'risiko-ton';
  let ctx = null;
  let master = null;
  let unlocked = false;
  const lastPlayed = {};
  const state = (() => {
    try { return { muted: false, volume: 0.6, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch (_) { return { muted: false, volume: 0.6 }; }
  })();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { /* privat-Modus */ } };

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = state.muted ? 0 : state.volume * 0.5;
    master.connect(ctx.destination);
    return ctx;
  }

  /** Erste Interaktion: Audio freischalten, Hinweis ausblenden. */
  function unlock() {
    if (unlocked) return;
    const c = ensure();
    if (!c) return;
    c.resume().then(() => { unlocked = true; render(); }).catch(() => {});
  }

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
    // Würfel: Klicks, die immer langsamer werden – wie Würfel, die ausrollen
    dice() { let t = 0; for (let i = 0; i < 6; i++) { click(t, 0.22 - i * 0.025); t += 0.05 + i * 0.035; } },
    place() { tone(520, { dur: 0.09, glide: 660, gain: 0.1 }); },
    conquer() { tone(523, { dur: 0.16, type: 'triangle', gain: 0.12 }); tone(784, { at: 0.12, dur: 0.26, type: 'triangle', gain: 0.11 }); },
    round() { tone(220, { dur: 0.32, glide: 330, gain: 0.12 }); },
    turn() { tone(392, { dur: 0.14, gain: 0.07 }); },
    trade() { tone(880, { dur: 0.07, type: 'triangle', gain: 0.09 }); tone(1175, { at: 0.08, dur: 0.09, type: 'triangle', gain: 0.08 }); },
  };

  /** Ton abspielen (gleiche Töne höchstens alle 90 ms, z. B. beim gleichzeitigen Setzen). */
  function play(name) {
    if (state.muted || !unlocked || !ctx || !SOUNDS[name]) return;
    const now = performance.now();
    if (now - (lastPlayed[name] || 0) < 90) return;
    lastPlayed[name] = now;
    try { SOUNDS[name](); } catch (_) { /* Audio nicht verfügbar */ }
  }

  function setMuted(m) { state.muted = m; save(); if (master) master.gain.value = m ? 0 : state.volume * 0.5; if (!m) unlock(); render(); }
  function setVolume(v) { state.volume = v; save(); if (master && !state.muted) master.gain.value = v * 0.5; }

  /** Bedienelemente im Banner: Ton an/aus, Lautstärke, einmaliger Hinweis „Ton aktivieren“. */
  function render() {
    const box = document.getElementById('rk-sound');
    if (!box) return;
    const hint = !state.muted && !unlocked;
    box.innerHTML = `${hint ? '<button type="button" class="rk-sound-hint" data-sound="unlock">Ton aktivieren</button>' : ''}
      <button type="button" class="rk-sound-btn" data-sound="toggle" aria-pressed="${!state.muted}">${state.muted ? 'Ton aus' : 'Ton an'}</button>
      <input type="range" class="rk-volume" min="0" max="1" step="0.05" value="${state.volume}" aria-label="Lautstärke" ${state.muted ? 'disabled' : ''} />`;
  }

  function init() {
    const box = document.getElementById('rk-sound');
    if (!box || box.dataset.ready) return;
    box.dataset.ready = '1';
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sound]');
      if (!b) return;
      if (b.dataset.sound === 'toggle') setMuted(!state.muted);
      else unlock();
    });
    box.addEventListener('input', (e) => { if (e.target.matches('.rk-volume')) setVolume(Number(e.target.value)); });
    ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => { if (!state.muted) unlock(); }, { once: false, passive: true }));
    render();
  }

  return { init, play, state };
})();
