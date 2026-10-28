'use strict';

/* Avatar-Set: 24 gültige, rein geometrische SVG-Motive ohne Skripte, Monogramm und Anzeige. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { AV_MOTIVE, AV_IDS, avatarSvg, avatarHtml, avTint, avInitial } = require('../public/shared/avatare');

/** Einfache Prüfung auf Wohlgeformtheit: jedes geöffnete Element wird geschlossen. */
function wellFormed(svg) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g;
  let m;
  let pos = 0;
  while ((m = re.exec(svg))) {
    if (svg.slice(pos, m.index).includes('<')) return false;   // verirrtes '<'
    pos = re.lastIndex;
    const [, close, name, attrs, self] = m;
    if ((attrs.match(/"/g) || []).length % 2) return false;   // Anführungszeichen paarweise
    if (close) { if (stack.pop() !== name) return false; } else if (!self) stack.push(name);
  }
  return stack.length === 0 && !svg.slice(pos).includes('<');
}

const ERLAUBT = new Set(['svg', 'rect', 'circle', 'ellipse', 'path', 'polygon', 'polyline', 'line', 'g']);

test('Avatar-Set: 24 Motive mit eindeutiger Kennung und deutschem Namen, dazu Monogramm', () => {
  assert.equal(AV_MOTIVE.length, 24);
  assert.equal(new Set(AV_MOTIVE.map((m) => m.id)).size, 24);
  assert.equal(AV_IDS.length, 25);
  assert.ok(AV_IDS.includes('monogramm'));
  for (const m of AV_MOTIVE) assert.match(m.name, /^[A-ZÄÖÜ][a-zäöüß]+$/, m.id);
});

test('Avatar-Set: jedes Motiv ist gültiges SVG, ohne Skripte, Verläufe, Text oder Bilder', () => {
  for (const color of ['#e63946', '#e0e0e0', '#264653', '#f0a202']) {
    const tint = avTint(color);
    assert.match(tint, /^#[0-9a-f]{6}$/);
    assert.notEqual(tint, color);
    for (const m of AV_MOTIVE) {
      const svg = avatarSvg(m.id, color);
      assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"'), m.id);
      assert.ok(wellFormed(svg), `${m.id} ist wohlgeformt`);
      assert.doesNotMatch(svg, /script|javascript:|\son[a-z]+=|href|Gradient|filter|<text|<image|foreignObject|NaN|undefined/i, m.id);
      for (const [, name] of svg.matchAll(/<([a-zA-Z]+)/g)) assert.ok(ERLAUBT.has(name), `${m.id}: <${name}> ist nicht erlaubt`);
      // Nur zwei Farben: Spielerfarbe und Tönung
      const colors = new Set([...svg.matchAll(/(?:fill|stroke)="(#[0-9a-f]{6})"/gi)].map((x) => x[1].toLowerCase()));
      assert.deepEqual([...colors].sort(), [color, tint].sort(), `${m.id}: Farbe und Tönung`);
    }
  }
  // Unbekannte Kennung und fremde Farbe: nichts bzw. neutrale Farbe statt Einschleusen
  assert.equal(avatarSvg('gibtsnicht', '#ff0000'), '');
  assert.doesNotMatch(avatarSvg('stern', '"/><script>'), /script/);
});

test('Avatar-Anzeige: runde Komponente in drei Größen, Monogramm, Foto mit Rückfall', () => {
  const p = { id: 'p1', name: 'Ölaf', color: '#1d72d8', avatar: 'ringe' };
  for (const size of ['S', 'M', 'L']) assert.match(avatarHtml(p, size), new RegExp(`class="av av-${size}"`));
  assert.match(avatarHtml(p), /<svg/);
  const mono = avatarHtml({ ...p, avatar: 'monogramm' });
  assert.match(mono, /<span class="av-mono">Ö<\/span>/);
  assert.equal(avInitial('  émile'), 'É');
  assert.match(avatarHtml({ ...p, name: '<b>', avatar: 'monogramm' }), /&lt;/, 'Name wird maskiert');
  // Foto liegt über dem Motiv: lädt es nicht, bleibt das Motiv sichtbar
  const lobby = [{ id: 'p1', avatar: 'stern', photo: '/api/avatar/ABCD/p1?v=1' }];
  const html = avatarHtml({ id: 'p1', name: 'Ölaf', color: '#1d72d8' }, 'M', lobby);
  assert.match(html, /<svg[\s\S]*<img class="av-foto" src="\/api\/avatar\/ABCD\/p1\?v=1"/);
  assert.doesNotMatch(html, /🎩|🚗/u);
});
