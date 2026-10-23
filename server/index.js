'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');

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
  };

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
    listen(port = 0) {
      return new Promise((resolve) => server.listen(port, () => resolve(server.address().port)));
    },
    close() {
      rooms.shutdown();
      io.close();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const instance = createServer();
  instance.listen(port).then((p) => {
    console.log(`Monopoly-Abend läuft auf http://localhost:${p}  (Tablet: /board, Handy: /play)`);
  });
}

module.exports = { createServer, joinUrl };
