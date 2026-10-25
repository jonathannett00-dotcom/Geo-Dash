'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');
const { createPgStore } = require('./db');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** Erste LAN-Adresse, damit Handys im WLAN den lokal gestarteten Server erreichen. */
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

/** Adresse, unter der Handys dem Raum beitreten. */
function joinUrl(req, code, testMode) {
  let base = process.env.PUBLIC_URL;
  if (!base) {
    const host = req.get('host') || 'localhost';
    const [hostname, port] = host.split(':');
    const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
    const lan = local && !testMode ? lanAddress() : null;
    base = `${req.protocol}://${lan ? `${lan}${port ? `:${port}` : ''}` : host}`;
  }
  return `${base.replace(/\/+$/, '')}/play?room=${encodeURIComponent(code)}`;
}

function createServer(options = {}) {
  const testMode = options.testMode ?? process.env.MONOPOLY_TEST === '1';
  const config = {
    testMode,
    seed: options.seed ?? process.env.MONOPOLY_SEED,
    timeScale: options.timeScale ?? (testMode ? 0.25 : 1),
    store: options.store || null,
  };
  const { store } = config;

  const app = express();
  app.set('trust proxy', true);
  const server = http.createServer(app);
  const io = new Server(server);
  const rooms = new RoomManager(config);

  const sendPage = (file) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, file));
  app.get('/', (req, res) => res.redirect('/board/'));
  app.get(['/board', '/board/'], sendPage('board/index.html'));
  app.get(['/play', '/play/'], sendPage('play/index.html'));
  app.use(express.static(PUBLIC_DIR, { index: false }));
  // Realistische Risiko-Karte (erzeugt von scripts/build-map.js) als statische Daten für die Host-Ansicht
  app.get('/risiko/map-paths.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'games', 'risiko', 'map-paths.js')));

  app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms.size }));

  const roomCode = (req) => String(req.query.room || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);

  app.get('/api/join-url', (req, res) => {
    const code = roomCode(req);
    if (!rooms.get(code)) return res.status(404).json({ error: 'Raum nicht gefunden.' });
    res.json({ url: joinUrl(req, code, testMode) });
  });

  app.get('/api/qr.svg', async (req, res) => {
    const code = roomCode(req);
    if (!rooms.get(code)) return res.status(404).type('text/plain').send('Raum nicht gefunden.');
    try {
      const svg = await QRCode.toString(joinUrl(req, code, testMode), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
    } catch (err) {
      res.status(500).type('text/plain').send('QR-Code konnte nicht erzeugt werden.');
    }
  });

  io.on('connection', (socket) => rooms.bindSocket(socket));

  return {
    app,
    server,
    io,
    rooms,
    /** Lädt (falls eine Datenbank angebunden ist) gespeicherte Räume und startet dann den Server. */
    async listen(port = 0) {
      if (store) {
        await store.init();
        const count = await rooms.loadFromStore();
        if (count) console.log(`${count} gespeicherte${count === 1 ? 'r Raum' : ' Räume'} wiederhergestellt.`);
      }
      return new Promise((resolve) => server.listen(port, () => resolve(server.address().port)));
    },
    async close() {
      await rooms.flush();
      rooms.shutdown();
      io.close();
      await new Promise((resolve) => server.close(() => resolve()));
      if (store) await store.close();
    },
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  // Mit DATABASE_URL werden Räume in Postgres gespeichert, sonst nur im Arbeitsspeicher
  const store = process.env.DATABASE_URL ? createPgStore({ connectionString: process.env.DATABASE_URL }) : null;
  const instance = createServer({ store });
  instance.listen(port).then((p) => {
    console.log(`Monopoly-Abend läuft auf http://localhost:${p}  (Tablet: /board, Handy: /play)`);
    console.log(store ? 'Spielstände werden in Postgres gespeichert.' : 'Keine DATABASE_URL – Spielstände nur im Arbeitsspeicher.');
  }).catch((err) => {
    console.error('Start fehlgeschlagen:', err.message);
    process.exit(1);
  });
  // Render beendet den Dienst bei Deploys mit SIGTERM: vorher alles speichern
  const stop = () => instance.close().finally(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

module.exports = { createServer, joinUrl };
