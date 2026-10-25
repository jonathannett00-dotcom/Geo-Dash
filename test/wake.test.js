'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createServer } = require('../server');

const WAKE = 'https://monopoly-wecker.netlify.app';

/** GET /healthz mit optionalem Origin-Header (http.request, damit der Header sicher mitgeht). */
function healthz(port, origin) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', headers: origin ? { Origin: origin } : {} }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }));
    });
    req.on('error', reject);
  });
}

async function withServer(env, fn) {
  const before = process.env.WAKE_ORIGIN;
  if (env === undefined) delete process.env.WAKE_ORIGIN;
  else process.env.WAKE_ORIGIN = env;
  const srv = createServer({ testMode: true });
  try {
    await fn(await srv.listen(0));
  } finally {
    await srv.close();
    if (before === undefined) delete process.env.WAKE_ORIGIN;
    else process.env.WAKE_ORIGIN = before;
  }
}

test('Weckseite: /healthz erlaubt genau die Origin aus WAKE_ORIGIN', async () => {
  await withServer(`${WAKE}/`, async (port) => {
    const ok = await healthz(port, WAKE);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.headers['access-control-allow-origin'], WAKE, 'Schrägstrich am Ende der Variable wird ignoriert');
    assert.match(ok.headers.vary || '', /Origin/);

    const other = await healthz(port, 'https://fremd.example');
    assert.equal(other.headers['access-control-allow-origin'], undefined, 'fremde Origin bekommt keine Freigabe');
    assert.equal(other.body.ok, true);

    const none = await healthz(port);
    assert.equal(none.headers['access-control-allow-origin'], undefined);
  });
});

test('Weckseite: ohne WAKE_ORIGIN bleibt /healthz wie bisher', async () => {
  await withServer(undefined, async (port) => {
    const res = await healthz(port, WAKE);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.equal(res.headers.vary, undefined);
  });
});
