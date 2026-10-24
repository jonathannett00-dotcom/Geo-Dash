'use strict';

/* =========================================================
 *  Ovale Rennbahn – Rendering aus dem Original-Spiel (legacy/game.js)
 *  übernommen und als wiederverwendbare Klasse verpackt.
 *  Rechnet keine Ergebnisse: Positionen kommen vom Server.
 * ========================================================= */

(function () {
  const TRACK_LENGTH = 1000;

  // Geometrie der Bahn im SVG-Koordinatensystem: zwei Geraden + zwei Halbkreise
  const OVAL = { W: 1000, H: 560, cx: 500, cy: 280, a: 230, r0: 118, lane: 22 };

  /** Abstand (in SVG-Einheiten), mit dem die Namen hinter dem Pferd herziehen. */
  const TRAIL_GAP = 26;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Pfad eines Ovals mit Kurvenradius r (Start unten Mitte, gegen den Uhrzeigersinn). */
  function ovalPath(r) {
    const { cx, cy, a } = OVAL;
    return `M${cx - a},${cy + r} L${cx + a},${cy + r} A${r},${r} 0 0 0 ${cx + a},${cy - r}`
      + ` L${cx - a},${cy - r} A${r},${r} 0 0 0 ${cx - a},${cy + r} Z`;
  }

  /** Punkt + Laufrichtung auf Bahn k bei Rundenanteil t (0 = Ziellinie). */
  function trackPoint(k, t) {
    const { cx, cy, a } = OVAL;
    const r = OVAL.r0 + OVAL.lane * (k + 0.5);
    const arc = Math.PI * r;
    let s = (((t % 1) + 1) % 1) * (4 * a + 2 * arc);
    if (s < a) return { x: cx + s, y: cy + r, dx: 1, dy: 0 };
    s -= a;
    if (s < arc) {
      const f = s / r;
      return { x: cx + a + r * Math.sin(f), y: cy + r * Math.cos(f), dx: Math.cos(f), dy: -Math.sin(f) };
    }
    s -= arc;
    if (s < 2 * a) return { x: cx + a - s, y: cy - r, dx: -1, dy: 0 };
    s -= 2 * a;
    if (s < arc) {
      const f = s / r;
      return { x: cx - a - r * Math.sin(f), y: cy - r * Math.cos(f), dx: -Math.cos(f), dy: Math.sin(f) };
    }
    s -= arc;
    return { x: cx - a + s, y: cy + r, dx: 1, dy: 0 };
  }

  const lanePerimeter = (k) => 4 * OVAL.a + 2 * Math.PI * (OVAL.r0 + OVAL.lane * (k + 0.5));

  function horseSVG(h, number) {
    return `
      <g class="bob">
        <path class="tail" d="M20 30 Q8 34 6 50 Q14 42 22 36 Z" fill="${h.coat}" style="filter:brightness(.7)"/>
        <rect class="leg b" x="26" y="38" width="5" height="26" rx="2" fill="${h.coat}" style="filter:brightness(.75)"/>
        <rect class="leg a" x="58" y="38" width="5" height="26" rx="2" fill="${h.coat}" style="filter:brightness(.75)"/>
        <ellipse cx="44" cy="34" rx="25" ry="11" fill="${h.coat}"/>
        <rect class="leg a" x="31" y="38" width="5" height="26" rx="2" fill="${h.coat}"/>
        <rect class="leg b" x="63" y="38" width="5" height="26" rx="2" fill="${h.coat}"/>
        <path d="M58 30 L72 10 L80 14 L70 38 Z" fill="${h.coat}"/>
        <path d="M71 8 L92 15 L94 21 L87 24 L75 18 Z" fill="${h.coat}"/>
        <path d="M73 9 L75 2 L78 9 Z" fill="${h.coat}"/>
        <path d="M62 27 L71 10 L67 9 L58 24 Z" fill="#1a1410"/>
        <circle cx="84" cy="15" r="1.4" fill="#000"/>
        <rect x="36" y="25" width="20" height="12" rx="2" fill="${h.silk}"/>
        <text class="num" x="46" y="34.5" font-size="8" font-weight="900" text-anchor="middle" fill="#fff">${number}</text>
        <path d="M44 25 L50 8 L58 10 L54 26 Z" fill="${h.silk}"/>
        <path d="M54 14 L66 20" stroke="${h.silk}" stroke-width="4" stroke-linecap="round"/>
        <circle cx="54" cy="5" r="5" fill="#f2c9a0"/>
        <path d="M49 4 A5 5 0 0 1 59 4 L61 5 L49 5 Z" fill="${h.silk}"/>
        <path d="M48 26 L44 36" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
      </g>`;
  }

  class RaceTrack {
    /** @param {HTMLElement} container  @param {Array} horses  (name, silk, coat) */
    constructor(container, horses) {
      this.el = container;
      this.horses = horses;
      this.backers = horses.map(() => []);
      this.lastZOrder = '';
      this.lastPositions = new Array(horses.length).fill(0);
      this.render();
    }

    q(sel) { return this.el.querySelector(sel); }
    horseEl(i) { return this.el.querySelector(`[data-horse="${i}"]`); }

    render() {
      const { W, H, cx, cy, r0, lane } = OVAL;
      const n = this.horses.length;
      const outer = r0 + lane * n;
      const dividers = [...Array(n - 1)].map((_, k) =>
        `<path d="${ovalPath(r0 + lane * (k + 1))}" class="t-divider"/>`).join('');
      const laneNos = this.horses.map((_, k) =>
        `<text x="${cx - 18}" y="${cy + r0 + lane * (k + 0.5) + 4}" class="t-laneno">${k + 1}</text>`).join('');

      this.el.classList.add('track');
      this.el.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Ovale Rennbahn mit ${n} Pferden">
        <defs>
          <pattern id="rt-checker" width="8" height="8" patternUnits="userSpaceOnUse">
            <rect width="8" height="8" fill="#fff"/><rect width="4" height="4" fill="#111"/><rect x="4" y="4" width="4" height="4" fill="#111"/>
          </pattern>
          <pattern id="rt-mow" width="80" height="80" patternUnits="userSpaceOnUse" patternTransform="rotate(30)">
            <rect width="40" height="80" class="t-mow"/>
          </pattern>
        </defs>
        <rect width="${W}" height="${H}" class="t-turf"/>
        <rect width="${W}" height="${H}" fill="url(#rt-mow)"/>
        <path d="${ovalPath((r0 + outer) / 2)}" class="t-dirt" stroke-width="${outer - r0}"/>
        <path d="${ovalPath(r0)}" class="t-infield"/>
        <path d="${ovalPath(r0)}" fill="url(#rt-mow)"/>
        ${dividers}
        <path d="${ovalPath(r0)}" class="t-rail"/>
        <path d="${ovalPath(outer)}" class="t-rail"/>
        <rect x="${cx - 5}" y="${cy + r0}" width="10" height="${outer - r0}" fill="url(#rt-checker)"/>
        <rect x="${cx - 2}" y="${cy + outer}" width="4" height="22" class="t-post"/>
        <circle cx="${cx}" cy="${cy + outer + 24}" r="7" class="t-postcap"/>
        ${laneNos}
        <g class="rt-trails"></g>
        <g class="rt-dust"></g>
        <g class="rt-horses">
          ${this.horses.map((h, i) => `
            <g class="horse" data-horse="${i}">
              <ellipse class="glow" cx="0" cy="-2" rx="34" ry="11"/>
              <g class="sprite"><g transform="translate(-33,-42) scale(0.66)">${horseSVG(h, i + 1)}</g></g>
            </g>`).join('')}
        </g>
      </svg>`;
      this.lastZOrder = '';
      this.positionHorses(this.lastPositions);
    }

    /**
     * Hebt Pferde hervor, auf die gewettet wurde: dezenter Lichtkranz + Namen,
     * die wie Bahnbeschriftung hinter dem Pferd herziehen.
     * @param {string[][]} backers  Namen der Wettenden je Pferd
     */
    setBackers(backers) {
      const key = JSON.stringify(backers);
      if (key === this.backersKey) return;
      this.backersKey = key;
      this.backers = backers;
      const layer = this.q('.rt-trails');
      layer.innerHTML = '';
      this.horses.forEach((_, i) => {
        const names = backers[i] || [];
        this.horseEl(i).classList.toggle('backed', names.length > 0);
        if (!names.length) return;
        const trail = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        trail.setAttribute('class', 'trail');
        trail.dataset.trail = i;
        // Wie auf die Bahn gemalt: Großbuchstaben, in Laufrichtung, flach im eigenen Streifen
        trail.innerHTML = `<text>${names.map((n) => esc(n.toUpperCase())).join(' · ')}</text>`;
        layer.appendChild(trail);
        trail.dataset.len = trail.querySelector('text').getComputedTextLength() || 60;
      });
      this.positionHorses(this.lastPositions);
    }

    isBacked(i) { return (this.backers[i] || []).length > 0; }

    /** Setzt jedes Pferd auf seine Bahn; positions in Streckeneinheiten (0 … TRACK_LENGTH). */
    positionHorses(positions) {
      this.lastPositions = positions;
      const pts = positions.map((p, i) => {
        const t = Math.min(p / TRACK_LENGTH, 1.06);   // nach dem Ziel noch ein Stück auslaufen
        return trackPoint(i, t);
      });
      pts.forEach((pt, i) => {
        const el = this.horseEl(i);
        if (!el) return;
        const face = pt.dx < -1e-6 ? -1 : 1;
        const tilt = Math.max(-22, Math.min(22, (Math.atan2(pt.dy, Math.abs(pt.dx)) * 180) / Math.PI));
        el.setAttribute('transform', `translate(${pt.x.toFixed(1)} ${pt.y.toFixed(1)})`);
        el.querySelector('.sprite').setAttribute('transform', `scale(${face} 1) rotate(${tilt.toFixed(1)})`);
        // Startnummer bleibt lesbar, auch wenn das Pferd nach links läuft
        el.querySelector('.num').setAttribute('transform', face < 0 ? 'translate(92 0) scale(-1 1)' : '');

        // Namen folgen der Bahn ein Stück hinter dem Pferd
        const trail = this.el.querySelector(`[data-trail="${i}"]`);
        if (trail) {
          const gap = TRAIL_GAP + Number(trail.dataset.len) / 2;
          const t = Math.min(positions[i] / TRACK_LENGTH, 1.06) - gap / lanePerimeter(i);
          const tp = trackPoint(i, t);
          // entlang der Bahn ausrichten, aber nie auf dem Kopf stehend
          let angle = (Math.atan2(tp.dy, tp.dx) * 180) / Math.PI;
          if (angle > 90) angle -= 180;
          if (angle < -90) angle += 180;
          trail.setAttribute('transform', `translate(${tp.x.toFixed(1)} ${tp.y.toFixed(1)}) rotate(${angle.toFixed(1)})`);
        }
      });
      // Pferde weiter unten im Bild werden vorne gezeichnet
      const order = pts.map((pt, i) => [pt.y, i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
      const key = order.join(',');
      if (key !== this.lastZOrder) {
        const layer = this.q('.rt-horses');
        order.forEach((i) => layer.appendChild(this.horseEl(i)));
        this.lastZOrder = key;
      }
      return pts;
    }

    spawnDust(pt) {
      const d = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      d.setAttribute('class', 'dust');
      d.setAttribute('cx', (pt.x - Math.sign(pt.dx || 1) * 16).toFixed(1));
      d.setAttribute('cy', (pt.y - 2).toFixed(1));
      d.setAttribute('r', '4');
      this.q('.rt-dust').appendChild(d);
      setTimeout(() => d.remove(), 650);
    }

    setRunning(on) { this.el.classList.toggle('running', on); }

    /** Platzierungs-Abzeichen über dem Pferd. */
    markFinished(i, place) {
      const el = this.horseEl(i);
      if (!el || el.classList.contains('finished')) return;
      el.classList.add('finished');
      const badge = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      badge.setAttribute('class', 'place-badge');
      badge.innerHTML = `<rect x="-13" y="-84" width="26" height="17" rx="8.5"/><text x="0" y="-71.5">${place + 1}.</text>`;
      el.appendChild(badge);
    }
  }

  RaceTrack.TRACK_LENGTH = TRACK_LENGTH;
  window.RaceTrack = RaceTrack;
}());
