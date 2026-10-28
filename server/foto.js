'use strict';

/*
 * Prüfung der Spielerfotos (ohne Bildbibliothek): Format und Maße werden aus dem
 * Dateikopf gelesen, nicht aus Angaben des Clients. Erlaubt sind nur WebP und JPEG
 * mit genau 128 × 128 Pixeln und höchstens 24 KB.
 */

const FOTO_MAX_BYTES = 24 * 1024;
const FOTO_SIZE = 128;

/** Breite und Höhe eines JPEG aus dem ersten SOF-Segment – sonst null. */
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }               // Füllbytes
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;   // Ende bzw. Bilddaten vor dem Kopf
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    // SOF0 … SOF15 außer DHT (C4), JPG (C8) und DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** Breite und Höhe eines WebP (VP8, VP8L oder VP8X) – sonst null. */
function webpSize(buf) {
  if (buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const riffSize = buf.readUInt32LE(4);
  if (riffSize + 8 > buf.length + 1 || riffSize < 22) return null;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/**
 * Prüft ein Foto. Gibt { type, data } zurück oder wirft einen Fehler mit deutscher Meldung
 * (fail kommt vom Aufrufer, damit es eine UserError ist).
 */
function checkFoto(input, fail) {
  let buf = null;
  if (Buffer.isBuffer(input)) buf = input;
  else if (input instanceof ArrayBuffer) buf = Buffer.from(input);
  else if (ArrayBuffer.isView(input)) buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  else if (typeof input === 'string' && input.length <= FOTO_MAX_BYTES * 2) {
    buf = Buffer.from(input.replace(/^data:[^,]*,/, ''), 'base64');
  }
  if (!buf || !buf.length) fail('Es kam kein Foto an. Bitte versuche es noch einmal.');
  if (buf.length > FOTO_MAX_BYTES) fail('Das Foto ist zu groß (höchstens 24 KB).');
  let type = null;
  let size = webpSize(buf);
  if (size) type = 'image/webp';
  else if ((size = jpegSize(buf))) type = 'image/jpeg';
  if (!type) fail('Dieses Bildformat geht nicht. Erlaubt sind nur WebP und JPEG.');
  if (size.width !== FOTO_SIZE || size.height !== FOTO_SIZE) fail(`Das Foto muss genau ${FOTO_SIZE} × ${FOTO_SIZE} Pixel groß sein.`);
  return { type, data: Buffer.from(buf) };
}

module.exports = { checkFoto, jpegSize, webpSize, FOTO_MAX_BYTES, FOTO_SIZE };
