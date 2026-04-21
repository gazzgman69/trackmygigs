const { Pool } = require('pg');

// Replit's helium binding auto-exports both DATABASE_URL (with sslmode=require)
// and the PG* env vars. If we pass connectionString, pg-connection-string parses
// the URL at Pool construction and emits a deprecation warning for sslmode=require
// regardless of any `ssl` option we pass. To avoid that, prefer PG* env vars
// whenever PGHOST is set, since node-postgres reads them automatically.
let pool;
if (process.env.PGHOST) {
  // Replit integrated binding on internal network - SSL not required
  pool = new Pool({ ssl: false });
} else {
  // External cloud DB (Neon-style) - require SSL without strict cert validation
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  end: () => pool.end(),
};
