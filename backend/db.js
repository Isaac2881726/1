// src/config/db.js
// Central Postgres connection pool. Import `pool` anywhere you need to query,
// or `withTransaction` when you need multiple statements to commit/rollback together.

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Reasonable defaults for a small-to-medium campus app.
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  // Catches errors on idle clients so one bad connection doesn't crash the process.
  console.error('Unexpected error on idle Postgres client', err);
});

/**
 * Run a callback inside a single DB transaction.
 * Automatically BEGIN / COMMIT / ROLLBACK and always releases the client.
 *
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction };
