'use strict';

/* =========================================================
 *  Eigenes Foto am Handy: quadratisch zuschneiden (Verschieben,
 *  Zoomen), auf 128 × 128 neu zeichnen und als WebP bzw. JPEG mit
 *  höchstens 20 KB kodieren. Gesendet wird nur dieses kleine Bild;
 *  durch das Neuzeichnen im Canvas fallen EXIF- und Ortsdaten weg.
 * ========================================================= */

const FOTO_PX = 128;
const FOTO_MAX = 20 * 1024;

/** Canvas → Blob (Promise). */
const fotoBlob = (canvas, type, q) => new Promise((resolve) => canvas.toBlob(resolve, type, q));

/**
 * Kodiert das 128er-Canvas: erst WebP, sonst (z. B. ältere Safari ohne WebP-Encoder) JPEG,
 * jeweils mit sinkender Qualität, bis es höchstens 20 KB sind.
 */
async function fotoKodieren(canvas) {
  for (const type of ['image/webp', 'image/jpeg']) {
    for (let q = 0.86; q >= 0.3; q -= 0.08) {
      const blob = await fotoBlob(canvas, type, q);
      if (!blob || blob.type !== type) break;   // Format wird nicht unterstützt
      if (blob.size <= FOTO_MAX) return blob;
    }
  }
  throw new Error('Das Foto ließ sich nicht klein genug speichern. Bitte nimm ein anderes.');
}

/** Bilddatei laden (Ausrichtung aus der Kamera wird vom Browser beachtet). */
function fotoLaden(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type || 'image/')) { reject(new Error('Bitte wähle ein Bild aus.')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Dieses Bild lässt sich nicht öffnen.')); };
    img.src = url;
  });
}

/**
 * Zuschnitt in einem quadratischen Canvas. Ziehen verschiebt, der Regler und zwei Finger
 * zoomen. Das Bild füllt den Ausschnitt immer ganz (kein leerer Rand).
 */
function fotoZuschnitt(canvas, zoomInput) {
  const ctx = canvas.getContext('2d');
  const st = { img: null, zoom: 1, x: 0, y: 0 };   // x/y: Mittelpunkt des Ausschnitts in Bildpixeln
  const pointers = new Map();
  let pinch = null;

  const view = () => {
    const { img } = st;
    const base = Math.min(img.naturalWidth, img.naturalHeight);
    const side = base / st.zoom;                     // sichtbare Seitenlänge in Bildpixeln
    const half = side / 2;
    st.x = Math.min(img.naturalWidth - half, Math.max(half, st.x));
    st.y = Math.min(img.naturalHeight - half, Math.max(half, st.y));
    return { sx: st.x - half, sy: st.y - half, side };
  };

  function draw(target = canvas) {
    if (!st.img) return;
    const c = target.getContext('2d');
    const { sx, sy, side } = view();
    c.imageSmoothingQuality = 'high';
    c.clearRect(0, 0, target.width, target.height);
    c.drawImage(st.img, sx, sy, side, side, 0, 0, target.width, target.height);
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(canvas.getBoundingClientRect().width * dpr) || 280;
    if (canvas.width !== w) { canvas.width = w; canvas.height = w; }
    draw();
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: st.zoom };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev || !st.img) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()];
      setZoom(pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.d));
      return;
    }
    const { side } = view();
    const k = side / canvas.getBoundingClientRect().width;
    st.x -= (e.clientX - prev.x) * k;
    st.y -= (e.clientY - prev.y) * k;
    draw();
  });
  const up = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  function setZoom(z) {
    st.zoom = Math.min(4, Math.max(1, z));
    if (zoomInput) zoomInput.value = String(st.zoom);
    draw();
  }
  if (zoomInput) zoomInput.addEventListener('input', () => setZoom(Number(zoomInput.value)));

  return {
    setImage(img) {
      st.img = img; st.zoom = 1; st.x = img.naturalWidth / 2; st.y = img.naturalHeight / 2;
      if (zoomInput) zoomInput.value = '1';
      resize();
    },
    /** Verschieben per Programm (für Tests): Anteil der Ausschnittsbreite. */
    nudge(dx, dy) { const { side } = view(); st.x += dx * side; st.y += dy * side; draw(); },
    setZoom,
    resize,
    /** Fertiges Foto: 128 × 128, höchstens 20 KB. */
    async export() {
      if (!st.img) throw new Error('Bitte wähle zuerst ein Bild aus.');
      const out = document.createElement('canvas');
      out.width = FOTO_PX; out.height = FOTO_PX;
      draw(out);
      return fotoKodieren(out);
    },
  };
}
