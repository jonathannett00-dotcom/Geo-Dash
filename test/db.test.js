'use strict';

/*
 * Tests gegen eine echte Postgres-Datenbank (z. B. Neon).
 * Laufen nur mit gesetzter DATABASE_URL (npm run test:db), sonst werden sie
 * übersprungen, ohne pg zu laden oder eine Verbindung aufzubauen.
 * Jeder Lauf nutzt eine eigene Tabelle. Am Ende wird jeder angelegte Raum
 * gelöscht (und geprüft, dass er weg ist), danach die Tabelle selbst.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const URL = process.env.DATABASE_URL;
const skip = URL ? false : 'DATABASE_URL fehlt (nur lokal)';

/** Speicher mit eigener Tabelle, der sich jeden gespeicherten Raumcode merkt. */
function testStore() {
  const { createPgStore } = require('../server/db');
  const store = createPgStore({ connectionString: URL, table: `rooms_test_${crypto.randomBytes(4).toString('hex')}`, max: 2 });
  const codes = new Set();
  const save = store.save.bind(store);
  store.save = (code, state) => { codes.add(code); return save(code, state); };
  store.codes = codes;
  return store;
}

/** Löscht jeden angelegten Raum, prüft das und entfernt dann die Tabelle. */
async function cleanup(store) {
  try {
    for (const code of store.codes) {
      await store.remove(code);
      assert.equal(await store.load(code), null, `Raum ${code} wurde gelöscht`);
    }
  } finally {
    await store.drop();
    await store.close();
  }
}

test('Datenbank: Raum speichern, laden, überschreiben und löschen', { skip, timeout: 60000 }, async () => {
  const store = testStore();
  try {
    await store.init();
    await store.save('ABCD', { code: 'ABCD', players: [{ name: 'Anna' }], n: 1 });
    assert.deepEqual(await store.load('ABCD'), { code: 'ABCD', players: [{ name: 'Anna' }], n: 1 });
    await store.save('ABCD', { code: 'ABCD', n: 2 });
    assert.equal((await store.load('ABCD')).n, 2, 'Upsert überschreibt den Stand');
    assert.equal((await store.loadAll(60 * 60 * 1000)).length, 1);
    await store.remove('ABCD');
    assert.equal(await store.load('ABCD'), null);
  } finally {
    await cleanup(store);
  }
});

test('Datenbank: Partie überlebt zwei Server-Neustarts und läuft weiter', { skip, timeout: 60000 }, async () => {
  const { persistenceScenario } = require('./persistence-scenario');
  const store = testStore();
  try {
    await persistenceScenario(store);
  } finally {
    await cleanup(store);
  }
});
