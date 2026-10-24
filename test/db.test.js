'use strict';

/*
 * Tests gegen eine echte Postgres-Datenbank (z. B. Neon).
 * Laufen nur mit gesetzter DATABASE_URL, sonst werden sie übersprungen.
 * Jeder Lauf nutzt eine eigene Tabelle und entfernt sie danach wieder.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createPgStore } = require('../server/db');
const { persistenceScenario } = require('./persistence-scenario');

const URL = process.env.DATABASE_URL;
const skip = URL ? false : 'DATABASE_URL nicht gesetzt – Datenbank-Tests übersprungen';

function testStore() {
  return createPgStore({ connectionString: URL, table: `rooms_test_${crypto.randomBytes(4).toString('hex')}`, max: 2 });
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
    await store.drop();
    await store.close();
  }
});

test('Datenbank: Partie überlebt zwei Server-Neustarts und läuft weiter', { skip, timeout: 60000 }, async () => {
  const store = testStore();
  try {
    await persistenceScenario(store);
  } finally {
    await store.drop();
    await store.close();
  }
});
