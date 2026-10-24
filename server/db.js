'use strict';

/*
 * Postgres-Speicher für Räume (z. B. Neon). Ein Raum ist eine Zeile mit
 * seinem kompletten Zustand als JSONB. Ohne DATABASE_URL wird dieser
 * Speicher nicht benutzt – der Server hält dann alles im Arbeitsspeicher.
 */

const { Pool } = require('pg');

const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

function createPgStore({ connectionString, table = 'rooms', max = 5 } = {}) {
  if (!connectionString) throw new Error('Keine Datenbank-Verbindung angegeben.');
  if (!TABLE_NAME.test(table)) throw new Error(`Ungültiger Tabellenname: ${table}`);

  const pool = new Pool({ connectionString, max, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
  // Verbindungsfehler im Leerlauf (z. B. Neon pausiert) dürfen den Server nicht beenden
  pool.on('error', (err) => console.error('Datenbank-Verbindung unterbrochen:', err.message));

  return {
    table,

    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (
        code text PRIMARY KEY,
        state jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    },

    async save(code, state) {
      await pool.query(
        `INSERT INTO ${table} (code, state, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (code) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
        [code, state],
      );
    },

    async load(code) {
      const { rows } = await pool.query(`SELECT state FROM ${table} WHERE code = $1`, [code]);
      return rows[0] ? rows[0].state : null;
    },

    /** Alle Räume, die jünger als maxAgeMs sind; ältere werden dabei gelöscht. */
    async loadAll(maxAgeMs) {
      await pool.query(`DELETE FROM ${table} WHERE updated_at < now() - ($1 || ' milliseconds')::interval`, [String(maxAgeMs)]);
      const { rows } = await pool.query(`SELECT state FROM ${table} ORDER BY updated_at`);
      return rows.map((r) => r.state);
    },

    async remove(code) {
      await pool.query(`DELETE FROM ${table} WHERE code = $1`, [code]);
    },

    /** Nur für Tests: eigene Tabelle wieder entfernen. */
    async drop() {
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
    },

    async close() {
      await pool.end();
    },
  };
}

module.exports = { createPgStore };
