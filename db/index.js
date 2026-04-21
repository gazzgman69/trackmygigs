const { Pool } = require('pg');

// Prefer DATABASE_URL if set (legacy external Neon via Secrets).
// Otherwise pg reads PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE
// from env automatically, which is what Replit's integrated binding provides.
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : new Pool();

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  end: () => pool.end(),
};
