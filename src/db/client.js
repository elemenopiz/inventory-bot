import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config, log } from '../config.js';

// Return DATE columns as plain 'YYYY-MM-DD' strings instead of JS Date objects.
// Avoids timezone-shift bugs when formatting (JST is UTC+9, so toISOString()
// on a local-midnight Date would roll back a day).
pg.types.setTypeParser(1082, (value) => value);

const { Pool } = pg;

export const pool = new Pool({ connectionString: config.databaseUrl });

pool.on('error', (err) => {
  console.error(`[${new Date().toISOString()}] ERROR: unexpected PostgreSQL pool error:`, err.message);
});

// Verifies connectivity and applies schema.sql (all CREATE TABLE IF NOT EXISTS,
// so safe to run on every start). Throws on failure — caller decides to exit.
export async function initDb() {
  await pool.query('SELECT 1');
  const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');
  const schema = await fs.readFile(schemaPath, 'utf8');
  await pool.query(schema);
  log('Database schema applied');
}
