'use strict';

/* =========================================================
 *  Animierte Hintergründe der drei Spielflächen (nur Canvas, ohne Bibliothek).
 *
 *  Jede Szene ist eine reine Funktion der Zeit: draw(ctx, w, h, t, q).
 *  Damit sind Standbilder (reduzierte Bewegung, Rückfall) einfach ein
 *  Bild zu einem festen Zeitpunkt.
 *
 *  Steuerung:
 *   - Es läuft höchstens eine Szene mit voller Bildrate (die unter Maus
 *     oder Fokus, sonst die am weitesten sichtbare), die übrigen sichtbaren
 *     mit halber Bildrate; unsichtbare und Szenen im Hintergrund-Tab ruhen.
 *   - Hover/Fokus beschleunigt die Szene weich.
 *   - Adaptive Qualität: Bleibt die Bildzeit einige Sekunden schlecht,
 *     sinken Auflösung und Punktzahl, Glas wird fest (body.st-lite);
 *     im schlimmsten Fall bleiben Standbilder stehen.
 * ========================================================= */

(function hintergrund() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const TAU = Math.PI * 2;
  const RAD = Math.PI / 180;

  /** Deterministische Pseudo-Zufallszahl aus einer ganzen Zahl (0 … 1). */
  function hash(n) {
    let x = (n | 0) * 374761393 + 668265263;
    x = (x ^ (x >>> 13)) * 1274126177;
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smooth = (x) => { const c = clamp(x, 0, 1); return c * c * (3 - 2 * c); };
  const easeOut = (x) => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
  const easeInOut = (x) => { const c = clamp(x, 0, 1); return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2; };
  const lerp = (a, b, k) => a + (b - a) * k;

  /* =====================================================
   *  Risiko: drehende Weltkugel aus Punkten
   * ===================================================== */

  const PLAYER = ['#e0836b', '#e9c46a', '#7fc4a4', '#9aa7f0', '#e09ab8', '#8ccbd6'];

  function globeScene(data) {
    const n = data.points.length / 2;
    const ux = new Float32Array(n); const uy = new Float32Array(n); const uz = new Float32Array(n);
    const lons = new Float32Array(n); const lats = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const la = data.points[2 * i] / 10 * RAD; const lo = data.points[2 * i + 1] / 10 * RAD;
      lats[i] = la; lons[i] = lo;
      ux[i] = Math.cos(la) * Math.cos(lo); uy[i] = Math.cos(la) * Math.sin(lo); uz[i] = Math.sin(la);
    }
    const TILT = 20 * RAD;            // Blick leicht von oben
    const ROLL = -0.2;                // dezente Achsneigung im Bild
    const SPEED = 7 * RAD;            // Grad pro Sekunde
    const EVERY = 1.9;                // neue Region alle … Sekunden
    const LIFE = 5.2;                 // so lange leuchtet eine Region
    const REGION = Math.cos(9 * RAD); // Radius einer Region
    const sinT = Math.sin(TILT); const cosT = Math.cos(TILT);

    /** Region k: ein Landpunkt, der zum Zeitpunkt des Aufleuchtens vorn liegt. */
    const regions = new Map();
    function region(k) {
      if (regions.has(k)) return regions.get(k);
      const lam = (k * EVERY + LIFE * 0.4) * SPEED;
      let best = 0; let bestScore = -Infinity;
      for (let tries = 0; tries < 60; tries++) {
        const i = Math.floor(hash(k * 977 + tries) * n);
        const d = Math.cos(lons[i] - lam) * Math.cos(lats[i]);
        const score = d - Math.abs(lats[i] - 0.35) * 0.3;
        if (score > bestScore) { bestScore = score; best = i; }
      }
      const r = { i: best, color: PLAYER[Math.floor(hash(k * 31 + 7) * PLAYER.length)] };
      regions.set(k, r);
      if (regions.size > 64) regions.delete(regions.keys().next().value);
      return r;
    }

    const stars = Array.from({ length: 60 }, (_, i) => [hash(i * 3 + 1), hash(i * 3 + 2), hash(i * 3 + 3)]);

    return function draw(ctx, w, h, t, q) {
      const R = Math.min(w * 0.4, h * 0.34);
      const cx = w * 0.5; const cy = h * 0.36;
      const lam = t * SPEED;
      const sinL = Math.sin(lam); const cosL = Math.cos(lam);
      const dpr = q.dpr;

      // Hintergrund: tiefes Blau mit wenigen ruhigen Sternen
      const bg = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, Math.max(w, h));
      bg.addColorStop(0, '#10234a'); bg.addColorStop(1, '#060d1f');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#c8d8ff';
      for (const [sx, sy, sa] of stars) {
        ctx.globalAlpha = 0.12 + 0.3 * sa * (0.6 + 0.4 * Math.sin(t * 0.7 + sa * 20));
        ctx.fillRect(sx * w, sy * h, 1.2 * dpr, 1.2 * dpr);
      }
      ctx.globalAlpha = 1;

      // Atmosphäre
      const atm = ctx.createRadialGradient(cx, cy, R * 0.92, cx, cy, R * 1.22);
      atm.addColorStop(0, 'rgba(111,155,224,0.42)'); atm.addColorStop(0.35, 'rgba(111,155,224,0.12)'); atm.addColorStop(1, 'rgba(111,155,224,0)');
      ctx.fillStyle = atm; ctx.beginPath(); ctx.arc(cx, cy, R * 1.22, 0, TAU); ctx.fill();

      // Kugelkörper mit Licht von links oben
      const body = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
      body.addColorStop(0, '#1d3c74'); body.addColorStop(0.7, '#0f2550'); body.addColorStop(1, '#0a1a3a');
      ctx.fillStyle = body; ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();

      ctx.save();
      ctx.translate(cx, cy); ctx.rotate(ROLL);

      // Projektion: Drehung um die Achse (λ), dann Neigung zum Betrachter
      const proj = (x, y, z, out) => {
        const x1 = x * cosL + y * sinL; const y1 = -x * sinL + y * cosL;
        out[0] = y1 * R; out[1] = -(cosT * z - sinT * x1) * R; out[2] = sinT * z + cosT * x1;
      };
      const p = [0, 0, 0];

      // Gitterlinien
      ctx.lineWidth = Math.max(0.6, 0.8 * dpr);
      ctx.strokeStyle = 'rgba(150,185,245,0.13)';
      ctx.beginPath();
      for (let la = -60; la <= 60; la += 30) {
        let pen = false;
        for (let s = 0; s <= 96; s++) {
          const lo = s / 96 * TAU; const cl = Math.cos(la * RAD);
          proj(cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la * RAD), p);
          if (p[2] > 0) { if (pen) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); pen = true; } else pen = false;
        }
      }
      for (let lo = 0; lo < 360; lo += 30) {
        let pen = false;
        for (let s = 0; s <= 64; s++) {
          const la = (-90 + s / 64 * 180) * RAD;
          proj(Math.cos(la) * Math.cos(lo * RAD), Math.cos(la) * Math.sin(lo * RAD), Math.sin(la), p);
          if (p[2] > 0) { if (pen) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); pen = true; } else pen = false;
        }
      }
      ctx.stroke();

      // Aktive Regionen
      const kNow = Math.floor(t / EVERY);
      const active = [];
      for (let k = kNow - Math.ceil(LIFE / EVERY); k <= kNow; k++) {
        if (k < 0) continue;
        const age = t - k * EVERY;
        if (age < 0 || age > LIFE) continue;
        const r = region(k);
        const env = smooth(age / 0.9) * (1 - smooth((age - LIFE + 1.4) / 1.4));
        active.push({ r, env, age, x: ux[r.i], y: uy[r.i], z: uz[r.i] });
      }

      // Landpunkte, nach Tiefe in Helligkeitsstufen gebündelt
      const stride = q.stride;
      const size = clamp(R * 0.0105, 0.9 * dpr, 3.2 * dpr) * (stride > 1 ? 1.25 : 1);
      const buckets = [[], [], [], []];
      const lit = [];
      for (let i = 0; i < n; i += stride) {
        const x = ux[i]; const y = uy[i]; const z = uz[i];
        const x1 = x * cosL + y * sinL;
        const depth = sinT * z + cosT * x1;
        if (depth <= 0.02) continue;
        const sx = (-x * sinL + y * cosL) * R; const sy = -(cosT * z - sinT * x1) * R;
        let glow = 0; let color = null;
        for (const a of active) {
          const d = x * a.x + y * a.y + z * a.z;
          if (d > REGION) {
            const g = a.env * (0.55 + 0.45 * smooth((d - REGION) / (1 - REGION) * 3));
            if (g > glow) { glow = g; color = a.r.color; }
          }
        }
        const s = size * (0.55 + 0.45 * depth);
        if (glow > 0.05) lit.push(sx, sy, s, glow, color);
        else buckets[Math.min(3, Math.floor(depth * 4))].push(sx - s / 2, sy - s / 2, s);
      }
      const alphas = [0.22, 0.4, 0.6, 0.82];
      ctx.fillStyle = '#cfe0ff';
      for (let b = 0; b < 4; b++) {
        const arr = buckets[b];
        ctx.globalAlpha = alphas[b];
        ctx.beginPath();
        for (let j = 0; j < arr.length; j += 3) ctx.rect(arr[j], arr[j + 1], arr[j + 2], arr[j + 2]);
        ctx.fill();
      }
      for (let j = 0; j < lit.length; j += 5) {
        ctx.globalAlpha = 0.35 + 0.65 * lit[j + 3];
        ctx.fillStyle = lit[j + 4];
        const s = lit[j + 2] * (1 + 0.35 * lit[j + 3]);
        ctx.fillRect(lit[j] - s / 2, lit[j + 1] - s / 2, s, s);
      }
      ctx.globalAlpha = 1;

      // Pulsierende Marker in der Mitte jeder Region
      for (const a of active) {
        proj(a.x, a.y, a.z, p);
        if (p[2] <= 0.1) continue;
        const pr = Math.max(2.2 * dpr, R * 0.018);
        const pulse = (a.age % 1.6) / 1.6;
        ctx.globalAlpha = a.env * (1 - pulse) * 0.8;
        ctx.strokeStyle = a.r.color; ctx.lineWidth = 1.4 * dpr;
        ctx.beginPath(); ctx.arc(p[0], p[1], pr + pulse * pr * 3.2, 0, TAU); ctx.stroke();
        ctx.globalAlpha = a.env;
        ctx.fillStyle = '#fff8ec';
        ctx.beginPath(); ctx.arc(p[0], p[1], pr * 0.75, 0, TAU); ctx.fill();
        ctx.fillStyle = a.r.color;
        ctx.beginPath(); ctx.arc(p[0], p[1], pr * 0.5, 0, TAU); ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.restore();

      // Glanz und Rand
      const shine = ctx.createRadialGradient(cx - R * 0.45, cy - R * 0.5, 0, cx - R * 0.45, cy - R * 0.5, R * 0.9);
      shine.addColorStop(0, 'rgba(255,255,255,0.08)'); shine.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = shine; ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();
      const limb = ctx.createRadialGradient(cx, cy, R * 0.75, cx, cy, R);
      limb.addColorStop(0, 'rgba(6,13,31,0)'); limb.addColorStop(1, 'rgba(6,13,31,0.45)');
      ctx.fillStyle = limb; ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(170,200,255,0.35)'; ctx.lineWidth = 1 * dpr;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
    };
  }

  /* =====================================================
   *  Steuerung
   * ===================================================== */

  const STILL_T = { risiko: 14.5, monopoly: 3.4, poker: 9.2 };
  const tiles = [];
  const quality = { level: 0, dpr: Math.min(2, window.devicePixelRatio || 1), stride: 1 };
  let running = false;
  let lastNow = 0;
  let frame = 0;
  let pointer = null;     // Fläche unter Maus oder Fokus

  function applyQuality() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    quality.dpr = quality.level >= 1 ? 1 : dpr;
    quality.stride = quality.level >= 1 ? 2 : 1;
    document.body.classList.toggle('st-lite', quality.level >= 1);
  }

  function resize(tile) {
    const rect = tile.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * quality.dpr));
    const h = Math.max(1, Math.round(rect.height * quality.dpr));
    if (tile.canvas.width !== w || tile.canvas.height !== h) { tile.canvas.width = w; tile.canvas.height = h; }
    // Kleine Flächen brauchen weniger Punkte
    tile.stride = quality.stride * (rect.width < 300 ? 2 : 1);
  }

  function paint(tile, t) {
    if (!tile.draw) return;
    const { canvas } = tile;
    try {
      tile.draw(tile.ctx, canvas.width, canvas.height, t, { dpr: quality.dpr, stride: tile.stride });
    } catch (err) {
      // Szene defekt: CSS-Standbild bleibt, ohne Fehler auf der Seite
      tile.draw = null;
      tile.el.classList.remove('st-has-canvas');
    }
  }

  function still(tile) {
    resize(tile);
    paint(tile, STILL_T[tile.game] || 0);
  }

  const isStill = () => reduce.matches || quality.level >= 2;

  function lead() {
    if (pointer && pointer.visible) return pointer;
    let best = null;
    for (const tile of tiles) if (tile.visible && tile.draw && (!best || tile.ratio > best.ratio)) best = tile;
    return best;
  }

  /* Bildzeit messen: Fenster von 3 s, Mittelwert über 26 ms (unter ~38 fps) heißt schlechter */
  let sampleSum = 0; let sampleN = 0; let sampleStart = 0;
  function measure(now, dt) {
    if (dt > 200) { sampleSum = 0; sampleN = 0; sampleStart = now; return; } // Tab-Wechsel o. Ä.
    sampleSum += dt; sampleN++;
    if (now - sampleStart < 3000) return;
    const avg = sampleSum / sampleN;
    sampleSum = 0; sampleN = 0; sampleStart = now;
    if (avg > 26 && quality.level < 2) {
      quality.level++;
      applyQuality();
      tiles.forEach(resize);
      if (quality.level >= 2) { stop(); tiles.forEach(still); }
    }
  }

  function loop(now) {
    if (!running) return;
    const dt = lastNow ? now - lastNow : 16;
    lastNow = now;
    frame++;
    measure(now, dt);
    const top = lead();
    for (const tile of tiles) {
      if (!tile.visible || !tile.draw) continue;
      const target = tile === pointer ? 2.2 : 1;
      tile.speed = lerp(tile.speed, target, Math.min(1, dt / 350));
      tile.time += Math.min(dt, 64) / 1000 * tile.speed;
      // Volle Bildrate nur für die führende Fläche, sonst jedes zweite Bild
      if (tile !== top && frame % 2) continue;
      paint(tile, tile.time);
    }
    requestAnimationFrame(loop);
  }

  function start() {
    if (running || isStill() || document.hidden) return;
    if (!tiles.some((tile) => tile.visible && tile.draw)) return;
    running = true; lastNow = 0; sampleStart = performance.now(); sampleSum = 0; sampleN = 0;
    requestAnimationFrame(loop);
  }
  function stop() { running = false; }

  function setup(tile, draw) {
    tile.draw = draw;
    tile.el.classList.add('st-has-canvas');
    resize(tile);
    paint(tile, tile.time);
    if (isStill()) still(tile); else start();
  }

  function init() {
    applyQuality();
    for (const el of document.querySelectorAll('.st-game')) {
      const canvas = el.querySelector('canvas');
      const ctx = canvas && canvas.getContext && canvas.getContext('2d');
      if (!ctx) continue;
      const game = el.dataset.game;
      tiles.push({ el, canvas, ctx, game, draw: null, visible: false, ratio: 0, speed: 1, time: STILL_T[game] || 0, stride: 1 });
    }
    if (!tiles.length) return;

    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const tile = tiles.find((x) => x.el === e.target);
        tile.visible = e.isIntersecting;
        tile.ratio = e.intersectionRatio;
      }
      if (tiles.some((x) => x.visible)) start(); else stop();
    }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
    tiles.forEach((tile) => io.observe(tile.el));

    for (const tile of tiles) {
      tile.el.addEventListener('pointerenter', () => { pointer = tile; });
      tile.el.addEventListener('pointerleave', () => { if (pointer === tile) pointer = null; });
      tile.el.addEventListener('focus', () => { pointer = tile; });
      tile.el.addEventListener('blur', () => { if (pointer === tile) pointer = null; });
    }

    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else start(); });
    const onMotion = () => { if (isStill()) { stop(); tiles.forEach(still); } else start(); };
    if (reduce.addEventListener) reduce.addEventListener('change', onMotion);
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { applyQuality(); tiles.forEach((tile) => (isStill() ? still(tile) : resize(tile))); }, 120);
    });

    // Szenen laden; jede für sich, ein Fehler lässt das CSS-Standbild stehen
    const risiko = tiles.find((x) => x.game === 'risiko');
    if (risiko) {
      fetch('/start/globe-points.json')
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error('Punktdatei fehlt'))))
        .then((data) => { if (data && Array.isArray(data.points) && data.points.length) setup(risiko, globeScene(data)); })
        .catch(() => { /* Standbild bleibt */ });
    }
    for (const tile of tiles) {
      const make = SCENES[tile.game];
      if (make) setup(tile, make());
    }
  }

  /** Weitere Szenen (Monopoly, Poker), unten eingetragen. */
  const SCENES = {};

  // Für Prüfungen im Browser (Bildzeit, Qualitätsstufe)
  window.stHintergrund = { quality, tiles, get running() { return running; } };

  try { init(); } catch (_) { /* Hintergrund ist Zierde: Seite läuft auch ohne */ }
}());
