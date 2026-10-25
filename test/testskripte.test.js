'use strict';

/*
 * Wächter für die Testskripte in package.json: Jede Testdatei steht in genau
 * einem Skript, und `npm test` braucht weder Browser noch Datenbank.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { scripts } = require('../package.json');
const filesIn = (script) => (script.match(/test\/[\w.-]+\.test\.js/g) || []).map((f) => path.basename(f));

test('Testskripte: jede Testdatei läuft in genau einem Skript', () => {
  const all = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
  const listed = ['test', 'test:db', 'test:browser'].flatMap((name) => filesIn(scripts[name]));
  assert.deepEqual([...listed].sort(), all, 'neue Testdatei in package.json eintragen');
});

test('Testskripte: npm test ohne Browser und ohne Datenbank, alle mit Zeitlimit', () => {
  const unit = filesIn(scripts.test);
  assert.ok(unit.length > 0);
  assert.ok(!unit.some((f) => /e2e|^db\./.test(f)), 'keine Browser- oder Datenbank-Tests in npm test');
  assert.deepEqual(filesIn(scripts['test:db']), ['db.test.js']);
  assert.ok(filesIn(scripts['test:browser']).every((f) => /e2e/.test(f)));
  for (const name of ['test', 'test:db', 'test:browser']) assert.match(scripts[name], /--test-timeout=60000/, name);
});
