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
  let sampleSum = 0; let sampleN = 0; let sampleStart = 0; let bad = 0;
  function measure(now, dt) {
    if (dt > 200) { sampleSum = 0; sampleN = 0; sampleStart = now; return; } // Tab-Wechsel o. Ä.
    sampleSum += dt; sampleN++;
    if (now - sampleStart < 3000) return;
    const avg = sampleSum / sampleN;
    sampleSum = 0; sampleN = 0; sampleStart = now;
    bad = avg > 26 ? bad + 1 : 0;
    // Zwei schlechte Fenster in Folge (6 s), dann eine Stufe herunter
    if (bad >= 2 && quality.level < 2) {
      bad = 0;
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

  /* =====================================================
   *  Monopoly: Spielfeld in schräger Perspektive
   *  (eigene Projektion; nur Farbflächen, keine Namen)
   * ===================================================== */

  const GROUPS = [
    ['#8a5a3c', [1, 3]], ['#9cc9e3', [6, 8, 9]], ['#c76c9b', [11, 13, 14]], ['#de8a3e', [16, 18, 19]],
    ['#c8483e', [21, 23, 24]], ['#e2c24a', [26, 27, 29]], ['#3f9a5a', [31, 32, 34]], ['#3360a8', [37, 39]],
  ];
  const STATIONS = [5, 15, 25, 35];

  /** Mitte von Feld i (0 = Ecke vorn rechts, gegen den Uhrzeigersinn) und Richtung zur Brettmitte. */
  function cellPos(i) {
    const side = Math.floor(((i % 40) + 40) % 40 / 10); const k = ((i % 40) + 40) % 40 % 10;
    if (side === 0) return [5 - k, -5, 0, 1];
    if (side === 1) return [-5, -5 + k, 1, 0];
    if (side === 2) return [-5 + k, 5, 0, -1];
    return [5, 5 - k, -1, 0];
  }

  function monopolyScene() {
    const cellColor = new Array(40).fill(null);
    for (const [color, idx] of GROUPS) for (const i of idx) cellColor[i] = color;
    const TOKENS = [
      { color: '#d9b562', shape: 'pawn', off: 0 },
      { color: '#ece4d2', shape: 'cone', off: 0.7 },
      { color: '#c8564a', shape: 'cube', off: 1.4 },
      { color: '#86a6d4', shape: 'hat', off: 2.1 },
    ];
    const MOVE = 2.8;                           // Sekunden je Zug einer Marke
    const steps = TOKENS.map(() => [0]);        // kumulierte Felder je Zug
    const startAt = (j, m) => {
      const arr = steps[j];
      while (arr.length <= m) arr.push(arr[arr.length - 1] + 2 + Math.floor(hash(arr.length * 13 + j * 101) * 9));
      return arr[m];
    };

    // Würfel: Augen pro Fläche (+x, -x, +y, -y, +z, -z)
    const FACES = [
      { n: [1, 0, 0], v: 3 }, { n: [-1, 0, 0], v: 4 }, { n: [0, 1, 0], v: 2 },
      { n: [0, -1, 0], v: 5 }, { n: [0, 0, 1], v: 1 }, { n: [0, 0, -1], v: 6 },
    ];
    const PIPS = {
      1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]], 4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
      5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]], 6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
    };

    return function draw(ctx, w, h, t, q) {
      const yaw = 0.62 + t * 0.035 + 0.12 * Math.sin(t * 0.11);
      const pitch = 0.98 + 0.05 * Math.sin(t * 0.07);
      const sa = Math.sin(yaw); const ca = Math.cos(yaw); const sp = Math.sin(pitch); const cp = Math.cos(pitch);
      const k = Math.max(w * 0.95, h * 0.85) / 11.5;
      const cx = w * 0.5; const cy = h * 0.34; const D = 20;
      const P = (x, y, z) => {
        const x1 = x * ca - y * sa; const y1 = x * sa + y * ca;
        const Y = y1 * cp + z * sp; const Z = -y1 * sp + z * cp;
        const s = D / (D - Z);
        return [cx + x1 * s * k, cy - Y * s * k, Z, s];
      };
      const quad = (pts, fill) => {
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
      };
      const rect = (x0, y0, x1, y1, z, fill) => quad([P(x0, y0, z), P(x1, y0, z), P(x1, y1, z), P(x0, y1, z)], fill);
      const area = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i]; const n = pts[(i + 1) % pts.length]; a += p[0] * n[1] - n[0] * p[1]; } return a; };

      // Raum
      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.8);
      bg.addColorStop(0, '#173a2b'); bg.addColorStop(1, '#07140f');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);

      // Brett: Kanten, dann Oberfläche
      const B = 5.62; const TH = 0.32;
      const edges = [[[B, -B], [-B, -B]], [[-B, -B], [-B, B]], [[-B, B], [B, B]], [[B, B], [B, -B]]];
      for (const [[x0, y0], [x1, y1]] of edges) {
        const pts = [P(x0, y0, 0), P(x1, y1, 0), P(x1, y1, -TH), P(x0, y0, -TH)];
        if (area(pts) < 0) quad(pts, '#0b1f17');
      }
      rect(-B, -B, B, B, 0, '#1b4031');
      rect(-4.5, -4.5, 4.5, 4.5, 0, '#163829');

      // Felder
      const G = 0.05;
      for (let i = 0; i < 40; i++) {
        const [x, y, nx, ny] = cellPos(i);
        const corner = i % 10 === 0;
        const hx = corner ? 0.5 : (nx ? 0.5 : 0.5); const hy = 0.5;
        rect(x - hx + G, y - hy + G, x + hx - G, y + hy - G, 0, corner ? '#25503d' : '#22493a');
        const color = cellColor[i];
        if (color) {
          // Farbstreifen an der Innenkante
          const d = 0.28;
          const ix = x + nx * (0.5 - G); const iy = y + ny * (0.5 - G);
          if (nx) rect(Math.min(ix, ix - nx * d), y - 0.5 + G, Math.max(ix, ix - nx * d), y + 0.5 - G, 0.001, color);
          else rect(x - 0.5 + G, Math.min(iy, iy - ny * d), x + 0.5 - G, Math.max(iy, iy - ny * d), 0.001, color);
        } else if (STATIONS.includes(i)) {
          rect(x - 0.16, y - 0.16, x + 0.16, y + 0.16, 0.001, 'rgba(10,25,19,0.65)');
        } else if (corner) {
          rect(x - 0.22, y - 0.22, x + 0.22, y + 0.22, 0.001, 'rgba(217,181,98,0.22)');
        }
      }
      // Mitte: feiner goldener Rahmen und zwei Kartenfelder
      const ring = [P(-3.2, -3.2, 0), P(3.2, -3.2, 0), P(3.2, 3.2, 0), P(-3.2, 3.2, 0)];
      ctx.beginPath(); ring.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath();
      ctx.strokeStyle = 'rgba(217,181,98,0.28)'; ctx.lineWidth = 1.2 * q.dpr; ctx.stroke();
      rect(-2.6, 1.2, -0.9, 2.3, 0.001, 'rgba(217,181,98,0.16)');
      rect(0.9, -2.3, 2.6, -1.2, 0.001, 'rgba(111,155,224,0.16)');

      // Objekte sammeln und nach Tiefe zeichnen
      const items = [];

      TOKENS.forEach((tok, j) => {
        const tt = t + tok.off;
        const m = Math.floor(tt / MOVE); const u = tt / MOVE - m;
        const a = startAt(j, m); const b = startAt(j, m + 1);
        const prog = (b - a) * easeInOut(u / 0.62);
        const pos = a + prog; const f = pos - Math.floor(pos);
        const [x0, y0] = cellPos(Math.floor(pos)); const [x1, y1] = cellPos(Math.floor(pos) + 1);
        const off = [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]][j];
        const x = lerp(x0, x1, f) + off[0]; const y = lerp(y0, y1, f) + off[1];
        const hop = u < 0.62 ? Math.sin(Math.PI * f) * 0.45 : 0;
        items.push({ z: P(x, y, 0)[2], fn: () => token(tok, x, y, hop) });
      });

      // Würfel: Wurf alle 5,6 s
      const CYCLE = 5.6;
      const c = Math.floor(t / CYCLE); const ut = t - c * CYCLE;
      for (let d = 0; d < 2; d++) {
        const seed = c * 7 + d * 3;
        const ex = -0.4 + d * 1.15 + (hash(seed) - 0.5) * 0.5; const ey = -0.6 + d * 0.5 + (hash(seed + 1) - 0.5) * 0.6;
        const sx = -3.4 + d * 0.6; const sy = 3.0 - d * 0.5;
        const roll = clamp(ut / 1.7, 0, 1); const e = easeOut(roll);
        const x = lerp(sx, ex, e); const y = lerp(sy, ey, e);
        const bounce = Math.abs(Math.sin(roll * Math.PI * 3)) * (1 - roll) * 1.2;
        const endX = Math.floor(hash(seed + 2) * 4) * Math.PI / 2; const endY = Math.floor(hash(seed + 3) * 4) * Math.PI / 2;
        const endZ = (hash(seed + 4) - 0.5) * 1.2;
        const spin = (1 - e) * 9;
        const rx = endX + spin * (1 + d * 0.3); const ry = endY + spin * 0.8; const rz = endZ + spin * 0.5;
        const alpha = ut < 0.25 ? ut / 0.25 : ut > CYCLE - 0.6 ? (CYCLE - ut) / 0.6 : 1;
        items.push({ z: P(x, y, 0)[2], fn: () => die(x, y, 0.33 + bounce, rx, ry, rz, alpha) });
      }

      items.sort((p1, p2) => p1.z - p2.z);
      items.forEach((it) => it.fn());

      // Licht und Vignette
      const vg = ctx.createRadialGradient(cx, cy * 0.8, Math.min(w, h) * 0.2, cx, cy, Math.max(w, h) * 0.85);
      vg.addColorStop(0, 'rgba(255,240,200,0.06)'); vg.addColorStop(1, 'rgba(4,10,8,0.6)');
      ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);

      function shadow(x, y, r, a) {
        const p = P(x, y, 0);
        ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = '#04100b';
        ctx.beginPath(); ctx.ellipse(p[0], p[1], r * k * p[3], r * k * p[3] * cp, 0, 0, TAU); ctx.fill(); ctx.restore();
      }

      /** Rotationskörper als Folge von Ringen (r, z): Seitenflächen und Deckel. */
      function lathe(x, y, z0, profile, color) {
        let prev = null;
        for (const [r, z] of profile) {
          const p = P(x, y, z0 + z); const rx = r * k * p[3]; const ry = rx * cp;
          if (prev && (prev.rx > 0 || rx > 0)) {
            const g = ctx.createLinearGradient(p[0] - rx, 0, p[0] + rx, 0);
            g.addColorStop(0, shade(color, -0.35)); g.addColorStop(0.4, shade(color, 0.12)); g.addColorStop(1, shade(color, -0.45));
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.ellipse(prev.x, prev.y, Math.max(prev.rx, 0.01), Math.max(prev.ry, 0.01), 0, 0, Math.PI);
            ctx.lineTo(p[0] - rx, p[1]);
            ctx.ellipse(p[0], p[1], Math.max(rx, 0.01), Math.max(ry, 0.01), 0, Math.PI, 0, true);
            ctx.closePath(); ctx.fill();
          }
          prev = { x: p[0], y: p[1], rx, ry };
        }
        if (prev && prev.rx > 0.5) {
          ctx.fillStyle = shade(color, 0.18);
          ctx.beginPath(); ctx.ellipse(prev.x, prev.y, prev.rx, prev.ry, 0, 0, TAU); ctx.fill();
        }
      }
      function sphere(x, y, z, r, color) {
        const p = P(x, y, z); const rr = r * k * p[3];
        const g = ctx.createRadialGradient(p[0] - rr * 0.35, p[1] - rr * 0.4, rr * 0.1, p[0], p[1], rr);
        g.addColorStop(0, shade(color, 0.35)); g.addColorStop(1, shade(color, -0.4));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p[0], p[1], rr, 0, TAU); ctx.fill();
      }
      function token(tok, x, y, hop) {
        shadow(x, y, 0.3, 0.45 - hop * 0.4);
        if (tok.shape === 'pawn') {
          lathe(x, y, hop, [[0.26, 0], [0.26, 0.08], [0.14, 0.14], [0.09, 0.5]], tok.color);
          sphere(x, y, hop + 0.62, 0.16, tok.color);
        } else if (tok.shape === 'cone') {
          lathe(x, y, hop, [[0.25, 0], [0.25, 0.07], [0.2, 0.09], [0.02, 0.72]], tok.color);
        } else if (tok.shape === 'hat') {
          lathe(x, y, hop, [[0.3, 0], [0.3, 0.05], [0.17, 0.06], [0.17, 0.48]], tok.color);
        } else {
          box(x, y, hop + 0.21, 0.2, 0, 0, t * 0.4 + 0.5, tok.color, 1, null);
        }
      }
      function die(x, y, z, rx, ry, rz, alpha) {
        shadow(x, y, 0.42, 0.45 * alpha / (1 + (z - 0.33) * 1.2));
        box(x, y, z, 0.33, rx, ry, rz, '#f3eee2', alpha, true);
      }
      /** Würfel/Quader mit halber Kantenlänge s, gedreht um x, y, z. */
      function box(x, y, z, s, rx, ry, rz, color, alpha, pips) {
        const rot = (v) => {
          let [a, b, c2] = v;
          let t1 = b * Math.cos(rx) - c2 * Math.sin(rx); c2 = b * Math.sin(rx) + c2 * Math.cos(rx); b = t1;
          t1 = a * Math.cos(ry) + c2 * Math.sin(ry); c2 = -a * Math.sin(ry) + c2 * Math.cos(ry); a = t1;
          t1 = a * Math.cos(rz) - b * Math.sin(rz); b = a * Math.sin(rz) + b * Math.cos(rz); a = t1;
          return [a, b, c2];
        };
        ctx.save(); ctx.globalAlpha = alpha;
        for (const face of FACES) {
          const n = rot(face.n);
          // Eckpunkte der Fläche im Würfel
          const [nx, ny, nz] = face.n;
          const u = nx ? [0, 1, 0] : [1, 0, 0]; const v = nz ? [0, 1, 0] : [0, 0, 1];
          const corner = (a, b) => { const r = rot([(nx + u[0] * a + v[0] * b) * s, (ny + u[1] * a + v[1] * b) * s, (nz + u[2] * a + v[2] * b) * s]); return P(x + r[0], y + r[1], z + r[2]); };
          const pts = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
          // nur Flächen zum Betrachter
          const toCam = -(n[0] * sa + n[1] * ca) * sp + n[2] * cp;
          if (toCam <= 0.01) continue;
          const light = clamp(0.55 + 0.45 * (n[2] * 0.8 + (-n[0] * 0.3 + n[1] * 0.2)), 0.35, 1);
          quad(pts, shade(color, (light - 0.85) * 0.9));
          if (pips) {
            ctx.fillStyle = '#1d1f22';
            for (const [a, b] of PIPS[face.v]) {
              const c = corner(a * 0.5, b * 0.5);
              const pr = s * 0.13 * k * c[3];
              ctx.beginPath(); ctx.ellipse(c[0], c[1], pr, pr * Math.max(0.25, toCam), 0, 0, TAU); ctx.fill();
            }
          }
        }
        ctx.restore();
      }
    };
  }

  /** Farbe heller (f > 0) oder dunkler (f < 0) machen. */
  const shadeCache = new Map();
  function shade(hex, f) {
    const key = hex + (Math.round(f * 50) / 50);
    let out = shadeCache.get(key);
    if (out) return out;
    const n = parseInt(hex.slice(1), 16);
    const ch = (c) => Math.round(f >= 0 ? c + (255 - c) * f : c * (1 + f));
    out = `rgb(${ch(n >> 16)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
    shadeCache.set(key, out);
    return out;
  }

  /* =====================================================
   *  Poker: Tisch von oben, Karten und Chips
   * ===================================================== */

  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'B', 'D', 'K', 'A'];
  const SUIT_COLOR = ['#1c1f24', '#c0343f', '#2f62b5', '#2f8a4c']; // Pik, Herz, Karo, Kreuz

  function suitPath(ctx, suit, x, y, s) {
    ctx.beginPath();
    if (suit === 2) { // Karo
      ctx.moveTo(x, y - s * 0.55); ctx.lineTo(x + s * 0.4, y); ctx.lineTo(x, y + s * 0.55); ctx.lineTo(x - s * 0.4, y); ctx.closePath();
    } else if (suit === 1) { // Herz
      ctx.moveTo(x, y + s * 0.5);
      ctx.bezierCurveTo(x - s * 0.62, y + s * 0.02, x - s * 0.5, y - s * 0.58, x, y - s * 0.22);
      ctx.bezierCurveTo(x + s * 0.5, y - s * 0.58, x + s * 0.62, y + s * 0.02, x, y + s * 0.5);
    } else if (suit === 0) { // Pik
      ctx.moveTo(x, y - s * 0.55);
      ctx.bezierCurveTo(x + s * 0.62, y - s * 0.05, x + s * 0.5, y + s * 0.5, x, y + s * 0.18);
      ctx.bezierCurveTo(x - s * 0.5, y + s * 0.5, x - s * 0.62, y - s * 0.05, x, y - s * 0.55);
      ctx.moveTo(x, y + s * 0.1); ctx.lineTo(x + s * 0.16, y + s * 0.55); ctx.lineTo(x - s * 0.16, y + s * 0.55); ctx.closePath();
    } else { // Kreuz
      const r = s * 0.2;
      ctx.moveTo(x + r, y - s * 0.28); ctx.arc(x, y - s * 0.28, r, 0, TAU);
      ctx.moveTo(x - s * 0.2 + r, y + s * 0.06); ctx.arc(x - s * 0.2, y + s * 0.06, r, 0, TAU);
      ctx.moveTo(x + s * 0.2 + r, y + s * 0.06); ctx.arc(x + s * 0.2, y + s * 0.06, r, 0, TAU);
      ctx.moveTo(x, y); ctx.lineTo(x + s * 0.15, y + s * 0.55); ctx.lineTo(x - s * 0.15, y + s * 0.55); ctx.closePath();
    }
    ctx.fill();
  }

  function pokerScene() {
    let felt = null; let feltKey = '';
    const CHIP = ['#b8404a', '#ece6d6', '#2e5a8a', '#1b1d22', '#3f8a5a'];

    function makeFelt(w, h, dpr) {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d');
      const base = g.createRadialGradient(w * 0.5, h * 0.36, 0, w * 0.5, h * 0.4, Math.max(w, h) * 0.75);
      base.addColorStop(0, '#1a6146'); base.addColorStop(0.6, '#0f4732'); base.addColorStop(1, '#082a1e');
      g.fillStyle = base; g.fillRect(0, 0, w, h);
      // Filzfasern: viele sehr feine, kurze Striche
      const count = Math.floor(w * h / (60 * dpr));
      g.lineWidth = Math.max(0.6, 0.6 * dpr);
      for (let i = 0; i < count; i++) {
        const x = hash(i * 5 + 1) * w; const y = hash(i * 5 + 2) * h; const a = hash(i * 5 + 3) * TAU; const l = (1 + hash(i * 5 + 4) * 2.5) * dpr;
        g.strokeStyle = hash(i * 5 + 5) > 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.06)';
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
      }
      // Bande: Rand des ovalen Tisches
      g.save();
      g.lineWidth = Math.min(w, h) * 0.06;
      g.strokeStyle = '#17110d';
      g.beginPath(); g.ellipse(w * 0.5, h * 0.4, w * 0.62, h * 0.52, 0, 0, TAU); g.stroke();
      g.lineWidth = 1.5 * dpr; g.strokeStyle = 'rgba(217,181,98,0.25)';
      g.beginPath(); g.ellipse(w * 0.5, h * 0.4, w * 0.62 - Math.min(w, h) * 0.035, h * 0.52 - Math.min(w, h) * 0.035, 0, 0, TAU); g.stroke();
      // Setzlinie
      g.setLineDash([4 * dpr, 6 * dpr]); g.strokeStyle = 'rgba(255,255,255,0.08)';
      g.beginPath(); g.ellipse(w * 0.5, h * 0.4, w * 0.4, h * 0.3, 0, 0, TAU); g.stroke();
      g.restore();
      return c;
    }

    const PERIOD = 17;

    return function draw(ctx, w, h, t, q) {
      const key = `${w}x${h}`;
      if (key !== feltKey) { felt = makeFelt(w, h, q.dpr); feltKey = key; }
      ctx.drawImage(felt, 0, 0);

      const loop = Math.floor(t / PERIOD); const u = t - loop * PERIOD;
      const cw = Math.min(w * 0.13, h * 0.11); const chh = cw * 1.4;
      const deck = [w * 0.07, h * 0.05];
      const seats = [[w * 0.24, h * 0.13, -0.12], [w * 0.76, h * 0.13, 0.12], [w * 0.5, h * 0.5, 0]];
      const pot = [w * 0.5, h * 0.4];
      const board = (i) => [w * 0.5 + (i - 2) * cw * 1.12, h * 0.29];
      const card = (n) => { const v = Math.floor(hash(loop * 7919 + n * 104729 + 17) * 52); return { rank: RANKS[v % 13], suit: Math.floor(v / 13) }; };

      // Einsammeln am Ende: alle Karten zurück zum Stapel
      const collect = smooth((u - 13.2) / 1.2);
      const fadeIn = smooth(u / 0.4);

      // Stapel
      for (let i = 3; i >= 0; i--) drawCard(deck[0] + i * 0.6 * q.dpr, deck[1] - i * 0.6 * q.dpr, 0, 1, null, 1);

      // Chips: Stapel an den Plätzen, Einsätze in die Mitte, Pot zum Gewinner
      const winner = Math.floor(hash(loop * 17 + 3) * 3);
      seats.forEach(([sx, sy], i) => {
        const bet = smooth((u - 4.4 - i * 0.15) / 0.8);
        const back = smooth((u - 14.6) / 1.4);
        const toPot = bet * (1 - smooth((u - 10.2) / 1.0));
        const home = [sx + [cw * 1.5, -cw * 1.5, cw * 1.6][i], sy];
        stack(home[0], home[1], 6 + i, i);
        // Einsatz
        if (bet > 0.01 && u < 11.4) {
          const tx = lerp(home[0], pot[0] + (i - 1) * cw * 0.5, bet); const ty = lerp(home[1], pot[1], bet);
          stack(tx, ty, 3, i + 1, toPot > 0 ? 1 : 0);
        }
        // Gewinn
        if (i === winner && u > 10.2) {
          const win = smooth((u - 10.2) / 1.2) * (1 - back);
          const wx = lerp(pot[0], home[0] - cw * 0.6, win); const wy = lerp(pot[1], home[1], win);
          stack(wx, wy - chh * 0.25, 9, 2, 1 - back);
        }
      });

      // Handkarten (verdeckt), Plätze nacheinander
      for (let r = 0; r < 2; r++) {
        seats.forEach(([sx, sy, rot], i) => {
          const n = r * 3 + i; const t0 = 0.4 + n * 0.32;
          const k1 = easeOut((u - t0) / 0.5);
          if (k1 <= 0) return;
          const tx = sx + (r - 0.5) * cw * 0.7; const ty = sy;
          let x = lerp(deck[0], tx, k1); let y = lerp(deck[1], ty, k1);
          x = lerp(x, deck[0], collect); y = lerp(y, deck[1], collect);
          const flip = i === winner ? smooth((u - 8.6 - r * 0.2) / 0.5) * (1 - collect) : 0;
          drawCard(x, y, lerp(rot * 2.5, rot + (r - 0.5) * 0.12, k1) * (1 - collect), flip > 0.5 ? Math.abs(Math.cos(Math.PI * flip)) : Math.abs(Math.cos(Math.PI * flip)), flip > 0.5 ? card(10 + n) : null, fadeIn * (1 - collect * 0.4));
        });
      }

      // Gemeinschaftskarten: Flop, Turn, River
      const times = [2.6, 2.75, 2.9, 6.0, 7.4];
      times.forEach((t0, i) => {
        const k1 = easeOut((u - t0) / 0.55);
        if (k1 <= 0) return;
        const [bx, by] = board(i);
        let x = lerp(deck[0], bx, k1); let y = lerp(deck[1], by, k1);
        x = lerp(x, deck[0], collect); y = lerp(y, deck[1], collect);
        const flip = smooth((u - t0 - 0.6 - (i < 3 ? i * 0.18 : 0)) / 0.45) * (1 - collect);
        drawCard(x, y, (1 - k1) * 0.6, Math.abs(Math.cos(Math.PI * flip)), flip > 0.5 ? card(i) : null, 1 - collect * 0.4);
      });

      // Vignette
      const vg = ctx.createRadialGradient(w * 0.5, h * 0.4, Math.min(w, h) * 0.3, w * 0.5, h * 0.45, Math.max(w, h) * 0.8);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.5)');
      ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);

      function drawCard(x, y, rot, scaleX, face, alpha) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(x, y); ctx.rotate(rot); ctx.scale(Math.max(0.02, scaleX), 1);
        const r = cw * 0.1;
        ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 6 * q.dpr; ctx.shadowOffsetY = 2 * q.dpr;
        ctx.beginPath(); ctx.roundRect(-cw / 2, -chh / 2, cw, chh, r);
        ctx.fillStyle = face ? '#f5f0e4' : '#7a2630'; ctx.fill();
        ctx.shadowColor = 'transparent';
        if (face) {
          ctx.fillStyle = SUIT_COLOR[face.suit];
          ctx.font = `700 ${Math.round(cw * 0.3)}px system-ui, sans-serif`;
          ctx.textBaseline = 'top'; ctx.textAlign = 'left';
          ctx.fillText(face.rank, -cw / 2 + cw * 0.1, -chh / 2 + cw * 0.08);
          suitPath(ctx, face.suit, -cw / 2 + cw * 0.22, -chh / 2 + cw * 0.55, cw * 0.2);
          suitPath(ctx, face.suit, cw * 0.06, chh * 0.12, cw * 0.48);
        } else {
          ctx.strokeStyle = 'rgba(232,205,150,0.35)'; ctx.lineWidth = Math.max(1, cw * 0.02);
          ctx.beginPath(); ctx.roundRect(-cw / 2 + cw * 0.08, -chh / 2 + cw * 0.08, cw * 0.84, chh - cw * 0.16, r * 0.6); ctx.stroke();
          ctx.save(); ctx.clip();
          ctx.strokeStyle = 'rgba(232,205,150,0.14)'; ctx.beginPath();
          for (let d = -chh; d < chh; d += cw * 0.14) { ctx.moveTo(-cw, d); ctx.lineTo(cw, d + cw * 2); ctx.moveTo(cw, d); ctx.lineTo(-cw, d + cw * 2); }
          ctx.stroke(); ctx.restore();
        }
        ctx.restore();
      }

      function stack(x, y, count, colorIdx, alpha = 1) {
        if (alpha <= 0.01) return;
        const r = cw * 0.3; const step = r * 0.13;
        ctx.save(); ctx.globalAlpha = alpha;
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.beginPath(); ctx.ellipse(x + r * 0.12, y + r * 0.18, r * 1.05, r * 1.0, 0, 0, TAU); ctx.fill();
        for (let i = 0; i < count; i++) {
          const col = CHIP[(colorIdx + (i > count - 3 ? 1 : 0)) % CHIP.length];
          const cy2 = y - i * step;
          ctx.fillStyle = shade(col, -0.35);
          ctx.beginPath(); ctx.arc(x, cy2 + step * 0.6, r, 0, TAU); ctx.fill();
          ctx.fillStyle = col;
          ctx.beginPath(); ctx.arc(x, cy2, r, 0, TAU); ctx.fill();
        }
        // Deckel: Randmarken und Innenkreis
        const top = y - (count - 1) * step;
        ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = r * 0.16;
        ctx.setLineDash([r * 0.32, r * 0.42]);
        ctx.beginPath(); ctx.arc(x, top, r * 0.84, 0, TAU); ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = Math.max(1, r * 0.05);
        ctx.beginPath(); ctx.arc(x, top, r * 0.55, 0, TAU); ctx.stroke();
        ctx.restore();
      }
    };
  }

  const SCENES = { monopoly: monopolyScene, poker: pokerScene };

  // Für Prüfungen im Browser (Bildzeit, Qualitätsstufe)
  window.stHintergrund = { quality, tiles, get running() { return running; } };

  try { init(); } catch (_) { /* Hintergrund ist Zierde: Seite läuft auch ohne */ }
}());
